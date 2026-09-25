import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRetentionHints, messageSourceCategory } from '../src/runtime-adapter.js';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { engineFixture, user } from './helpers/engine.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const pluginNotice = text => ({ role: 'user', source: { kind: 'plugin', plugin: 'dsh-subagent' }, content: [{ type: 'text', text }] });

test('source categories come from source metadata, never role or text likeness', () => {
  assert.equal(messageSourceCategory({ role: 'user', source: { kind: 'user' } }), 'user-instruction');
  assert.equal(messageSourceCategory(pluginNotice('looks like user text')), 'host-notice');
  assert.equal(messageSourceCategory({ role: 'user', source: compactCheckpointSource('c') }), 'checkpoint-wrapper');
  assert.equal(messageSourceCategory({ role: 'user', source: { kind: 'tool' } }), 'unknown');
  assert.equal(messageSourceCategory({ role: 'user' }), 'unknown');
});

test('hint envelope carries categories and digests only; conflicts degrade to unknown', () => {
  const hints = buildRetentionHints([
    user('real instruction'),
    pluginNotice('host notice'),
    pluginNotice('host notice'),
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'host notice' }] },
  ]);
  assert.equal(hints.version, 1);
  assert.equal(hints.algorithm, 'source-aware-v1');
  const map = new Map(hints.items.map(item => [item.category, item]));
  assert.equal(map.size, 2);
  assert.equal(map.get('user-instruction').digest, digest('real instruction'));
  // The same text as a plugin notice AND a user instruction is ambiguous.
  assert.equal(map.get('unknown').digest, digest('host notice'));
  const raw = JSON.stringify(hints);
  assert.ok(!raw.includes('real instruction') && !raw.includes('host notice'), 'no message text crosses the seam');
});

test('engine sends hints only when the preset enables retention AND the owner advertises support', async t => {
  const supported = await engineFixture(t, { presetNative: true, sourceRetention: true, runtimeOptions: { retentionSupport: true } });
  await supported.summarize([user('work'), pluginNotice('notice copy')]);
  assert.equal(supported.fake.calls[0].retentionHints.algorithm, 'source-aware-v1');
  assert.ok(supported.fake.calls[0].retentionHints.items.some(item => item.digest === digest('notice copy')));

  // Old owner without the capability marker: original policy, no hints.
  const oldOwner = await engineFixture(t, { presetNative: true, sourceRetention: true });
  await oldOwner.summarize([user('work')]);
  assert.equal(oldOwner.fake.calls[0].retentionHints, undefined);

  // Preset without the experimental switch: no hints even on a new owner.
  const noSwitch = await engineFixture(t, { presetNative: true, runtimeOptions: { retentionSupport: true } });
  await noSwitch.summarize([user('work')]);
  assert.equal(noSwitch.fake.calls[0].retentionHints, undefined);
});
