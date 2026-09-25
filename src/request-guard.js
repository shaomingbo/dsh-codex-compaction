// Native request guard: pure, metadata-only deferral assessment executed by
// the engine before any native HTTP. The observer supplies bounded facts; the
// guard never owns a token meter, never writes history, and a deferral is
// never reported as a summary, a fallback, or a remote failure.
//
// Initial policy (source-aware efficiency work lands separately): if the last
// COMMITTED native compaction for this session released less than
// minNetFreedTokens heuristic tokens OR less than minRatio of the replaced
// content, and less than windowMs has elapsed since that commit, and the
// surface has not grown by at least surfaceGrowthTokens heuristic tokens
// since that commit, an AUTOMATIC compaction defers. Manual compaction
// bypasses efficiency deferral only — safety checks still run upstream.
// Unknown measurements, an incomparable basis, missing facts, or a changed
// configuration never defer.

export const GUARD_ALGORITHM = 'codex-native-guard/1';
export const DEFAULT_GUARD_CONFIG = Object.freeze({
  minNetFreedTokens: 4096,
  minRatio: 0.1,
  windowMs: 60_000,
  surfaceGrowthTokens: 4096,
});

const number = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);

/** Resolve a preset-supplied guard config: false/undefined disables. */
export function resolveGuardConfig(value) {
  if (value === undefined || value === false) return undefined;
  const base = value === true ? {} : (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
  if (base === null) return null; // malformed: caller fail-closes
  const resolved = {};
  for (const key of ['minNetFreedTokens', 'minRatio', 'windowMs', 'surfaceGrowthTokens']) {
    if (base[key] === undefined) continue;
    const value = base[key];
    if (!Number.isFinite(value) || value < 0) return null;
    resolved[key] = value;
  }
  return Object.freeze({ ...DEFAULT_GUARD_CONFIG, ...resolved });
}

/**
 * @param {object} input
 * @param {boolean} input.manual - the open transaction is user-initiated.
 * @param {object|null} input.latest - the observer's latest committed result
 *   (outcome, netFreedTokens, shadowedTokens, comparison, durationMs,
 *   endedAtMs, afterSurfaceTokens).
 * @param {number|null} input.currentSurfaceTokens - live surface measurement.
 * @param {number} input.nowMs
 * @returns {{defer:boolean, reason?:string}} defer is never based on pressure
 *   or a remote verdict; it is a local efficiency decision only.
 */
export function assessDeferral({ manual, latest, currentSurfaceTokens, nowMs, configChanged }, config = DEFAULT_GUARD_CONFIG) {
  if (manual === true) return { defer: false, reason: 'manual-bypass' };
  // A changed configuration invalidates the previous commit as a comparison
  // baseline: the guard must not defer on a measurement from another config.
  if (configChanged === true) return { defer: false, reason: 'config-changed' };
  // Facts must exist and be comparable; anything unknown never defers.
  if (!latest || latest.outcome !== 'committed') return { defer: false, reason: 'no-committed-baseline' };
  const { netFreedTokens, shadowedTokens, comparison, endedAtMs, afterSurfaceTokens } = latest;
  if (comparison?.basis !== 'fixed-heuristic-message-delta' || comparison.reason !== null) {
    return { defer: false, reason: 'comparison-unknown' };
  }
  if (!Number.isFinite(netFreedTokens) || !Number.isFinite(shadowedTokens) || shadowedTokens <= 0
      || !Number.isFinite(endedAtMs) || !Number.isFinite(afterSurfaceTokens)) {
    return { defer: false, reason: 'measurement-unknown' };
  }
  const lowGain = netFreedTokens < number(config.minNetFreedTokens, DEFAULT_GUARD_CONFIG.minNetFreedTokens)
    || netFreedTokens / shadowedTokens < number(config.minRatio, DEFAULT_GUARD_CONFIG.minRatio);
  if (!lowGain) return { defer: false, reason: 'sufficient-gain' };
  const elapsed = nowMs - endedAtMs;
  if (!Number.isFinite(elapsed) || elapsed >= number(config.windowMs, DEFAULT_GUARD_CONFIG.windowMs)) {
    return { defer: false, reason: 'window-elapsed' };
  }
  const growth = Number.isFinite(currentSurfaceTokens)
    ? currentSurfaceTokens - afterSurfaceTokens
    : Number.NaN;
  if (!Number.isFinite(growth) || growth >= number(config.surfaceGrowthTokens, DEFAULT_GUARD_CONFIG.surfaceGrowthTokens)) {
    return { defer: false, reason: Number.isFinite(growth) ? 'surface-grew' : 'surface-unknown' };
  }
  return { defer: true, reason: 'low-gain-short-interval', algorithm: GUARD_ALGORITHM };
}
