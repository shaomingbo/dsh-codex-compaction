import { BasicCompactionEngine, BlockAssembler } from './compatibility.js';
import { STANDARD_ROUTE, ROUTE, failure, ENGINE_ALGORITHM_VERSION } from './constants.js';
import { historyHasImages, isNativeCarrier, operationDiagnostic } from './runtime-adapter.js';
import { isRecoverableNativeFailure } from './native-seam.js';
import { sanitizeCompactHistory } from './compact-history.js';
import { isDeterministicLocalFailure, inputFingerprint } from './recovery.js';
import { assessDeferral, GUARD_ALGORITHM } from './request-guard.js';
import { COMPACTION_INSTRUCTION, READER_FIDELITY_NOTE } from './summary-instruction.js';

export const name = 'dsh-codex-compaction/compaction';
export const inject = [...BasicCompactionEngine.inject, 'codexBridge'];
export const Config = BasicCompactionEngine.Config;

/** Only summarize is customized. Basic owns all selection, pricing and writes. */
export class CodexNativeCompactionEngine extends BasicCompactionEngine {
  async summarize(input, agent, signal) {
    signal?.throwIfAborted();
    const bridge = this.ctx.codexBridge;
    const state = bridge.nativeState;
    const sessionId = agent.session.id;
    await state.ready(sessionId);
    signal?.throwIfAborted();
    const conversation = agent.session.requestHeader()?.config ?? agent.options;
    const routePolicy = this.config.modelPolicies.find(p => p.provider === conversation?.provider && p.model === conversation?.model);
    const provider = routePolicy?.summarizationProvider ?? this.config.summarizationProvider;
    const model = routePolicy?.summarizationModel ?? this.config.summarizationModel;
    const target = provider ? { provider, model } : conversation;
    const carriers = input.messages.some(isNativeCarrier);
    // The preset-local native default, guard config, and retention switch are
    // resolved per AGENT through the official preset registry (the same
    // serviceFor mechanism the root bridge uses), so a Native-preset default
    // never leaks into standard presets sharing the root bridge, and no realm
    // visibility assumption is involved. Absent row (standard presets or a
    // minimal host context) keeps Basic, no guard, no hints.
    let presetNative = false;
    let guardConfig;
    let sourceRetention = false;
    try {
      const presets = typeof this.ctx?.get === 'function' ? this.ctx.get('agentPresets') : undefined;
      const presetPolicy = typeof presets?.serviceFor === 'function' ? presets.serviceFor(agent, 'codexNativePolicy') : undefined;
      presetNative = typeof presetPolicy?.presetNativeDefault === 'function' && presetPolicy.presetNativeDefault() === true;
      if (typeof presetPolicy?.efficiencyGuard === 'function') {
        guardConfig = presetPolicy.efficiencyGuard();
        if (guardConfig === null) throw failure('CODEX_NATIVE_CONFIG', 'The preset efficiency guard configuration is malformed.');
      }
      if (typeof presetPolicy?.sourceRetention === 'function') sourceRetention = presetPolicy.sourceRetention() === true;
    } catch (error) {
      if (error?.code === 'CODEX_NATIVE_CONFIG') throw error;
      presetNative = false;
    }
    const enabled = bridge.nativeCompaction !== false && state.effective(sessionId, presetNative);
    const supported = [STANDARD_ROUTE, ROUTE].includes(target?.provider);
    if (!enabled || !supported) {
      if (carriers) throw failure('CODEX_NATIVE_READER_REQUIRED', 'Native checkpoint compaction requires its enabled matching owner reader.');
      return super.summarize(input, agent, signal);
    }
    const explicitReader = state.sessionPreference(sessionId) === 'reader-text';
    const gate = await bridge.nativeApplicability(target.model, signal);
    signal?.throwIfAborted();
    if (!gate.applicable) {
      // An opted-in request with unavailable/unknown identity or protocol never
      // gets reinterpreted as a plain request, even without an old checkpoint.
      throw failure('CODEX_NATIVE_REPLAY_UNAVAILABLE', `Owner reader unavailable (${gate.reason}); no fallback was sent.`);
    }
    const images = historyHasImages(input.messages);
    if (images && !carriers && !explicitReader) return super.summarize(input, agent, signal);
    const readerText = explicitReader || images;
    const maxTokens = routePolicy?.maxTokens ?? this.config.maxTokens;
    // Config identity for the deterministic fingerprint and the guard: the
    // summarization target, output budget, and guard policy.
    const configVersion = JSON.stringify([ENGINE_ALGORITHM_VERSION, target?.provider, target?.model,
      maxTokens ?? null, guardConfig === undefined ? 'guard:off' : { 'guard': guardConfig, algorithm: GUARD_ALGORITHM },
      sourceRetention ? 'retention:source-aware-v1' : 'retention:off']);
    const options = { provider: target.provider, model: target.model, sessionId, purpose: 'compaction',
      messages: [...input.messages, { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION
        + (explicitReader ? `\n\n${READER_FIDELITY_NOTE}` : '') }] }],
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }), maxTokens, signal,
      fingerprint: { digest: inputFingerprint(input.messages, input.tools), configVersion } };
    const adapter = bridge.adapter;
    const flight = state.recovery.begin(options);
    let lease, kind = readerText ? 'reader-text' : 'native', cause;
    const record = extra => state.recordAttempt(sessionId, { kind, model: target.model,
      ...(readerText ? { reason: explicitReader ? 'explicit-reader-text' : 'image-history' } : {}),
      ...(cause ? { cause } : {}), ...extra });
    const defer = reason => failure('CODEX_NATIVE_COMPACTION_DEFERRED',
      `Native compaction deferred before any request (${reason}); this is a local efficiency decision, not a remote failure. Manual /compact bypasses efficiency deferral.`);
    const text = async () => {
      const assembler = new BlockAssembler();
      let terminal = false;
      for await (const chunk of adapter.seamStreamOnLease(lease, options)) {
        if (chunk.type === 'finish') terminal = chunk.reason?.kind === 'stop';
        assembler.push(chunk);
      }
      signal?.throwIfAborted();
      if (!terminal || assembler.finish.kind !== 'stop') throw failure(assembler.finish.failure?.code ?? 'CODEX_NATIVE_READER_FAILED', 'Owner text summary did not finish successfully.');
      const rawOutput = assembler.blocks();
      if (rawOutput.some(block => block.type !== 'text' && block.type !== 'reasoning')) throw failure('CODEX_NATIVE_INVALID_RESULT', 'Owner summary contains unsupported output.');
      const summary = rawOutput.filter(block => block.type === 'text');
      if (!summary.some(block => block.text.trim())) throw failure('CODEX_NATIVE_INVALID_RESULT', 'Owner summary is empty.');
      // Direct owner converter is NOT this context's ctx.llm.stream call.
      return { summary, rawOutput, provider: target.provider, model: target.model, maxTokens,
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage }) };
    };
    // Snapshot the last attempt BEFORE recording 'running', so the guard's
    // config comparison reads the PREVIOUS attempt (not the current one that
    // is about to overwrite it). Successful outcomes AND deferrals carry the
    // configVersion that produced them, preserving the comparison baseline
    // across consecutive deferrals. Reader-text attempts do not carry the
    // guard baseline (different code path).
    const previousAttempt = state.lastAttempt(sessionId);
    const baselineConfigVersion = previousAttempt && ['native', 'fallback-text', 'deferred'].includes(previousAttempt.outcome)
      && previousAttempt.configVersion !== undefined
      ? previousAttempt.configVersion : undefined;
    record({ outcome: 'running' });
    try {
      // Pure-local history/schema prechecks run BEFORE any lease opens, so a
      // deterministically bad input can never reach the remote request path.
      if (!readerText) sanitizeCompactHistory(input.messages);
      // Efficiency guard (preset-opt-in): assess with bounded observer facts
      // only, before any HTTP. Unknown measurements never defer.
      if (!readerText && guardConfig !== undefined) {
        // Read the last COMMITTED result from the observer — not `latest`,
        // which is overwritten to 'pending' when the current transaction's
        // compaction/start event arrives before summarize executes.
        const lastCommitted = bridge.progress.status(agent.session)?.lastCommitted ?? null;
        // Configuration-change protection: the guard baseline must come from
        // the SAME configuration that produced it. A changed config (guard
        // parameters, summarization target, output budget, retention switch)
        // invalidates the previous commit as a comparison baseline, so the
        // guard must NOT defer on it. The baseline is read from the attempt
        // recorded BEFORE this run's 'running' marker overwrote it.
        const configChanged = baselineConfigVersion !== undefined && baselineConfigVersion !== configVersion;
        let currentSurfaceTokens;
        try { currentSurfaceTokens = this.ctx.tokenMeter?.measure(agent.session)?.surfaceTokens; }
        catch { currentSurfaceTokens = undefined; }
        const verdict = assessDeferral({ manual: state.recovery.manualCompaction(sessionId), latest: lastCommitted,
          currentSurfaceTokens, nowMs: state.recovery.now(), ...(configChanged ? { configChanged: true } : {}) }, guardConfig);
        if (verdict.defer) throw defer(verdict.reason);
      }
      lease = await adapter.seamLease({ model: target.model, signal });
      let result;
      if (readerText) result = await text();
      else {
        let native;
        try { native = await adapter.seamCompactOnLease(lease, { model: target.model, messages: input.messages, tools: input.tools, signal, retention: sourceRetention }); }
        catch (error) {
          if (carriers || !isRecoverableNativeFailure(error, signal)) throw error;
          // Exactly one text fallback, on the SAME lease/account. No native retry.
          cause = error.code;
          kind = 'fallback';
          result = await text();
        }
        if (native) result = { summary: [{ type: 'text', text: native.envelope }], provider: target.provider, model: target.model,
          ...(native.usage === undefined ? {} : { usage: native.usage }) };
      }
      signal?.throwIfAborted();
      const diagnostics = operationDiagnostic(lease);
      record({ outcome: kind === 'fallback' ? 'fallback-text' : kind, configVersion,
        ...(diagnostics?.requests !== undefined ? { httpRequests: diagnostics.requests } : {}), diagnostics });
      return result;
    } catch (error) {
      if (error.code === 'CODEX_NATIVE_COMPACTION_DEFERRED') {
        // A deferral is not a summary, not a fallback and not a remote failure:
        // HTTP stays 0, no history is written, and it never counts as a
        // failure for cooldown or fingerprint purposes.
        flight.ignored = true;
        record({ outcome: 'deferred', reason: error.message.match(/\(([^)]+)\)/)?.[1] ?? 'low-gain', httpRequests: 0, configVersion });
        throw error;
      }
      record({ outcome: 'failed', cause: cause ?? error.code, failure: error.code, diagnostics: operationDiagnostic(lease, error) });
      if (signal?.aborted || error.name === 'AbortError' || ['ABORTED', 'CODEX_RUNTIME_CANCELLED'].includes(error.code)) flight.ignored = true;
      else if (isDeterministicLocalFailure(error)) {
        // Deterministic local failure: block the exact input+config instead of
        // arming the transient 60s cooldown.
        state.recovery.deterministic(flight, { digest: options.fingerprint.digest, configVersion, errorClass: error.code });
      }
      else state.recovery.fail(flight, error.code);
      signal?.throwIfAborted();
      throw error;
    } finally {
      state.recovery.release(flight);
      lease?.close();
    }
  }
}

export function apply(ctx, config = {}) {
  if (ctx.get('compaction') !== undefined) throw failure('CODEX_NATIVE_ENGINE_COLLISION', 'Mount one engine per isolated compaction realm.');
  return new CodexNativeCompactionEngine(ctx, config);
}
