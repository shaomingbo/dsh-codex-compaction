// Reproducible offline comparison. Writes only this experiment's result artifact.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { calibrateA, runMatrix, restoredRounds, runFailures, usageAnchorChallenge, summarizeResults } from './compare.js';
import { VARIANTS, hash, MODEL } from './fixtures.js';
import { ROUTE } from './a-baseline/constants.js';

const calibration = await calibrateA();
try {
  const matrix = await runMatrix(calibration);
  const restoration = [];
  for (const variant of VARIANTS) restoration.push(await restoredRounds(variant, calibration));
  for (let round = 0; round < 3; round++) {
    for (let variant = 1; variant < restoration.length; variant++) {
      assert.equal(restoration[0].rounds[round].inputHash, restoration[variant].rounds[round].inputHash, 'Restored provider input must be identical across all variants.');
      assert.equal(restoration[0].rounds[round].outputHash, restoration[variant].rounds[round].outputHash);
      assert.equal(restoration[0].rounds[round].normalInferenceInputHash, restoration[variant].rounds[round].normalInferenceInputHash, 'Normal inference replay must also carry identical provider inputs.');
      assert.equal(restoration[0].rounds[round].expandedHistoryHash, restoration[variant].rounds[round].expandedHistoryHash);
    }
    assert.equal(restoration[0].rounds[round].effectiveTokensAfter, restoration[1].rounds[round].effectiveTokensAfter);
  }
  const failures = await runFailures(calibration);
  const usageAnchors = [];
  for (const variant of VARIANTS) usageAnchors.push(await usageAnchorChallenge(variant, calibration));
  assert.ok(usageAnchors.every(row => row.avoidsDoubleCounting), 'The repaired prototype must not double-count the usage anchor.');
  const sourceHashes = {};
  for (const path of ['PROTOCOL.md', 'a-host.js', 'b-host.js', 'b-backend.js', 'fixtures.js', 'compare.js', 'run.js', 'restore-worker.js', 'comparison.test.js', 'b-backend.test.js', 'usage-anchor-observation.json', '../../package.json', './a-baseline/auth.js', './a-baseline/constants.js', './a-baseline/compatibility.js', './a-baseline/compaction.js', './a-baseline/checkpoint.js', './a-baseline/provider.js', './a-baseline/native-transport.js', './a-baseline/replay.js', '../../pnpm-lock.yaml']) {
    sourceHashes[path] = hash(await readFile(new URL(path, import.meta.url), 'utf8'));
  }
  const libraryVersions = {};
  for (const pkg of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-token-meter', '@deepseek-ai/dsh-llm-pi-ai', '@earendil-works/pi-ai']) {
    // Metadata observation only, not a private runtime code import; pi-ai does
    // not export package.json even though its installed manifest is readable.
    libraryVersions[pkg] = JSON.parse(await readFile(new URL(`../../node_modules/${pkg}/package.json`, import.meta.url), 'utf8')).version;
  }
  const sourceInventory = {};
  for (const path of ['./a-baseline/compaction.js', 'b-backend.js', 'b-host.js']) {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    sourceInventory[path] = { linesIncludingCommentsAndBlanks: text.trimEnd().split('\n').length, bytes: Buffer.byteLength(text) };
  }
  const traceDifferences = failures.filter(row => row.scenario === 'abort-before').map(row => ({ variant: row.variant, starts: row.starts, ends: row.ends, nativeCalls: row.nativeCalls, nativeReplacement: row.nativeReplacement }));
  const result = { schemaVersion: 1, experiment: 'compaction-carrier-and-pricing-ab',
    environment: { node: process.version, platform: process.platform, arch: process.arch, libraryVersions },
    controls: { model: MODEL, providerRoute: ROUTE, seedFamilies: ['ascii', 'cjk', 'tool'], sourceChars: [4000, 16000, 64000], cipherChars: [256, 1024, 4096, 8192, 16384, 32768, 65536, 131072], identicalNativeOutput: true, fakeAuthAndProviderOnly: true, productionBackendUsed: false, archivedABaseline: '0.1.0-alpha.1' },
    summary: { ...summarizeResults(matrix, restoration, failures), admissionMatrixBaseline: 'heuristic-only', usageAnchorResults: usageAnchors }, traceDifferences, sourceInventory, sourceHashes,
    limitations: ['No real Codex requests or provider-token oracle', 'Initial B usage double-counting and its repair are explicitly measured; passing the synthetic anchor challenge is not a production accuracy proof', 'No semantic task-fidelity or latency measurement', 'No automatic-compaction trigger implementation comparison', 'JSONL/public Session restore and separate-process checkpoint reads are not a full DSH app or production persistence restart', 'Single-version compatibility only; source size is not measured upgrade cost', 'B uses a disclosed estimator; its advantages cannot establish estimator accuracy'],
    matrix, restoration, failures };
  await writeFile(new URL('./rerun-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result.summary, traceDifferences, sourceInventory, resultFile: 'experiments/compaction-ab/rerun-results.json' }, null, 2));
} finally { await calibration.dispose(); }
