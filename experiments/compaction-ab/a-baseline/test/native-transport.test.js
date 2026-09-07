import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTransport } from '../native-transport.js';

const binding = { provider: 'experimental-codex', model: 'test-model' };
const credentials = { accessToken: 'FAKE-TOKEN-SENTINEL', accountId: 'FAKE-ACCOUNT-SENTINEL', identity: 'fingerprint-1' };
const opaque = { type: 'compaction', encrypted_content: 'opaque-🔒', future: { b: 2, a: ['🙂', null] } };
const event = (value, eol = '\n') => `data: ${JSON.stringify(value)}${eol}${eol}`;
const itemEvent = (item = opaque) => ({ type: 'response.output_item.done', item });
const terminal = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 4 } } };
const success = event(itemEvent()) + event(terminal);
const input = () => [
  { role: 'developer', content: [{ type: 'input_text', text: 'Keep paths precise.' }], unknown: { b: 1, a: 2 } },
  { role: 'user', content: [{ type: 'input_text', text: 'hello 😀' }] },
  { type: 'reasoning', encrypted_content: 'old-opaque', extra: [1, 2] },
  { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' },
  { type: 'function_call_output', call_id: 'call-1', output: 'fixture' },
];
const request = (extra = {}) => ({ ...binding, input: input(), ...extra });

function response(text = success, chunkSize = Infinity) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) return controller.close();
    const end = Math.min(offset + chunkSize, bytes.length);
    controller.enqueue(bytes.slice(offset, end));
    offset = end;
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function transport(overrides = {}) {
  return new NativeTransport({ fetch: async () => response(), auth: async () => ({ ...credentials }), identity: credentials.identity, ...overrides });
}
const rejects = (promise, code) => assert.rejects(promise, { code });

// All fetch/auth implementations in this file are in-memory fixtures; no DSH,
// credential stores, sockets, package installs, or real network are used.
test('fixed V2 request, opaque ordering, usage and immutable input', async () => {
  let authCalls = 0;
  const source = request({ instructions: 'test instruction', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] });
  const before = JSON.stringify(source);
  const native = transport({
    auth: async (params) => { authCalls++; assert.equal(params.provider, binding.provider); assert.ok(params.signal instanceof AbortSignal); return { ...credentials }; },
    fetch: async (url, options) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, `Bearer ${credentials.accessToken}`);
      assert.equal(options.headers['ChatGPT-Account-ID'], credentials.accountId);
      assert.equal(options.headers['OpenAI-Beta'], 'responses=experimental');
      assert.equal(options.headers.originator, 'dsh-codex-compaction');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.input, [...source.input, { type: 'compaction_trigger' }]);
      assert.equal(body.store, false); assert.equal(body.stream, true);
      assert.deepEqual(body.include, ['reasoning.encrypted_content']);
      assert.deepEqual(body.tools, source.tools); assert.equal(body.instructions, source.instructions);
      return response();
    },
  });
  const result = await native.compact(source);
  assert.equal(authCalls, 1);
  assert.deepEqual(result.items, [...source.input.slice(0, 2), opaque]);
  assert.equal(JSON.stringify(result.items.at(-1)), JSON.stringify(opaque));
  assert.deepEqual(result.usage, terminal.response.usage);
  assert.equal(result.identity, credentials.identity);
  assert.ok(!JSON.stringify(result).includes(credentials.accessToken));
  result.items[0].unknown.b = 99;
  assert.equal(JSON.stringify(source), before);
});

test('SSE handles split UTF-8 bytes, CRLF split, comments and multiline data', async () => {
  const text = ': heartbeat\r\n\r\nevent: response.output_item.done\r\ndata: {"type":"response.output_item.done",\r\ndata: "item":' + JSON.stringify(opaque) + '}\r\n\r\n' + event(terminal, '\r\n') + 'data: [DONE]\r\n\r\n';
  for (const chunkSize of [1, 2, 7, 64]) {
    const result = await transport({ fetch: async () => response(text, chunkSize) }).compact(request());
    assert.deepEqual(result.items.at(-1), opaque);
  }
});

test('SSE rejects failed+completed, missing terminal, multiple/empty item and truncation', async () => {
  const cases = [
    [event({ type: 'response.failed', response: { error: { message: credentials.accessToken } } }) + success, 'SSE_FAILED'],
    [success + event({ type: 'response.failed' }), 'SSE_FAILED'],
    [event(itemEvent()), 'SSE_TERMINAL'],
    [event(itemEvent()) + success, 'SSE_COMPACTION'],
    [event(itemEvent({ type: 'compaction', encrypted_content: ' ' })) + event(terminal), 'SSE_COMPACTION'],
    [event(terminal), 'SSE_TERMINAL'],
    [success.trimEnd(), 'SSE_TERMINAL'],
    [success + event(terminal), 'SSE_TERMINAL'],
    [event(itemEvent()) + event({ type: 'response.completed', response: { status: 'failed' } }), 'SSE_TERMINAL'],
    [event(itemEvent()) + event({ type: 'response.completed' }), 'SSE_TERMINAL'],
    [event(itemEvent()) + event({ type: 'response.completed', response: null }), 'SSE_TERMINAL'],
    [event(itemEvent()) + event({ type: 'response.completed', response: [] }), 'SSE_TERMINAL'],
    ['data: [DONE]\n\n', 'SSE_TERMINAL'],
    ['data: not-json\n\n', 'SSE_JSON'],
    ['event: wrong\n' + success, 'SSE_EVENT'],
  ];
  for (const [text, code] of cases) await rejects(transport({ fetch: async () => response(text, 3) }).compact(request()), code);
});

test('response.done completed terminal is accepted, but failed status is not', async () => {
  const text = event(itemEvent()) + event({ type: 'response.done', response: { status: 'completed' } });
  assert.deepEqual((await transport({ fetch: async () => response(text) }).compact(request())).items.at(-1), opaque);
});

test('identity mismatch rejects before fetch and external errors are redacted', async () => {
  let calls = 0;
  await rejects(transport({ auth: async () => ({ ...credentials, identity: 'different' }), fetch: async () => { calls++; return response(); } }).compact(request()), 'IDENTITY_MISMATCH');
  assert.equal(calls, 0);
  for (const phase of ['auth', 'fetch']) {
    await assert.rejects(transport({ [phase]: async () => { throw new Error(`${credentials.accessToken} ${credentials.accountId}`); } }).compact(request()), e => {
      assert.equal(e.code, 'TRANSPORT_ERROR');
      assert.ok(!e.stack.includes(credentials.accessToken) && !e.stack.includes(credentials.accountId));
      assert.equal(e.cause, undefined);
      return true;
    });
  }
});

test('HTTP errors never read body, reflect status text or retry', async () => {
  let reads = 0, calls = 0, cancelled = 0;
  const native = transport({ fetch: async () => {
    calls++;
    return { ok: false, status: 401, statusText: credentials.accessToken, text: () => { reads++; throw new Error('not allowed'); }, body: { cancel: async () => { cancelled++; } } };
  } });
  await rejects(native.compact(request()), 'HTTP_ERROR');
  assert.equal(reads, 0); assert.equal(calls, 1); assert.equal(cancelled, 1);
});

test('images and unsupported content rejected before auth/fetch', async () => {
  let calls = 0;
  const native = transport({ auth: async () => { calls++; return credentials; }, fetch: async () => { calls++; return response(); } });
  for (const content of [
    [{ type: 'input_image', image_url: 'https://invalid.example/image' }],
    [{ type: 'input_audio', data: 'fixture' }],
    [{ type: 'input_file', file_id: 'fixture' }],
    [{ type: 'future_content', value: 'unsupported' }],
  ]) await assert.rejects(native.compact(request({ input: [{ role: 'user', content }] })));
  assert.equal(calls, 0);
});

test('retains recent complete clients within 64k heuristic, refuses oversized instead of truncating', async () => {
  const clients = [0, 1, 2].map(i => ({ role: 'user', content: [{ type: 'input_text', text: `${i}` + '😀'.repeat(60_000) }] }));
  const result = await transport().compact(request({ input: clients }));
  assert.deepEqual(result.items, [...clients.slice(1), opaque]);
  let calls = 0;
  await rejects(transport({ auth: async () => { calls++; return credentials; } }).compact(request({ input: [{ role: 'user', content: '😀'.repeat(128_001) }] })), 'RETENTION_SIZE');
  assert.equal(calls, 0);
});

test('request byte/depth/item/prototype limits reject before auth', async () => {
  let calls = 0;
  const native = transport({ auth: async () => { calls++; return credentials; } });
  await rejects(native.compact(request({ instructions: 'x'.repeat(4 * 1024 * 1024 + 1) })), 'BODY_SIZE');
  await rejects(native.compact(request({ input: Array(1025).fill({ type: 'reasoning' }) })), 'INVALID_INPUT');
  let nested = 'x'; for (let i = 0; i < 34; i++) nested = { nested };
  await rejects(native.compact(request({ input: [{ type: 'reasoning', nested }] })), 'JSON_LIMIT');
  await rejects(native.compact(request({ input: [JSON.parse('{"type":"reasoning","__proto__":{}}')] })), 'UNSAFE_JSON_KEY');
  assert.equal(calls, 0);
});

test('SSE byte/depth/prototype bounds and UTF-8 validation', async () => {
  await rejects(transport({ fetch: async () => response(':' + 'x'.repeat(4 * 1024 * 1024)) }).compact(request()), 'SSE_SIZE');
  let nested = 'x'; for (let i = 0; i < 34; i++) nested = { nested };
  await rejects(transport({ fetch: async () => response(event({ type: 'unknown', nested })) }).compact(request()), 'SSE_JSON');
  await rejects(transport({ fetch: async () => response('data: {"type":"unknown","constructor":{}}\n\n') }).compact(request()), 'SSE_JSON');
  await rejects(transport({ fetch: async () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'text/event-stream' } }) }).compact(request()), 'TRANSPORT_ERROR');
});

test('abort before start does not authenticate; in-flight auth/fetch/body cancellation finishes', async () => {
  const already = new AbortController(); already.abort(credentials.accessToken);
  let calls = 0;
  await rejects(transport({ auth: async () => { calls++; return credentials; } }).compact(request({ signal: already.signal })), 'CANCELLED');
  assert.equal(calls, 0);
  for (const phase of ['auth', 'fetch', 'body']) {
    const controller = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    let cancelled = false;
    const overrides = phase === 'body' ? { fetch: async () => new Response(new ReadableStream({ start() { started(); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) }
      : { [phase]: async () => { started(); return new Promise(() => {}); } };
    const pending = transport(overrides).compact(request({ signal: controller.signal }));
    await ready;
    // A microtask lets parseSSE attach its reader for the body case.
    await Promise.resolve();
    controller.abort(credentials.accessToken);
    await rejects(pending, 'CANCELLED');
    if (phase === 'body') assert.equal(cancelled, true);
  }
});

test('rejects non-SSE content, oversized persisted output and reader errors safely', async () => {
  await rejects(transport({ fetch: async () => new Response(credentials.accessToken) }).compact(request()), 'SSE_CONTENT_TYPE');
  const text = event(itemEvent({ type: 'compaction', encrypted_content: 'x'.repeat(512 * 1024) })) + event(terminal);
  await rejects(transport({ fetch: async () => response(text, 4096) }).compact(request()), 'CHECKPOINT_SIZE');
  await assert.rejects(transport({ fetch: async () => new Response(new ReadableStream({ pull(controller) {
    controller.error(new Error(credentials.accessToken + credentials.accountId));
  } }), { headers: { 'content-type': 'text/event-stream' } }) }).compact(request()), e => {
    assert.equal(e.code, 'TRANSPORT_ERROR');
    assert.ok(!e.stack.includes(credentials.accessToken) && !e.stack.includes(credentials.accountId));
    return true;
  });
});

test('continuously ready SSE readers cannot starve cancellation', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const native = transport({ fetch: async () => new Response(new ReadableStream({
    pull(stream) { stream.enqueue(new TextEncoder().encode(': heartbeat\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  setImmediate(() => controller.abort());
  await rejects(native.compact(request({ signal: controller.signal })), 'CANCELLED');
  assert.equal(cancelled, true);
});

test('auth resolving after cancellation never starts fetch', async () => {
  let resolveAuth, fetchCalls = 0;
  const controller = new AbortController();
  const native = transport({ auth: () => new Promise(resolve => { resolveAuth = resolve; }), fetch: async () => { fetchCalls++; return response(); } });
  const pending = native.compact(request({ signal: controller.signal }));
  controller.abort();
  await rejects(pending, 'CANCELLED');
  resolveAuth(credentials);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchCalls, 0);
});

test('finite timeout includes uncooperative auth, fetch and body', async () => {
  for (const phase of ['auth', 'fetch', 'body']) {
    const overrides = phase === 'body' ? { fetch: async () => new Response(new ReadableStream({}), { headers: { 'content-type': 'text/event-stream' } }) }
      : { [phase]: async () => new Promise(() => {}) };
    await rejects(transport({ ...overrides, timeoutMs: 10 }).compact(request()), 'TIMEOUT');
  }
  for (const timeoutMs of [0, Infinity, -1, 120001]) assert.throws(() => transport({ timeoutMs }), { code: 'CONFIG' });
});
