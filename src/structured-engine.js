// Manual-only structured Codex engine; prices are estimates, never fabricated usage.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CompactionEngine, ManualCompactionError, compactCheckpointSource,
  toolPairingBalancedBefore, toolPairingBalancedAfter,
  createUserMessage, errorChain, Session,
} from './engine-host.js';
import { compactionSystemPrompt, replaceSurfaceOp } from './compatibility.js';

const summary = () => [{ type: 'text', text: 'Codex structured checkpoint (context size is estimated).' }];
const manualError = (code, cause) => new ManualCompactionError(code, `structured Codex compaction: ${code}`, { cause });
class Changed extends Error {}
// Public-prefix reconstruction is intentionally bounded, not a private meter cache.
const MAX_EVENTS = 100000;
function guard(session, signal) {
  signal?.throwIfAborted();
  if (session.seq > MAX_EVENTS) throw new Error(`structured compaction history exceeds ${MAX_EVENTS} event work limit`);
}
function estimate(engine, record) {
  // The codec detaches the record, so a pricing callback cannot mutate persistence.
  const value = engine.estimateCheckpoint(engine.validateCheckpoint(record));
  if (!value || typeof value.tokens !== 'number' || !Number.isFinite(value.tokens)
      || value.tokens < 0 || value.exact !== false || typeof value.basis !== 'string' || !value.basis.trim()) {
    throw new Error('estimateCheckpoint must return {tokens: finite nonnegative number, basis: nonempty string, exact: false}');
  }
  return { tokens: value.tokens, basis: value.basis, exact: false };
}
function effectiveNodes(engine, session, measurement, signal) {
  const surface = session.surface.nodes;
  if (surface.length !== measurement.nodes.length || surface.some((seq, i) => seq !== measurement.nodes[i].seq)) {
    throw new Changed('meter surface mismatch');
  }
  return measurement.nodes.map(node => {
    signal?.throwIfAborted();
    const record = engine.readCheckpoint(session.deriveEventMessage(session.eventAt(node.seq)));
    const price = record === undefined ? undefined : estimate(engine, record);
    return {
      seq: node.seq, hostTokens: node.tokens, hostHeuristicTokens: node.heuristicTokens,
      effectiveTokens: price?.tokens ?? node.tokens,
      structuredCheckpoint: record !== undefined,
      ...(price ? { estimate: price } : {}),
    };
  });
}
const hiddenDelta = nodes => nodes.reduce((sum, node) => sum + node.effectiveTokens - node.hostTokens, 0);

// Verify the most recent assistant by EVENT IDENTITY, including equal-count later
// anchors. Its request is the prefix BEFORE step/start, excluding in-step edits
// and interrupted durable output. All replay uses public Session/TokenMeter.
function usageAnchor(engine, session, hostMeasurement, signal) {
  guard(session, signal);
  const meter = engine.ctx.tokenMeter;
  const events = session.snapshotEvents();
  const assistantIndex = events.findLastIndex(event => event.type === 'assistant/message');
  const assistant = events[assistantIndex];
  const fail = () => {
    const error = new Error('Cannot verify structured checkpoint usage anchor through public replay');
    error.code = 'CODEX_USAGE_ANCHOR_UNRESOLVED';
    throw error;
  };
  if (!assistant || assistant.data.usage === undefined) return fail();
  const stepIndex = events.findLastIndex((event, index) => index < assistantIndex && event.type === 'step/start');
  const step = events[stepIndex];
  if (!step || step.data.turn !== assistant.data.turn || step.data.step !== assistant.data.step) return fail();
  const prefix = end => {
    signal?.throwIfAborted();
    return Session.create(session.id, events.slice(0, end), session.header);
  };
  const header = session.requestHeader();
  const atAssistant = meter.measure(prefix(assistantIndex + 1), header);
  if (!isDeepStrictEqual(atAssistant.baseline, hostMeasurement.baseline)
      || atAssistant.surfaceTokens - atAssistant.surfaceDeltaTokens
        !== hostMeasurement.surfaceTokens - hostMeasurement.surfaceDeltaTokens) return fail();
  const request = prefix(stepIndex);
  const requestMeasurement = meter.measure(request, header);
  return {
    assistantSeq: assistant.seq, stepStartSeq: step.seq,
    hiddenDelta: hiddenDelta(effectiveNodes(engine, request, requestMeasurement, signal)),
  };
}
function measure(engine, session, signal) {
  guard(session, signal);
  const hostMeasurement = engine.ctx.tokenMeter.measure(session);
  const nodes = effectiveNodes(engine, session, hostMeasurement, signal);
  const currentHiddenDelta = hiddenDelta(nodes);
  const anchor = hostMeasurement.baseline.kind === 'usage'
    ? usageAnchor(engine, session, hostMeasurement, signal) : undefined;
  const anchorHiddenDelta = anchor?.hiddenDelta ?? 0;
  const correctionTokens = currentHiddenDelta - anchorHiddenDelta;
  const effectiveTokens = Math.max(0, hostMeasurement.baseline.tokens + hostMeasurement.surfaceDeltaTokens + correctionTokens);
  if (!Number.isFinite(effectiveTokens)) throw new Error('effective checkpoint estimate overflow');
  return {
    hostTokens: hostMeasurement.totalTokens, effectiveTokens,
    pricing: 'provider-estimate', exact: false, nodes, hostMeasurement,
    anchorAdjustment: {
      kind: anchor ? 'verified-usage-prefix' : 'no-usage',
      assistantSeq: anchor?.assistantSeq ?? null, stepStartSeq: anchor?.stepStartSeq ?? null,
      currentHiddenDelta, anchorHiddenDelta, correctionTokens,
    },
  };
}
function entry(session, signal) {
  guard(session, signal);
  let turn = null, turnKnown = false, bracketKnown = false, lock, seed;
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    signal?.throwIfAborted();
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
  const first = nodes.indexOf(start), last = nodes.indexOf(end);
  if (first < 0 || last < first) throw new Error('invalid compactRegion surface range');
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
    throw new Error('compactRegion would split a tool pairing');
  }
  return { first, last, seqs: nodes.slice(first, last + 1) };
}

/**
 * Owner-supplied pure codecs validate provenance/native schema and detach records.
 * compact(input, agent, signal) -> {checkpoint, usage?}; no text fallback.
 * No automatic policy is registered. compactRegion is an explicit open-turn call.
 */
export class StructuredCodexCompactionEngine extends CompactionEngine {
  static inject = ['tokenMeter', 'sessions'];
  constructor(ctx, { compact, readCheckpoint, validateCheckpoint, estimateCheckpoint }) {
    if ([compact, readCheckpoint, validateCheckpoint, estimateCheckpoint].some(fn => typeof fn !== 'function')) {
      throw new TypeError('compact, readCheckpoint, validateCheckpoint and estimateCheckpoint are required');
    }
    super(ctx);
    Object.assign(this, { compact, readCheckpoint, validateCheckpoint, estimateCheckpoint });
  }
  measureEffective(session) { return measure(this, session); }
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
          if (entry(session, operation) !== null) throw manualError('busy');
          const nodes = session.surface.nodes;
          let keep = nodes.length - 1;
          while (keep > 0 && !toolPairingBalancedBefore(session, nodes[keep])) { operation.throwIfAborted(); keep--; }
          if (keep <= 0) return null;
          return await transact(this, nodes[0], nodes[keep - 1], agent, operation, true, sourceCommandId);
        } catch (error) {
          if (agentSignal.aborted && operation.reason === agentSignal.reason) throw manualError('cancelled', error);
          operation.throwIfAborted();
          throw error;
        }
      });
    } catch (error) { throw manualError('busy', error); }
  }
}

// Module-private functions rather than JS private methods support Cordis scope proxies.
async function transact(engine, start, end, agent, signal, manual, sourceCommandId) {
  signal?.throwIfAborted();
  const session = agent.session;
  guard(session, signal);
  const selected = select(session, start, end);
  const turn = entry(session, signal);
  if (manual ? turn !== null : turn === null) {
    if (manual) throw manualError('busy');
    throw new Error('compactRegion requires an open turn');
  }
  const lifecycle = { compactionId: randomUUID(), turn, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) };
  const opened = session.append('compaction/start', lifecycle);
  let stage = 'summary', closing = false, closed = false, failure, persistence, result;
  try {
    const before = measure(engine, session, signal);
    const priced = before.nodes.slice(selected.first, selected.last + 1);
    const hostSelected = before.hostMeasurement.nodes.slice(selected.first, selected.last + 1);
    const messages = selected.seqs.map(seq => session.deriveEventMessage(session.eventAt(seq))).filter(message => message !== null);
    const header = session.requestHeader();
    const system = compactionSystemPrompt(session, messages);
    const input = { messages, ...(system === undefined ? {} : { system }), ...(header?.tools === undefined ? {} : { tools: header.tools }) };
    const native = await engine.compact(input, agent, signal);
    signal?.throwIfAborted();
    const record = engine.validateCheckpoint(native?.checkpoint);
    const checkpointPrice = estimate(engine, record);
    const sourcePrice = priced.reduce((sum, node) => sum + node.effectiveTokens, 0);
    if (!Number.isFinite(sourcePrice) || checkpointPrice.tokens >= sourcePrice) {
      throw new Error(`checkpoint estimate is not smaller (${checkpointPrice.tokens} >= ${sourcePrice})`);
    }
    if (agent.session !== session) throw new Changed('agent session changed');
    const current = measure(engine, session, signal);
    let target;
    try { target = select(session, start, end); }
    catch (cause) { throw new Changed('selected span no longer balanced/present', { cause }); }
    const stable = manual
      ? isDeepStrictEqual(selected.seqs, target.seqs)
        && isDeepStrictEqual(hostSelected, current.hostMeasurement.nodes.slice(target.first, target.last + 1))
        && isDeepStrictEqual(priced, current.nodes.slice(target.first, target.last + 1))
      : isDeepStrictEqual(before.hostMeasurement.nodes, current.hostMeasurement.nodes) && isDeepStrictEqual(before.nodes, current.nodes);
    if (!stable || !isDeepStrictEqual(header, session.requestHeader())) throw new Changed('surface changed during compaction');
    const message = createUserMessage({ content: summary(), source: { ...compactCheckpointSource(lifecycle.compactionId, sourceCommandId), nativeCodex: record } });
    stage = 'commit';
    // Durable shadow accounting uses honest host heuristics, NOT opaque estimates.
    const shadowedTokenCount = priced.reduce((sum, node) => sum + node.hostHeuristicTokens, 0);
    const data = {
      compactionId: lifecycle.compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      summary: summary(), shadowedRange: { start, end }, shadowedSeqs: [...selected.seqs],
      shadowedTokenCount, provider: record.provider, model: record.model,
      ...(native.usage === undefined ? {} : { usage: native.usage }),
    };
    const summarized = session.append('compaction/summary', data);
    session.append('user/message', message, { surfaceOp: replaceSurfaceOp(start, end), sourceEventSeqs: [opened.seq, summarized.seq, ...selected.seqs] });
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
