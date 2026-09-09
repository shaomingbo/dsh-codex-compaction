// Generic DSH-to-owner-capability adapter. No OAuth, endpoint, or model catalog ownership.
import { randomUUID } from 'node:crypto';
import { LlmAdapter, LlmError, PiAiAdapter, PiAiConfig, BlockAssembler, resolveRetryPolicy, isCompactCheckpointSource } from './compatibility.js';
import { ROUTE, STANDARD_ROUTE, NATIVE_PROVIDER, DISPLAY_NAME, failure } from './constants.js';

const PREFIX = '<dsh-codex-compaction';
export const CODEC_PREFIX = PREFIX;
const EMPTY_CREDENTIALS = Object.freeze({ read: async () => undefined, list: async () => [],
  modify: async () => { throw failure('CODEX_BRIDGE_NO_CREDENTIALS', 'The compaction bridge does not own credentials.'); },
  delete: async () => { throw failure('CODEX_BRIDGE_NO_CREDENTIALS', 'The compaction bridge does not own credentials.'); } });
const NO_AMBIENT = Object.freeze({ env: async () => undefined, fileExists: async () => false });
const safeCode = code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'CODEX_RUNTIME_ERROR';
const codeError = error => {
  // Only the published converter's fixed timeout shape may cross this seam.
  // Never forward arbitrary SDK text or a cause that may carry request data.
  const idle = error instanceof LlmError && error.code === 'TIMEOUT'
    ? /^pi-ai stream idle timeout after ([1-9][0-9]{0,9})ms$/.exec(error.message) : undefined;
  if (idle && Number(idle[1]) <= 2147483647) {
    return new LlmError(`Codex stream idle timeout after ${idle[1]}ms without model output.`, 'TIMEOUT');
  }
  return new LlmError(`Codex owner-bound operation failed (${safeCode(error?.code)}); check Accounts & Usage and the native capability version.`, safeCode(error?.code));
};
// PiAi preserves the owner's errorMessage but reclassifies its code. Only recover
// exact owner-generated categories; never forward arbitrary SDK diagnostic text.
const ownerFailureCode = text => typeof text === 'string' && /^CODEX_RUNTIME_(?:HTTP_[1-5]\d{2}|HTTP_ERROR|NETWORK|REQUEST_PREPARE|RESPONSE_TYPE|RESPONSE_STREAM|RESPONSE_PROTOCOL|REQUEST_FAILED|TIMEOUT|CANCELLED|DISPOSED|CLOSED|NOT_READY|NOT_CONFIGURED)$/.exec(text)?.[0] === text ? text : undefined;

// Both the legacy A experiment and the new main path commit the owner codec's
// versioned envelope as a dedicated text block on a compact-checkpoint
// message. A basic text summary can quote that syntax anywhere; substring
// mentions are not state. Keep prefix-only detection (not successful
// decoding) so malformed/future native envelopes still fail closed rather
// than silently becoming ordinary text.
export function isNativeCarrier(message) {
  if (message?.source === undefined || !isCompactCheckpointSource(message.source)) return false;
  return message.source.nativeCodex !== undefined
    || (message.content ?? []).some(block => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(PREFIX));
}
const contentHasImages = blocks => (blocks ?? []).some(block => block.type === 'image'
  || (block.type === 'tool-result' && contentHasImages(block.content)));
/** Detect images, including durable images returned by tools. */
export const historyHasImages = messages => messages.some(message => contentHasImages(message?.content));
export function assertTextHistory(messages) {
  const inspect = blocks => {
    for (const block of blocks ?? []) {
      if (block.type === 'image') throw failure('CODEX_NATIVE_TEXT_ONLY', 'This manual native candidate supports text/tool histories only.');
      if (block.type === 'tool-result') inspect(block.content);
    }
  };
  for (const message of messages) inspect(message.content);
}
export function requireRuntime(runtime) {
  const methods = ['describe', 'models', 'open', 'encodeCheckpoint', 'decodeCheckpoint', 'validateCheckpoint', 'estimateCheckpoint'];
  if (runtime?.protocol !== 'codex-runtime/v1' || methods.some(method => typeof runtime?.[method] !== 'function')) {
    throw failure('CODEX_RUNTIME_UNAVAILABLE', 'This candidate requires Accounts & Usage with the codex-runtime/v1 capability. Existing login remains there; do not create or copy another grant.');
  }
  const description = runtime.describe();
  if (description?.route !== ROUTE || description?.authOwner !== 'dsh-token-usage') throw failure('CODEX_RUNTIME_INCOMPATIBLE', 'The account capability does not describe the supported Codex route/owner.');
  return runtime;
}

/** Pure source inspection delegates native JSON semantics to the owning runtime. */
export function inspectCarrier(runtime, message, expected) {
  if (!isNativeCarrier(message)) return undefined;
  // Replacing a carrier with its replay slot must not erase extra media.
  if (contentHasImages(message.content)) throw failure('CODEX_NATIVE_INVALID_CARRIER', 'Native checkpoint framing cannot contain image blocks.');
  const texts = message.content.filter(block => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(PREFIX));
  if (message.source.nativeCodex !== undefined) {
    if (texts.length) throw failure('CODEX_NATIVE_AMBIGUOUS_CARRIER', 'A checkpoint cannot contain both structured and envelope native payloads.');
    return runtime.validateCheckpoint(message.source.nativeCodex, expected);
  }
  if (texts.length !== 1) throw failure('CODEX_NATIVE_INVALID_CARRIER', 'Native checkpoint must contain exactly one envelope block.');
  const record = runtime.decodeCheckpoint(texts[0].text, expected);
  if (!record) throw failure('CODEX_NATIVE_INVALID_CARRIER', 'Native checkpoint framing is not supported.');
  return record;
}

function assertOperation(operation, model) {
  if (!operation || operation.binding?.provider !== ROUTE || operation.binding?.model !== model || typeof operation.binding?.identity !== 'string'
      || typeof operation.provider !== 'function' || typeof operation.close !== 'function' || typeof operation.compactionUsage !== 'function') {
    throw failure('CODEX_RUNTIME_INCOMPATIBLE', 'The account operation does not satisfy the native capability contract.');
  }
}
function closeOperation(operation) {
  if (typeof operation?.close !== 'function') return;
  try { operation.close(); } catch { throw failure('CODEX_RUNTIME_CLOSE_FAILED', 'The bound account operation could not be released cleanly.'); }
}

function prepareHistory(runtime, messages, binding) {
  const replay = [];
  const prepared = messages.map(message => {
    const checkpoint = inspectCarrier(runtime, message, binding);
    if (checkpoint) {
      const placeholder = `DSH_CODEX_OWNER_REPLAY_${randomUUID()}`;
      replay.push({ placeholder, checkpoint });
      return { ...message, content: [{ type: 'text', text: placeholder }] };
    }
    return message.source?.kind === 'model' && message.source.provider === ROUTE
      ? { ...message, source: { ...message.source, provider: NATIVE_PROVIDER } }
      : message;
  });
  return { messages: prepared, replay };
}

// Owner error chunks are re-labeled with the owner category only; arbitrary SDK
// diagnostic text never crosses the seam.
async function* relayOwnerChunks(chunks) {
  for await (const chunk of chunks) {
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      const code = ownerFailureCode(chunk.reason.failure?.message) ?? safeCode(chunk.reason.failure?.code);
      yield { ...chunk, reason: { kind: 'error', failure: { code, message: `Codex owner-bound operation failed (${code}); upstream details withheld.` } } };
    } else yield chunk;
  }
}

/**
 * Shared native replay stream behind both the registered ROUTE adapter and the
 * standard-route llm/stream seam. Carriers decode/replay through their exact
 * account binding; identity/format failures fail closed and never fall back.
 */
async function* ownerReplayStream(adapter, options) {
  options.signal?.throwIfAborted();
  const lease = await openLease(adapter, { model: options.model, signal: options.signal });
  try {
    yield* streamOnLease(adapter, lease, options);
  } catch (error) { options.signal?.throwIfAborted(); throw codeError(error); }
  finally { lease.close(); }
}

const DIAGNOSTIC_EVENTS = ['created', 'in-progress', 'queued', 'compaction-added', 'compaction-item', 'completed', 'failed', 'other',
  'reasoning-added', 'reasoning-done', 'message-added', 'message-done', 'item-added-other', 'item-done-other',
  'content-added', 'content-done', 'output-text-delta', 'output-text-done', 'reasoning-delta', 'reasoning-done-text',
  'reasoning-summary-added', 'reasoning-summary-done', 'reasoning-summary-delta', 'reasoning-summary-text-done'];

/** Optional diagnostic extension: fixed enums and numbers only; older owners remain valid. */
export function operationDiagnostic(lease, error) {
  try {
    const raw = lease?.operation?.diagnostics?.() ?? error?.diagnostics;
    const phase = raw?.phase;
    if (!raw || raw.version !== 1 || !['model-metadata', 'account-binding', 'bound', 'request-prepare', 'waiting-headers', 'waiting-body', 'reading-sse', 'completed'].includes(phase)) return;
    const data = { version: 1, phase };
    for (const key of ['budgetMs', 'setupBudgetMs', 'totalBudgetMs', 'timeoutBudgetMs', 'elapsedMs', 'metadataMs', 'boundMs', 'requests', 'requestMs', 'requestBytes', 'headersMs', 'httpStatus', 'firstByteMs', 'lastByteMs', 'responseBytes', 'chunks', 'events', 'lastEventMs', 'itemMs', 'completedMs']) {
      const value = raw[key];
      if (Number.isSafeInteger(value) && value >= 0) data[key] = value;
    }
    const timeoutKind = raw.timeoutKind;
    if (['setup', 'total'].includes(timeoutKind)) data.timeoutKind = timeoutKind;
    const lastEvent = raw.lastEvent;
    if (DIAGNOSTIC_EVENTS.includes(lastEvent)) data.lastEvent = lastEvent;
    const counts = raw.eventCounts;
    if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
      data.eventCounts = {};
      for (const key of DIAGNOSTIC_EVENTS) {
        const value = counts[key];
        if (Number.isSafeInteger(value) && value >= 0) data.eventCounts[key] = value;
      }
    }
    return data;
  } catch { /* Diagnostic failure must not affect request/error semantics. */ }
}

/** Open and validate one owner operation lease; raw coded failures propagate. */
async function openLease(adapter, { model, signal, purpose }) {
  const runtime = adapter.runtime();
  const operation = await runtime.open({ model, signal, ...(purpose === 'compaction' ? { purpose } : {}) });
  assertOperation(operation, model);
  const close = () => closeOperation(operation);
  return Object.freeze({ operation, binding: operation.binding, close });
}

/** Plain-text streaming through an already-bound lease (same account/model). */
async function* streamOnLease(adapter, lease, options) {
  options.signal?.throwIfAborted();
  const history = prepareHistory(adapter.runtime(), options.messages, lease.binding);
  const provider = lease.operation.provider({ mode: 'stream', replay: history.replay });
  yield* relayOwnerChunks(adapter.converter(provider).stream({ ...options, provider: NATIVE_PROVIDER, messages: history.messages }));
}

/** Native compaction on an already-bound lease; raw coded failures propagate. */
async function compactOnLease(adapter, lease, { model, messages, system, tools, signal }) {
  assertTextHistory(messages); signal?.throwIfAborted();
  const runtime = adapter.runtime();
  const history = prepareHistory(runtime, messages, lease.binding);
  const provider = lease.operation.provider({ mode: 'compact', replay: history.replay });
  const assembler = new BlockAssembler();
  const request = { provider: NATIVE_PROVIDER, model, messages: history.messages,
    ...(system === undefined ? {} : { system }), ...(tools === undefined ? {} : { tools }), signal };
  for await (const chunk of adapter.converter(provider).stream(request)) assembler.push(chunk);
  signal?.throwIfAborted();
  if (assembler.finish.kind !== 'stop') throw failure(ownerFailureCode(assembler.finish.failure?.message) ?? 'CODEX_NATIVE_FAILED', 'Owner-bound native compaction did not complete.');
  const blocks = assembler.blocks();
  if (blocks.length !== 1 || blocks[0].type !== 'text') throw failure('CODEX_NATIVE_INVALID_RESULT', 'The native capability returned an invalid transient result.');
  const envelope = blocks[0].text;
  const checkpoint = runtime.decodeCheckpoint(envelope, lease.binding);
  if (!checkpoint) throw failure('CODEX_NATIVE_INVALID_RESULT', 'Missing structured native result.');
  const receipt = lease.operation.compactionUsage();
  if (receipt?.kind !== 'observed' && receipt?.kind !== 'unavailable') throw failure('CODEX_NATIVE_INVALID_USAGE', 'The owner returned an unsupported native usage receipt.');
  if (receipt.kind === 'observed' && (!receipt.usage || ['inputTokens', 'outputTokens', 'totalTokens'].some(key => !Number.isFinite(receipt.usage[key]) || receipt.usage[key] < 0))) throw failure('CODEX_NATIVE_INVALID_USAGE', 'Observed native usage must contain valid token facts.');
  const allowedUsage = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
  if (receipt.kind === 'observed' && Object.entries(receipt.usage).some(([key, value]) => !allowedUsage.includes(key) || !Number.isFinite(value) || value < 0)) throw failure('CODEX_NATIVE_INVALID_USAGE', 'Native usage contains unsupported or invalid fields.');
  // Never promote the converter's zero-filled SDK placeholder into an observation.
  return { envelope, record: checkpoint, ...(receipt.kind === 'observed' ? { usage: structuredClone(receipt.usage) } : {}) };
}

/**
 * Shared native compaction core. Returns the exact envelope text plus its
 * validated record and honest usage receipt; throws raw coded failures so the
 * ROUTE adapter and the standard-route seam can classify differently.
 */
export async function ownerCompact(adapter, request) {
  assertTextHistory(request.messages); request.signal?.throwIfAborted();
  const lease = await openLease(adapter, { ...request, purpose: 'compaction' });
  try {
    return await compactOnLease(adapter, lease, request);
  } finally { lease.close(); }
}

export class OwnerBoundCodexAdapter extends LlmAdapter {
  constructor(getRuntime, { resolveAttachments, resolveImageAccess } = {}) {
    super();
    this.getRuntime = getRuntime;
    this.resolveAttachments = resolveAttachments;
    this.resolveImageAccess = resolveImageAccess;
    this.retry = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'Codex owner-bound runtime');
  }
  runtime() { return requireRuntime(this.getRuntime()); }
  route(provider) { if (provider !== ROUTE) throw new LlmError('This adapter does not own that provider route.', 'NO_ADAPTER'); }
  providerInfo(provider) { this.route(provider); return { id: ROUTE, name: DISPLAY_NAME }; }
  providerRetryPolicy(provider) { this.route(provider); return this.retry; }
  converter(provider) {
    // Use the public Pi idle watchdog for both replay/text and native output.
    // Owner setup/total deadlines remain separate; native retains its 300s cap.
    const streamIdleTimeoutMs = 300000;
    // PiAiAdapter accepts already-resolved profiles; it does not apply defaults.
    // Obtain the three image bounds from the published schema, not private code
    // or a second set of constants. Owner auth/models/retry/deadlines stay ours.
    const { maxRequestImageBytes, requestImagePixelBudget, requestImageMaxBytes } =
      PiAiConfig({ providers: { [NATIVE_PROVIDER]: {} } }).providers[NATIVE_PROVIDER];
    const profiles = new Map([[NATIVE_PROVIDER, { provider: NATIVE_PROVIDER, displayName: DISPLAY_NAME,
      piProvider: provider, configuredMaxTokens: new Map(), retryPolicy: this.retry, streamIdleTimeoutMs,
      maxRequestImageBytes, requestImagePixelBudget, requestImageMaxBytes }]]);
    return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined,
      auth: { credentials: EMPTY_CREDENTIALS, authContext: NO_AMBIENT },
      resolveAttachments: this.resolveAttachments, resolveImageAccess: this.resolveImageAccess,
      onReplayDegrade: () => { throw failure('CODEX_NATIVE_REPLAY_INCOMPATIBLE', 'Native reasoning metadata requires its compatible reader.'); } });
  }
  metadataProvider(runtime) {
    return { id: NATIVE_PROVIDER, name: DISPLAY_NAME, getModels: () => runtime.models(),
      auth: { apiKey: { name: 'Owner-bound metadata only', resolve: async () => undefined } },
      streamSimple() { throw failure('CODEX_METADATA_ONLY', 'Metadata cannot execute a model request.'); } };
  }
  async listModels(provider) {
    this.route(provider);
    return this.runtime().models().map(model => ({ provider: ROUTE, id: model.id, name: model.name, inputModalities: model.input.filter(kind => kind === 'text' || kind === 'image') }));
  }
  async resolveModel(provider, model, signal) {
    this.route(provider); signal?.throwIfAborted();
    const runtime = this.runtime();
    const result = await this.converter(this.metadataProvider(runtime)).resolveModel(NATIVE_PROVIDER, model, signal);
    return { ...result, provider: ROUTE };
  }
  async prepareCall(provider, model, signal) {
    const runtime = this.runtime();
    return { model: await this.resolveModel(provider, model, signal), stream: options => {
      if (options.provider !== provider || options.model !== model || this.runtime() !== runtime) throw failure('CODEX_RUNTIME_CHANGED', 'Prepared Codex runtime or model changed; prepare the next request again.');
      return this.stream(options);
    } };
  }
  async *stream(options) {
    if (options.purpose === 'compaction') throw failure('CODEX_NATIVE_PRESET_REQUIRED', 'Use the structured native preset for compaction, not a generic text-summary request.');
    this.route(options.provider);
    yield* ownerReplayStream(this, options);
  }
  async compact(input, agent, signal = input.signal) {
    const target = agent?.session.requestHeader()?.config ?? agent?.options ?? input;
    this.route(target.provider);
    try {
      const native = await ownerCompact(this, { model: target.model, messages: input.messages, system: input.system, tools: input.tools, signal });
      return { checkpoint: native.record, ...(native.usage === undefined ? {} : { usage: native.usage }) };
    } catch (error) { signal?.throwIfAborted(); throw codeError(error); }
  }
  /** Internal seam entry: standard-route native compact without ROUTE routing. */
  seamCompact(request) {
    return ownerCompact(this, request);
  }
  /** Internal seam entry: open one owner lease for unified native+fallback control. */
  seamLease(request) {
    return openLease(this, { ...request, purpose: 'compaction' });
  }
  /** Internal seam entry: native compact on an existing lease. */
  seamCompactOnLease(lease, request) {
    return compactOnLease(this, lease, request);
  }
  /** Internal seam entry: plain-text streaming on an existing lease (same account/model). */
  async *seamStreamOnLease(lease, options) {
    yield* streamOnLease(this, lease, options);
  }
  /** Internal seam entry: standard-route native replay without ROUTE routing. */
  async *seamReplay(options) {
    yield* ownerReplayStream(this, options);
  }
}
