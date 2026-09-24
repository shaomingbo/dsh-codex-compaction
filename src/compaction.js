import { BasicCompactionEngine, BlockAssembler } from './compatibility.js';
import { STANDARD_ROUTE, ROUTE, failure } from './constants.js';
import { historyHasImages, isNativeCarrier, operationDiagnostic } from './runtime-adapter.js';
import { isRecoverableNativeFailure } from './native-seam.js';
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
    const policy = this.config.modelPolicies.find(p => p.provider === conversation?.provider && p.model === conversation?.model);
    const provider = policy?.summarizationProvider ?? this.config.summarizationProvider;
    const model = policy?.summarizationModel ?? this.config.summarizationModel;
    const target = provider ? { provider, model } : conversation;
    const carriers = input.messages.some(isNativeCarrier);
    const enabled = bridge.nativeCompaction !== false && state.effective(sessionId);
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
    const maxTokens = policy?.maxTokens ?? this.config.maxTokens;
    const options = { provider: target.provider, model: target.model, sessionId, purpose: 'compaction',
      messages: [...input.messages, { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION
        + (explicitReader ? `\n\n${READER_FIDELITY_NOTE}` : '') }] }],
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }), maxTokens, signal };
    const adapter = bridge.adapter;
    const flight = state.recovery.begin(options);
    let lease, kind = readerText ? 'reader-text' : 'native', cause;
    const record = extra => state.recordAttempt(sessionId, { kind, model: target.model,
      ...(readerText ? { reason: explicitReader ? 'explicit-reader-text' : 'image-history' } : {}),
      ...(cause ? { cause } : {}), ...extra });
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
    record({ outcome: 'running' });
    try {
      lease = await adapter.seamLease({ model: target.model, signal });
      let result;
      if (readerText) result = await text();
      else {
        let native;
        try { native = await adapter.seamCompactOnLease(lease, { model: target.model, messages: input.messages, tools: input.tools, signal }); }
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
      record({ outcome: kind === 'fallback' ? 'fallback-text' : kind, diagnostics: operationDiagnostic(lease) });
      return result;
    } catch (error) {
      record({ outcome: 'failed', cause: cause ?? error.code, failure: error.code, diagnostics: operationDiagnostic(lease, error) });
      if (signal?.aborted || error.name === 'AbortError' || ['ABORTED', 'CODEX_RUNTIME_CANCELLED'].includes(error.code)) flight.ignored = true;
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
