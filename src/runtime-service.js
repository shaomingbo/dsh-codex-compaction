import { Service, resolveImageAttachmentAccess } from './compatibility.js';
import { OwnerBoundCodexAdapter, requireRuntime, inspectCarrier, isNativeCarrier } from './runtime-adapter.js';
import { NativeSessionState } from './native-seam.js';
import { CompactionProgress } from './compaction-progress.js';

/** DSH-specific bridge only; authenticated execution belongs to the account Module. */
export class CodexRuntimeBridge extends Service {
  constructor(ctx, getRuntime, { profileNative = false, recoverPreference } = {}) {
    super(ctx, 'codexBridge');
    this.getRuntime = getRuntime;
    this.adapter = new OwnerBoundCodexAdapter(getRuntime, {
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments,
        hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    });
    this.nativeState = new NativeSessionState(profileNative, recoverPreference);
    this.progress = new CompactionProgress({
      measure: session => ctx.get('tokenMeter')?.measure(session),
      estimateMessage: message => ctx.get('tokenMeter')?.estimateMessage(message),
    });
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
  /** Metadata-only; snapshot inspection never binds authentication or changes history. */
  compactionProgress(session) {
    const observed = this.progress.status(session);
    try {
      const carriers = session.deriveMessages().filter(isNativeCarrier);
      if (!carriers.length) return { ...observed, native: { kind: 'absent', carriers: 0 } };
      let clients = 0, retainedUtf16Units = 0, opaqueUtf16Units = 0;
      for (const carrier of carriers) {
        const record = this.readCheckpoint(carrier);
        for (const item of record.items) {
          if (['user', 'developer', 'system'].includes(item.role)) {
            clients++;
            retainedUtf16Units += typeof item.content === 'string' ? item.content.length
              : (item.content ?? []).reduce((n, part) => n + (typeof part.text === 'string' ? part.text.length : 0), 0);
          }
          if (item.type === 'compaction' && typeof item.encrypted_content === 'string') opaqueUtf16Units += item.encrypted_content.length;
        }
      }
      return { ...observed, native: { kind: 'observed', carriers: carriers.length, clients,
        retainedUtf16Units, opaqueUtf16Units, basis: 'wire-text-utf16-length-not-provider-tokens' } };
    } catch { return { ...observed, native: { kind: 'unavailable' } }; }
  }
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
