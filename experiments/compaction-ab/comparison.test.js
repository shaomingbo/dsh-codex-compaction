import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrateA, runMatrix, restoredRounds, runFailures, usageAnchorChallenge } from './compare.js';
import { VARIANTS } from './fixtures.js';

test('matched-price ablation holds inputs and admission constant across all history families', async () => {
  const c = await calibrateA();
  try {
    const rows = await runMatrix(c, { bulkSizes: [4000], cipherSizes: [256, 4096] });
    assert.equal(rows.length, 18);
    const boundary = rows.filter(r => r.family === 'ascii' && r.cipherChars === 4096);
    assert.deepEqual(boundary.map(r => r.accepted), [false, false, true]);
    // This asserts estimator sensitivity, NOT actual token or quality improvement.
    assert.ok(boundary[0].aFramedCheckpointPrice >= boundary[0].selectedEffectiveTokens);
    assert.ok(boundary[2].nativeCheckpointEstimate < boundary[2].selectedEffectiveTokens);
  } finally { await c.dispose(); }
});

test('structured metadata cannot be treated as free host context', async () => {
  const c = await calibrateA();
  try {
    const rows = await runMatrix(c, { families: ['ascii'], bulkSizes: [64000], cipherSizes: [16384] });
    const [a, matched, native] = rows;
    assert.equal(a.effectiveTokensAfter, matched.effectiveTokensAfter);
    assert.ok(matched.hostTokensAfter < matched.effectiveTokensAfter);
    assert.ok(native.hostTokensAfter < native.effectiveTokensAfter);
    assert.equal(a.referenceNativeEstimateAfter, native.referenceNativeEstimateAfter);
    assert.equal(a.expandedHistoryHash, native.expandedHistoryHash);
    assert.ok(matched.compactionEventBytes < a.compactionEventBytes);
  } finally { await c.dispose(); }
});

test('three rounds survive JSONL and a separate-process checkpoint read with identical provider inputs', async () => {
  const c = await calibrateA();
  try {
    const runs = [];
    for (const variant of VARIANTS) runs.push(await restoredRounds(variant, c));
    for (let i = 0; i < 3; i++) {
      assert.equal(runs[0].rounds[i].inputHash, runs[1].rounds[i].inputHash);
      assert.equal(runs[0].rounds[i].inputHash, runs[2].rounds[i].inputHash);
      assert.equal(runs[0].rounds[i].outputHash, runs[2].rounds[i].outputHash);
      assert.equal(runs[0].rounds[i].normalInferenceInputHash, runs[1].rounds[i].normalInferenceInputHash);
      assert.equal(runs[0].rounds[i].normalInferenceInputHash, runs[2].rounds[i].normalInferenceInputHash);
      assert.equal(runs[0].rounds[i].effectiveTokensAfter, runs[1].rounds[i].effectiveTokensAfter);
      assert.ok(runs.every(r => r.rounds[i].separateProcessCheckpointVerified));
    }
    assert.ok(runs.every(r => r.flushes === 3 && r.wrongIdentityRejectedBeforeFetch && r.normalReplayIdentityRejectedBeforeFetch));
  } finally { await c.dispose(); }
});

test('failure safety matches while pre-cancel trace differences are explicitly retained', async () => {
  const c = await calibrateA();
  try {
    const rows = await runFailures(c);
    assert.equal(rows.length, 33);
    assert.deepEqual(rows.filter(r => r.scenario === 'abort-before').map(r => [r.starts, r.ends]), [[1, 1], [0, 0], [0, 0]]);
    assert.ok(rows.filter(r => r.scenario === 'rewrite-selected').every(r => r.nativeOutputs === 1 && r.selectedRewriteSurvived));
    assert.ok(rows.filter(r => r.scenario === 'flush-error').every(r => r.nativeReplacement && r.outcome === 'persistence-error-after-replacement'));
  } finally { await c.dispose(); }
});

test('usage-anchor repair removes the measured double count; the original formula remains an explicit ablation', async () => {
  const c = await calibrateA();
  try {
    const rows = [];
    for (const variant of VARIANTS) rows.push(await usageAnchorChallenge(variant, c));
    assert.ok(rows.every(row => row.baselineKind === 'usage' && row.realProviderUsage === false));
    // 0.1.7 composes the reused usage baseline with the surface nodes after the
    // anchor (the anchor message itself contributes 17 heuristic tokens), so the
    // host total is baseline + surfaceDelta — not the bare reported total.
    assert.deepEqual(rows.map(row => row.baselineTokens), [10010, 10010, 10010]);
    assert.ok(rows.every(row => row.hostTokens === row.baselineTokens + row.surfaceDeltaTokens));
    assert.deepEqual(rows.map(row => row.avoidsDoubleCounting), [true, true, true]);
    // The repaired formula must never add anything on top of the host's own
    // total, whatever that total is.
    assert.deepEqual(rows.map(row => row.effectiveTokens), rows.map(row => row.hostTokens));
    assert.deepEqual(rows.map(row => row.duplicateAdjustment), [0, 0, 0]);
    assert.deepEqual(rows.map(row => row.naiveDuplicateAdjustment), [0, 4293, 2933]);
    // Keep the pre-fix effect reproducible without shipping that defect or
    // treating synthetic reported usage as a real-provider token oracle.
  } finally { await c.dispose(); }
});

test('controlled quantitative rows are deterministic, not timing samples', async () => {
  const c = await calibrateA();
  try {
    const options = { families: ['tool'], bulkSizes: [4000], cipherSizes: [256, 4096] };
    assert.deepEqual(await runMatrix(c, options), await runMatrix(c, options));
  } finally { await c.dispose(); }
});
