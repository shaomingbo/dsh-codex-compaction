import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Llm, { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import Sessions, { Session } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Meter from '@deepseek-ai/dsh-token-meter';
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { StructuredCodexCompactionEngine } from '../src/structured-engine.js';
// Fixture codec only: production receives these callbacks from owner runtime.
import { encodeCheckpoint, decodeCheckpoint } from '../experiments/compaction-ab/a-baseline/checkpoint.js';
const binding = { provider: 'fixture', model: 'fixture-model', identity: 'nonsecret-fixture' };
const native = () => validate({ ...binding, items: [{ type: 'compaction', encrypted_content: 'opaque'.repeat(400), future: { keep: [1, true, null] } }] });
const validate = record => decodeCheckpoint(encodeCheckpoint(record), record);
const read = message => {
  const record = message?.source?.nativeCodex;
  if (record === undefined) return undefined;
  if (message.role !== 'user' || !isCompactCheckpointSource(message.source) || !message.source.compactionId) throw new Error('provenance');
  if (record.version !== 1 || record.protocol !== 'responses.compaction-trigger.v2') throw new Error('version/protocol');
  const valid = validate(record);
  assert.deepEqual(valid, record);
  return valid;
};
const signal = () => new AbortController().signal;
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const assistant = content => createAssistantMessage({ content, source: binding });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const events = (s, type) => s.snapshotEvents().filter(e => e.type === type);
async function fixture(t, compact = async () => ({ checkpoint: native() }), price = () => 100) {
  const ctx = new Context();
  for (const plugin of [Llm, Sessions, Projections, Meter]) await ctx.plugin(plugin);
  const session = ctx.sessions.create();
  session.append('request/header', { header: { config: binding }, reason: 'initial' });
  const engine = new StructuredCodexCompactionEngine(ctx, { compact, readCheckpoint: read, validateCheckpoint: validate, estimateCheckpoint: record => ({ tokens: price(record), basis: 'synthetic test estimate', exact: false }) });
  const agent = { session, options: binding, runMaintenance: fn => fn(signal()) };
  t.after(() => ctx.fiber.dispose());
  return { ctx, session, engine, agent };
}
function work(s, open = false) {
  const turn = s.seq;
  s.append('turn/start', { turn });
  s.append('user/message', user('Requirements. '.repeat(200)), { surfaceOp: 'append' });
  s.append('step/start', { turn, step: 1 });
  s.append('assistant/message', { turn, step: 1, message: assistant([{ type: 'text', text: 'Old analysis. '.repeat(500) }]) }, { surfaceOp: 'append' });
  s.append('step/end', { turn, step: 1 });
  s.append('user/message', user('Keep latest unit verbatim.'), { surfaceOp: 'append' });
  if (!open) s.append('turn/end', { turn, reason: { kind: 'completed' } });
}
const usage = { inputTokens: 10000, outputTokens: 10, totalTokens: 10010 };
function anchor(s, { counts = usage, interrupted = false, beforeOutput } = {}) {
  const turn = s.seq;
  s.append('turn/start', { turn });
  const step = s.append('step/start', { turn, step: 1 });
  beforeOutput?.();
  const output = s.append('assistant/message', { turn, step: 1, message: assistant([{ type: 'text', text: 'Synthetic usage response' }]), ...(counts === null ? {} : { usage: counts }), ...(interrupted ? { interrupted: true } : {}) }, { surfaceOp: 'append', ...(interrupted ? { sourceEventSeqs: [] } : {}) });
  s.append('step/end', { turn, step: 1 }); s.append('turn/end', { turn, reason: { kind: 'completed' } });
  return { stepSeq: step.seq, assistantSeq: output.seq };
}
test('public proxy lifecycle, detached structured persistence/recovery and honest accounting', async t => {
  const f = await fixture(t, async input => { assert.equal(input.messages.length, 2); return { checkpoint: native() }; }, record => { record.items[0].encrypted_content = 'mutation'; return 100; }); work(f.session);
  const before = f.ctx.tokenMeter.measure(f.session); let stored;
  f.ctx.on('session/flush', s => { stored = JSON.parse(JSON.stringify(s.snapshotEvents())); });
  const result = await f.ctx.compaction.compactNow(f.agent, signal(), 'command');
  assert.equal(result.shadowedTokenCount, before.nodes.slice(0, 2).reduce((n, node) => n + node.heuristicTokens, 0));
  assert.deepEqual(f.session.snapshotEvents().slice(-4).map(e => e.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
  const restored = Session.create(f.session.id, stored, f.session.header);
  const message = restored.deriveMessages()[0];
  assert.deepEqual(read(message), native()); assert.ok(JSON.stringify(message.content).length < 200);
  assert.equal(message.source.sourceCommandId, 'command');
  const measured = f.ctx.compaction.measureEffective(restored);
  assert.equal(measured.pricing, 'provider-estimate'); assert.equal(measured.exact, false);
  assert.equal(measured.effectiveTokens, measured.hostTokens + measured.anchorAdjustment.currentHiddenDelta);
  assert.equal(measured.nodes[0].estimate.basis, 'synthetic test estimate');
});
for (const price of [Infinity, NaN, -1, '10', 100000]) test(`invalid/nonshrinking price ${price}`, async t => {
  const f = await fixture(t, undefined, () => price); work(f.session); const nodes = [...f.session.surface.nodes];
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'summary' });
  assert.deepEqual(f.session.surface.nodes, nodes); assert.equal(events(f.session, 'compaction/end').length, 1);
});
for (const estimate of [{ tokens: 1, basis: '', exact: false }, { tokens: 1, basis: 'oracle', exact: true }, 1]) test(`invalid estimate disclosure ${JSON.stringify(estimate)}`, async t => {
  const f = await fixture(t); work(f.session); f.engine.estimateCheckpoint = () => estimate;
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'summary' });
});
test('idle, empty, open-turn region and public proxy', async t => {
  const f = await fixture(t); assert.equal(await f.engine.compactNow(f.agent, signal()), null);
  work(f.session); const [start, end] = f.session.surface.nodes;
  await assert.rejects(f.engine.compactRegion(start, end, f.agent, signal()), /open turn/);
  work(f.session, true); let flushed = 0; f.ctx.on('session/flush', () => { flushed++; });
  assert.ok(await f.ctx.compaction.compactRegion(start, end, f.agent, signal())); assert.equal(flushed, 0);
  f.agent.runMaintenance = () => { throw new Error('busy'); }; assert.throws(() => f.engine.compactNow(f.agent, signal()), { code: 'busy' });
});
test('tool pair cannot split; manual retains complete final tool unit', async t => {
  const f = await fixture(t); work(f.session, true); const turn = events(f.session, 'turn/start').at(-1).data.turn;
  f.session.append('step/start', { turn, step: 2 });
  const call = f.session.append('assistant/message', { turn, step: 2, message: assistant([{ type: 'tool-call', id: 'tool', name: 'fixture', arguments: '{}' }]) }, { surfaceOp: 'append' });
  await assert.rejects(f.engine.compactRegion(f.session.surface.nodes[0], call.seq, f.agent, signal()), /pairing/);
  f.session.append('tool/call', { turn, step: 2, callId: 'tool', name: 'fixture', arguments: '{}' });
  const tool = f.session.append('tool/result', { turn, step: 2, message: createToolResultMessage({ callId: 'tool', content: [{ type: 'text', text: 'result' }], isError: false }) }, { surfaceOp: 'append' });
  await assert.rejects(f.engine.compactRegion(tool.seq, tool.seq, f.agent, signal()), /pairing/);
  f.session.append('step/end', { turn, step: 2 }); f.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  const result = await f.engine.compactNow(f.agent, signal()); assert.ok(!result.shadowedSeqs.includes(call.seq));
});
for (const mode of ['manual-tail', 'region-tail', 'replace', 'session', 'cancel', 'maintenance', 'header']) test(`in-flight ${mode}`, async t => {
  const start = deferred(), release = deferred(), abort = new AbortController();
  const f = await fixture(t, async () => { start.resolve(); await release.promise; return { checkpoint: native() }; }); work(f.session, mode === 'region-tail');
  if (mode === 'maintenance') f.agent.runMaintenance = fn => fn(abort.signal);
  const nodes = [...f.session.surface.nodes];
  const pending = mode === 'region-tail' ? f.engine.compactRegion(nodes[0], nodes[1], f.agent, signal()) : f.engine.compactNow(f.agent, mode === 'cancel' ? abort.signal : signal());
  await start.promise;
  if (mode.endsWith('tail')) f.session.append('user/message', user('tail'), { surfaceOp: 'append' });
  if (mode === 'replace') f.session.append('user/message', user('changed'), { surfaceOp: { op: 'replace', start: nodes[0], end: nodes[1] }, sourceEventSeqs: nodes.slice(0, 2) });
  if (mode === 'session') f.agent.session = f.ctx.sessions.create();
  if (mode === 'header') f.session.append('request/header', { header: { config: { ...binding, model: 'other' } }, reason: 'change' });
  if (['cancel', 'maintenance'].includes(mode)) abort.abort();
  release.resolve();
  if (mode === 'manual-tail') assert.ok(await pending); else await assert.rejects(pending);
  assert.equal(events(f.session, 'compaction/end').length, 1);
});
test('concurrent compaction is rejected by durable bracket before provider call', async t => {
  const start = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, async () => { calls++; start.resolve(); await release.promise; return { checkpoint: native() }; }); work(f.session);
  const pending = f.engine.compactNow(f.agent, signal()); await start.promise;
  await assert.rejects(f.ctx.compaction.compactNow(f.agent, signal()), { code: 'busy' });
  assert.equal(calls, 1); release.resolve(); await pending;
  assert.equal(events(f.session, 'compaction/end').length, 1);
});
test('invalid checkpoint is a summary failure, never a plain-text fallback', async t => {
  const f = await fixture(t, async () => ({ checkpoint: { text: 'summary' } })); work(f.session);
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'summary' });
  assert.equal(events(f.session, 'compaction/summary').length, 0);
  assert.equal(events(f.session, 'compaction/end').length, 1);
});
test('pre-cancel, durable lock and end-seed recovery', async t => {
  const f = await fixture(t); work(f.session); const abort = new AbortController(); abort.abort();
  assert.throws(() => f.engine.compactNow(f.agent, abort.signal), { name: 'AbortError' });
  const [a, b] = f.session.surface.nodes; await assert.rejects(f.engine.compactRegion(a, b, f.agent, abort.signal), { name: 'AbortError' });
  assert.equal(events(f.session, 'compaction/start').length, 0);
  f.session.append('compaction/start', { compactionId: 'stale', turn: null });
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'busy' });
  f.agent.session = f.ctx.sessions.create(undefined, { seed: f.session.snapshotEvents() }); work(f.agent.session);
  assert.ok(await f.engine.compactNow(f.agent, signal()));
});
test('transport/commit/flush failures close once and do not claim durable success', async t => {
  let mode = 'transport'; const f = await fixture(t, async () => { if (mode === 'transport') throw new Error('transport'); return { checkpoint: native(), ...(mode === 'commit' ? { usage: { invalid: BigInt(1) } } : {}) }; }); work(f.session);
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'summary' }); mode = 'commit';
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'commit' });
  assert.equal(events(f.session, 'compaction/end').length, 2); assert.equal(events(f.session, 'compaction/summary').length, 0);
  mode = 'ok'; f.ctx.on('session/flush', () => { throw new Error('disk'); });
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'persistence' }); assert.ok(read(f.session.deriveMessages()[0]));
  mode = 'transport'; await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'summary' });
});
test('usage coverage, tail, recompaction, same-count later anchor and recovery', async t => {
  let output = native(); const price = r => r.items[0].encrypted_content.length / 20;
  const f = await fixture(t, async () => ({ checkpoint: output }), price); work(f.session); await f.engine.compactNow(f.agent, signal());
  const first = anchor(f.session); const before = f.engine.measureEffective(f.session);
  assert.equal(before.effectiveTokens, usage.totalTokens); assert.equal(before.anchorAdjustment.assistantSeq, first.assistantSeq);
  const tail = user('tail '.repeat(100)); f.session.append('user/message', tail, { surfaceOp: 'append' });
  const withTail = f.engine.measureEffective(f.session); assert.equal(withTail.effectiveTokens, before.effectiveTokens + f.ctx.tokenMeter.estimateMessage(tail));
  const removed = withTail.nodes.slice(0, -1).reduce((n, x) => n + x.effectiveTokens, 0);
  output = validate({ ...binding, items: [{ type: 'compaction', encrypted_content: 'new' }] }); await f.engine.compactNow(f.agent, signal());
  assert.equal(f.engine.measureEffective(f.session).effectiveTokens, withTail.effectiveTokens - removed + price(output));
  const second = anchor(f.session); const measured = f.engine.measureEffective(f.session);
  assert.equal(measured.effectiveTokens, usage.totalTokens); assert.equal(measured.anchorAdjustment.assistantSeq, second.assistantSeq); assert.notEqual(first.assistantSeq, second.assistantSeq);
  const restored = Session.create(f.session.id, JSON.parse(JSON.stringify(f.session.snapshotEvents())), f.session.header);
  assert.deepEqual(f.engine.measureEffective(restored).anchorAdjustment, measured.anchorAdjustment);
});
test('request prefix before step excludes in-step checkpoint replacement', async t => {
  const price = r => r.items[0].encrypted_content.length / 20;
  const f = await fixture(t, undefined, price); work(f.session); await f.engine.compactNow(f.agent, signal());
  const original = f.session.deriveMessages()[0], seq = f.session.surface.nodes[0]; const changed = structuredClone(original); changed.id = 'in-step'; changed.source.nativeCodex.items[0].encrypted_content = 'new';
  const delta = price(changed.source.nativeCodex) - price(original.source.nativeCodex);
  const a = anchor(f.session, { beforeOutput: () => f.session.append('user/message', changed, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] }) });
  const measured = f.engine.measureEffective(f.session); assert.equal(measured.effectiveTokens, usage.totalTokens + delta); assert.equal(measured.anchorAdjustment.stepStartSeq, a.stepSeq);
});
test('interrupted output and absent/low usage or changed envelope', async t => {
  const f = await fixture(t); work(f.session); await f.engine.compactNow(f.agent, signal());
  anchor(f.session, { interrupted: true }); let m = f.engine.measureEffective(f.session); assert.equal(m.hostMeasurement.baseline.kind, 'usage'); assert.equal(m.effectiveTokens, m.hostTokens);
  for (const counts of [null, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }]) { anchor(f.session, { counts, interrupted: true }); m = f.engine.measureEffective(f.session); assert.equal(m.anchorAdjustment.kind, 'no-usage'); assert.equal(m.effectiveTokens, m.hostTokens + m.anchorAdjustment.currentHiddenDelta); }
  anchor(f.session); f.session.append('request/header', { header: { config: { ...binding, model: 'other' } }, reason: 'change' }); assert.equal(f.engine.measureEffective(f.session).anchorAdjustment.kind, 'no-usage');
});
test('unresolved public usage prefix fails closed, never guesses hidden coverage', async t => {
  const f = await fixture(t); work(f.session); await f.engine.compactNow(f.agent, signal()); anchor(f.session);
  // Fault-injected public snapshot adapter, without private meter state changes.
  const broken = new Proxy(f.session, { get(target, key) {
    if (key === 'snapshotEvents') return () => target.snapshotEvents().filter(e => e.type !== 'step/start');
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => f.engine.measureEffective(broken), { code: 'CODEX_USAGE_ANCHOR_UNRESOLVED' });
});
test('correction precedes host nonnegative clamp', async t => {
  let output = native(); const f = await fixture(t, async () => ({ checkpoint: output }), r => r.items[0].encrypted_content.length); work(f.session);
  f.session.append('user/message', user('large source '.repeat(2000)), { surfaceOp: 'append' }); f.session.append('user/message', user('retain'), { surfaceOp: 'append' });
  await f.engine.compactNow(f.agent, signal()); anchor(f.session, { counts: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 } });
  output = validate({ ...binding, items: [{ type: 'compaction', encrypted_content: 'x' }] }); await f.engine.compactNow(f.agent, signal());
  const m = f.engine.measureEffective(f.session); assert.ok(m.hostMeasurement.baseline.tokens + m.hostMeasurement.surfaceDeltaTokens + m.anchorAdjustment.correctionTokens < 0); assert.equal(m.effectiveTokens, 0);
});
