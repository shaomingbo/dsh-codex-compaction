// Compact-path history normalization. Official Basic still owns selection and
// tool-pairing cuts; this only prevents an already-selected native compact
// request from dropping usable completed work or wrapping the whole transcript
// because one assistant turn finished as error/aborted.
import { failure, ROUTE, NATIVE_PROVIDER } from './constants.js';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from './engine-host.js';

/** Boundary checks always delegate to the public V4 host implementation. */
export function assertCompactionBoundaries(session, start, end) {
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
    throw unsafe('Compaction boundary splits a tool call/result pair.');
  }
}

const ERROR_STOPS = new Set(['error', 'aborted']);
const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);
const REPLAY_BLOCK = { text: 'text', reasoning: 'reasoning', 'tool-call': 'tool-call' };

/** Top-level pairing only. Nested tool-result content is payload, not another call/result. */
function toolIds(message, type, idKey) {
  const ids = [];
  for (const block of message?.content ?? []) {
    if (block?.type === type && typeof block[idKey] === 'string' && block[idKey]) ids.push(block[idKey]);
  }
  return ids;
}

function incompatible(detail) {
  return failure('CODEX_NATIVE_REPLAY_INCOMPATIBLE', `Native compact history replay is not a supported pi-ai envelope (${detail}).`);
}

function unsafe(message) {
  return failure('CODEX_NATIVE_UNSAFE_HISTORY', message);
}

/** Same mapping prepareHistory applies before Pi replay: lab route → native provider. */
export function remapLegacyCompactSource(source) {
  if (source?.kind === 'model' && source.provider === ROUTE) return { ...source, provider: NATIVE_PROVIDER };
  return source;
}

export function remapLegacyCompactMessage(message) {
  const source = remapLegacyCompactSource(message?.source);
  return source === message?.source ? message : { ...message, source };
}

/**
 * Replay must be a supported, source-aligned pi-ai v2 envelope before any
 * error/aborted sanitization. Invalid metadata stays fail-closed instead of
 * being stripped into a foreign assistant.
 */
export function assertSupportedReplay(message) {
  const raw = message?.source?.replayState;
  if (raw === undefined) return { present: false };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw incompatible('envelope');
  const response = raw.response;
  if (typeof response !== 'object' || response === null || Array.isArray(response)) throw incompatible('response');
  if (response.kind !== 'pi-ai') throw incompatible('kind');
  if (response.version !== 2) throw incompatible('version');
  for (const key of ['api', 'provider', 'model']) {
    if (typeof response[key] !== 'string' || !response[key]) throw incompatible(key);
  }
  if (!STOP_REASONS.has(response.stopReason)) throw incompatible('stopReason');
  if (response.responseModel !== undefined && typeof response.responseModel !== 'string') throw incompatible('responseModel');
  if (response.responseId !== undefined && typeof response.responseId !== 'string') throw incompatible('responseId');
  const source = remapLegacyCompactSource(message.source);
  if (source?.kind !== 'model' || response.provider !== source.provider || response.model !== source.model) {
    throw incompatible('source');
  }
  const blocks = raw.blocks;
  const content = message.content ?? [];
  if (!Array.isArray(blocks) || blocks.length !== content.length) throw incompatible('blocks');
  for (const [index, block] of blocks.entries()) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) throw incompatible(`block ${index}`);
    const expected = REPLAY_BLOCK[content[index]?.type];
    if (expected === undefined || block.type !== expected) throw incompatible(`block ${index} type`);
    for (const signature of ['textSignature', 'thinkingSignature', 'thoughtSignature']) {
      if (block[signature] !== undefined && typeof block[signature] !== 'string') throw incompatible(`block ${index} ${signature}`);
    }
    if (block.redacted !== undefined && typeof block.redacted !== 'boolean') throw incompatible(`block ${index} redacted`);
  }
  return { present: true, stopReason: response.stopReason };
}

/** Durable pi-ai stopReason, if the assistant carries a same-adapter replay envelope. */
export function assistantStopReason(message) {
  const reason = message?.source?.replayState?.response?.stopReason;
  return typeof reason === 'string' ? reason : undefined;
}

/** Call/result ids must match 1:1 in order, with no interrupting user/assistant text. */
export function assertToolPairingOrder(messages) {
  const unmatched = [];
  const seenCalls = new Set();
  const seenResults = new Set();
  for (const message of messages) {
    const calls = toolIds(message, 'tool-call', 'id');
    const results = message?.role === 'tool' && typeof message.toolCallId === 'string' ? [message.toolCallId] : [];
    if (calls.length && results.length) throw unsafe('A message cannot mix tool calls and tool results.');
    if (results.length) {
      for (const id of results) {
        if (seenResults.has(id)) throw unsafe('Duplicate tool result.');
        const index = unmatched.indexOf(id);
        if (index === -1) throw unsafe('Tool results are not paired with a surviving tool call.');
        unmatched.splice(index, 1);
        seenResults.add(id);
      }
      continue;
    }
    if (calls.length) {
      if (unmatched.length) throw unsafe('An assistant tool call interrupted unmatched tool calls from a previous turn.');
      for (const id of calls) {
        if (seenCalls.has(id)) throw unsafe('Duplicate tool call.');
        seenCalls.add(id);
        unmatched.push(id);
      }
      continue;
    }
    if (unmatched.length) throw unsafe('A user or assistant message interrupted an unmatched tool call.');
  }
  if (unmatched.length) throw unsafe('Tool calls are not paired with a result; refusing to invent a successful tool outcome.');
}

/**
 * Keep completed text/tool work from error/aborted assistant turns, drop
 * unpaired tool calls, and strip the error replay envelope so the owner
 * converter cannot skip the whole turn. Never invents a successful tool
 * result and never concatenates the transcript into one user message.
 */
export function sanitizeCompactHistory(messages) {
  if (!Array.isArray(messages)) throw unsafe('Compact history must be a message list.');
  if (messages.some(message => (message.content ?? []).some(block => block.type === 'tool-result'))) {
    throw unsafe('V3 tool-result wrappers require official migration before compacting V4 history.');
  }
  messages = messages.map(remapLegacyCompactMessage);
  const completed = new Set();
  for (const message of messages) {
    if (message?.role === 'tool' && typeof message.toolCallId === 'string') completed.add(message.toolCallId);
  }
  const out = [];
  for (const message of messages) {
    if (message?.role !== 'assistant') {
      out.push(message);
      continue;
    }
    const replay = assertSupportedReplay(message);
    if (!replay.present || !ERROR_STOPS.has(replay.stopReason)) {
      out.push(message);
      continue;
    }
    const kept = [];
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length) {
        kept.push({ type: 'text', text: block.text });
        continue;
      }
      if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.length) {
        kept.push({ type: 'reasoning', text: block.text });
        continue;
      }
      if (block?.type === 'tool-call' && typeof block.id === 'string' && completed.has(block.id)) {
        kept.push(block);
        continue;
      }
      if (block?.type === 'tool-call') continue;
      if (block?.type === 'image') throw unsafe('Aborted compact history cannot carry assistant image blocks.');
      if (block != null && block.type !== 'text' && block.type !== 'reasoning') {
        throw unsafe('Aborted assistant history contains a block that cannot be converted safely.');
      }
    }
    if (!kept.length) continue;
    const next = structuredClone({ ...message, content: kept, source: { ...message.source } });
    if (next.source && Object.prototype.hasOwnProperty.call(next.source, 'replayState')) delete next.source.replayState;
    out.push(next);
  }
  assertToolPairingOrder(out);
  return out;
}
