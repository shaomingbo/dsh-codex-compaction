// Guard-level efficiency check on the SAME synthetic corpus driven twice:
//   old = pre-candidate policy (no preset efficiency guard)
//   new = candidate policy (preset efficiency guard enabled)
//
// SCOPE: this file exercises the guard's DECISION on the engine entry
// (`engine.summarize`), so it proves deferral/bypass/no-regression and that no
// content is mutated. It does NOT commit through a Basic transaction and
// therefore does NOT provide R1 M2's 提交数 / framed 净收益 / 下一请求 prompt /
// 召回 pairing — those are provided by the real-owner same-corpus benchmark
// inside test/accounts.integration.js ("R1 M2 same-corpus benchmark"), which
// drives the real public entry (compactIfNeeded on the isolated owner snapshot).
// Wall time is reported for information only and never asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { engineFixture, user } from './helpers/engine.js';
import { DEFAULT_GUARD_CONFIG } from '../src/request-guard.js';

// Fixed corpus: every fact below must survive on the wire under BOTH policies.
const FACTS = ['Do not restart DSH', '/fixture/source.ts', 'pending validation', 'Latest tail'];
// The exact corpus submitted for summarization, identical across every pair.
const CORPUS = [
  user(`${FACTS[0]}. Preserve ${FACTS[1]} and ${FACTS[2]}. ${'c'.repeat(400)}`),
  user(`${FACTS[3]}: continue with validation.`),
];

const factReport = text => ({
  required: FACTS.length,
  present: FACTS.filter(fact => text.includes(fact)).length,
  missing: FACTS.filter(fact => !text.includes(fact)),
});

/** Seed one committed compaction through the real session lifecycle. */
function seedCommit(session, { shadowedChars, replacementChars, id = 'seed' }) {
  session.append('user/message', { role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: `${FACTS[0]}. Preserve ${FACTS[1]} and ${FACTS[2]}. ${'h'.repeat(shadowedChars)}` }] }, { surfaceOp: 'append' });
  const shadowed = session.surface.nodes.at(-1);
  const start = session.append('compaction/start', { compactionId: id });
  const summary = session.append('compaction/summary', { compactionId: id, summary: [{ type: 'text', text: 's' }],
    shadowedRange: { start: shadowed, end: shadowed }, shadowedSeqs: [shadowed], shadowedTokenCount: Math.ceil(shadowedChars / 4) });
  session.append('user/message', { role: 'user', source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    content: [{ type: 'text', text: `${FACTS[0]}. Preserve ${FACTS[1]} and ${FACTS[2]}. ${'r'.repeat(replacementChars)}` }] },
  { surfaceOp: { op: 'replace', startSeq: shadowed, endSeq: shadowed }, sourceEventSeqs: [start.seq, summary.seq, shadowed] });
  session.append('compaction/end', { compactionId: id });
}

async function runScenario(t, { guard, shadowedChars, replacementChars, manual }) {
  const f = await engineFixture(t, { presetNative: true, ...(guard === undefined ? {} : { guard }) });
  const started = process.hrtime.bigint();
  seedCommit(f.session, { shadowedChars, replacementChars, id: manual ? 'manual' : 'seed' });
  const seeded = f.ctx.codexBridge.progress.status(f.session).latest;
  if (manual) f.session.append('compaction/start', { compactionId: 'manual-now', sourceCommandId: '/compact' });
  const corpusSnapshot = JSON.stringify(CORPUS);
  const httpBefore = f.fake.calls.length;
  let outcome = 'committed', failure, resultText;
  try {
    const result = await f.summarize(CORPUS);
    resultText = result?.summary?.[0]?.text;
    if (manual) f.session.append('compaction/end', { compactionId: 'manual-now' });
    failure = result ? undefined : 'no-result';
  } catch (error) { outcome = error.code ?? 'threw'; failure = error.code; }
  const http = f.fake.calls.length - httpBefore;
  // What actually left for the owner, and what the next request would carry.
  const wire = JSON.stringify(f.fake.calls.at(-1)?.context ?? {});
  f.session.append('user/message', { role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: `${FACTS[3]}: continue with validation.` }] }, { surfaceOp: 'append' });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    policy: guard === undefined ? 'old' : 'new',
    outcome: outcome === 'committed' ? 'committed' : outcome,
    http, opens: f.fake.opened,
    seededNetFreed: seeded?.netFreedTokens ?? null,
    seededCommitted: seeded?.outcome ?? null,
    // A committed attempt is one whose native result carried the checkpoint envelope.
    nativeResultReturned: typeof resultText === 'string' && resultText.startsWith('<dsh-codex-compaction-v1'),
    surfacePromptTokens: f.ctx.tokenMeter.measure(f.session).totalTokens,
    submittedInputFacts: factReport(wire),
    // A deferral must neither send a request nor rewrite the submitted history.
    requestLeft: http > 0,
    corpusUnchanged: JSON.stringify(CORPUS) === corpusSnapshot,
    automaticReaderText: f.ctx.codexBridge.nativeState.lastAttempt(f.session.id)?.outcome === 'reader-text',
    failure,
    wallMs: Math.round(wallMs),
  };
}

async function pair(t, name, options) {
  const oldRow = await runScenario(t, { ...options, guard: undefined });
  const newRow = await runScenario(t, { ...options, guard: true });
  return [{ scenario: name, ...oldRow }, { scenario: name, ...newRow }];
}

test('guard-level same-corpus check: low-gain deferral, manual bypass, sufficient gain', async t => {
  const rows = [];
  // Scenario 1: short-interval LOW-gain automatic compaction — the sample R1 M2
  // requires to issue fewer HTTP requests under the candidate policy.
  rows.push(...await pair(t, 'auto-low-gain-short-interval', { shadowedChars: 4000, replacementChars: 3960 }));
  // Scenario 2: manual compaction of the same low-gain corpus must NOT be
  // suppressed by the efficiency guard (manual bypass, no regression).
  rows.push(...await pair(t, 'manual-low-gain', { shadowedChars: 4000, replacementChars: 3960, manual: true }));
  // Scenario 3: sufficient-gain automatic compaction must still run (control).
  rows.push(...await pair(t, 'auto-sufficient-gain', { shadowedChars: 80_000, replacementChars: 400 }));

  const of = name => rows.filter(row => row.scenario === name);
  const lowGain = of('auto-low-gain-short-interval');
  const manual = of('manual-low-gain');
  const sufficient = of('auto-sufficient-gain');

  // --- The R1 M2 pass conditions. ---
  // Fewer HTTP requests on the low-gain short-interval sample, with no false commit.
  assert.equal(lowGain[0].policy, 'old');
  assert.equal(lowGain[0].http, 1, 'the old policy sends the low-gain request');
  assert.equal(lowGain[1].http, 0, 'the candidate policy defers it with zero HTTP');
  assert.equal(lowGain[1].opens, 0, 'a deferred request never opens an owner lease');
  assert.equal(lowGain[1].nativeResultReturned, false, 'a deferral returns no native result (no false commit)');
  assert.equal(lowGain[1].outcome, 'CODEX_NATIVE_COMPACTION_DEFERRED');
  // Manual compaction is not suppressed by an efficiency deferral.
  assert.equal(manual[0].http, 1);
  assert.equal(manual[1].http, 1, 'manual compaction bypasses efficiency deferral');
  assert.equal(manual[1].nativeResultReturned, true, 'manual compaction still produces a native result');
  // Sufficient gain is never deferred.
  assert.equal(sufficient[0].http, 1);
  assert.equal(sufficient[1].http, 1, 'a sufficiently large gain is not deferred');
  // The guard must never silently switch the session to reader-text.
  assert.ok(rows.every(row => row.automaticReaderText === false), 'no automatic reader-text in any policy');
  // Recall parity: the same corpus puts the same authoritative facts on the wire
  // under both policies — the guard changes request COUNT, not request CONTENT.
  for (const row of rows) {
    if (row.requestLeft) {
      assert.deepEqual(row.submittedInputFacts.missing, [], `${row.scenario}/${row.policy} must send every authoritative fact`);
      assert.equal(row.submittedInputFacts.present, row.submittedInputFacts.required);
    } else {
      assert.equal(row.policy, 'new');
      assert.equal(row.http, 0, `${row.scenario}: only a zero-HTTP deferral may skip the wire check`);
    }
    // Whatever the policy decided, the submitted history is never rewritten.
    assert.equal(row.corpusUnchanged, true, `${row.scenario}/${row.policy} must not mutate the submitted corpus`);
  }
  for (const name of ['auto-low-gain-short-interval', 'manual-low-gain', 'auto-sufficient-gain']) {
    const [oldRow, newRow] = of(name);
    assert.equal(newRow.seededNetFreed, oldRow.seededNetFreed, `${name}: identical corpus must yield identical measured gain`);
    assert.equal(newRow.surfacePromptTokens, oldRow.surfacePromptTokens, `${name}: the surface prompt is unchanged by a pure decision change`);
  }
  // The guard's own thresholds are the ones under test, not re-tuned here.
  assert.equal(DEFAULT_GUARD_CONFIG.minNetFreedTokens, 4096);
  assert.equal(DEFAULT_GUARD_CONFIG.minRatio, 0.1);

  const report = { benchmark: 'guard-level-deferral-check', basis: 'fixed synthetic corpus, identical configuration per pair',
    scope: 'guard decision on the engine entry; not the R1 M2:146 commit/benefit/recall pairing',
    guardConfig: DEFAULT_GUARD_CONFIG, facts: FACTS, rows };
  if (process.env.EFFICIENCY_REPORT_PATH) writeFileSync(process.env.EFFICIENCY_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[benchmark] ${rows.length} rows; low-gain HTTP old=${lowGain[0].http} new=${lowGain[1].http}; report=${process.env.EFFICIENCY_REPORT_PATH ?? '(not written)'}`);
});
