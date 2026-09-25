// Process-local request suppression, not a replacement compaction engine.
// Only public compaction events can confirm a successful history replacement.
//
// Two suppression mechanisms with different evidence requirements:
// - Transient cooldown (60s): for failures whose determinism is unproven
//   (network/stream classes). The clock alone re-admits the request.
// - Deterministic fingerprint: for failures a pure-local precheck can
//   reproduce (unsafe/incompatible/invalid history classes). The same
//   session+route+config-version+input digest is refused until the input or
//   the relevant configuration actually changes — no remote request is sent
//   merely because 60 seconds passed. Fingerprints hold only digests, fixed
//   error classes and counters; never message text or credentials. All state
//   is process-local; a restart rebuilds it and the pure-local precheck runs
//   first anyway.
import { createHash } from 'node:crypto';
import { failure } from './constants.js';

const LIMIT = 4096;
export const RETRY_INTERVAL_MS = 60_000;
/** Bumped when the fingerprint inputs or normalization change. */
export const FINGERPRINT_ALGORITHM = 'codex-native-fingerprint/1';
export const cancelled = (error, signal) => signal?.aborted || ['ABORTED', 'CODEX_RUNTIME_CANCELLED', 'CODEX_RUNTIME_DISPOSED'].includes(error?.code);
/** Fixed failure classes a pure-local precheck can reproduce deterministically. */
export const DETERMINISTIC_CLASSES = new Set([
  'CODEX_NATIVE_UNSAFE_HISTORY', 'CODEX_NATIVE_TEXT_ONLY', 'CODEX_NATIVE_REPLAY_INCOMPATIBLE',
  'CODEX_NATIVE_INVALID_CARRIER', 'CODEX_NATIVE_AMBIGUOUS_CARRIER', 'CODEX_NATIVE_CONFIG',
]);
export function isDeterministicLocalFailure(error) {
  return DETERMINISTIC_CLASSES.has(error?.code);
}
/** Stable, content-free digest of the selected compaction input. */
export function inputFingerprint(messages, tools) {
  const digest = createHash('sha256');
  digest.update(FINGERPRINT_ALGORITHM);
  digest.update('\0');
  digest.update(JSON.stringify({ messages: messages ?? null, tools: tools ?? null }));
  return digest.digest('hex');
}
export function recoveryDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(failure('CODEX_RUNTIME_CANCELLED', 'Compaction recovery cancelled.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class CompactionRecovery {
  constructor({ now = Date.now, delay = recoveryDelay } = {}) {
    this.now = now;
    this.delay = delay;
    this.entries = new Map();
    this.transactions = new Map();
  }
  key(options) { return JSON.stringify([options.sessionId, options.provider, options.model]); }
  begin(options) {
    const key = this.key(options);
    let entry = this.entries.get(key);
    if (entry?.flight) throw failure('CODEX_NATIVE_COMPACTION_BUSY', 'A compaction attempt for this session and model is already running.');
    if (entry?.nextAllowedAt > this.now()) throw failure('CODEX_NATIVE_COMPACTION_COOLDOWN', `Compaction retry deferred until ${new Date(entry.nextAllowedAt).toISOString()}; no recovery request was sent.`);
    // Deterministic fingerprints do not expire with the transient clock: the
    // identical bad input under the identical config is refused outright.
    if (entry?.fingerprint && options.fingerprint !== undefined
        && entry.fingerprint.digest === options.fingerprint.digest
        && entry.fingerprint.configVersion === options.fingerprint.configVersion) {
      throw failure('CODEX_NATIVE_COMPACTION_DETERMINISTIC',
        `A deterministic local failure (${entry.fingerprint.errorClass}) already rejected this exact input and configuration; no remote request was sent. Fix or change the input, or change the configuration, to retry.`);
    }
    if (!entry) {
      if (this.entries.size >= LIMIT) {
        const removable = [...this.entries].find(([, value]) => !value.flight && !(value.nextAllowedAt > this.now()) && !value.fingerprint);
        if (!removable) throw failure('CODEX_NATIVE_COMPACTION_BUSY', 'Compaction recovery state is at capacity.');
        this.entries.delete(removable[0]);
      }
      entry = { sessionId: options.sessionId, provider: options.provider, model: options.model, failures: 0, nextAllowedAt: 0 };
      this.entries.set(key, entry);
    } else if (options.fingerprint !== undefined
        && (entry.fingerprint === undefined || entry.fingerprint.digest !== options.fingerprint.digest
          || entry.fingerprint.configVersion !== options.fingerprint.configVersion)) {
      // Related input or configuration actually changed: revalidate.
      delete entry.fingerprint;
    }
    const flight = { entry, transaction: this.transactions.get(options.sessionId), failed: false, ignored: false };
    entry.flight = flight;
    return flight;
  }
  fail(flight, code) {
    if (flight.failed || flight.ignored) return;
    flight.failed = true;
    flight.entry.failures++;
    flight.entry.lastFailure = code;
    flight.entry.nextAllowedAt = this.now() + RETRY_INTERVAL_MS;
  }
  /** Record a deterministic local failure keyed by the input fingerprint. */
  deterministic(flight, { digest, configVersion, errorClass }) {
    if (flight.failed || flight.ignored) return;
    flight.failed = true;
    flight.entry.failures++;
    flight.entry.lastFailure = errorClass;
    flight.entry.fingerprint = { algorithm: FINGERPRINT_ALGORITHM, digest, configVersion, errorClass, at: this.now() };
  }
  release(flight) {
    if (flight.entry.flight === flight) flight.entry.flight = undefined;
    // Keep the transaction's outcome after the stream releases its lease.
    if (flight.transaction) flight.transaction.flights.add(flight);
  }
  status(sessionId) {
    return [...this.entries.values()].filter(entry => entry.sessionId === sessionId).map(entry => ({
      provider: entry.provider, model: entry.model, failures: entry.failures,
      nextAllowedAt: entry.nextAllowedAt, coolingDown: entry.nextAllowedAt > this.now(),
      inFlight: !!entry.flight,
      ...(entry.lastFailure ? { lastFailure: entry.lastFailure } : {}),
      ...(entry.fingerprint ? { deterministicBlock: {
        errorClass: entry.fingerprint.errorClass, algorithm: entry.fingerprint.algorithm,
        at: entry.fingerprint.at } } : {}),
    }));
  }
  observe(session, event) {
    const id = event.data?.compactionId;
    if (event.type === 'compaction/start') {
      if (this.transactions.size >= LIMIT) return; // Unknown lifecycles cannot clear failures.
      this.transactions.set(session.id, { id, replaced: false, flights: new Set(),
        // Public manual compaction carries a sourceCommandId; automatic
        // pressure/overflow compaction does not.
        manual: event.data.sourceCommandId !== undefined });
      return;
    }
    const transaction = this.transactions.get(session.id);
    if (!transaction) return;
    if (event.type === 'user/message') {
      transaction.replaced ||= (event.sourceEventSeqs ?? []).some(seq => {
        const source = session.eventAt(seq);
        return source?.type === 'compaction/summary' && source.data?.compactionId === transaction.id;
      });
    }
    if (event.type !== 'compaction/end' || id !== transaction.id) return;
    for (const flight of transaction.flights) {
      if (flight.failed || flight.ignored) continue;
      if (event.data.error !== undefined || !transaction.replaced) this.fail(flight, 'CODEX_NATIVE_COMPACTION_NOT_COMMITTED');
      else {
        flight.entry.failures = 0;
        flight.entry.nextAllowedAt = 0;
        delete flight.entry.lastFailure;
        delete flight.entry.fingerprint;
      }
    }
    this.transactions.delete(session.id);
  }
  /** Whether the currently open compaction transaction was user-initiated. */
  manualCompaction(sessionId) { return this.transactions.get(sessionId)?.manual === true; }
  clear() { this.entries.clear(); this.transactions.clear(); }
}
