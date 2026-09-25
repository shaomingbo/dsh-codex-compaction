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
  /** Preset default for one agent, resolved from that agent's mounted preset.
   * Standard presets mount no codexNativePolicy row, so their default stays
   * Basic; the root bridge never propagates the Native preset's default. */
  presetNativeDefault(agent) {
    try {
      const presets = this.ctx.get('agentPresets');
      const policy = typeof presets?.serviceFor === 'function' ? presets.serviceFor(agent, 'codexNativePolicy') : undefined;
      return typeof policy?.presetNativeDefault === 'function' && policy.presetNativeDefault() === true;
    } catch { return false; }
  }
  setNativePreference(sessionId, mode, options) { return this.nativeState.setSession(sessionId, mode, options); }
  async nativePreferenceStatus(agent, sessionId) {
    // Backward-compatible single-argument form: a bare session id resolves
    // without a preset default (the constructor profile flag applies), which
    // keeps existing callers and the command surface stable.
    const legacy = sessionId === undefined && typeof agent === 'string';
    const id = legacy ? agent : sessionId;
    await this.nativeState.ready(id);
    return this.nativeState.nativeStatus(id, {
      ...(legacy ? {} : { presetNative: agent === undefined ? undefined : this.presetNativeDefault(agent) }),
      capability: this.nativeCompaction !== false,
    });
  }
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
  /** Bounded carrier readability: presence plus the replay-gate verdict.
   * OFF stops new native creation; existing carriers still report whether the
   * owner reader could replay them. No history write, no authentication. */
  async carrierReadability(session, agent, signal) {
    let carriers;
    try { carriers = session.deriveMessages().filter(isNativeCarrier).length; }
    catch { return { kind: 'unavailable' }; }
    if (!carriers) return { kind: 'absent', carriers: 0 };
    const target = session.requestHeader()?.config ?? agent?.options ?? {};
    const verdict = target.model
      ? await this.nativeApplicability(target.model, signal)
      : { applicable: false, reason: 'NO_MODEL' };
    signal?.throwIfAborted();
    return { kind: 'present', carriers, readable: verdict.applicable === true,
      ...(verdict.applicable ? {} : { reason: verdict.reason }) };
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
