// Standard-route native seam: connects official basic's purpose=compaction
// llm/stream call (and existing native carriers' ordinary replay) to the
// account-owned native runtime. Official basic keeps triggers, selection,
// meter, shrink checks and the durable transaction; this seam only swaps the
// summarization/replay transport. Registered after the account plugin's own
// llm/stream middleware so account preparation still runs before any
// short-circuit, and never registered when the account capability is absent.
import { isNativeCarrier, historyHasImages, operationDiagnostic } from './runtime-adapter.js';
import { STANDARD_ROUTE, failure } from './constants.js';
import { basicInstructionTail } from './native-checkpoint.js';
import { CompactionRecovery, cancelled } from './recovery.js';

// Confirmed native availability/request failure categories only. Auth
// failures, client-side HTTP errors and every unmatched cause stay on the
// native path's own failure reporting — never a silent text fallback.
const RECOVERABLE = new Set(['CODEX_RUNTIME_NOT_READY', 'CODEX_RUNTIME_NOT_CONFIGURED',
  'CODEX_RUNTIME_NETWORK', 'CODEX_RUNTIME_RESPONSE_STREAM']);
const retryNative = code => ['CODEX_RUNTIME_NETWORK', 'CODEX_RUNTIME_RESPONSE_STREAM'].includes(code) || /^CODEX_RUNTIME_HTTP_5\d\d$/.test(code);
const reasonCode = reason => typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : 'CODEX_SEAM_UNKNOWN_REASON';
const codeOf = error => typeof error?.code === 'string' && error.code ? error.code
  : typeof error?.failure?.code === 'string' ? error.failure.code : 'CODEX_RUNTIME_ERROR';

/** Whitelist-only: cancellation, identity, protocol and unknown causes never fall back. */
export function isRecoverableNativeFailure(error, signal) {
  if (signal?.aborted) return false;
  const code = codeOf(error);
  if (code === 'ABORTED' || code === 'CODEX_RUNTIME_CANCELLED') return false;
  return RECOVERABLE.has(code) || /^CODEX_RUNTIME_HTTP_[5]\d\d$/.test(code);
}

async function* completedText(chunks, failureCode) {
  let terminal = false;
  for await (const chunk of chunks) {
    if (chunk.type === 'finish') {
      if (chunk.reason?.kind !== 'stop') throw failure(chunk.reason?.failure?.code ?? failureCode, 'Owner-bound text summary did not finish successfully.');
      terminal = true;
    }
    yield chunk;
  }
  if (!terminal) throw failure(failureCode, 'Owner-bound text summary ended without a successful finish.');
}

const MAX_ATTEMPTS = 4096;

/** Profile default (RC: off) plus per-session on/off overrides. */
export class NativeSessionState {
  constructor(profileNative = false, recoverPreference, recoveryOptions) {
    this.recovery = new CompactionRecovery(recoveryOptions);
    this.profileNative = profileNative === true;
    this.sessions = new Map();
    this.attempts = new Map();
    // Sessions whose durable command log has already been scanned once;
    // recovery never overrides an in-process change made through setSession.
    this.scanned = new Set();
    this.recoverPreference = typeof recoverPreference === 'function' ? recoverPreference : undefined;
  }
  setSession(sessionId, mode) {
    if (!['on', 'off', 'inherit'].includes(mode)) throw failure('CODEX_NATIVE_PREF_MODE', 'Preference must be on, off, or inherit.');
    if (typeof sessionId !== 'string' || !sessionId) throw failure('CODEX_NATIVE_PREF_SESSION', 'A live session is required.');
    // In-process changes are authoritative from here on: no later recovery
    // scan may resurrect a superseded persisted preference for this session.
    this.scanned.add(sessionId);
    if (mode === 'inherit') this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, mode === 'on');
    return this.nativeStatus(sessionId);
  }
  /** One durable-log scan per unseen session; the verdict is then cached. */
  recovered(sessionId) {
    if (this.scanned.has(sessionId) || !this.recoverPreference) return undefined;
    this.scanned.add(sessionId);
    let value;
    try { value = this.recoverPreference(sessionId); }
    catch { return undefined; }
    if (value === 'on') { this.sessions.set(sessionId, true); return 'on'; }
    if (value === 'off') { this.sessions.set(sessionId, false); return 'off'; }
    return undefined; // explicit inherit, or no durable preference
  }
  sessionPreference(sessionId) {
    const value = this.sessions.get(sessionId);
    if (value !== undefined) return value ? 'on' : 'off';
    return this.recovered(sessionId) ?? 'inherit';
  }
  effective(sessionId) {
    const value = this.sessions.get(sessionId);
    if (value !== undefined) return value;
    const recovered = this.recovered(sessionId);
    // A recovered 'off' is an explicit override and survives any profile default.
    if (recovered === 'on') return true;
    if (recovered === 'off') return false;
    return this.profileNative;
  }
  recordAttempt(sessionId, attempt) {
    this.attempts.set(sessionId, { ...attempt, sessionId, at: this.recovery.now() });
    if (this.attempts.size > MAX_ATTEMPTS) this.attempts.delete(this.attempts.keys().next().value);
  }
  lastAttempt(sessionId) { return this.attempts.get(sessionId); }
  nativeStatus(sessionId) {
    return { profile: this.profileNative, session: this.sessionPreference(sessionId),
      effective: this.effective(sessionId), lastAttempt: this.lastAttempt(sessionId) ?? null,
      recovery: this.recovery.status(sessionId) };
  }
}

/**
 * The llm/stream takeover middleware for the standard openai-codex route.
 * Order matters: account-owned preparation middleware must already be in the
 * chain, so instances register only from the codexRuntime-ready callback.
 */
export class NativeCompactionSeam {
  constructor({ adapter, getRuntime, state }) {
    this.adapter = adapter;
    this.getRuntime = getRuntime;
    this.state = state;
  }

  /** Owner applicability verdict; never resolves authentication or network I/O. */
  async gate(model, signal) {
    const runtime = this.getRuntime();
    if (typeof runtime?.applicability !== 'function') return { applicable: false, reason: 'CODEX_SEAM_CAPABILITY_MISSING' };
    try {
      const verdict = await runtime.applicability({ provider: STANDARD_ROUTE, model, signal });
      signal?.throwIfAborted();
      if (verdict?.applicable === true) return { applicable: true, model: verdict.model };
      return { applicable: false, reason: reasonCode(verdict?.reason) };
    } catch (error) {
      signal?.throwIfAborted();
      return { applicable: false, reason: codeOf(error) };
    }
  }

  async *dispatch(options, next) {
    if (options.provider !== STANDARD_ROUTE) return yield* next();
    const signal = options.signal;
    const sessionId = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : '(anonymous)';
    const carriers = options.messages.filter(isNativeCarrier);
    const images = historyHasImages(options.messages);
    if (options.purpose === 'compaction') {
      const enabled = this.state.effective(sessionId);
      // Opaque native content may never be summarized through a plain adapter.
      if (carriers.length && !enabled) {
        throw failure('CODEX_NATIVE_READER_REQUIRED', 'Native Codex checkpoints in the compacted region require the native reader; enable /codex-native for this session or use the structured preset.');
      }
      if (!enabled) return yield* next();
      // Carrier histories are fail-closed on EVERY guard branch below: no
      // early return may hand opaque native state to the plain adapter.
      const gate = await this.gate(options.model, signal);
      if (!gate.applicable) {
        this.state.recordAttempt(sessionId, { kind: 'none', reason: `inapplicable:${gate.reason}`, model: options.model });
        if (carriers.length) {
          throw failure('CODEX_NATIVE_REPLAY_UNAVAILABLE', `Native Codex checkpoints cannot be summarized on this route (${gate.reason}); the request was not sent.`);
        }
        return yield* next();
      }
      if (!basicInstructionTail(options.messages.at(-1))) {
        this.state.recordAttempt(sessionId, { kind: 'none', reason: 'instruction-tail-unrecognized', model: options.model });
        if (carriers.length) {
          throw failure('CODEX_NATIVE_READER_REQUIRED', 'Native Codex checkpoints in the compacted region require the native reader; this summarization request was not recognized and was not sent.');
        }
        return yield* next();
      }
      if (images && !carriers.length) {
        this.state.recordAttempt(sessionId, { kind: 'none', reason: 'images-present', model: options.model });
        return yield* next();
      }
      const history = options.messages.slice(0, -1);
      const recovery = this.state.recovery;
      const flight = recovery.begin({ ...options, sessionId });
      let lease, cause, kind = images ? 'reader-text' : 'native', outputComplete = false;
      const record = fields => this.state.recordAttempt(sessionId, { kind, model: options.model, ...(cause ? { cause } : {}), ...fields });
      record({ outcome: 'running' });
      try {
        lease = await this.adapter.seamLease({ model: options.model, signal });
        if (images) {
          // The v1 native compactor/codec is text-only. Its ordinary reader can
          // replay opaque state alongside images, so ask that SAME bound reader
          // for Basic's text summary. This is a deliberate one-request mode,
          // not a failure fallback; never send the envelope to the stock route.
          yield* completedText(this.adapter.seamStreamOnLease(lease, options), 'CODEX_NATIVE_READER_FAILED');
          signal?.throwIfAborted();
          outputComplete = true;
          record({ outcome: 'reader-text', diagnostics: operationDiagnostic(lease) });
          return;
        }
        const compact = () => this.adapter.seamCompactOnLease(lease, { model: options.model, messages: history,
          system: options.system, tools: options.tools, signal });
        let native;
        try { native = await compact(); }
        catch (error) {
          cause = codeOf(error);
          if (!isRecoverableNativeFailure(error, signal)) throw error;
          // A single shared recovery budget: native retry OR text fallback,
          // never both. Reuse the owner lease without resetting its deadline.
          if (retryNative(cause)) {
            record({ outcome: 'retrying' });
            await recovery.delay(200, signal);
            signal?.throwIfAborted();
            native = await compact();
          } else {
            if (carriers.length) throw error;
            kind = 'fallback';
            record({ outcome: 'running' });
            yield* completedText(this.adapter.seamStreamOnLease(lease, options), 'CODEX_NATIVE_FALLBACK_FAILED');
            signal?.throwIfAborted();
            outputComplete = true;
            record({ outcome: 'fallback-text', diagnostics: operationDiagnostic(lease) });
            return;
          }
        }
        signal?.throwIfAborted();
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: native.envelope };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: native.envelope } };
        if (native.usage !== undefined) yield { type: 'usage', usage: native.usage };
        yield { type: 'finish', reason: { kind: 'stop' } };
        outputComplete = true;
        record({ outcome: 'native', diagnostics: operationDiagnostic(lease), ...(native.usage === undefined ? {} : { usage: native.usage }) });
        return;
      } catch (error) {
        const code = codeOf(error);
        record({ outcome: 'failed', cause: cause ?? code, failure: code, diagnostics: operationDiagnostic(lease, error) });
        if (cancelled(error, signal)) flight.ignored = true;
        else recovery.fail(flight, code);
        if (!lease && carriers.length && !cancelled(error, signal) && code !== 'CODEX_RUNTIME_TIMEOUT') {
          throw failure('CODEX_NATIVE_REPLAY_UNAVAILABLE', `Native checkpoints could not bind to their owner (${code}); no request was sent.`);
        }
        throw error;
      } finally {
        // Generator cancellation is not another retryable failure.
        if (!outputComplete && !flight.failed) flight.ignored = true;
        recovery.release(flight);
        lease?.close();
      }
    }
    if (carriers.length) {
      const gate = await this.gate(options.model, signal);
      if (!gate.applicable) {
        throw failure('CODEX_NATIVE_REPLAY_UNAVAILABLE', `Native Codex checkpoints cannot be replayed on this route (${gate.reason}); the request was not sent.`);
      }
      yield* this.adapter.seamReplay(options);
      return;
    }
    yield* next();
  }
}
