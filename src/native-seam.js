// The middleware is a reader only. New summaries enter through Basic.summarize.
import { isNativeCarrier } from './runtime-adapter.js';
import { STANDARD_ROUTE, failure } from './constants.js';
import { CompactionRecovery } from './recovery.js';

const RECOVERABLE = new Set(['CODEX_RUNTIME_NOT_READY', 'CODEX_RUNTIME_NOT_CONFIGURED',
  'CODEX_RUNTIME_NETWORK', 'CODEX_RUNTIME_RESPONSE_STREAM']);
export function isRecoverableNativeFailure(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') return false;
  const code = error?.code ?? error?.failure?.code;
  return RECOVERABLE.has(code) || /^CODEX_RUNTIME_HTTP_5\d\d$/.test(code ?? '');
}

/** Per-session preference. Async recovery cannot overwrite a newer live command.
 *
 * Effective preference resolution: an explicit session value (on / off /
 * reader-text) wins; `inherit` and a never-set session follow the CURRENT
 * agent's preset default (`presetNative`), which is resolved per call from the
 * preset-local codexNativePolicy row and is false for standard presets. This
 * includes old sessions created before the preset default existed.
 */
export class NativeSessionState {
  constructor(profileNative = false, recoverPreference, recoveryOptions) {
    this.recovery = new CompactionRecovery(recoveryOptions);
    // Legacy constructor flag kept as the fallback when no preset context is
    // supplied; the provider entry keeps it false (capability gate only).
    this.profileNative = profileNative === true;
    this.sessions = new Map();
    this.attempts = new Map();
    this.scanned = new Set();
    this.scanning = new Map();
    this.recoverPreference = recoverPreference;
  }
  setSession(sessionId, mode, { presetNative = this.profileNative, capability = true } = {}) {
    if (!['on', 'off', 'inherit', 'reader-text'].includes(mode)) throw failure('CODEX_NATIVE_PREF_MODE', 'Preference must be on, off, inherit, or reader-text.');
    if (typeof sessionId !== 'string' || !sessionId) throw failure('CODEX_NATIVE_PREF_SESSION', 'A live session is required.');
    this.scanned.add(sessionId);
    if (mode === 'inherit') this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, mode === 'reader-text' ? mode : mode === 'on');
    return this.nativeStatus(sessionId, { presetNative, capability });
  }
  async ready(sessionId) {
    if (this.scanned.has(sessionId) || !this.recoverPreference) return;
    if (!this.scanning.has(sessionId)) {
      const pending = Promise.resolve().then(() => this.recoverPreference(sessionId)).then(value => {
        if (this.scanned.has(sessionId)) return;
        if (['on', 'off', 'reader-text'].includes(value)) this.sessions.set(sessionId, value === 'reader-text' ? value : value === 'on');
        this.scanned.add(sessionId);
      }).finally(() => this.scanning.delete(sessionId));
      this.scanning.set(sessionId, pending);
    }
    await this.scanning.get(sessionId);
  }
  sessionPreference(sessionId) {
    const value = this.sessions.get(sessionId);
    return value === undefined ? 'inherit' : value === 'reader-text' ? value : value ? 'on' : 'off';
  }
  effective(sessionId, presetNative = this.profileNative) {
    const value = this.sessions.get(sessionId);
    return value === undefined ? presetNative === true : value !== false;
  }
  recordAttempt(sessionId, attempt) {
    this.attempts.set(sessionId, { ...attempt, sessionId, at: this.recovery.now() });
    if (this.attempts.size > 4096) this.attempts.delete(this.attempts.keys().next().value);
  }
  lastAttempt(sessionId) { return this.attempts.get(sessionId); }
  nativeStatus(sessionId, { presetNative = this.profileNative, capability = true } = {}) {
    const effective = capability !== false && this.effective(sessionId, presetNative);
    return { capability: capability !== false, preset: presetNative === true, session: this.sessionPreference(sessionId), effective,
      summarizationMode: this.sessionPreference(sessionId) === 'reader-text' ? 'reader-text' : effective ? 'native' : 'off',
      lastAttempt: this.lastAttempt(sessionId) ?? null, recovery: this.recovery.status(sessionId) };
  }
}

/** Checkpoint replay/fail-closed only: purpose never identifies a producer. */
export class NativeCompactionSeam {
  constructor({ adapter, getRuntime, state }) { Object.assign(this, { adapter, getRuntime, state }); }
  async gate(model, signal) {
    const runtime = this.getRuntime();
    if (typeof runtime?.applicability !== 'function') return { applicable: false, reason: 'CODEX_SEAM_CAPABILITY_MISSING' };
    const verdict = await runtime.applicability({ provider: STANDARD_ROUTE, model, signal });
    signal?.throwIfAborted();
    return verdict;
  }
  async *dispatch(options, next) {
    if (options.provider !== STANDARD_ROUTE || !options.messages.some(isNativeCarrier)) return yield* next();
    const verdict = await this.gate(options.model, options.signal);
    if (!verdict?.applicable) throw failure('CODEX_NATIVE_REPLAY_UNAVAILABLE', 'Native checkpoint owner reader is unavailable; nothing was sent.');
    yield* this.adapter.seamReplay(options);
  }
}
