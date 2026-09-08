// Process-local request suppression, not a replacement compaction engine.
// Only public compaction events can confirm a successful history replacement.
import { failure } from './constants.js';

const LIMIT = 4096;
export const RETRY_INTERVAL_MS = 60_000;
export const cancelled = (error, signal) => signal?.aborted || ['ABORTED', 'CODEX_RUNTIME_CANCELLED', 'CODEX_RUNTIME_DISPOSED'].includes(error?.code);
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
    if (!entry) {
      if (this.entries.size >= LIMIT) {
        const removable = [...this.entries].find(([, value]) => !value.flight && !(value.nextAllowedAt > this.now()));
        if (!removable) throw failure('CODEX_NATIVE_COMPACTION_BUSY', 'Compaction recovery state is at capacity.');
        this.entries.delete(removable[0]);
      }
      entry = { sessionId: options.sessionId, provider: options.provider, model: options.model, failures: 0, nextAllowedAt: 0 };
      this.entries.set(key, entry);
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
  release(flight) {
    if (flight.entry.flight === flight) flight.entry.flight = undefined;
    // Keep the transaction's outcome after the stream releases its lease.
    if (flight.transaction) flight.transaction.flights.add(flight);
  }
  status(sessionId) {
    return [...this.entries.values()].filter(entry => entry.sessionId === sessionId).map(entry => ({
      provider: entry.provider, model: entry.model, failures: entry.failures,
      nextAllowedAt: entry.nextAllowedAt, coolingDown: entry.nextAllowedAt > this.now(),
      inFlight: !!entry.flight, ...(entry.lastFailure ? { lastFailure: entry.lastFailure } : {}),
    }));
  }
  observe(session, event) {
    const id = event.data?.compactionId;
    if (event.type === 'compaction/start') {
      if (this.transactions.size >= LIMIT) return; // Unknown lifecycles cannot clear failures.
      this.transactions.set(session.id, { id, replaced: false, flights: new Set() });
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
      }
    }
    this.transactions.delete(session.id);
  }
  clear() { this.entries.clear(); this.transactions.clear(); }
}
