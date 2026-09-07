import { Service } from './compatibility.js';
import { OwnerBoundCodexAdapter, requireRuntime, inspectCarrier, isNativeCarrier } from './runtime-adapter.js';
import { NativeSessionState } from './native-seam.js';

/** DSH-specific bridge only; authenticated execution belongs to the account Module. */
export class CodexRuntimeBridge extends Service {
  constructor(ctx, getRuntime, { profileNative = false, recoverPreference } = {}) {
    super(ctx, 'codexBridge');
    this.getRuntime = getRuntime;
    this.adapter = new OwnerBoundCodexAdapter(getRuntime);
    this.nativeState = new NativeSessionState(profileNative, recoverPreference);
  }
  runtime() { return requireRuntime(this.getRuntime()); }
  describe() { return this.runtime().describe(); }
  compact(input, agent, signal) { return this.adapter.compact(input, agent, signal); }
  readCheckpoint(message, expected) {
    if (!isNativeCarrier(message)) return undefined;
    return inspectCarrier(this.runtime(), message, expected);
  }
  validateCheckpoint(record, expected) { return this.runtime().validateCheckpoint(record, expected); }
  estimateCheckpoint(record) { return this.runtime().estimateCheckpoint(record); }
  setNativePreference(sessionId, mode) { return this.nativeState.setSession(sessionId, mode); }
  nativePreferenceStatus(sessionId) { return this.nativeState.nativeStatus(sessionId); }
  /** Standard-route takeover verdict; never resolves authentication. */
  async nativeApplicability(model, signal) {
    let runtime;
    try { runtime = this.runtime(); }
    catch { return { applicable: false, reason: 'CODEX_RUNTIME_UNAVAILABLE' }; }
    if (typeof runtime.applicability !== 'function') return { applicable: false, reason: 'CODEX_SEAM_CAPABILITY_MISSING' };
    try {
      const verdict = await runtime.applicability({ provider: 'openai-codex', model, signal });
      if (verdict?.applicable === true) return { applicable: true, ...(verdict.model === undefined ? {} : { model: verdict.model }) };
      return { applicable: false, reason: typeof verdict?.reason === 'string' && verdict.reason ? verdict.reason : 'CODEX_SEAM_UNKNOWN_REASON' };
    } catch (error) {
      signal?.throwIfAborted();
      return { applicable: false, reason: typeof error?.code === 'string' && error.code ? error.code : 'CODEX_RUNTIME_ERROR' };
    }
  }
}
