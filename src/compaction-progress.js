// Observation only: no policies, persistence, usage synthesis, or host imports.
import { createHash } from 'node:crypto';

const LIMIT = 256;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const seq = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const counts = () => ({ started: 0, committed: 0, failed: 0, unknown: 0 });
const elapsed = (start, end) => nonnegative(start) && nonnegative(end) && end >= start ? end - start : null;

/**
 * Inject bound public TokenMeter.measure/estimateMessage functions (or undefined).
 * Call observe AFTER each public session/event append, in durable seq order.
 * status never replays history or invents a pre-measurement. Metadata is detached.
 * stepInterval counts observed step/start events between compaction starts.
 * Token savings use fixed-heuristic node prices minus the WHOLE framed message,
 * not pressure subtraction: pressure may be usage-anchored or clamped to zero.
 * Missing/invalid measurements affect comparison, never the compaction driver.
 */
export class CompactionProgress {
  #entries = new Map();
  #measure;
  #estimateMessage;
  #now;

  constructor({ measure, estimateMessage, now = Date.now } = {}) {
    this.#measure = measure;
    this.#estimateMessage = estimateMessage;
    this.#now = now;
  }

  #time() {
    try { const value = this.#now(); return nonnegative(value) ? value : null; }
    catch { return null; }
  }

  #surface(session) {
    try {
      const nodes = session.surface.nodes;
      if (!Array.isArray(nodes) || !nodes.every(seq) || new Set(nodes).size !== nodes.length) return null;
      return { nodes, fingerprint: digest(nodes) };
    } catch { return null; }
  }

  #header(session) {
    try { return digest(session.requestHeader() ?? null); }
    catch { return null; }
  }

  #measurement(session, surface) {
    try {
      const value = this.#measure?.(session);
      if (!surface || !value || value.logRevision !== session.seq || !seq(value.logRevision)
          || !nonnegative(value.totalTokens) || !nonnegative(value.surfaceTokens)
          || !Number.isFinite(value.surfaceDeltaTokens)
          || !['none', 'estimated', 'usage'].includes(value.baseline?.kind)
          || !nonnegative(value.baseline.tokens)
          || !Array.isArray(value.nodes) || value.nodes.length !== surface.nodes.length) return null;
      let sum = 0;
      for (let i = 0; i < value.nodes.length; i++) {
        const node = value.nodes[i];
        if (node.seq !== surface.nodes[i] || !nonnegative(node.tokens) || !nonnegative(node.heuristicTokens)) return null;
        sum += node.tokens;
      }
      if (!nonnegative(sum) || Math.abs(sum - value.surfaceTokens) > 1e-6
          || (value.baseline.kind === 'none' && value.baseline.tokens !== 0)
          || !Number.isFinite(value.baseline.tokens + value.surfaceDeltaTokens)
          || Math.abs(Math.max(0, value.baseline.tokens + value.surfaceDeltaTokens) - value.totalTokens) > 1e-6) return null;
      return value;
    } catch { return null; }
  }

  #pressure(measurement) {
    return measurement ? { tokens: measurement.totalTokens, baseline: measurement.baseline.kind } : null;
  }

  #unknown(flight, reason) {
    if (flight.result.comparison.reason === null) flight.result.comparison = { basis: 'unknown', reason };
    flight.result.netFreedTokens = null;
  }

  #finish(entry, outcome, time) {
    const flight = entry.flight;
    flight.result.outcome = outcome;
    flight.result.durationMs = elapsed(flight.startedAt, time);
    flight.result.endedAtMs = time;
    if (outcome !== 'committed') this.#unknown(flight, outcome === 'failed' ? 'compaction-error' : 'incomplete-lifecycle');
    else if (flight.result.comparison.reason === null) {
      const { shadowedTokens, framedReplacementTokens } = flight.result;
      const freed = shadowedTokens - framedReplacementTokens;
      if (shadowedTokens === null || framedReplacementTokens === null || !Number.isFinite(freed)) this.#unknown(flight, 'measurement-unavailable');
      else flight.result.netFreedTokens = freed;
    }
    entry.counts[outcome]++;
    entry.latest = flight.result;
    // Preserve the last COMMITTED result across subsequent compactions: the
    // efficiency guard needs it as a comparison baseline even when a new
    // transaction has already set `latest` to its own pending result.
    if (outcome === 'committed') entry.lastCommitted = flight.result;
    entry.flight = null;
  }

  observe(session, event) {
    // Diagnostics must not throw into session persistence, including bad injections.
    try { this.#observe(session, event); } catch {
      const entry = this.#entries.get(session?.id);
      if (entry?.flight) this.#unknown(entry.flight, 'observation-unavailable');
    }
  }

  #observe(session, event) {
    if (typeof session?.id !== 'string' || !session.id || !event || !seq(event.seq)) return;
    let entry = this.#entries.get(session.id);
    if (!entry) {
      if (this.#entries.size >= LIMIT) this.#entries.delete(this.#entries.keys().next().value);
      entry = { counts: counts(), latest: null, flight: null, lastSeq: -1, steps: 0, previousStartStep: null };
      this.#entries.set(session.id, entry);
    }
    if (event.seq <= entry.lastSeq) return; // Duplicate delivery must not inflate counters.
    this.#entries.delete(session.id);
    this.#entries.set(session.id, entry);
    const skipped = entry.lastSeq >= 0 && event.seq !== entry.lastSeq + 1;
    entry.lastSeq = event.seq;
    if (event.type === 'step/start') entry.steps++;
    const id = event.data?.compactionId;
    const starting = event.type === 'compaction/start' && typeof id === 'string' && id;
    if (!starting && !entry.flight) return;
    const current = event.seq === session.seq - 1;
    const time = this.#time();
    const surface = this.#surface(session);
    const header = this.#header(session);
    if (starting) {
      const overlap = !!entry.flight;
      if (overlap) this.#finish(entry, 'unknown', time);
      const measured = current ? this.#measurement(session, surface) : null;
      const result = {
        compactionId: id, outcome: 'pending',
        beforePressure: this.#pressure(measured), afterPressure: null,
        shadowedTokens: null, framedReplacementTokens: null, netFreedTokens: null,
        durationMs: null, endedAtMs: null, afterSurfaceTokens: null,
        stepInterval: entry.previousStartStep === null ? null : entry.steps - entry.previousStartStep,
        comparison: { basis: 'fixed-heuristic-message-delta', reason: null },
      };
      entry.previousStartStep = entry.steps;
      entry.counts.started++;
      entry.flight = { result, startedAt: time, surface: surface?.fingerprint ?? null, header,
        summarySeq: null, range: null, expectedSurface: null, replaced: false };
      entry.latest = result;
      if (!measured) this.#unknown(entry.flight, 'measurement-unavailable');
      if (!surface || header === null) this.#unknown(entry.flight, 'observation-unavailable');
      if (overlap) this.#unknown(entry.flight, 'overlapping-compaction');
      return;
    }
    const flight = entry.flight;
    if (!flight) return;
    if (skipped) this.#unknown(flight, 'event-gap');
    if (!current) this.#unknown(flight, 'event-not-current');
    if (!surface || header === null) this.#unknown(flight, 'observation-unavailable');
    else if (header !== flight.header) this.#unknown(flight, 'request-header-changed');

    let ownReplacement = false;
    if (event.type === 'user/message' && flight.summarySeq !== null && !flight.replaced
        && event.sourceEventSeqs?.includes(flight.summarySeq)
        && event.surfaceOp?.op === 'replace'
        // Host replacement events carry startSeq/endSeq (0.1.7 schema); the
        // historical start/end misread made every legitimate commit unknown.
        && event.surfaceOp.startSeq === flight.range.start && event.surfaceOp.endSeq === flight.range.end
        && surface?.nodes.includes(event.seq)) {
      ownReplacement = true;
      flight.replaced = true;
      if (digest(surface.nodes.map(node => node === event.seq ? -1 : node)) !== flight.expectedSurface) {
        this.#unknown(flight, 'surface-changed');
      }
      try {
        const message = session.deriveEventMessage(event);
        const tokens = message == null ? null : this.#estimateMessage?.(message);
        flight.result.framedReplacementTokens = nonnegative(tokens) ? tokens : null;
      } catch { /* Remain unknown, do not retain errors or message content. */ }
      if (flight.result.framedReplacementTokens === null) this.#unknown(flight, 'measurement-unavailable');
    }
    if (!ownReplacement && surface?.fingerprint !== flight.surface) this.#unknown(flight, 'surface-changed');
    flight.surface = surface?.fingerprint ?? null;

    if (event.type === 'compaction/summary' && id === flight.result.compactionId) {
      if (flight.summarySeq !== null) { this.#unknown(flight, 'duplicate-summary'); return; }
      const { shadowedRange: range, shadowedSeqs } = event.data;
      const first = surface?.nodes.indexOf(range?.start) ?? -1;
      const last = surface?.nodes.indexOf(range?.end) ?? -1;
      if (first < 0 || last < first || !Array.isArray(shadowedSeqs)
          || digest(surface.nodes.slice(first, last + 1)) !== digest(shadowedSeqs)) {
        this.#unknown(flight, 'invalid-shadow-range'); return;
      }
      flight.summarySeq = event.seq;
      flight.range = { start: range.start, end: range.end };
      flight.expectedSurface = digest([...surface.nodes.slice(0, first), -1, ...surface.nodes.slice(last + 1)]);
      const measured = current ? this.#measurement(session, surface) : null;
      const tokens = measured?.nodes.slice(first, last + 1).reduce((sum, node) => sum + node.heuristicTokens, 0);
      flight.result.shadowedTokens = nonnegative(tokens) ? tokens : null;
      if (flight.result.shadowedTokens === null) this.#unknown(flight, 'measurement-unavailable');
    }
    if (event.type === 'compaction/end' && id === flight.result.compactionId) {
      const measured = current ? this.#measurement(session, surface) : null;
      flight.result.afterPressure = this.#pressure(measured);
      // Surface size at commit time is the guard's growth baseline; it is a
      // bounded heuristic measurement, not a provider token count.
      flight.result.afterSurfaceTokens = nonnegative(measured?.surfaceTokens) ? measured.surfaceTokens : null;
      if (!measured) this.#unknown(flight, 'measurement-unavailable');
      this.#finish(entry, event.data.error !== undefined ? 'failed' : flight.replaced ? 'committed' : 'unknown', time);
    } else if (event.type === 'session/end-seed') {
      this.#finish(entry, 'unknown', time);
    }
  }

  status(session) {
    const entry = this.#entries.get(session?.id);
    const result = structuredClone({ observed: !!entry, counts: entry?.counts ?? counts(), latest: entry?.latest ?? null,
      // The last COMMITTED result, preserved across subsequent pending
      // transactions; the efficiency guard reads this, not `latest`.
      lastCommitted: entry?.lastCommitted ?? null });
    if (entry?.flight) result.latest.durationMs = elapsed(entry.flight.startedAt, this.#time());
    return result;
  }

  clear() { this.#entries.clear(); }
}
