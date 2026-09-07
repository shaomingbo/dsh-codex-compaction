import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Context, Llm, Sessions, Session, Projections, Meter, createUserMessage,
  createAssistantMessage, createToolResultMessage,
} from './b-host.js';
import { StructuredCompactionEngine, readStructuredCheckpoint, measureEffective } from './b-backend.js';

const binding = { provider: 'fixture', model: 'fixture-model', identity: 'nonsecret-fixture' };
const native = () => ({ ...binding, items: [{ type: 'compaction', encrypted_content: 'opaque'.repeat(400), future: { keep: [1, true, null] } }] });
const signal = () => new AbortController().signal;
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const assistant = content => createAssistantMessage({ content, source: { provider: binding.provider, model: binding.model } });
async function fixture(t, summarize = async () => native(), priceCheckpoint = () => 10) {
  const ctx = new Context();
  for (const plugin of [Llm, Sessions, Projections, Meter]) await ctx.plugin(plugin);
  const session = ctx.sessions.create();
  session.append('request/header', { header: { config: { provider: binding.provider, model: binding.model } }, reason: 'initial' });
  const engine = new StructuredCompactionEngine(ctx, { summarize, priceCheckpoint });
  let admitted = 0;
  const agent = { session, options: binding, runMaintenance: async fn => { admitted++; return fn(signal()); } };
  t.after(() => ctx.fiber.dispose());
  return { ctx, session, engine, agent, admissions: () => admitted };
}
function work(session, open = false) {
  const turn = session.seq;
  session.append('turn/start', { turn });
  session.append('user/message', user('Requirements. '.repeat(200)), { surfaceOp: 'append' });
  session.append('step/start', { turn, step: 1 });
  session.append('assistant/message', { turn, step: 1, message: assistant([{ type: 'text', text: 'Old analysis. '.repeat(500) }]) }, { surfaceOp: 'append' });
  session.append('step/end', { turn, step: 1 });
  session.append('user/message', user('Keep latest unit verbatim.'), { surfaceOp: 'append' });
  if (!open) session.append('turn/end', { turn, reason: { kind: 'completed' } });
}
const events = (session, type) => session.snapshotEvents().filter(event => event.type === type);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('B lifecycle, canonical accounting, small display, whole-record pricing, replay and flush', async t => {
  const calls = [];
  const f = await fixture(t, async input => { calls.push(input); return native(); }, record => { assert.deepEqual(record, native()); return 10; });
  work(f.session);
  const before = f.ctx.tokenMeter.measure(f.session);
  let stored;
  f.ctx.on('session/flush', session => { stored = JSON.parse(JSON.stringify(session.snapshotEvents())); });
  const result = await f.ctx.compaction.compactNow(f.agent, signal(), 'command-fixture');
  assert.equal(f.admissions(), 1);
  assert.equal(calls[0].messages.length, 2);
  assert.deepEqual(f.session.snapshotEvents().slice(-4).map(e => e.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
  assert.equal(result.shadowedTokenCount, before.nodes.slice(0, 2).reduce((n, node) => n + node.heuristicTokens, 0));
  const landed = events(f.session, 'user/message').at(-1);
  assert.deepEqual(landed.sourceEventSeqs, [result.startSeq, result.summarySeq, ...result.shadowedSeqs]);
  assert.equal(landed.data.source.sourceCommandId, 'command-fixture');
  assert.ok(JSON.stringify(landed.data.content).length < 200);
  assert.ok(!JSON.stringify(landed.data.content).includes('opaque'));
  const restored = Session.create(f.session.id, stored, f.session.header);
  const record = readStructuredCheckpoint(restored.deriveMessages()[0], binding);
  assert.deepEqual(record.items, native().items);
  const measured = measureEffective(restored, f.ctx.tokenMeter, () => 10);
  const node = measured.nodes.find(node => node.structuredCheckpoint);
  assert.equal(node.effectiveTokens, 10);
  assert.equal(measured.effectiveTokens, measured.hostTokens + 10 - node.hostTokens);
  assert.equal(measured.pricing, 'prototype-estimate');
});

test('runner pricing receives detached payload and cannot rewrite persisted opaque JSON', async t => {
  const f = await fixture(t, async () => native(), record => {
    record.items[0].encrypted_content = 'runner mutation';
    return 10;
  });
  work(f.session);
  await f.engine.compactNow(f.agent, signal());
  assert.deepEqual(readStructuredCheckpoint(f.session.deriveMessages()[0], binding).items, native().items);
});

test('binding/provenance/version fail closed; opaque unknown JSON stays exact', async t => {
  const f = await fixture(t); work(f.session);
  await f.engine.compactNow(f.agent, signal());
  const message = f.session.deriveMessages()[0];
  assert.throws(() => readStructuredCheckpoint(message, { ...binding, identity: 'other' }), /IDENTITY/);
  assert.throws(() => readStructuredCheckpoint(message, { ...binding, model: 'other' }), /IDENTITY/);
  assert.throws(() => readStructuredCheckpoint(message, { ...binding, provider: 'other' }), /IDENTITY/);
  assert.throws(() => readStructuredCheckpoint({ ...message, source: { kind: 'user', nativeAB: message.source.nativeAB } }), /provenance/);
  assert.throws(() => readStructuredCheckpoint({ ...message, source: { ...message.source, nativeAB: { ...message.source.nativeAB, version: 2 } } }), /version/);
  assert.equal(readStructuredCheckpoint(user('ordinary')), undefined);
  const decoded = readStructuredCheckpoint(message, binding);
  decoded.items[0].future.keep.push('changed');
  assert.deepEqual(readStructuredCheckpoint(message, binding).items, native().items);
});

for (const price of [Infinity, NaN, -1, '10', 100000]) {
  test(`reject invalid/non-shrinking estimate ${String(price)} without surface mutation`, async t => {
    const f = await fixture(t, async () => native(), () => price); work(f.session);
    const before = [...f.session.surface.nodes];
    let flushed = 0; f.ctx.on('session/flush', () => { flushed++; });
    await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'summary' });
    assert.deepEqual(f.session.surface.nodes, before);
    assert.equal(events(f.session, 'compaction/end').length, 1);
    assert.equal(events(f.session, 'compaction/summary').length, 0);
    assert.equal(flushed, 1);
  });
}

test('prior native checkpoint is priced effectively on recompaction, not its hidden host cost', async t => {
  let price = 10;
  const f = await fixture(t, async () => native(), () => price); work(f.session);
  await f.engine.compactNow(f.agent, signal());
  // Only the previous checkpoint is selected on round two; equal price must fail.
  await assert.rejects(f.engine.compactNow(f.agent, signal()), error => error.code === 'summary' && /not smaller/.test(error.cause.message));
  price = 0;
  // Both existing and new checkpoint receive the same runner price: still no shrink.
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'summary' });
});

test('idle admission, empty/non-useful histories and open-turn requirement', async t => {
  const f = await fixture(t);
  assert.equal(await f.engine.compactNow(f.agent, signal()), null);
  f.session.append('user/message', user('one'), { surfaceOp: 'append' });
  assert.equal(await f.engine.compactNow(f.agent, signal()), null);
  await assert.rejects(f.engine.compactRegion(f.session.surface.nodes[0], f.session.surface.nodes[0], f.agent, signal()), /open turn/);
  f.agent.runMaintenance = () => { throw new Error('not idle'); };
  assert.throws(() => f.engine.compactNow(f.agent, signal()), { code: 'busy' });
});

test('tool-pair split rejected and manual retains the entire last balanced tool unit', async t => {
  const f = await fixture(t); work(f.session, true);
  const turn = events(f.session, 'turn/start').at(-1).data.turn;
  f.session.append('step/start', { turn, step: 2 });
  const call = f.session.append('assistant/message', { turn, step: 2, message: assistant([{ type: 'tool-call', id: 'tool-1', name: 'fixture', arguments: '{}' }]) }, { surfaceOp: 'append' });
  await assert.rejects(f.engine.compactRegion(f.session.surface.nodes[0], call.seq, f.agent, signal()), /pairing/);
  f.session.append('tool/call', { turn, step: 2, callId: 'tool-1', name: 'fixture', arguments: '{}' });
  const tool = f.session.append('tool/result', { turn, step: 2, message: createToolResultMessage({ callId: 'tool-1', content: [{ type: 'text', text: 'result' }], isError: false }) }, { surfaceOp: 'append' });
  await assert.rejects(f.engine.compactRegion(tool.seq, tool.seq, f.agent, signal()), /pairing/);
  f.session.append('step/end', { turn, step: 2 });
  f.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  const result = await f.engine.compactNow(f.agent, signal());
  assert.ok(!result.shadowedSeqs.includes(call.seq));
  assert.ok(!result.shadowedSeqs.includes(tool.seq));
  assert.ok(f.session.surface.nodes.includes(call.seq));
});

test('live log bracket locks concurrent entry, constructor end-seed makes stale bracket recoverable', async t => {
  const started = deferred(); const release = deferred();
  const f = await fixture(t, async () => { started.resolve(); await release.promise; return native(); }); work(f.session);
  const pending = f.engine.compactNow(f.agent, signal()); await started.promise;
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'busy' });
  release.resolve(); await pending;
  f.session.append('compaction/start', { compactionId: 'stale', turn: null });
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'busy' });
  f.agent.session = f.ctx.sessions.create(undefined, { seed: f.session.snapshotEvents() });
  work(f.agent.session);
  assert.ok(await f.engine.compactNow(f.agent, signal()));
});

for (const manual of [true, false]) {
  test(`${manual ? 'manual selected span tolerates tail append' : 'region whole surface rejects tail append'}`, async t => {
    const started = deferred(); const release = deferred();
    const f = await fixture(t, async () => { started.resolve(); await release.promise; return native(); }); work(f.session, !manual);
    const nodes = [...f.session.surface.nodes];
    const pending = manual ? f.engine.compactNow(f.agent, signal()) : f.engine.compactRegion(nodes[0], nodes[1], f.agent, signal());
    await started.promise;
    f.session.append('user/message', user('outside selected span'), { surfaceOp: 'append' });
    release.resolve();
    if (manual) assert.ok(await pending);
    else await assert.rejects(pending, /surface changed/);
    assert.equal(events(f.session, 'compaction/end').length, 1);
  });
}

test('manual selected-span replacement while in flight fails changed', async t => {
  const started = deferred(); const release = deferred();
  const f = await fixture(t, async () => { started.resolve(); await release.promise; return native(); }); work(f.session);
  const nodes = [...f.session.surface.nodes];
  const pending = f.engine.compactNow(f.agent, signal()); await started.promise;
  f.session.append('user/message', user('replacement'), { surfaceOp: { op: 'replace', start: nodes[0], end: nodes[1] }, sourceEventSeqs: nodes.slice(0, 2) });
  release.resolve();
  await assert.rejects(pending, { code: 'changed' });
  assert.equal(events(f.session, 'compaction/end').length, 1);
});

test('cancel closes once, flushes, does not commit even when transport ignores signal', async t => {
  const started = deferred(); const release = deferred(); const abort = new AbortController();
  const f = await fixture(t, async (_input, _agent, seen) => { assert.equal(seen.aborted, false); started.resolve(); await release.promise; return native(); }); work(f.session);
  let flush = 0; f.ctx.on('session/flush', () => { flush++; });
  const pending = f.engine.compactNow(f.agent, abort.signal); await started.promise;
  abort.abort(new Error('cancel fixture')); release.resolve();
  await assert.rejects(pending, /cancel fixture/);
  assert.equal(events(f.session, 'compaction/end').length, 1);
  assert.equal(events(f.session, 'compaction/summary').length, 0);
  assert.equal(flush, 1);
});

test('transport failure and genuine host JSON commit rejection close once', async t => {
  let mode = 'transport';
  const f = await fixture(t, async () => { if (mode === 'transport') throw new Error('fixture transport'); return { ...native(), usage: { invalid: BigInt(1) } }; }); work(f.session);
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'summary' });
  mode = 'commit';
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'commit' });
  assert.equal(events(f.session, 'compaction/start').length, 2);
  assert.equal(events(f.session, 'compaction/end').length, 2);
  assert.equal(events(f.session, 'compaction/summary').length, 0);
});

test('public-proxy compactRegion succeeds inside turn without standalone flush', async t => {
  const f = await fixture(t); work(f.session, true);
  let flush = 0; f.ctx.on('session/flush', () => { flush++; });
  const [start, end] = f.session.surface.nodes;
  const result = await f.ctx.compaction.compactRegion(start, end, f.agent, signal());
  assert.equal(events(f.session, 'compaction/start').at(-1).data.turn, events(f.session, 'turn/start').at(-1).data.turn);
  assert.equal(events(f.session, 'compaction/end').length, 1);
  assert.equal(result.shadowedSeqs.length, 2);
  assert.equal(flush, 0);
  assert.equal(f.admissions(), 0);
});

test('maintenance cancellation is classified, pre-cancel emits no lifecycle', async t => {
  const started = deferred(); const release = deferred(); const agentAbort = new AbortController();
  const f = await fixture(t, async () => { started.resolve(); await release.promise; return native(); }); work(f.session);
  const preAbort = new AbortController(); preAbort.abort();
  assert.throws(() => f.engine.compactNow(f.agent, preAbort.signal), { name: 'AbortError' });
  assert.equal(events(f.session, 'compaction/start').length, 0);
  f.agent.runMaintenance = fn => fn(agentAbort.signal);
  const pending = f.engine.compactNow(f.agent, signal()); await started.promise;
  agentAbort.abort(); release.resolve();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(events(f.session, 'compaction/end').length, 1);
  assert.equal(events(f.session, 'compaction/summary').length, 0);
});

test('agent session replacement in flight is rejected, original session is closed and flushed', async t => {
  const started = deferred(); const release = deferred();
  const f = await fixture(t, async () => { started.resolve(); await release.promise; return native(); }); work(f.session);
  let flushed;
  f.ctx.on('session/flush', session => { flushed = session.id; });
  const pending = f.engine.compactNow(f.agent, signal()); await started.promise;
  f.agent.session = f.ctx.sessions.create(); release.resolve();
  await assert.rejects(pending, { code: 'changed' });
  assert.equal(flushed, f.session.id);
  assert.equal(events(f.session, 'compaction/end').length, 1);
  assert.equal(events(f.agent.session, 'compaction/start').length, 0);
});

// Synthetic reported usage activates the REAL public meter; it is not real
// provider/token truth. Stable counts deliberately recur across different calls.
const fixtureUsage = { inputTokens: 10000, outputTokens: 10, totalTokens: 10010 };
function appendUsage(session, { usage = fixtureUsage, interrupted = false, beforeOutput } = {}) {
  const turn = session.seq;
  session.append('turn/start', { turn });
  const step = session.append('step/start', { turn, step: 1 });
  if (beforeOutput) beforeOutput();
  const message = session.append('assistant/message', {
    turn, step: 1, message: assistant([{ type: 'text', text: 'Reported synthetic usage response.' }]),
    ...(usage === null ? {} : { usage }), ...(interrupted ? { interrupted: true } : {}),
  }, { surfaceOp: 'append', ...(interrupted ? { sourceEventSeqs: [] } : {}) });
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  return { stepSeq: step.seq, assistantSeq: message.seq };
}

test('usage already covers hidden checkpoint; tail append adds only the new delta', async t => {
  const price = () => 100;
  const f = await fixture(t, async () => native(), price); work(f.session);
  await f.engine.compactNow(f.agent, signal());
  const anchor = appendUsage(f.session);
  const initial = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(initial.hostMeasurement.baseline.kind, 'usage');
  assert.equal(initial.hostTokens, fixtureUsage.totalTokens);
  assert.equal(initial.effectiveTokens, initial.hostTokens);
  assert.equal(initial.anchorAdjustment.assistantSeq, anchor.assistantSeq);
  assert.equal(initial.anchorAdjustment.stepStartSeq, anchor.stepSeq);
  assert.notEqual(initial.anchorAdjustment.currentHiddenDelta, 0);
  assert.equal(initial.anchorAdjustment.correctionTokens, 0);
  const tail = user('New retained tail. '.repeat(100));
  f.session.append('user/message', tail, { surfaceOp: 'append' });
  const after = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(after.effectiveTokens, initial.effectiveTokens + f.ctx.tokenMeter.estimateMessage(tail));
  assert.equal(after.anchorAdjustment.correctionTokens, 0);
});

test('recompaction subtracts old anchor payload; same-count later usage reanchors by event identity', async t => {
  let output = native();
  const price = record => record.items[0].encrypted_content.length / 20;
  const f = await fixture(t, async () => output, price); work(f.session);
  await f.engine.compactNow(f.agent, signal());
  const firstAnchor = appendUsage(f.session);
  const before = measureEffective(f.session, f.ctx.tokenMeter, price);
  const sourceEffective = before.nodes.slice(0, -1).reduce((sum, node) => sum + node.effectiveTokens, 0);
  output = { ...binding, items: [{ type: 'compaction', encrypted_content: 'new'.repeat(100) }] };
  const result = await f.engine.compactNow(f.agent, signal());
  assert.ok(result);
  const after = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(after.hostMeasurement.baseline.kind, 'usage');
  assert.equal(after.effectiveTokens, before.effectiveTokens - sourceEffective + price(output));
  assert.equal(after.anchorAdjustment.assistantSeq, firstAnchor.assistantSeq);
  assert.notEqual(after.anchorAdjustment.currentHiddenDelta, after.anchorAdjustment.anchorHiddenDelta);
  assert.equal(result.shadowedTokenCount, before.nodes.slice(0, -1).reduce((sum, node) => sum + node.hostHeuristicTokens, 0));
  const secondAnchor = appendUsage(f.session); // EXACT same reported usage counts.
  const second = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(second.anchorAdjustment.assistantSeq, secondAnchor.assistantSeq);
  assert.notEqual(second.anchorAdjustment.assistantSeq, firstAnchor.assistantSeq);
  assert.equal(second.effectiveTokens, fixtureUsage.totalTokens);
  assert.equal(second.anchorAdjustment.correctionTokens, 0);
  // Prefix reconstruction is deterministic after actual public Session restore.
  const restored = Session.create(f.session.id, JSON.parse(JSON.stringify(f.session.snapshotEvents())), f.session.header);
  assert.deepEqual(measureEffective(restored, f.ctx.tokenMeter, price).anchorAdjustment, second.anchorAdjustment);
});

test('in-step checkpoint replacement is not retroactively covered by assistant usage', async t => {
  const price = record => record.items[0].encrypted_content.length / 20;
  const f = await fixture(t, async () => native(), price); work(f.session);
  await f.engine.compactNow(f.agent, signal());
  const original = f.session.deriveMessages()[0];
  const originalSeq = f.session.surface.nodes[0];
  const changed = JSON.parse(JSON.stringify(original));
  changed.id = 'in-step-replacement';
  changed.source.nativeAB.items[0].encrypted_content = 'changed'.repeat(10);
  const delta = price(changed.source.nativeAB) - price(original.source.nativeAB);
  const anchor = appendUsage(f.session, { beforeOutput: () => {
    f.session.append('user/message', changed, { surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq }, sourceEventSeqs: [originalSeq] });
  } });
  const measured = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(measured.hostTokens, fixtureUsage.totalTokens);
  assert.equal(measured.effectiveTokens, fixtureUsage.totalTokens + delta);
  assert.equal(measured.anchorAdjustment.correctionTokens, delta);
  assert.equal(measured.anchorAdjustment.stepStartSeq, anchor.stepSeq);
});

test('interrupted explicit-empty provider output keeps durable suffix outside usage anchor', async t => {
  const price = () => 100;
  const f = await fixture(t, async () => native(), price); work(f.session);
  await f.engine.compactNow(f.agent, signal());
  const anchor = appendUsage(f.session, { interrupted: true });
  const measured = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(measured.hostMeasurement.baseline.kind, 'usage');
  const suffix = f.ctx.tokenMeter.estimateMessage(f.session.eventAt(anchor.assistantSeq).data.message);
  assert.equal(measured.hostTokens, fixtureUsage.totalTokens + suffix);
  assert.equal(measured.effectiveTokens, measured.hostTokens);
  assert.equal(measured.anchorAdjustment.correctionTokens, 0);
  // Missing usage on a later interrupted call supersedes the older usage anchor.
  appendUsage(f.session, { usage: null, interrupted: true });
  const missing = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(missing.hostMeasurement.baseline.kind, 'estimated');
  assert.equal(missing.anchorAdjustment.kind, 'no-usage');
  assert.equal(missing.effectiveTokens, missing.hostTokens + missing.anchorAdjustment.currentHiddenDelta);
});

test('unusable low usage and changed envelope fall back to full current payload correction', async t => {
  const price = () => 100;
  const f = await fixture(t, async () => native(), price); work(f.session);
  await f.engine.compactNow(f.agent, signal());
  appendUsage(f.session, { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  const low = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(low.hostMeasurement.baseline.kind, 'estimated');
  assert.equal(low.anchorAdjustment.kind, 'no-usage');
  assert.equal(low.effectiveTokens, low.hostTokens + low.anchorAdjustment.currentHiddenDelta);
  appendUsage(f.session);
  f.session.append('request/header', { header: { config: { provider: binding.provider, model: 'changed-model' } }, reason: 'change' });
  const changed = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(changed.hostMeasurement.baseline.kind, 'estimated');
  assert.equal(changed.anchorAdjustment.anchorHiddenDelta, 0);
  assert.equal(changed.effectiveTokens, changed.hostTokens + changed.anchorAdjustment.currentHiddenDelta);
});

test('a later no-usage assistant cannot accidentally resurrect earlier identical usage', async t => {
  const price = () => 100;
  const f = await fixture(t, async () => native(), price); work(f.session);
  await f.engine.compactNow(f.agent, signal());
  appendUsage(f.session);
  appendUsage(f.session, { usage: null });
  const result = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(result.hostMeasurement.baseline.kind, 'estimated');
  assert.equal(result.anchorAdjustment.assistantSeq, null);
});

test('effective pressure is clamped nonnegative after historical hidden-delta correction', async t => {
  let output = native();
  const price = record => record.items[0].encrypted_content.length;
  const f = await fixture(t, async () => output, price);
  work(f.session);
  // Price 2400 requires a genuinely larger selected source, not fake host usage.
  f.session.append('user/message', user('large source '.repeat(2000)), { surfaceOp: 'append' });
  f.session.append('user/message', user('retain'), { surfaceOp: 'append' });
  await f.engine.compactNow(f.agent, signal());
  appendUsage(f.session, { usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 } });
  output = { ...binding, items: [{ type: 'compaction', encrypted_content: 'x' }] };
  await f.engine.compactNow(f.agent, signal());
  const measured = measureEffective(f.session, f.ctx.tokenMeter, price);
  assert.equal(measured.hostMeasurement.baseline.kind, 'usage');
  assert.ok(measured.hostMeasurement.baseline.tokens + measured.hostMeasurement.surfaceDeltaTokens + measured.anchorAdjustment.correctionTokens < 0);
  assert.equal(measured.effectiveTokens, 0);
});

test('flush failure distinguishes already committed surface; original failure takes precedence', async t => {
  let fail = false;
  const f = await fixture(t, async () => { if (fail) throw new Error('transport'); return native(); }); work(f.session);
  f.ctx.on('session/flush', () => { throw new Error('disk fixture'); });
  const generation = f.session.surface.replaceGeneration;
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'persistence' });
  assert.ok(f.session.surface.replaceGeneration > generation);
  fail = true;
  await assert.rejects(f.engine.compactNow(f.agent, signal()), { code: 'summary' });
});
