// Preset-local native-default policy. Mounted only inside the declarative
// codex-native-b preset; standard presets mount no such row and stay Basic.
import { failure } from './constants.js';
import { resolveGuardConfig } from './request-guard.js';

export const name = 'dsh-codex-compaction/native-policy';

/**
 * Publish the preset's native summarization default, its native request guard
 * configuration, and the experimental source-aware retention switch. The row
 * accepts `{ nativeDefault?: boolean, efficiencyGuard?: boolean | object,
 * sourceRetention?: boolean }`; it owns no routing, credential or engine
 * concern, and the global nativeCompaction capability flag stays a separate
 * gate that never carries user preference.
 */
export function apply(ctx, config = {}) {
  const keys = Object.keys(config);
  if (keys.some(key => key !== 'nativeDefault' && key !== 'efficiencyGuard' && key !== 'sourceRetention')
      || (config.nativeDefault !== undefined && typeof config.nativeDefault !== 'boolean')
      || (config.sourceRetention !== undefined && typeof config.sourceRetention !== 'boolean')) {
    throw failure('CODEX_NATIVE_CONFIG', 'The native policy row accepts only { nativeDefault?: boolean, efficiencyGuard?: boolean | object, sourceRetention?: boolean }.');
  }
  const guardConfig = resolveGuardConfig(config.efficiencyGuard);
  if (config.efficiencyGuard !== undefined && guardConfig === null) {
    throw failure('CODEX_NATIVE_CONFIG', 'The efficiencyGuard value must be a boolean or a nonnegative numeric policy object.');
  }
  const nativeDefault = config.nativeDefault === true;
  ctx.provide('codexNativePolicy', Object.freeze({
    presetNativeDefault: () => nativeDefault,
    ...(config.efficiencyGuard === undefined ? {} : { efficiencyGuard: () => structuredClone(guardConfig) }),
    ...(config.sourceRetention === undefined ? {} : { sourceRetention: () => config.sourceRetention === true }),
  }));
}
