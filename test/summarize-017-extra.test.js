import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { engineFixture } from './helpers/engine.js';
import { fakeAttachments, imageBlock } from './helpers/images.js';
const image = () => createUserMessage({ source: { kind: 'user' }, content: [imageBlock()] });
const carrier = text => createUserMessage({ source: compactCheckpointSource('image-test'), content: [{ type: 'text', text }] });

test('image-only history stays on super; mixed native state uses same-owner reader-text', async t => {
  const f = await engineFixture(t); f.enable();
  assert.equal((await f.summarize([image()])).llmStreamCall, true);
  assert.equal(f.fake.opened, 0);
  const envelope = (await f.summarize()).summary[0].text;
  const attachments = fakeAttachments();
  f.ctx.provide('attachments', attachments);
  f.ctx.provide('fs', { processPathFromHostPath: x => x });
  const result = await f.summarize([carrier(envelope), image()]);
  assert.equal(result.summary[0].text, 'fixture continued');
  assert.equal(Object.hasOwn(result, 'llmStreamCall'), false);
  assert.equal(f.fake.calls.at(-1).mode, 'stream');
  assert.equal(f.fake.calls.at(-1).replay.length, 1);
  assert.equal(attachments.reads.length, 1);
});
test('per-target Basic model policies are honored before choosing native or super', async t => {
  const f = await engineFixture(t, { config: { modelPolicies: [{ provider: 'openai-codex', model: 'gpt-5.4', summarizationProvider: 'foreign', summarizationModel: 'text', maxTokens: 4321 }] } });
  f.enable();
  const result = await f.summarize();
  assert.equal(result.provider, 'foreign'); assert.equal(result.model, 'text'); assert.equal(result.maxTokens, 4321);
  assert.equal(result.llmStreamCall, true); assert.equal(f.fake.calls.length, 0);
});
test('disabled capability does not turn a session preference into native traffic', async t => {
  const f = await engineFixture(t, { capability: false }); f.enable();
  assert.equal((await f.summarize()).llmStreamCall, true);
  assert.equal(f.fake.calls.length, 0);
});
test('existing native carrier never falls back after native transport failure', async t => {
  const f = await engineFixture(t, { runtimeOptions: { fail: 'CODEX_RUNTIME_NETWORK' } }); f.enable();
  const envelope = f.fake.runtime.encodeCheckpoint({ provider: 'codex-native-lab', model: 'gpt-5.4', identity: 'fixture-owner-connection', items: [{ type: 'compaction', encrypted_content: 'synthetic' }] });
  await assert.rejects(f.summarize([carrier(envelope)]));
  assert.deepEqual(f.fake.calls.map(x => x.mode), ['compact']);
});
