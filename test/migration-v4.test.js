import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFormatV3ToV4 } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { OwnerBoundCodexAdapter } from '../src/runtime-adapter.js';
import { fakeRuntime } from './helpers/fake-runtime.js';

test('official V3 migration lifts tool-role results; legacy owner carrier remains readable (synthetic replay MRV)', async () => {
  const fake = fakeRuntime();
  const binding = { provider: 'codex-native-lab', model: 'gpt-5.4', identity: 'fixture-owner-connection' };
  const envelope = fake.runtime.encodeCheckpoint({ ...binding, items: [{ type: 'compaction', encrypted_content: 'synthetic-only' }] });
  const header = { version: 3, id: 'synthetic-v3', createdAt: 0, isSeeded: false, delegationDepth: 0 };
  const migration = createSessionFormatV3ToV4([]);
  const stage = migration.createStage({ sourceHeader: header, targetHeader: migration.migrateHeader(header), sourceInheritedEventCount: 0, sourceKind: 'decoded' });
  const output = [];
  const context = { emitEvent: e => output.push(e), emitRun: run => output.push(...run.expand()) };
  const messages = [
    { id: 'native', role: 'user', source: { kind: 'plugin', plugin: 'compact', compactionId: 'synthetic-compact' }, content: [{ type: 'text', text: envelope }] },
    { id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'codex-native-lab', model: 'gpt-5.4' }, content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }] },
    { id: 'result', role: 'user', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'tool-result', toolCallId: 'call', isError: true, content: [{ type: 'text', text: 'synthetic tool failure' }] }] },
  ];
  const events = [
    { type: 'user/message', data: messages[0], surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: messages[1] }, surfaceOp: 'append' },
    { type: 'tool/result', data: { turn: 1, step: 1, message: messages[2] }, surfaceOp: 'append' },
  ];
  events.forEach((event, seq) => stage.transformEvent({ ...event, seq, time: 0 }, context));
  assert.equal(stage.finish(context), 0);
  assert.deepEqual(output[0].data.source, compactCheckpointSource('synthetic-compact'));
  const tool = output[2].data.message;
  assert.equal(tool.role, 'tool'); assert.equal(tool.toolCallId, 'call'); assert.equal(tool.isError, true);
  assert.deepEqual(tool.content, [{ type: 'text', text: 'synthetic tool failure' }]);
  const adapter = new OwnerBoundCodexAdapter(() => fake.runtime);
  const result = await adapter.compact({ provider: 'codex-native-lab', model: 'gpt-5.4', messages: [output[0].data, output[1].data.message, tool] });
  assert.equal(result.checkpoint.identity, binding.identity);
  assert.equal(fake.calls[0].replay.length, 1);
  assert.equal(fake.calls[0].context.messages.at(-1).role, 'toolResult');
  assert.equal(fake.calls[0].context.messages.at(-1).isError, true);
});
