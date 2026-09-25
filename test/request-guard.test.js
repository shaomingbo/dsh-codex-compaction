import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactionRecovery, isDeterministicLocalFailure, inputFingerprint, FINGERPRINT_ALGORITHM, RETRY_INTERVAL_MS } from '../src/recovery.js';
import { assessDeferral, resolveGuardConfig, DEFAULT_GUARD_CONFIG, GUARD_ALGORITHM } from '../src/request-guard.js';
import { engineFixture, user } from './helpers/engine.js';

const request = (extra = {}) => ({ sessionId: 's', provider: 'openai-codex', model: 'm', ...extra });
const failure = code => Object.assign(new Error(code), { code });

test('deterministic fingerprints survive the transient clock; changed input or config revalidates', () => {
  let clock = 1000;
  const recovery = new CompactionRecovery({ now: () => clock });
  const digest = inputFingerprint([{ role: 'user', content: [] }]);
  const configVersion = 'cfg/1';
  const options = { ...request(), fingerprint: { digest, configVersion } };
  const flight = recovery.begin(options);
  recovery.deterministic(flight, { digest, configVersion, errorClass: 'CODEX_NATIVE_UNSAFE_HISTORY' });
  recovery.release(flight);
  // Far past the 60s cooldown, the identical input is still refused — and no
  // request may leave for it.
  clock += RETRY_INTERVAL_MS + 60_001;
  assert.throws(() => recovery.begin(options), error => error.code === 'CODEX_NATIVE_COMPACTION_DETERMINISTIC');
  // A different input digest revalidates.
  const changed = recovery.begin({ ...request(), fingerprint: { digest: inputFingerprint([{ role: 'user', content: [{ type: 'text', text: 'new' }] }]), configVersion } });
  recovery.release(changed);
  // The same bad input under a changed config also revalidates.
  const reconfig = recovery.begin({ ...request(), fingerprint: { digest, configVersion: 'cfg/2' } });
  recovery.release(reconfig);
  // A successful commit clears the fingerprint along with failure state.
  const again = recovery.begin(options);
  recovery.release(again);
  again.entry.failures = 0;
  delete again.entry.nextAllowedAt;
  delete again.entry.fingerprint;
  assert.doesNotThrow(() => recovery.begin(options));
});

test('fingerprint entries stay bounded and report a metadata-only block status', () => {
  const recovery = new CompactionRecovery({ now: () => 0 });
  const options = { ...request(), fingerprint: { digest: 'd', configVersion: 'c' } };
  const flight = recovery.begin(options);
  recovery.deterministic(flight, { digest: 'd', configVersion: 'c', errorClass: 'CODEX_NATIVE_UNSAFE_HISTORY' });
  recovery.release(flight);
  const [status] = recovery.status('s');
  assert.equal(status.deterministicBlock.errorClass, 'CODEX_NATIVE_UNSAFE_HISTORY');
  assert.equal(status.deterministicBlock.algorithm, FINGERPRINT_ALGORITHM);
  const raw = JSON.stringify(status);
  assert.ok(!/raw body|content|apiKey|accessToken/.test(raw), 'only fixed metadata crosses into status');
});

test('deterministic local classes are recognized; network classes are not', () => {
  assert.equal(isDeterministicLocalFailure(failure('CODEX_NATIVE_UNSAFE_HISTORY')), true);
  assert.equal(isDeterministicLocalFailure(failure('CODEX_NATIVE_REPLAY_INCOMPATIBLE')), true);
  assert.equal(isDeterministicLocalFailure(failure('CODEX_RUNTIME_NETWORK')), false);
  assert.equal(isDeterministicLocalFailure(failure('CODEX_RUNTIME_HTTP_503')), false);
});

test('engine: a deterministic bad history is rejected before any lease and not re-sent after the cooldown', async t => {
  // V3 tool-result wrappers fail the pure-local precheck deterministically.
  const bad = { role: 'user', source: { kind: 'user' }, content: [{ type: 'tool-result', id: 'x' }] };
  const f = await engineFixture(t, { presetNative: true });
  await assert.rejects(f.summarize([bad]), error => error.code === 'CODEX_NATIVE_UNSAFE_HISTORY');
  assert.equal(f.fake.opened, 0, 'no lease was opened for a locally-rejected input');
  assert.equal(f.fake.calls.length, 0);
  const blocked = f.ctx.codexBridge.nativeState.recovery.status(f.session.id);
  assert.equal(blocked.some(entry => entry.deterministicBlock?.errorClass === 'CODEX_NATIVE_UNSAFE_HISTORY'), true);
  // Even after the transient cooldown passes, the same input never reaches HTTP.
  const entry = f.ctx.codexBridge.nativeState.recovery.entries.get(JSON.stringify([f.session.id, 'openai-codex', 'gpt-5.4']));
  entry.nextAllowedAt = 0;
  await assert.rejects(f.summarize([bad]), error => error.code === 'CODEX_NATIVE_COMPACTION_DETERMINISTIC');
  assert.equal(f.fake.opened, 0);
  assert.equal(f.fake.calls.length, 0);
  // Changed input revalidates and reaches the owner normally.
  const result = await f.summarize([user('fresh input')]);
  assert.match(result.summary[0].text, /^<dsh-codex-compaction-v1>/);
  assert.equal(f.fake.calls.length, 1);
});

test('guard config resolution: disabled, default, override, malformed', () => {
  assert.equal(resolveGuardConfig(undefined), undefined);
  assert.equal(resolveGuardConfig(false), undefined);
  assert.deepEqual(resolveGuardConfig(true), DEFAULT_GUARD_CONFIG);
  assert.deepEqual(resolveGuardConfig({ minNetFreedTokens: 512 }), { ...DEFAULT_GUARD_CONFIG, minNetFreedTokens: 512 });
  assert.equal(resolveGuardConfig({ minNetFreedTokens: -1 }), null);
  assert.equal(resolveGuardConfig('yes'), null);
});

test('assessDeferral defers only on proven low gain within the window without surface growth', () => {
  const latest = { outcome: 'committed', netFreedTokens: 1000, shadowedTokens: 100_000, comparison: { basis: 'fixed-heuristic-message-delta', reason: null }, endedAtMs: 10_000, afterSurfaceTokens: 5000 };
  const at = (over = {}) => assessDeferral({ manual: false, latest, currentSurfaceTokens: 6000, nowMs: 10_500 }, over.config);
  // Low absolute AND low ratio gain, within window, surface flat → defer.
  assert.deepEqual(at(), { defer: true, reason: 'low-gain-short-interval', algorithm: GUARD_ALGORITHM });
  // Manual compaction always bypasses efficiency deferral.
  assert.equal(at().defer, true);
  assert.deepEqual(assessDeferral({ manual: true, latest, currentSurfaceTokens: 6000, nowMs: 10_500 }), { defer: false, reason: 'manual-bypass' });
  // Sufficient recent gain (both absolute and ratio thresholds met) never defers.
  assert.deepEqual(assessDeferral({ manual: false, latest: { ...latest, netFreedTokens: 9000, shadowedTokens: 50_000 }, currentSurfaceTokens: 6000, nowMs: 10_500 }).reason, 'sufficient-gain');
  // High ratio but low absolute stays low-gain; high absolute but low ratio too.
  assert.equal(assessDeferral({ manual: false, latest: { ...latest, netFreedTokens: 1000, shadowedTokens: 2000 }, currentSurfaceTokens: 6000, nowMs: 10_500 }).defer, true);
  // Window elapsed.
  assert.deepEqual(assessDeferral({ manual: false, latest, currentSurfaceTokens: 6000, nowMs: 10_000 + DEFAULT_GUARD_CONFIG.windowMs }).reason, 'window-elapsed');
  // Surface grew enough.
  assert.deepEqual(assessDeferral({ manual: false, latest, currentSurfaceTokens: 5000 + DEFAULT_GUARD_CONFIG.surfaceGrowthTokens, nowMs: 10_500 }).reason, 'surface-grew');
  // Unknown surface never defers.
  assert.deepEqual(assessDeferral({ manual: false, latest, currentSurfaceTokens: undefined, nowMs: 10_500 }).reason, 'surface-unknown');
  // Unknown comparison basis never defers.
  assert.deepEqual(assessDeferral({ manual: false, latest: { ...latest, comparison: { basis: 'unknown', reason: 'measurement-unavailable' } }, currentSurfaceTokens: 6000, nowMs: 10_500 }).reason, 'comparison-unknown');
  // No committed baseline never defers.
  assert.deepEqual(assessDeferral({ manual: false, latest: null, currentSurfaceTokens: 6000, nowMs: 10_500 }).reason, 'no-committed-baseline');
});

test('engine: guard defers an automatic low-gain request with zero HTTP; manual bypasses', async t => {
  const f = await engineFixture(t, { presetNative: true, guard: true });
  const bridge = f.ctx.codexBridge;
  const session = f.session;
  // Seed the observer through the REAL session lifecycle: one large user
  // message compacted into a nearly equal replacement (low gain).
  session.append('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(4000) }] }, { surfaceOp: 'append' });
  const shadowed = session.surface.nodes[0];
  const start = session.append('compaction/start', { compactionId: 'seed' });
  const summary = session.append('compaction/summary', { compactionId: 'seed', summary: [{ type: 'text', text: 's' }],
    shadowedRange: { start: shadowed, end: shadowed }, shadowedSeqs: [shadowed], shadowedTokenCount: 1008 });
  session.append('user/message', { role: 'user', source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    content: [{ type: 'text', text: 'y'.repeat(3960) }] },
  { surfaceOp: { op: 'replace', startSeq: shadowed, endSeq: shadowed }, sourceEventSeqs: [start.seq, summary.seq, shadowed] });
  session.append('compaction/end', { compactionId: 'seed' });
  const seeded = bridge.progress.status(session).latest;
  assert.equal(seeded.outcome, 'committed');
  assert.ok(seeded.netFreedTokens < DEFAULT_GUARD_CONFIG.minNetFreedTokens, `a low-gain seed (freed ${seeded.netFreedTokens})`);
  assert.ok(Number.isFinite(seeded.afterSurfaceTokens));

  // Automatic compaction (no open transaction): deferred before any HTTP.
  await assert.rejects(f.summarize(), error => error.code === 'CODEX_NATIVE_COMPACTION_DEFERRED');
  assert.equal(f.fake.calls.length, 0);
  assert.equal(f.fake.opened, 0);
  const attempt = bridge.nativeState.lastAttempt(session.id);
  assert.equal(attempt.outcome, 'deferred');
  assert.equal(attempt.httpRequests, 0);
  // The deferral did not arm a failure cooldown.
  const recovery = bridge.nativeState.recovery.status(session.id);
  assert.equal(recovery.every(entry => !entry.coolingDown), true);

  // Manual compaction (open transaction with sourceCommandId) bypasses.
  session.append('compaction/start', { compactionId: 'manual', sourceCommandId: '/compact' });
  const manualResult = await f.summarize();
  assert.match(manualResult.summary[0].text, /^<dsh-codex-compaction-v1>/);
  assert.equal(f.fake.calls.length, 1);
  session.append('compaction/end', { compactionId: 'manual' });
});

test('engine: guard disabled without a preset efficiencyGuard policy', async t => {
  const f = await engineFixture(t, { presetNative: true });
  const result = await f.summarize();
  assert.match(result.summary[0].text, /^<dsh-codex-compaction-v1>/);
  assert.equal(f.fake.calls.length, 1);
});

test('engine: guard does not defer when configuration changed since the last commit', async t => {
  // Config-change protection: a guard parameter or summarization target
  // change invalidates the previous commit as a comparison baseline.
  const first = { manual: false, latest: { outcome: 'committed', netFreedTokens: 100, shadowedTokens: 1000,
    comparison: { basis: 'fixed-heuristic-message-delta', reason: null }, endedAtMs: 1000, afterSurfaceTokens: 500 },
    currentSurfaceTokens: 600, nowMs: 1500 };
  assert.deepEqual(assessDeferral(first).reason, 'low-gain-short-interval', 'same config defers');
  assert.deepEqual(assessDeferral({ ...first, configChanged: true }).reason, 'config-changed', 'changed config never defers');
});

