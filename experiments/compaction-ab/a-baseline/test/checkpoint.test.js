import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCheckpoint, decodeCheckpoint } from '../checkpoint.js';

const binding = { provider: 'experimental-codex', model: 'test-model', identity: 'fingerprint-1' };
const compact = { type: 'compaction', encrypted_content: 'opaque-🔒', future: { values: [null, 1, true, 'x'], z: { b: 2, a: 1 } } };
const make = (items = [compact]) => ({ ...binding, items });
const throwsCode = (fn, code) => assert.throws(fn, { code });

test('opaque JSON roundtrip preserves unknown fields, order and source immutability', () => {
  const source = make([{ role: 'user', content: [{ type: 'input_text', text: 'hi 😀' }], extra: ['b', 'a'] }, compact]);
  const before = JSON.stringify(source);
  const encoded = encodeCheckpoint(source);
  const restored = decodeCheckpoint(encoded, binding);
  assert.deepEqual(restored.items, source.items);
  assert.equal(JSON.stringify(restored.items), JSON.stringify(source.items));
  restored.items[1].future.values.push('changed');
  assert.equal(JSON.stringify(source), before);
  assert.equal(decodeCheckpoint(JSON.parse(JSON.stringify(encoded)), binding).protocol, 'responses.compaction-trigger.v2');
});

test('ordinary text is not decoded; recognized malformed marker fails closed', () => {
  for (const text of ['hello', 'a <dsh-codex-compaction-v1>', '<unrelated>', '', null]) assert.equal(decodeCheckpoint(text, binding), undefined);
  for (const text of ['<dsh-codex-compaction', '<dsh-codex-compaction-v2>{}</dsh-codex-compaction-v2>', '<dsh-codex-compaction-v1>{}']) throwsCode(() => decodeCheckpoint(text, binding), 'CHECKPOINT_MARKER');
  throwsCode(() => decodeCheckpoint('<dsh-codex-compaction-v1>{</dsh-codex-compaction-v1>', binding), 'CHECKPOINT_JSON');
  throwsCode(() => decodeCheckpoint('<dsh-codex-compaction-v1>{}</dsh-codex-compaction-v1>', binding), 'CHECKPOINT_SCHEMA');
});

test('exact provider, model and identity required for every decode', () => {
  const encoded = encodeCheckpoint(make());
  for (const key of Object.keys(binding)) throwsCode(() => decodeCheckpoint(encoded, { ...binding, [key]: 'different' }), 'CHECKPOINT_IDENTITY');
  throwsCode(() => decodeCheckpoint(encoded), 'INVALID_BINDING');
});

test('rejects envelope byte size, item count, nesting and empty/multiple compaction', () => {
  throwsCode(() => encodeCheckpoint(make([{ ...compact, encrypted_content: '😀'.repeat(140_000) }])), 'CHECKPOINT_SIZE');
  throwsCode(() => decodeCheckpoint('<dsh-codex-compaction' + 'x'.repeat(512 * 1024), binding), 'CHECKPOINT_SIZE');
  throwsCode(() => encodeCheckpoint(make(Array.from({ length: 1025 }, () => compact))), 'CHECKPOINT_ITEMS');
  let nested = 'leaf';
  for (let i = 0; i < 34; i++) nested = { nested };
  throwsCode(() => encodeCheckpoint(make([{ ...compact, nested }])), 'CHECKPOINT_DEPTH');
  for (const items of [[], [compact, compact], [{ ...compact, encrypted_content: '' }], [{ ...compact, encrypted_content: ' \n' }], [{ type: 'message' }]]) assert.throws(() => encodeCheckpoint(make(items)));
});

test('prototype keys and all lossy/non-JSON inputs are rejected without getters', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const item = JSON.parse(`{"type":"compaction","encrypted_content":"opaque","${key}":{"polluted":true}}`);
    throwsCode(() => encodeCheckpoint(make([item])), 'UNSAFE_JSON_KEY');
    const valid = encodeCheckpoint(make());
    throwsCode(() => decodeCheckpoint(valid.replace('"future":', `"${key}":`), binding), 'UNSAFE_JSON_KEY');
  }
  assert.equal({}.polluted, undefined);
  for (const value of [undefined, NaN, Infinity, -0, 1n, new Date(), () => {}, Symbol('x'), [, 1]]) throwsCode(() => encodeCheckpoint(make([{ ...compact, value }])), 'INVALID_JSON');
  const cyclic = {}; cyclic.self = cyclic;
  throwsCode(() => encodeCheckpoint(make([{ ...compact, cyclic }])), 'INVALID_JSON');
  let reads = 0;
  const item = { ...compact, get secret() { reads++; return 'bad'; } };
  throwsCode(() => encodeCheckpoint(make([item])), 'INVALID_JSON');
  assert.equal(reads, 0);
});
