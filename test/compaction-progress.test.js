import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactionProgress } from '../src/compaction-progress.js';

function fixture(options = {}) {
  let clock = 100;
  const events = [];
  const session = {
    id: options.id ?? 'session-a', seq: 0, surface: { nodes: [] },
    header: { provider: 'fake', model: 'small', system: 'private system', tools: [] },
    requestHeader() { return this.header; },
    eventAt(seq) { return events[seq]; },
    deriveEventMessage(event) { return event.data; },
  };
  const measurement = () => {
    const nodes = session.surface.nodes.map(seq => ({ seq, tokens: events[seq].data.price, heuristicTokens: events[seq].data.price }));
    const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0);
    return { logRevision: session.seq, baseline: { kind: 'estimated', tokens: 10 }, surfaceDeltaTokens: surfaceTokens,
      totalTokens: surfaceTokens + 10, surfaceTokens, nodes };
  };
  const progress = options.progress ?? new CompactionProgress({ measure: options.measure ?? measurement,
    estimateMessage: options.estimateMessage ?? (message => message.price), now: () => clock });
  function emit(type, data = {}, extra = {}, observed = true) {
    const event = { seq: session.seq++, type, data, ...extra };
    events.push(event);
    if (type === 'user/message' || type === 'assistant/message') {
      if (extra.surfaceOp?.op === 'replace') {
        // Real 0.1.7 replacement events carry startSeq/endSeq.
        const first = session.surface.nodes.indexOf(extra.surfaceOp.startSeq);
        const last = session.surface.nodes.indexOf(extra.surfaceOp.endSeq);
        assert.ok(first >= 0 && last >= first);
        session.surface.nodes.splice(first, last - first + 1, event.seq);
      } else session.surface.nodes.push(event.seq);
    }
    if (observed) progress.observe(session, event);
    return event;
  }
  emit('user/message', { role: 'user', content: [{ type: 'text', text: 'old secret body' }], price: 80 }, {}, false);
  emit('assistant/message', { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], price: 40 }, {}, false);
  const start = (id = 'a') => emit('compaction/start', { compactionId: id, turn: null });
  const summary = (id = 'a', overrides = {}) => emit('compaction/summary', { compactionId: id,
    summary: [{ type: 'text', text: 'summary only' }], shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1],
    shadowedTokenCount: 999999, ...overrides });
  const replace = (summaryEvent, price = 30, extra = {}) => emit('user/message', { role: 'user', price,
    content: [{ type: 'text', text: '<framing>ciphertext-payload</framing>' }], source: { privateIdentity: 'do-not-retain' } },
  { surfaceOp: { op: 'replace', startSeq: summaryEvent.data.shadowedRange.start, endSeq: summaryEvent.data.shadowedRange.end },
    sourceEventSeqs: [summaryEvent.seq], ...extra });
  const end = (id = 'a', extra = {}) => emit('compaction/end', { compactionId: id, ...extra });
  const latest = () => progress.status(session).latest;
  return { session, progress, emit, start, summary, replace, end, latest, measurement, advance: amount => { clock += amount; } };
}

test('commits only the observed summary, actual framed replacement, and matching clean end', () => {
  let seen;
  const f = fixture({ estimateMessage(message) { seen = structuredClone(message); return message.price; } });
  f.start(); f.advance(10);
  const summary = f.summary();
  assert.equal(f.latest().outcome, 'pending');
  assert.equal(f.latest().netFreedTokens, null);
  f.replace(summary); f.advance(15);
  assert.equal(f.latest().outcome, 'pending');
  f.end();
  assert.deepEqual(f.latest(), {
    compactionId: 'a', outcome: 'committed', beforePressure: { tokens: 130, baseline: 'estimated' },
    afterPressure: { tokens: 40, baseline: 'estimated' }, shadowedTokens: 120,
    framedReplacementTokens: 30, netFreedTokens: 90, durationMs: 25, stepInterval: null,
    endedAtMs: 125, afterSurfaceTokens: 30,
    comparison: { basis: 'fixed-heuristic-message-delta', reason: null },
  });
  assert.match(seen.content[0].text, /framing/);
  assert.deepEqual(f.progress.status(f.session).counts, { started: 1, committed: 1, failed: 0, unknown: 0 });
});

test('does not clamp negative savings or confuse pressure with heuristic savings', () => {
  const f = fixture();
  f.start(); f.replace(f.summary(), 150); f.end();
  assert.equal(f.latest().outcome, 'committed');
  assert.equal(f.latest().netFreedTokens, -30);
});

test('clean end without replacement is unknown, not success', () => {
  const f = fixture(); f.start(); f.summary(); f.end();
  assert.equal(f.latest().outcome, 'unknown');
  assert.equal(f.latest().comparison.reason, 'incomplete-lifecycle');
  assert.equal(f.latest().netFreedTokens, null);
});

test('a cited summary in an append is not a replacement', () => {
  const f = fixture(); f.start(); const summary = f.summary();
  f.emit('user/message', { price: 30 }, { sourceEventSeqs: [summary.seq] }); f.end();
  assert.equal(f.latest().outcome, 'unknown');
  assert.equal(f.latest().netFreedTokens, null);
});

test('replacement without summary citation cannot commit', () => {
  const f = fixture(); f.start(); f.replace(f.summary(), 30, { sourceEventSeqs: [] }); f.end();
  assert.equal(f.latest().outcome, 'unknown');
});

test('failed and cancelled end cannot claim savings even after replacement', () => {
  for (const error of ['network failure', [{ name: 'AbortError', message: 'cancelled private data' }], null]) {
    const f = fixture(); f.start(); f.replace(f.summary()); f.end('a', { error });
    assert.equal(f.latest().outcome, 'failed');
    assert.equal(f.latest().netFreedTokens, null);
    assert.equal(JSON.stringify(f.progress.status(f.session)).includes('private data'), false);
  }
});

test('interleaved compaction ids never cross-confirm a transaction', () => {
  const f = fixture(); f.start('a'); const a = f.summary('a');
  f.start('b'); f.replace(a); f.end('a');
  assert.equal(f.latest().compactionId, 'b');
  assert.equal(f.latest().outcome, 'pending');
  f.end('b');
  assert.equal(f.latest().outcome, 'unknown');
  assert.deepEqual(f.progress.status(f.session).counts, { started: 2, committed: 0, failed: 0, unknown: 2 });
});

test('foreign summary and end are ignored; matching lifecycle can still commit', () => {
  const f = fixture(); f.start(); f.summary('other'); f.end('other');
  assert.equal(f.latest().outcome, 'pending');
  f.replace(f.summary()); f.end();
  assert.equal(f.latest().outcome, 'committed');
  assert.equal(f.latest().netFreedTokens, 90);
});

test('an interrupted lifecycle remains pending until public seed boundary makes it unknown', () => {
  const f = fixture(); f.start(); f.summary(); f.advance(50);
  assert.equal(f.latest().outcome, 'pending'); assert.equal(f.latest().durationMs, 50);
  f.emit('session/end-seed');
  assert.equal(f.latest().outcome, 'unknown'); assert.equal(f.latest().netFreedTokens, null);
});

test('outside append before summary, before replacement, or before end invalidates savings', () => {
  for (const stage of ['before-summary', 'before-replacement', 'before-end']) {
    const f = fixture(); f.start();
    const append = () => f.emit('user/message', { price: 25 });
    if (stage === 'before-summary') append();
    const summary = f.summary();
    if (stage === 'before-replacement') append();
    f.replace(summary);
    if (stage === 'before-end') append();
    f.end();
    assert.equal(f.latest().outcome, 'committed', stage);
    assert.equal(f.latest().comparison.reason, 'surface-changed', stage);
    assert.equal(f.latest().netFreedTokens, null, stage);
  }
});

test('route/system/tools changes invalidate comparison, even if later reverted', () => {
  for (const field of ['provider', 'model', 'system', 'tools']) {
    const f = fixture(); f.start(); const old = f.session.header[field];
    f.session.header[field] = field === 'tools' ? [{ name: 'new-tool' }] : 'changed';
    f.emit('step/start'); f.session.header[field] = old;
    f.replace(f.summary()); f.end();
    assert.equal(f.latest().outcome, 'committed');
    assert.equal(f.latest().comparison.reason, 'request-header-changed');
    assert.equal(f.latest().netFreedTokens, null);
  }
});

test('unknown/throwing/malformed measurements do not block lifecycle observation', () => {
  const bad = [undefined, null, {}, { totalTokens: NaN }, { totalTokens: Infinity }, Promise.resolve(null)];
  for (const value of bad) {
    const f = fixture({ measure: () => value });
    assert.doesNotThrow(() => { f.start(); f.replace(f.summary()); f.end(); });
    assert.equal(f.latest().outcome, 'committed');
    assert.equal(f.latest().beforePressure, null); assert.equal(f.latest().afterPressure, null);
    assert.equal(f.latest().netFreedTokens, null);
    assert.equal(f.latest().comparison.reason, 'measurement-unavailable');
  }
  const f = fixture({ measure() { throw new Error('private data'); } });
  assert.doesNotThrow(() => { f.start(); f.replace(f.summary()); f.end(); });
  assert.equal(f.latest().outcome, 'committed');
});

test('rejects stale revision, mismatched nodes, corrupt prices and totals', () => {
  const corruptions = [m => { m.logRevision--; }, m => { m.nodes[0].seq = 12345; },
    m => { m.nodes[0].heuristicTokens = -1; }, m => { m.nodes[0].tokens = NaN; },
    m => { m.surfaceTokens++; }, m => { m.baseline.kind = 'invented'; },
    m => { m.surfaceDeltaTokens = Infinity; }, m => { m.totalTokens++; },
    m => { m.baseline.kind = 'none'; }];
  for (const corrupt of corruptions) {
    let f;
    f = fixture({ measure() { const m = f.measurement(); corrupt(m); return m; } });
    f.start(); f.replace(f.summary()); f.end();
    assert.equal(f.latest().outcome, 'committed');
    assert.equal(f.latest().netFreedTokens, null);
  }
});

test('bad message estimator and clock stay diagnostic-only', () => {
  for (const estimateMessage of [() => NaN, () => -1, () => Infinity, () => undefined, () => { throw new Error('secret'); }]) {
    const f = fixture({ estimateMessage }); f.start(); f.replace(f.summary()); f.end();
    assert.equal(f.latest().outcome, 'committed'); assert.equal(f.latest().netFreedTokens, null);
  }
  const progress = new CompactionProgress({ now() { throw new Error('broken clock'); } });
  const f = fixture({ progress }); f.start(); f.end();
  assert.equal(f.latest().durationMs, null); assert.equal(f.latest().outcome, 'unknown');
});

test('status is detached, contains no content, errors, headers, usage or history', () => {
  const f = fixture(); f.start(); f.replace(f.summary()); f.end();
  const status = f.progress.status(f.session);
  status.counts.committed = 999; status.latest.beforePressure.tokens = 0; status.latest.comparison.reason = 'mutated';
  assert.equal(f.progress.status(f.session).counts.committed, 1);
  assert.equal(f.latest().beforePressure.tokens, 130); assert.equal(f.latest().comparison.reason, null);
  const json = JSON.stringify(f.progress.status(f.session));
  for (const secret of ['old secret', 'ciphertext', 'do-not-retain', 'private system', 'usage', 'shadowedSeqs']) assert.equal(json.includes(secret), false);
});

test('new instance does not replay history or invent before pressure', () => {
  const f = fixture(); f.start(); f.replace(f.summary()); f.end();
  const fresh = new CompactionProgress();
  assert.deepEqual(fresh.status(f.session), { observed: false, counts: { started: 0, committed: 0, failed: 0, unknown: 0 }, latest: null, lastCommitted: null });
  const end = f.end(); fresh.observe(f.session, end);
  assert.equal(fresh.status(f.session).latest, null);
});

test('steps between starts, duplicate events and latest-only counts are deterministic', () => {
  const f = fixture(); const start = f.start(); f.progress.observe(f.session, start); f.end('a', { error: 'failed' });
  f.emit('step/start'); f.emit('step/start'); f.start('b');
  assert.equal(f.latest().stepInterval, 2);
  assert.equal(f.progress.status(f.session).counts.started, 2);
  f.replace(f.summary('b')); const end = f.end('b'); f.progress.observe(f.session, end);
  assert.equal(f.progress.status(f.session).counts.committed, 1);
  assert.equal(f.latest().compactionId, 'b');
});

test('missing observed event is unknown even without visible surface change', () => {
  const f = fixture(); f.start(); f.emit('step/start', {}, {}, false); f.replace(f.summary()); f.end();
  assert.equal(f.latest().outcome, 'committed'); assert.equal(f.latest().comparison.reason, 'event-gap');
  assert.equal(f.latest().netFreedTokens, null);
});

test('invalid shadow ranges cannot claim a valid replacement', () => {
  const f = fixture(); f.start(); const summary = f.summary('a', { shadowedSeqs: [1, 0] });
  f.replace(summary); f.end();
  assert.equal(f.latest().outcome, 'unknown'); assert.equal(f.latest().netFreedTokens, null);
});

test('ordinary events outside a flight never traverse surface, header or meter', () => {
  const calls = { surface: 0, header: 0, measure: 0 };
  const progress = new CompactionProgress({ measure() { calls.measure++; } });
  const session = { id: 'idle', seq: 0,
    get surface() { calls.surface++; return { nodes: [] }; },
    requestHeader() { calls.header++; return {}; } };
  for (const type of ['assistant/chunk', 'step/start', 'assistant/message', 'compaction/end']) {
    const event = { seq: session.seq++, type, data: {} };
    progress.observe(session, event);
  }
  assert.deepEqual(calls, { surface: 0, header: 0, measure: 0 });
  assert.equal(progress.status(session).latest, null);
});

test('late historical starts never fabricate their before measurement', () => {
  const f = fixture(); const start = f.start(); f.replace(f.summary()); f.end();
  let calls = 0;
  const progress = new CompactionProgress({ measure() { calls++; return f.measurement(); } });
  progress.observe(f.session, start);
  assert.equal(progress.status(f.session).latest.beforePressure, null);
  assert.equal(progress.status(f.session).latest.comparison.basis, 'unknown');
  assert.equal(calls, 0);
});

test('sessions are isolated, storage bounded to 256 and clear forgets all metadata', () => {
  const progress = new CompactionProgress();
  const first = fixture({ progress, id: 'first' }); first.start();
  const second = fixture({ progress, id: 'second' }); second.start(); second.end('a', { error: 'fail' });
  assert.equal(first.latest().outcome, 'pending'); assert.equal(second.latest().outcome, 'failed');
  for (let i = 0; i < 255; i++) fixture({ progress, id: `s-${i}` }).start();
  assert.equal(progress.status(first.session).observed, false);
  assert.equal(progress.status(second.session).observed, true);
  progress.clear();
  assert.equal(progress.status(second.session).observed, false);
  assert.equal(progress.status({ id: 's-254' }).observed, false);
});
