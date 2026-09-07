// Archived A baseline: preserve pre-B production behavior for the A/B experiment.
/**
 * Versioned opaque checkpoint codec (not an authenticity/provenance check).
 * The DSH adapter MUST authorize the message's compact source before decoding;
 * never scan arbitrary user/tool text. Pass the current exact provider/model and
 * a nonsecret account/workspace identity fingerprint on every replay, including
 * continuation. Never pass tokens or raw account identifiers as identity.
 * Unknown JSON fields and array order are preserved; unsafe/non-JSON values are
 * rejected rather than normalized. Returned objects are independent snapshots.
 */
const PREFIX = '<dsh-codex-compaction';
const OPEN = '<dsh-codex-compaction-v1>';
const CLOSE = '</dsh-codex-compaction-v1>';
const PROTOCOL = 'responses.compaction-trigger.v2';
const MAX_BYTES = 512 * 1024;
const MAX_DEPTH = 32;
const MAX_ITEMS = 1024;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function fail(code) {
  const error = new Error(`Native checkpoint: ${code}`);
  error.code = code;
  throw error;
}

function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) fail('INVALID_BINDING');
}

function jsonTree(value, depth = 0, seen = new Set(), budget = { nodes: 0, bytes: 0 }) {
  if (depth > MAX_DEPTH) fail('CHECKPOINT_DEPTH');
  if (++budget.nodes > 50_000) fail('CHECKPOINT_SIZE');
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > MAX_BYTES) fail('CHECKPOINT_SIZE');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (typeof value !== 'object' || seen.has(value)) fail('INVALID_JSON');
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('INVALID_JSON');
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 50_000) fail('CHECKPOINT_SIZE');
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || forbidden.has(key)) fail('UNSAFE_JSON_KEY');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !('value' in descriptor)) fail('INVALID_JSON');
    if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail('INVALID_JSON');
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > MAX_BYTES) fail('CHECKPOINT_SIZE');
    jsonTree(descriptor.value, depth + 1, seen, budget);
  }
  if (Array.isArray(value) && keys.length !== value.length + 1) fail('INVALID_JSON');
  seen.delete(value);
}

function validate(value) {
  jsonTree(value);
  if (!value || Array.isArray(value) || value.version !== 1 || value.protocol !== PROTOCOL) fail('CHECKPOINT_SCHEMA');
  for (const key of ['provider', 'model', 'identity']) label(value[key]);
  if (!Array.isArray(value.items) || !value.items.length || value.items.length > MAX_ITEMS) fail('CHECKPOINT_ITEMS');
  let compactions = 0;
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('CHECKPOINT_ITEMS');
    if (item.type === 'compaction') {
      compactions++;
      if (typeof item.encrypted_content !== 'string' || !item.encrypted_content.trim()) fail('CHECKPOINT_COMPACTION');
    }
  }
  if (compactions !== 1) fail('CHECKPOINT_COMPACTION');
}

export function encodeCheckpoint({ provider, model, identity, items }) {
  const value = { version: 1, protocol: PROTOCOL, provider, model, identity, items };
  validate(value);
  const text = OPEN + JSON.stringify(value) + CLOSE;
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('CHECKPOINT_SIZE');
  return text;
}

export function decodeCheckpoint(text, expected) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return undefined;
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('CHECKPOINT_SIZE');
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) fail('CHECKPOINT_MARKER');
  let value;
  try { value = JSON.parse(text.slice(OPEN.length, -CLOSE.length)); }
  catch { fail('CHECKPOINT_JSON'); }
  validate(value);
  for (const key of ['provider', 'model', 'identity']) {
    label(expected?.[key]);
    if (value[key] !== expected[key]) fail('CHECKPOINT_IDENTITY');
  }
  return value;
}
