// Independent controlled-experiment prototype, NOT production equivalence.
// Pricing is runner-supplied ESTIMATION, never native usage or token truth.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CompactionEngine, ManualCompactionError, compactCheckpointSource,
  isCompactCheckpointSource, toolPairingBalancedBefore, toolPairingBalancedAfter,
  createUserMessage, errorChain, Session,
} from './b-host.js';
import { encodeCheckpoint, decodeCheckpoint } from './a-baseline/checkpoint.js';

const DISPLAY = 'Experimental structured native checkpoint (prototype; pricing estimate).';
const summary = () => [{ type: 'text', text: DISPLAY }];
class Changed extends Error {}
const manualError = (code, cause) => new ManualCompactionError(code, `structured prototype compaction: ${code}`, { cause });
const recordInput = ({ provider, model, identity, items }) => ({ provider, model, identity, items });

/** Inspection without expected is NOT replay authorization. Replay must bind all three labels. */
export function readStructuredCheckpoint(message, expected) {
  const native = message?.source?.nativeAB;
  if (native === undefined) return undefined;
  if (message.role !== 'user' || !isCompactCheckpointSource(message.source)
      || typeof message.source.compactionId !== 'string' || !message.source.compactionId) {
    throw new Error('structured checkpoint lacks public compaction provenance');
  }
  if (!native || native.version !== 1 || native.protocol !== 'responses.compaction-trigger.v2') {
    throw new Error('unsupported structured checkpoint version/protocol');
  }
  // Codec roundtrip validates JSON limits and snapshots opaque items unchanged.
  const decoded = decodeCheckpoint(encodeCheckpoint(native), expected ?? native);
  if (!isDeepStrictEqual(native, decoded)) throw new Error('structured checkpoint schema mismatch');
  return decoded;
}

function estimate(priceCheckpoint, record) {
  // Runner-owned pricing cannot rewrite the opaque payload we later persist.
  const value = priceCheckpoint(recordInput(decodeCheckpoint(encodeCheckpoint(record), record)));
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('priceCheckpoint must return a finite nonnegative token estimate');
  }
  return value;
}

function effectiveNodes(session, measurement, priceCheckpoint) {
  const surface = session.surface.nodes;
  if (surface.length !== measurement.nodes.length || surface.some((seq, i) => seq !== measurement.nodes[i].seq)) {
    throw new Changed('meter surface mismatch');
  }
  return measurement.nodes.map(node => {
    const message = session.deriveEventMessage(session.eventAt(node.seq));
    const record = readStructuredCheckpoint(message);
    return {
      seq: node.seq, hostTokens: node.tokens, hostHeuristicTokens: node.heuristicTokens,
      effectiveTokens: record === undefined ? node.tokens : estimate(priceCheckpoint, record),
      structuredCheckpoint: record !== undefined,
    };
  });
}
const hiddenDelta = nodes => nodes.reduce((total, node) => total + node.effectiveTokens - node.hostTokens, 0);

/**
 * Locate the rc.1 usage anchor through public replay, not private meter state.
 * Its request surface is the surface BEFORE its matching step/start. In-step
 * replacements/appends and interrupted provider-output suffixes are not part
 * of that request surface. The last assistant is selected by EVENT IDENTITY,
 * never by a change in usage counts (two distinct calls can report equal usage).
 * The same meter verifies the candidate under the current canonical envelope;
 * future/unsupported behavior fails explicitly instead of guessing an anchor.
 * This intentionally expensive O(event-count + payload) replay is an experiment, not a
 * production incremental-meter design. No state is installed into the live log.
 */
function usageAnchor(session, meter, hostMeasurement, priceCheckpoint) {
  const events = session.snapshotEvents();
  const assistantIndex = events.findLastIndex(event => event.type === 'assistant/message');
  const assistant = events[assistantIndex];
  const fail = () => {
    const error = new Error('Cannot verify structured checkpoint usage anchor through public replay');
    error.code = 'B_USAGE_ANCHOR_UNRESOLVED';
    throw error;
  };
  if (!assistant || assistant.data.usage === undefined) return fail();
  const stepIndex = events.findLastIndex((event, index) => index < assistantIndex && event.type === 'step/start');
  const step = events[stepIndex];
  if (!step || step.data.turn !== assistant.data.turn || step.data.step !== assistant.data.step) return fail();
  const prefix = end => Session.create(session.id, events.slice(0, end), session.header);
  const header = session.requestHeader();
  const atAssistant = meter.measure(prefix(assistantIndex + 1), header);
  // Equal usage alone is insufficient. The invariant also verifies the exact
  // route-priced anchor surface, including provider rather than durable output.
  if (!isDeepStrictEqual(atAssistant.baseline, hostMeasurement.baseline)
      || atAssistant.surfaceTokens - atAssistant.surfaceDeltaTokens
        !== hostMeasurement.surfaceTokens - hostMeasurement.surfaceDeltaTokens) return fail();
  const request = prefix(stepIndex);
  const requestMeasurement = meter.measure(request, header);
  return {
    assistantSeq: assistant.seq, stepStartSeq: step.seq,
    hiddenDelta: hiddenDelta(effectiveNodes(request, requestMeasurement, priceCheckpoint)),
  };
}

/**
 * Correct only the hidden-payload DELTA not already covered by reused usage.
 * Per-node prices remain independent runner estimates for shrink comparisons.
 * A reused usage anchor covers historical opaque payload even if that payload
 * has since been replaced. Pure estimated baselines need only current payload.
 */
export function measureEffective(session, meter, priceCheckpoint) {
  const hostMeasurement = meter.measure(session);
  const nodes = effectiveNodes(session, hostMeasurement, priceCheckpoint);
  const currentHiddenDelta = hiddenDelta(nodes);
  const anchor = hostMeasurement.baseline.kind === 'usage'
    ? usageAnchor(session, meter, hostMeasurement, priceCheckpoint) : undefined;
  const anchorHiddenDelta = anchor?.hiddenDelta ?? 0;
  const correctionTokens = currentHiddenDelta - anchorHiddenDelta;
  return {
    hostTokens: hostMeasurement.totalTokens,
    // Correct before the host's nonnegative clamp, otherwise a large historical
    // replacement can erase a negative raw host delta that B still needs.
    effectiveTokens: Math.max(0, hostMeasurement.baseline.tokens + hostMeasurement.surfaceDeltaTokens + correctionTokens),
    pricing: 'prototype-estimate', nodes, hostMeasurement,
    anchorAdjustment: {
      kind: anchor ? 'verified-usage-prefix' : 'no-usage',
      assistantSeq: anchor?.assistantSeq ?? null, stepStartSeq: anchor?.stepStartSeq ?? null,
      currentHiddenDelta, anchorHiddenDelta, correctionTokens,
    },
  };
}

function entry(session) {
  let turn = null;
  let turnKnown = false;
  let bracketKnown = false;
  let lock;
  let seed;
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (seed === undefined && event.type === 'session/end-seed') seed = seq;
    if (!bracketKnown && ['compaction/start', 'compaction/end'].includes(event.type)) {
      bracketKnown = true;
      if (event.type === 'compaction/start') lock = seq;
    }
    if (!turnKnown && ['turn/start', 'turn/end'].includes(event.type)) {
      turnKnown = true;
      if (event.type === 'turn/start') turn = event.data.turn;
    }
  }
  if (lock !== undefined && !(seed !== undefined && seed > lock)) throw manualError('busy');
  return turn;
}

function select(session, start, end) {
  const nodes = session.surface.nodes;
  const first = nodes.indexOf(start);
  const last = nodes.indexOf(end);
  if (first < 0 || last < first) throw new Error('invalid compactRegion surface range');
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
    throw new Error('compactRegion would split a tool pairing');
  }
  return { first, last, seqs: nodes.slice(first, last + 1) };
}

export class StructuredCompactionEngine extends CompactionEngine {
  static inject = ['tokenMeter', 'sessions'];
  constructor(ctx, { summarize, priceCheckpoint }) {
    if (typeof summarize !== 'function' || typeof priceCheckpoint !== 'function') throw new TypeError('summarize and priceCheckpoint are required');
    super(ctx);
    this.summarize = summarize;
    this.priceCheckpoint = priceCheckpoint;
  }

  compactRegion(start, end, agent, signal) {
    return transact(this, start, end, agent, signal, false);
  }

  compactNow(agent, signal, sourceCommandId) {
    signal.throwIfAborted();
    try {
      return agent.runMaintenance(async agentSignal => {
        const operation = AbortSignal.any([signal, agentSignal]);
        try {
          operation.throwIfAborted();
          const session = agent.session;
          if (entry(session) !== null) throw manualError('busy');
          const nodes = session.surface.nodes;
          let keep = nodes.length - 1;
          while (keep > 0 && !toolPairingBalancedBefore(session, nodes[keep])) keep--;
          if (keep <= 0) return null;
          return await transact(this, nodes[0], nodes[keep - 1], agent, operation, true, sourceCommandId);
        } catch (error) {
          if (agentSignal.aborted && operation.reason === agentSignal.reason) throw manualError('cancelled', error);
          operation.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      throw manualError('busy', error);
    }
  }

}

// Module-private transaction also works through Cordis' public service Proxy.
async function transact(engine, start, end, agent, signal, manual, sourceCommandId) {
    signal?.throwIfAborted();
    const session = agent.session;
    const selected = select(session, start, end);
    const turn = entry(session);
    if (manual ? turn !== null : turn === null) {
      if (manual) throw manualError('busy');
      throw new Error('compactRegion requires an open turn');
    }
    const lifecycle = { compactionId: randomUUID(), turn, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) };
    // Synchronous entry check + append is the shared durable lock.
    const opened = session.append('compaction/start', lifecycle);
    let stage = 'summary';
    let closing = false;
    let closed = false;
    let failure;
    let persistence;
    let result;
    try {
      const before = measureEffective(session, engine.ctx.tokenMeter, engine.priceCheckpoint);
      const priced = before.nodes.slice(selected.first, selected.last + 1);
      const hostSelected = before.hostMeasurement.nodes.slice(selected.first, selected.last + 1);
      const messages = selected.seqs.map(seq => session.deriveEventMessage(session.eventAt(seq))).filter(message => message !== null);
      const header = session.requestHeader();
      const input = {
        messages, ...(header?.system === undefined ? {} : { system: header.system }),
        ...(header?.tools === undefined ? {} : { tools: header.tools }),
      };
      const native = await engine.summarize(input, agent, signal);
      signal?.throwIfAborted();
      const record = decodeCheckpoint(encodeCheckpoint(native), native);
      const checkpointPrice = estimate(engine.priceCheckpoint, record);
      const sourcePrice = priced.reduce((total, node) => total + node.effectiveTokens, 0);
      if (checkpointPrice >= sourcePrice) throw new Error(`checkpoint estimate is not smaller (${checkpointPrice} >= ${sourcePrice})`);
      if (agent.session !== session) throw new Changed('agent session changed');
      const current = measureEffective(session, engine.ctx.tokenMeter, engine.priceCheckpoint);
      let target;
      try { target = select(session, start, end); }
      catch (cause) { throw new Changed('selected span no longer balanced/present', { cause }); }
      const stable = manual
        ? isDeepStrictEqual(selected.seqs, target.seqs)
          && isDeepStrictEqual(hostSelected, current.hostMeasurement.nodes.slice(target.first, target.last + 1))
          && isDeepStrictEqual(priced, current.nodes.slice(target.first, target.last + 1))
        : isDeepStrictEqual(before.hostMeasurement.nodes, current.hostMeasurement.nodes)
          && isDeepStrictEqual(before.nodes, current.nodes);
      if (!stable) throw new Changed('surface changed during summarization');
      const message = createUserMessage({ content: summary(), source: { ...compactCheckpointSource(lifecycle.compactionId, sourceCommandId), nativeAB: record } });
      stage = 'commit';
      // Durable accounting is the actual canonical host heuristic sum, NOT B pricing.
      const shadowedTokenCount = priced.reduce((total, node) => total + node.hostHeuristicTokens, 0);
      const data = {
        compactionId: lifecycle.compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        summary: summary(), shadowedRange: { start, end }, shadowedSeqs: [...selected.seqs],
        shadowedTokenCount, provider: record.provider, model: record.model,
        ...(native.usage === undefined ? {} : { usage: native.usage }),
      };
      const summarized = session.append('compaction/summary', data);
      session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [opened.seq, summarized.seq, ...selected.seqs],
      });
      closing = true;
      const ended = session.append('compaction/end', lifecycle);
      closed = true;
      result = {
        compactionId: lifecycle.compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        startSeq: opened.seq, summarySeq: summarized.seq, endSeq: ended.seq,
        summary: data.summary, shadowedRange: data.shadowedRange, shadowedSeqs: data.shadowedSeqs, shadowedTokenCount,
      };
    } catch (error) {
      failure = { error, stage };
      if (!closing) {
        closing = true;
        try { session.append('compaction/end', { ...lifecycle, error: errorChain(error) }); closed = true; }
        catch (error) { failure = { error, stage: 'commit' }; }
      }
    }
    if (closed && manual) {
      try { await engine.ctx.sessions.flush(session); }
      catch (error) { persistence = error; }
    }
    signal?.throwIfAborted();
    if (failure) {
      if (!manual) throw failure.error;
      throw manualError(failure.stage === 'commit' ? 'commit' : failure.error instanceof Changed ? 'changed' : 'summary', failure.error);
    }
    if (persistence) throw manualError('persistence', persistence);
    return result;
}
