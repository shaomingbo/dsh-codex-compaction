import test from 'node:test';
import assert from 'node:assert/strict';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { CodexNativeCompactionEngine } from '../src/compaction.js';
import { NativeSessionState, isRecoverableNativeFailure } from '../src/native-seam.js';
import { commandLogPreferenceRecovery, preferenceFromEvents } from '../src/preference-recovery.js';
import { COMPACTION_INSTRUCTION } from '../src/summary-instruction.js';
import { engineFixture, user } from './helpers/engine.js';
const carrier = text => createUserMessage({ source: compactCheckpointSource('test'), content: [{ type: 'text', text }] });
const drain = async stream => { const a = new BlockAssembler(); for await (const c of stream) a.push(c); return a; };

test('subclass only overrides summarize; official trigger, transaction and meter remain inherited', () => {
  assert.deepEqual(Object.getOwnPropertyNames(CodexNativeCompactionEngine.prototype), ['constructor', 'summarize']);
  for (const method of ['compactIfNeeded', 'compactNow', 'compactRegion']) assert.equal(CodexNativeCompactionEngine.prototype[method], BasicCompactionEngine.prototype[method]);
});
test('capability enabled is not preference enabled: off uses real super and exactly one host stream', async t => {
  const f = await engineFixture(t);
  const result = await f.summarize();
  assert.equal(result.summary[0].text, 'host summary');
  assert.equal(result.llmStreamCall, true);
  assert.equal(f.fake.opened, 0);
  assert.equal(f.hostCalls.length, 1);
  assert.equal(f.hostCalls[0].messages.at(-1).source, undefined);
  assert.equal(f.hostCalls[0].messages.at(-1).content[0].text, COMPACTION_INSTRUCTION);
});
test('native returns unmarked SummaryResult with observed receipt, no appended instruction', async t => {
  const usage = { inputTokens: 123, outputTokens: 4, totalTokens: 127 };
  const f = await engineFixture(t, { runtimeOptions: { receipt: { kind: 'observed', usage } } });
  f.enable();
  const result = await f.summarize();
  assert.match(result.summary[0].text, /^<dsh-codex-compaction-v1>/);
  assert.equal(Object.hasOwn(result, 'llmStreamCall'), false);
  assert.deepEqual(result.usage, usage);
  assert.equal(f.fake.calls.length, 1);
  assert.equal(f.fake.calls[0].mode, 'compact');
  assert.equal(JSON.stringify(f.fake.calls[0].context).includes(COMPACTION_INSTRUCTION), false);
  assert.equal(f.fake.closed, 1);
  assert.equal(f.hostCalls.length, 0);
});
test('unavailable native receipt omits usage instead of fabricating zero', async t => {
  const f = await engineFixture(t); f.enable();
  assert.equal(Object.hasOwn(await f.summarize(), 'usage'), false);
});
test('reader-text sends complete instruction and fidelity note once through actual owner converter', async t => {
  const f = await engineFixture(t); f.enable('reader-text');
  const result = await f.summarize();
  assert.equal(result.summary[0].text, 'fixture continued');
  assert.equal(Object.hasOwn(result, 'llmStreamCall'), false);
  assert.equal(f.fake.calls.length, 1);
  assert.equal(f.fake.calls[0].mode, 'stream');
  assert.ok(JSON.stringify(f.fake.calls[0].context).includes('Reader-text fidelity note'));
  const content = f.fake.calls[0].context.messages.at(-1).content;
  assert.ok((typeof content === 'string' ? content : content[0].text).startsWith(COMPACTION_INSTRUCTION));
});
for (const code of ['CODEX_RUNTIME_NOT_READY', 'CODEX_RUNTIME_NETWORK', 'CODEX_RUNTIME_HTTP_503']) {
  test(`${code}: exactly one transparent text fallback uses the original account lease`, async t => {
    const f = await engineFixture(t, { runtimeOptions: { fail: code, failMode: 'once', rotateIdentityOnFailure: 'new-account' } });
    f.enable(); const result = await f.summarize();
    assert.equal(result.summary[0].text, 'fixture continued');
    assert.deepEqual(f.fake.calls.map(c => c.mode), ['compact', 'stream']);
    assert.deepEqual(f.fake.calls.map(c => c.identity), ['fixture-owner-connection', 'fixture-owner-connection']);
    assert.equal(f.fake.opened, 1); assert.equal(f.fake.closed, 1);
  });
}
for (const code of ['CODEX_RUNTIME_HTTP_401', 'CODEX_RUNTIME_RESPONSE_PROTOCOL', 'CODEX_RUNTIME_CANCELLED', 'CODEX_RUNTIME_TIMEOUT']) {
  test(`${code}: failure is closed without fallback`, async t => {
    const f = await engineFixture(t, { runtimeOptions: { fail: code } }); f.enable();
    await assert.rejects(f.summarize());
    assert.equal(f.fake.calls.length, 1); assert.equal(f.fake.closed, 1);
  });
}
test('failed text fallback terminates after two sends, never a retry loop', async t => {
  const f = await engineFixture(t, { runtimeOptions: { fail: 'CODEX_RUNTIME_NETWORK' } }); f.enable();
  await assert.rejects(f.summarize());
  assert.deepEqual(f.fake.calls.map(c => c.mode), ['compact', 'stream']);
});
test('carrier round-trip uses reader middleware even with preference off', async t => {
  const f = await engineFixture(t); f.enable();
  const result = await f.summarize(); f.enable('off');
  await drain(f.ctx.llm.stream({ ...f.agent.options, messages: [carrier(result.summary[0].text), user('continue')] }));
  assert.equal(f.fake.calls.at(-1).replay.length, 1);
  assert.equal(f.hostCalls.length, 0);
  await assert.rejects(f.summarize([carrier(result.summary[0].text)]), { code: 'CODEX_NATIVE_READER_REQUIRED' });
});
test('purpose=compaction from an unrelated caller is never taken over', async t => {
  const f = await engineFixture(t); f.enable();
  await drain(f.ctx.llm.stream({ ...f.agent.options, sessionId: f.session.id, purpose: 'compaction', messages: [user(COMPACTION_INSTRUCTION)] }));
  assert.equal(f.fake.calls.length, 0); assert.equal(f.hostCalls.length, 1);
});
test('malformed carrier fails before network; missing account reader also refuses', async t => {
  const f = await engineFixture(t); f.enable();
  await assert.rejects(f.summarize([carrier('<dsh-codex-compaction-v99>broken')]));
  assert.equal(f.fake.calls.length, 0);
  const g = await engineFixture(t, { withOwner: false }); g.enable();
  await assert.rejects(g.summarize(), { code: 'CODEX_NATIVE_REPLAY_UNAVAILABLE' });
  assert.equal(g.hostCalls.length, 0);
});
test('unknown model/protocol applicability and cancellation never fallback', async t => {
  const f = await engineFixture(t, { runtimeOptions: { applicable: false } }); f.enable();
  await assert.rejects(f.summarize(), { code: 'CODEX_NATIVE_REPLAY_UNAVAILABLE' });
  await assert.rejects(f.summarize(undefined, AbortSignal.abort()));
  assert.equal(f.fake.opened, 0); assert.equal(f.hostCalls.length, 0);
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error(), { code: 'CODEX_RUNTIME_NETWORK', name: 'AbortError' })), false);
});
const command = (id, args, kind = 'success') => [{ type: 'command/run', data: { commandId: id, name: 'codex-native', args } }, { type: 'command/done', data: { commandId: id, kind } }];
test('public async command projection recovers only successful paired preferences', async () => {
  const events = [...command('a', 'on'), ...command('b', 'off', 'error'), ...command('c', 'status'), ...command('d', 'reader-text')];
  const recover = commandLogPreferenceRecovery({ get: name => name === 'sessionQuery' ? { readSession: async () => ({ events }) } : undefined });
  const state = new NativeSessionState(false, recover);
  await state.ready('s');
  assert.equal(state.nativeStatus('s').summarizationMode, 'reader-text');
  assert.equal(preferenceFromEvents([...events, ...command('e', 'inherit')]), 'inherit');
  assert.equal(preferenceFromEvents(command('f', 'off').slice(0, 1)), undefined);
});
test('async recovery racing a live command cannot restore an old preference', async () => {
  const gate = Promise.withResolvers();
  const state = new NativeSessionState(false, () => gate.promise);
  const ready = state.ready('s'); state.setSession('s', 'off'); gate.resolve('on'); await ready;
  assert.equal(state.effective('s'), false);
});
