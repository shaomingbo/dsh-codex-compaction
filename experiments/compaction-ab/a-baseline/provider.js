// Archived A baseline: preserve pre-B production behavior for the A/B experiment.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { LlmAdapter, LlmError, PiAiAdapter, PiAiConfig, BlockAssembler, attributionHeaders, resolveRetryPolicy } from './compatibility.js';
import { encodeCheckpoint } from './checkpoint.js';
import { NativeTransport } from './native-transport.js';
import { prepareReplay, expandReplay, assertTextHistory } from './replay.js';
import { NO_AMBIENT_AUTH } from './auth.js';
import { ROUTE, NATIVE_PROVIDER, DISPLAY_NAME, failure } from './constants.js';

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const NO_CREDENTIALS = { read: async () => undefined, list: async () => [], modify: async () => { throw failure('CODEX_LAB_AUTH_SCOPE', 'Unexpected secondary credential mutation.'); }, delete: async () => { throw failure('CODEX_LAB_AUTH_SCOPE', 'Unexpected secondary credential deletion.'); } };
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const numeric = value => Number.isFinite(value) && value >= 0 ? value : 0;
function mapUsage(usage) {
  const result = emptyUsage();
  const cached = numeric(usage?.input_tokens_details?.cached_tokens);
  return { ...result, input: Math.max(0, numeric(usage?.input_tokens) - cached), output: numeric(usage?.output_tokens), cacheRead: cached, totalTokens: numeric(usage?.total_tokens) };
}
function textStream(model, action, signal) {
  const stream = createAssistantMessageEventStream();
  const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now() };
  void Promise.resolve().then(action).then(({ text, usage }) => {
    signal?.throwIfAborted();
    stream.push({ type: 'start', partial: message });
    message.content.push({ type: 'text', text: '' });
    stream.push({ type: 'text_start', contentIndex: 0, partial: message });
    message.content[0].text = text;
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
    message.usage = mapUsage(usage);
    stream.push({ type: 'done', reason: 'stop', message });
  }).catch(error => {
    message.stopReason = signal?.aborted ? 'aborted' : 'error';
    message.errorMessage = typeof error?.code === 'string' && error.code.startsWith('CODEX_') ? error.code : 'CODEX_LAB_NATIVE_FAILED';
    stream.push({ type: 'error', reason: message.stopReason, error: message });
  });
  return stream;
}

/** Wire transport is fixed, attributed, non-redirecting and injectable for offline tests. */
export function attributedFetch(fetchImpl) {
  return (input, init = {}) => {
    if (String(input) !== ENDPOINT) throw failure('CODEX_LAB_ENDPOINT', 'Codex request attempted an unsupported endpoint.');
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value);
    return fetchImpl(input, { ...init, headers, redirect: 'error' });
  };
}

/** Outer DSH route is isolated; each operation gets its own converter and auth snapshot. */
export class CodexLabAdapter extends LlmAdapter {
  constructor({ provider, auth, fetch: fetchImpl = globalThis.fetch, timeoutMs = 120000 }) {
    super();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw failure('CODEX_LAB_TIMEOUT', 'Operation timeout must be 1–120000 ms.');
    this.timeoutMs = timeoutMs;
    this.provider = provider;
    this.auth = auth;
    this.fetch = attributedFetch(fetchImpl);
    this.retryPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'Codex Native Lab');
  }
  checkRoute(provider) {
    if (provider !== ROUTE) throw new LlmError('Codex Native Lab does not own this route.', 'NO_ADAPTER');
  }
  providerInfo(provider) { this.checkRoute(provider); return { id: ROUTE, name: DISPLAY_NAME }; }
  providerRetryPolicy(provider) { this.checkRoute(provider); return this.retryPolicy; }
  async listModels(provider) {
    this.checkRoute(provider);
    return this.provider.getModels().map(model => ({ provider: ROUTE, id: model.id, name: model.name, inputModalities: ['text'] }));
  }
  profile(provider) {
    // 0.1.7 profile schema: scalar defaults come from PiAiConfig, and the
    // adapter reads modelErrors/configuredMaxTokens Maps plus the image budget
    // fields on every resolved profile.
    const defaults = PiAiConfig({ providers: { [NATIVE_PROVIDER]: {} } }).providers.get()[NATIVE_PROVIDER];
    return new Map([[NATIVE_PROVIDER, { provider: NATIVE_PROVIDER, displayName: DISPLAY_NAME,
      piProvider: provider,
      streamIdleTimeoutMs: 120000,
      maxRequestImageBytes: defaults.maxRequestImageBytes,
      requestImagePixelBudget: defaults.requestImagePixelBudget,
      requestImageMaxBytes: defaults.requestImageMaxBytes,
      retryPolicy: this.retryPolicy, modelErrors: new Map(), configuredMaxTokens: new Map() }]]);
  }
  converter(provider, accessToken) {
    const profiles = this.profile(provider);
    return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => accessToken,
      auth: { credentials: NO_CREDENTIALS, authContext: NO_AMBIENT_AUTH },
      onReplayDegrade: () => { throw failure('CODEX_LAB_REPLAY_DEGRADED', 'Native reasoning replay became incompatible; use the matching plugin build.'); } });
  }
  async resolveModel(provider, model, signal) {
    this.checkRoute(provider); signal?.throwIfAborted();
    const metadata = await this.converter(this.provider).resolveModel(NATIVE_PROVIDER, model, signal);
    return { ...metadata, provider: ROUTE, inputModalities: ['text'] };
  }
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: options => {
      if (options.provider !== provider || options.model !== model) throw failure('CODEX_LAB_ROUTE_CHANGED', 'Prepared Codex route/model changed.');
      return this.stream(options);
    } };
  }
  async buildCall(options, native) {
    this.checkRoute(options.provider);
    options.signal?.throwIfAborted();
    assertTextHistory(options.messages);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline };
    // No auth resolution or provider I/O happens until inputs have passed the modality guard.
    const auth = await new Promise((resolve, reject) => {
      const stop = () => reject(options.signal.reason);
      options.signal.addEventListener('abort', stop, { once: true });
      Promise.resolve().then(() => { options.signal.throwIfAborted(); return this.auth.resolve({ signal: options.signal }); })
        .then(resolve, reject).finally(() => options.signal.removeEventListener('abort', stop));
    });
    options.signal?.throwIfAborted();
    const prepared = prepareReplay(options.messages, { provider: ROUTE, model: options.model, identity: auth.identity });
    const base = this.provider;
    let nativeFailure;
    const wrapped = { ...base,
      // pi-ai resolves an explicit per-request bearer override through its
      // public apiKey auth branch, even though humans only sign in via OAuth.
      auth: { ...base.auth, apiKey: { name: 'Request-scoped Codex OAuth bearer',
        async resolve({ credential }) { return credential?.key ? { auth: { apiKey: credential.key }, source: 'OAuth' } : undefined; } } },
      streamSimple: (model, context, streamOptions) => {
        if (native) return textStream(model, async () => {
          try {
            // The public converter uses undefined for absent optional wire fields.
            // Match its normal JSON wire serialization before strict native validation.
            const converted = JSON.parse(JSON.stringify(convertResponsesMessages(model, context, new Set(['openai', NATIVE_PROVIDER, 'opencode']), { includeSystemPrompt: false })));
            const input = expandReplay(converted, prepared.replacements);
            const tools = context.tools?.length ? JSON.parse(JSON.stringify(convertResponsesTools(context.tools, { strict: null, supportsStrictMode: model.compat?.supportsStrictMode ?? true, supportsOpenAIGrammarTools: false }))) : [];
            const transport = new NativeTransport({ fetch: this.fetch, identity: auth.identity, auth: async () => auth, timeoutMs: 120000 });
            const compacted = await transport.compact({ provider: ROUTE, model: options.model, input, instructions: context.systemPrompt ?? '', tools, signal: streamOptions.signal });
            return { text: encodeCheckpoint({ provider: ROUTE, model: options.model, identity: compacted.identity, items: compacted.items }), usage: compacted.usage };
          } catch (error) { nativeFailure = error; throw error; }
        }, streamOptions.signal);
        return base.streamSimple(model, context, { ...streamOptions, transport: 'sse', maxRetries: 0, fetch: this.fetch,
          onPayload: payload => {
            if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw failure('CODEX_LAB_BAD_PAYLOAD', 'Codex generated an invalid request.');
            return { ...payload, input: expandReplay(payload.input, prepared.replacements) };
          } });
      },
    };
    return { adapter: this.converter(wrapped, auth.accessToken), options: { ...options, provider: NATIVE_PROVIDER, messages: prepared.messages }, nativeFailure: () => nativeFailure };
  }
  async *stream(options) {
    if (options.purpose === 'compaction') throw failure('CODEX_LAB_PRESET_REQUIRED', 'Use the Codex Native Lab preset for compaction; generic text summarization is disabled on this route.');
    const call = await this.buildCall(options, false);
    const safeCode = code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'CODEX_LAB_PROVIDER_ERROR';
    try {
      for await (const chunk of call.adapter.stream(call.options)) {
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          const code = safeCode(chunk.reason.failure?.code);
          yield { ...chunk, reason: { kind: 'error', failure: { code, message: `Codex Native Lab request failed (${code}); provider response details were withheld.` } } };
        } else yield chunk;
      }
    } catch (error) {
      call.options.signal.throwIfAborted();
      const code = safeCode(error?.code);
      throw new LlmError(`Codex Native Lab request failed (${code}); provider response details were withheld.`, code);
    }
  }
  /** Invoked explicitly by the basic subclass: no purpose sniffing or trailing-message removal. */
  async compact(options) {
    const call = await this.buildCall(options, true);
    const assembler = new BlockAssembler();
    try { for await (const chunk of call.adapter.stream(call.options)) assembler.push(chunk); }
    catch (error) { throw call.nativeFailure() ?? error; }
    options.signal?.throwIfAborted();
    if (call.nativeFailure()) throw call.nativeFailure();
    if (assembler.finish?.kind !== 'stop') {
      throw failure('CODEX_LAB_NATIVE_FAILED', 'Native compaction did not complete; original history is retained.');
    }
    const summary = assembler.blocks();
    if (summary.length !== 1 || summary[0].type !== 'text') throw failure('CODEX_LAB_NATIVE_FAILED', 'Native compaction returned an invalid envelope.');
    return { summary, provider: ROUTE, model: options.model, ...(assembler.usage ? { usage: assembler.usage } : {}) };
  }
}
