import { LlmError, assertProviderCompatibility } from './compatibility.js';
import { CodexRuntimeBridge } from './runtime-service.js';
import { requireRuntime, isNativeCarrier } from './runtime-adapter.js';
import { NativeCompactionSeam } from './native-seam.js';
import { commandLogPreferenceRecovery } from './preference-recovery.js';
import { ROUTE, STANDARD_ROUTE, failure } from './constants.js';

export const name = 'dsh-codex-compaction/provider';
export const inject = ['llm'];

/**
 * Generic DSH route/reader entry, separate from compaction policy and setup UI.
 * `nativeCompaction` is the profile-level preference and stays OFF by default;
 * per-session /codex-native overrides inherit from it.
 */
export function apply(ctx, config = {}) {
  if (Object.keys(config).some(key => key !== 'nativeCompaction')
      || (config.nativeCompaction !== undefined && typeof config.nativeCompaction !== 'boolean')) {
    throw failure('CODEX_NATIVE_CONFIG', 'The provider bridge accepts no credential or endpoint configuration.');
  }
  assertProviderCompatibility(ctx);
  let currentRuntime;
  let seamActive = false;
  // Restart survival: the durable host command log (public events only)
  // restores an explicitly persisted per-session preference.
  const bridge = new CodexRuntimeBridge(ctx, () => currentRuntime, {
    profileNative: config.nativeCompaction === true,
    recoverPreference: commandLogPreferenceRecovery(ctx),
  });
  ctx.on('session/event', (session, event) => {
    bridge.progress.observe(session, event);
    bridge.nativeState.recovery.observe(session, event);
  });
  ctx.on('dispose', () => { bridge.nativeState.recovery.clear(); bridge.progress.clear(); });
  ctx.inject(['codexRuntime', 'llm'], ownerCtx => {
    const runtime = requireRuntime(ownerCtx.codexRuntime);
    currentRuntime = runtime;
    const unregister = ownerCtx.llm.registerAdapter([ROUTE], bridge.adapter);
    // Registered only after the account capability exists, and without prepend,
    // so account-owned llm/stream preparation still runs before a short-circuit.
    const seam = new NativeCompactionSeam({ adapter: bridge.adapter, getRuntime: () => currentRuntime, state: bridge.nativeState });
    const disposeSeam = ownerCtx.on('llm/stream', (options, next) => seam.dispatch(options, next));
    seamActive = true;
    return () => {
      seamActive = false;
      disposeSeam();
      unregister();
      if (currentRuntime === runtime) currentRuntime = undefined;
    };
  });
  // Remains when the policy entry is disabled. Whole-package removal still
  // removes this bridge and requires preserving a compatible native reader.
  ctx.on('llm/stream', (options, next) => {
    const explicitReader = options.provider === STANDARD_ROUTE && options.purpose === 'compaction'
      && bridge.nativeState.sessionPreference(options.sessionId) === 'reader-text';
    if (options.provider === ROUTE || (!explicitReader && !options.messages.some(isNativeCarrier))) return next();
    // The seam (when the account capability is present) owns standard-route
    // carriers after account preparation; nothing else may carry them.
    if (options.provider === STANDARD_ROUTE && seamActive) return next();
    if (options.provider === STANDARD_ROUTE) {
      throw new LlmError('Native Codex checkpoints require the Accounts & Usage native reader; it is unavailable in this host.', 'CODEX_NATIVE_READER_UNAVAILABLE');
    }
    throw new LlmError(`Native Codex history requires its matching ${ROUTE} reader and account.`, 'CODEX_NATIVE_FOREIGN_REPLAY');
  }, { global: true, prepend: true });
}
