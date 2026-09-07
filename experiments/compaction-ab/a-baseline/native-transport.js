// Archived A baseline: preserve pre-B production behavior for the A/B experiment.
import { setImmediate as yieldToTimers } from 'node:timers/promises';
import { encodeCheckpoint } from './checkpoint.js';

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_ITEMS = 1024;
const RETAIN_TOKENS = 64_000; // ceil(UTF-16 text length / 4), not provider token usage.
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);

function error(code) {
  const result = new Error(`Native compaction: ${code}`);
  result.code = code;
  return result;
}
function requireValue(condition, code) { if (!condition) throw error(code); }
function binding(value) { return typeof value === 'string' && !!value.trim() && value.length <= 256; }

// Reject values JSON.stringify would silently change, getters, and pollution keys.
function snapshot(value, limit = MAX_BODY) {
  let nodes = 0, bytes = 0;
  const ancestors = new Set();
  function visit(node, depth) {
    requireValue(++nodes <= 50_000 && depth <= 32, 'JSON_LIMIT');
    if (node === null || typeof node === 'boolean') return;
    if (typeof node === 'string') {
      bytes += Buffer.byteLength(node);
      requireValue(bytes <= limit, 'BODY_SIZE');
      return;
    }
    if (typeof node === 'number' && Number.isFinite(node) && !Object.is(node, -0)) return;
    requireValue(typeof node === 'object' && !ancestors.has(node), 'INVALID_JSON');
    const array = Array.isArray(node);
    const proto = Object.getPrototypeOf(node);
    requireValue(array ? proto === Array.prototype : proto === Object.prototype || proto === null, 'INVALID_JSON');
    const keys = Reflect.ownKeys(node);
    requireValue(keys.length <= 50_000, 'JSON_LIMIT');
    ancestors.add(node);
    for (const key of keys) {
      if (array && key === 'length') continue;
      requireValue(typeof key === 'string' && !unsafe.has(key), 'UNSAFE_JSON_KEY');
      bytes += Buffer.byteLength(key);
      requireValue(bytes <= limit, 'BODY_SIZE');
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      requireValue(descriptor.enumerable && 'value' in descriptor, 'INVALID_JSON');
      if (array) requireValue(/^(0|[1-9]\d*)$/.test(key) && Number(key) < node.length, 'INVALID_JSON');
      visit(descriptor.value, depth + 1);
    }
    if (array) requireValue(keys.length === node.length + 1, 'INVALID_JSON');
    ancestors.delete(node);
  }
  visit(value, 0);
  const text = JSON.stringify(value);
  requireValue(Buffer.byteLength(text) <= limit, 'BODY_SIZE');
  return JSON.parse(text);
}

function checkModalities(node) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') {
    requireValue(!/(image|audio|video|file)/i.test(node.type), 'UNSUPPORTED_MODALITY');
  }
  for (const [key, value] of Object.entries(node)) {
    requireValue(!['image_url', 'image', 'file_data', 'file_id', 'input_audio'].includes(key), 'UNSUPPORTED_MODALITY');
    if (typeof value === 'string') requireValue(!/^data:(image|audio|video)\//i.test(value), 'UNSUPPORTED_MODALITY');
    else checkModalities(value);
  }
}

function retainedInput(input) {
  const retained = [];
  let tokens = 0;
  // Validate every selected client, not only those surviving the retention cap.
  const clients = input.filter(item => ['user', 'developer', 'system'].includes(item.role)).map(item => {
    let text;
    if (typeof item.content === 'string') text = item.content;
    else {
      requireValue(Array.isArray(item.content) && item.content.every(part =>
        part && part.type === 'input_text' && typeof part.text === 'string'), 'UNSUPPORTED_CLIENT_CONTENT');
      text = item.content.map(part => part.text).join('');
    }
    const cost = Math.ceil(text.length / 4);
    // Never truncate or rewrite opaque items (including surrogate pairs).
    requireValue(cost <= RETAIN_TOKENS, 'RETENTION_SIZE');
    return { item, cost };
  });
  for (let i = clients.length - 1; i >= 0; i--) {
    const { item, cost } = clients[i];
    if (tokens + cost > RETAIN_TOKENS) break;
    tokens += cost;
    retained.push(item);
  }
  return retained.reverse();
}

async function parseSSE(response, signal) {
  requireValue(response.body && typeof response.body.getReader === 'function', 'SSE_BODY');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, chunks = 0, lineParts = [], skipLF = false, data = [], eventName = '', terminal = false, item, usage;
  let eventCount = 0, doneMarker = false;
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  function dispatch() {
    if (!data.length) { eventName = ''; return; }
    requireValue(++eventCount <= 8192, 'SSE_LIMIT');
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') {
      requireValue(terminal && !doneMarker, 'SSE_TERMINAL');
      doneMarker = true;
      eventName = '';
      return;
    }
    requireValue(!doneMarker, 'SSE_TERMINAL');
    let event;
    try { event = snapshot(JSON.parse(payload)); }
    catch { throw error('SSE_JSON'); }
    requireValue(event && typeof event === 'object' && !Array.isArray(event), 'SSE_JSON');
    requireValue(!eventName || eventName === event.type, 'SSE_EVENT');
    eventName = '';
    requireValue(!['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type) && !event.error, 'SSE_FAILED');
    if (event.type === 'response.completed' || event.type === 'response.done') {
      requireValue(!terminal && event.response && typeof event.response === 'object' && !Array.isArray(event.response) && (!event.response.status || event.response.status === 'completed') && !event.response.error, 'SSE_TERMINAL');
      terminal = true;
      if (event.response?.usage !== undefined) usage = event.response.usage;
    } else {
      requireValue(!terminal, 'SSE_TERMINAL');
      if (event.type === 'response.output_item.done' && event.item?.type === 'compaction') {
        requireValue(!item && typeof event.item.encrypted_content === 'string' && !!event.item.encrypted_content.trim(), 'SSE_COMPACTION');
        item = event.item;
      }
    }
  }
  function line(value) {
    if (value === '') return dispatch();
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    if (field === 'event') eventName = content;
  }
  function consume(chunk) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (skipLF) {
        skipLF = false;
        if (chunk[i] === '\n') { start = i + 1; continue; }
      }
      if (chunk[i] !== '\r' && chunk[i] !== '\n') continue;
      lineParts.push(chunk.slice(start, i));
      line(lineParts.join(''));
      lineParts = [];
      skipLF = chunk[i] === '\r';
      start = i + 1;
    }
    if (start < chunk.length) lineParts.push(chunk.slice(start));
  }
  try {
    while (true) {
      requireValue(!signal.aborted, 'CANCELLED');
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      requireValue(bytes <= MAX_BODY, 'SSE_SIZE');
      requireValue(++chunks <= 65_536, 'SSE_LIMIT');
      consume(decoder.decode(value, { stream: true }));
      // In-memory/malicious readers must not starve timeout and abort timers.
      if (chunks % 256 === 0) await yieldToTimers();
    }
    consume(decoder.decode());
    // An unterminated event is an incomplete stream, even after success.
    requireValue(!lineParts.length && !data.length && !eventName && terminal && item, 'SSE_TERMINAL');
    return { item, ...(usage !== undefined ? { usage } : {}) };
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/**
 * Inject only fetch and auth; production URL is fixed and redirects are refused.
 * identity is a required nonsecret fingerprint pinned by the caller. auth receives
 * {provider,model,signal} and resolves {accessToken,accountId,identity}; credentials
 * are consumed here only and never returned or included in errors. The adapter
 * must decode/validate prior checkpoints using this identity and current exact
 * provider/model BEFORE flattening them to input (raw items carry no provenance).
 * auth must honor signal and avoid external side effects after cancellation.
 * Timeout covers auth, fetch, and complete SSE, even with uncooperative promises.
 * No retry, text fallback, global fetch/auth, DSH import, or mutable input state.
 */
export class NativeTransport {
  #fetch; #auth; #identity; #timeout;
  constructor({ fetch, auth, identity, timeoutMs = 30_000 }) {
    requireValue(typeof fetch === 'function' && typeof auth === 'function' && binding(identity), 'CONFIG');
    requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'CONFIG');
    this.#fetch = fetch;
    this.#auth = auth;
    this.#identity = identity;
    this.#timeout = timeoutMs;
  }

  async compact({ provider, model, input, instructions = '', tools = [], signal } = {}) {
    requireValue(binding(provider) && binding(model), 'INVALID_BINDING');
    requireValue(Array.isArray(input) && input.length > 0 && input.length <= MAX_ITEMS && Array.isArray(tools) && tools.length <= MAX_ITEMS && typeof instructions === 'string', 'INVALID_INPUT');
    requireValue(!signal?.aborted, 'CANCELLED');
    const source = snapshot(input);
    requireValue(source.every(item => item && typeof item === 'object' && !Array.isArray(item) && item.type !== 'compaction_trigger'), 'INVALID_INPUT');
    checkModalities(source);
    const retained = retainedInput(source);
    const body = JSON.stringify(snapshot({ model, instructions, tools, input: [...source, { type: 'compaction_trigger' }], store: false, stream: true, include: ['reasoning.encrypted_content'] }));
    const controller = new AbortController();
    let timeout = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timeout = true; abort(); }, this.#timeout);
    let onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(error(timeout ? 'TIMEOUT' : 'CANCELLED'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const run = async () => {
      const auth = await this.#auth({ provider, model, signal: controller.signal });
      requireValue(!controller.signal.aborted, 'CANCELLED');
      requireValue(auth && binding(auth.identity) && auth.identity === this.#identity, 'IDENTITY_MISMATCH');
      requireValue(typeof auth.accessToken === 'string' && !!auth.accessToken && typeof auth.accountId === 'string' && !!auth.accountId && !/[\r\n]/.test(auth.accessToken + auth.accountId), 'AUTH_INVALID');
      const response = await this.#fetch(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${auth.accessToken}`, 'ChatGPT-Account-ID': auth.accountId, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'OpenAI-Beta': 'responses=experimental', originator: 'dsh-codex-compaction' }, body,
      });
      if (controller.signal.aborted) {
        Promise.resolve(response.body?.cancel()).catch(() => {});
        throw error('CANCELLED');
      }
      if (!response.ok) {
        Promise.resolve(response.body?.cancel()).catch(() => {});
        throw error('HTTP_ERROR'); // Never read or reflect the error body/status text.
      }
      if (response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
        Promise.resolve(response.body?.cancel()).catch(() => {});
        throw error('SSE_CONTENT_TYPE');
      }
      const result = await parseSSE(response, controller.signal);
      requireValue(!controller.signal.aborted, 'CANCELLED');
      const items = [...retained, result.item];
      // Apply exactly the persistence limits before reporting native success.
      encodeCheckpoint({ provider, model, identity: this.#identity, items });
      return { items, identity: this.#identity, ...(result.usage !== undefined ? { usage: result.usage } : {}) };
    };
    try { return await Promise.race([run(), stopped]); }
    catch (cause) {
      // Never propagate external Error messages, causes, headers, or bodies.
      const allowed = new Set(['CANCELLED', 'TIMEOUT', 'IDENTITY_MISMATCH', 'AUTH_INVALID', 'HTTP_ERROR', 'SSE_BODY', 'SSE_LIMIT', 'SSE_JSON', 'SSE_EVENT', 'SSE_FAILED', 'SSE_TERMINAL', 'SSE_COMPACTION', 'SSE_SIZE', 'SSE_CONTENT_TYPE', 'CHECKPOINT_SIZE', 'CHECKPOINT_DEPTH', 'CHECKPOINT_ITEMS', 'CHECKPOINT_COMPACTION']);
      throw error(controller.signal.aborted ? (timeout ? 'TIMEOUT' : 'CANCELLED') : allowed.has(cause?.code) ? cause.code : 'TRANSPORT_ERROR');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
