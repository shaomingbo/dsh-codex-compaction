import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeSessionState, NativeCompactionSeam } from '../src/native-seam.js';
import { CodexNativeCompactionEngine } from '../src/compaction.js';
import { BASIC_INSTRUCTION_FIRST_LINE } from '../src/native-checkpoint.js';
import { CompactionRecovery, recoveryDelay } from '../src/recovery.js';

const request = (sessionId = 's', model = 'm') => ({ provider: 'openai-codex', model, sessionId, purpose: 'compaction', messages: [
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }] },
  { role: 'user', source: { kind: 'plugin', plugin: 'dsh-compaction-basic' }, content: [{ type: 'text', text: BASIC_INSTRUCTION_FIRST_LINE }] },
] });
const failure = code => Object.assign(new Error(code), { code });
const drain = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
function fixture({ failures = [], fallbackFailure, clock = () => Date.now() } = {}) {
  let opens = 0, native = 0, fallback = 0, closed = 0;
  const state = new NativeSessionState(true, undefined, { now: clock, delay: async () => {} });
  const seam = { adapter: {
    async seamLease() { opens++; return { close() { closed++; } }; },
    async seamCompactOnLease() { const code = failures[native++]; if (code) throw failure(code); return { envelope: 'synthetic summary' }; },
    async *seamStreamOnLease() {
      fallback++; if (fallbackFailure) throw failure(fallbackFailure);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'fallback' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fallback' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  } };
  const engine = { config: { modelPolicies: [], summarizationProvider: '', maxTokens: 100 }, ctx: {
    // This fixture stands in for the codex-native-b preset: the official
    // registry seam (agentPresets.serviceFor) resolves its codexNativePolicy.
    get: name => (name === 'agentPresets'
      ? { serviceFor: (_agent, service) => (service === 'codexNativePolicy' ? { presetNativeDefault: () => true } : undefined) }
      : undefined),
    codexBridge: { nativeState: state, adapter: seam.adapter, nativeApplicability: async () => ({ applicable: true }) },
  } };
  return { state, seam, run: (r = request()) => CodexNativeCompactionEngine.prototype.summarize.call(engine,
    { messages: r.messages.slice(0, -1) }, { session: { id: r.sessionId, requestHeader: () => ({ config: { provider: r.provider, model: r.model } }) } }, r.signal),
    counts: () => ({ opens, native, fallback, closed }) };
}

test('expired lease timeout is preserved without any fallback', async () => {
  const f = fixture({ failures: ['CODEX_RUNTIME_TIMEOUT'] });
  await assert.rejects(f.run(), { code: 'CODEX_RUNTIME_TIMEOUT' });
  assert.deepEqual(f.counts(), { opens: 1, native: 1, fallback: 0, closed: 1 });
  assert.equal(f.state.lastAttempt('s').outcome, 'failed');
});

test('transient failure uses one text fallback and no native retry', async () => {
  const f = fixture({ failures: ['CODEX_RUNTIME_HTTP_503'] });
  await f.run();
  assert.deepEqual(f.counts(), { opens: 1, native: 1, fallback: 1, closed: 1 });
});

test('native failure and failed fallback cannot stack into a third request', async () => {
  const f = fixture({ failures: ['CODEX_RUNTIME_NETWORK'], fallbackFailure: 'CODEX_RUNTIME_HTTP_503' });
  await assert.rejects(f.run(), { code: 'CODEX_RUNTIME_HTTP_503' });
  assert.deepEqual(f.counts(), { opens: 1, native: 1, fallback: 1, closed: 1 });
});

test('fallback records actual failure rather than successful output', async () => {
  const f = fixture({ failures: ['CODEX_RUNTIME_NOT_READY'], fallbackFailure: 'CODEX_RUNTIME_TIMEOUT' });
  await assert.rejects(f.run(), { code: 'CODEX_RUNTIME_TIMEOUT' });
  assert.equal(f.state.lastAttempt('s').outcome, 'failed');
  assert.equal(f.state.lastAttempt('s').cause, 'CODEX_RUNTIME_NOT_READY');
  assert.equal(f.state.lastAttempt('s').failure, 'CODEX_RUNTIME_TIMEOUT');
});

test('cooldown blocks leases for 60 seconds, allows other keys and does not slide', async () => {
  let now = 1000;
  const f = fixture({ failures: Array(5).fill('CODEX_RUNTIME_TIMEOUT'), clock: () => now });
  await assert.rejects(f.run(), { code: 'CODEX_RUNTIME_TIMEOUT' });
  now += 59000;
  await assert.rejects(f.run(), { code: 'CODEX_NATIVE_COMPACTION_COOLDOWN' });
  assert.equal(f.counts().opens, 1);
  await assert.rejects(f.run(request('other')), { code: 'CODEX_RUNTIME_TIMEOUT' });
  await assert.rejects(f.run(request('s', 'other-model')), { code: 'CODEX_RUNTIME_TIMEOUT' });
  now += 1000;
  await assert.rejects(f.run(), { code: 'CODEX_RUNTIME_TIMEOUT' });
  assert.equal(f.counts().opens, 4);
});

test('user cancellation is not retried or counted as terminal failure', async () => {
  const f = fixture({ failures: ['CODEX_RUNTIME_CANCELLED'] });
  await assert.rejects(f.run(), { code: 'CODEX_RUNTIME_CANCELLED' });
  await f.run();
  assert.deepEqual(f.counts(), { opens: 2, native: 2, fallback: 0, closed: 2 });
});

test('single-flight guard stops same-key overlap before a second lease opens', async () => {
  let finish;
  const f = fixture();
  f.seam.adapter.seamCompactOnLease = () => new Promise(resolve => { finish = resolve; });
  const first = f.run();
  while (!finish) await Promise.resolve();
  await assert.rejects(f.run(), { code: 'CODEX_NATIVE_COMPACTION_BUSY' });
  assert.equal(f.counts().opens, 1);
  finish({ envelope: 'synthetic' });
  await first;
});

test('ordinary task requests are not stopped by compaction cooldown', async () => {
  const f = fixture({ failures: ['CODEX_RUNTIME_TIMEOUT'] });
  await assert.rejects(f.run());
  let ordinary = 0;
  const r = request(); delete r.purpose;
  await drain(new NativeCompactionSeam({ state: f.state, adapter: f.seam.adapter }).dispatch(r, async function* () { ordinary++; yield { type: 'finish', reason: { kind: 'stop' } }; }));
  assert.equal(ordinary, 1);
  assert.equal(f.counts().opens, 1);
});

test('abort racing native failure prevents fallback and preserves cancellation', async () => {
  const controller = new AbortController();
  const f = fixture();
  f.seam.adapter.seamCompactOnLease = async () => { controller.abort(); throw failure('CODEX_RUNTIME_NETWORK'); };
  await assert.rejects(f.run({ ...request(), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.counts().fallback, 0);
  assert.equal(f.state.nativeStatus('s').recovery[0].failures, 0);
});

test('protocol rejection is never retried or sent through text fallback', async () => {
  const f = fixture({ failures: ['CODEX_RUNTIME_RESPONSE_PROTOCOL'] });
  await assert.rejects(f.run(), { code: 'CODEX_RUNTIME_RESPONSE_PROTOCOL' });
  assert.deepEqual(f.counts(), { opens: 1, native: 1, fallback: 0, closed: 1 });
});

test('only matching successful replacement clears failures; commit errors count once', () => {
  let now = 0;
  const recovery = new CompactionRecovery({ now: () => now });
  const events = new Map();
  const session = { id: 's', eventAt: seq => events.get(seq) };
  const emit = (type, data, extra = {}) => recovery.observe(session, { type, data, ...extra });
  emit('compaction/start', { compactionId: 'first' });
  const first = recovery.begin(request());
  recovery.fail(first, 'CODEX_RUNTIME_TIMEOUT');
  recovery.release(first);
  emit('compaction/end', { compactionId: 'first', error: 'failed' });
  assert.equal(recovery.status('s')[0].failures, 1, 'no double count from end event');
  now = 60000;
  emit('compaction/start', { compactionId: 'second' });
  const second = recovery.begin(request());
  recovery.release(second); // summary streamed, but not committed
  assert.equal(recovery.status('s')[0].failures, 1);
  emit('compaction/end', { compactionId: 'second', error: 'shrink rejected' });
  assert.equal(recovery.status('s')[0].failures, 2);
  now = 120000;
  emit('compaction/start', { compactionId: 'third' });
  recovery.release(recovery.begin(request()));
  events.set(9, { type: 'compaction/summary', data: { compactionId: 'third' } });
  emit('user/message', {}, { sourceEventSeqs: [9] });
  emit('compaction/end', { compactionId: 'unrelated' });
  assert.equal(recovery.status('s')[0].failures, 2);
  emit('compaction/end', { compactionId: 'third' });
  assert.equal(recovery.status('s')[0].failures, 0);
  assert.equal(recovery.status('s')[0].nextAllowedAt, 0);
  recovery.clear();
  assert.deepEqual(recovery.status('s'), []);
});
