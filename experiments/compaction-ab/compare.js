import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, ControlledProvider, appendWork, nativeEstimate, VARIANTS, expected, TEXT_PREFIX, hash, bytes, outcome, user } from './fixtures.js';
import { readStructuredCheckpoint } from './b-backend.js';
import { isCompactCheckpointSource } from './b-host.js';
import { encodeCheckpoint, decodeCheckpoint } from './a-baseline/checkpoint.js';
import { freezeMessage, createAssistantMessage } from './a-host.js';
import { ROUTE } from './a-baseline/constants.js';
import { MODEL } from './fixtures.js';

export async function calibrateA() {
  const f = await createFixture('A-basic', { provider: new ControlledProvider({ cipherChars: 256 }), sessionId: 'ab-calibration' });
  appendWork(f.agent.session, { bulkChars: 16000, label: 'calibration' });
  const result = await f.engine.compactNow(f.agent, new AbortController().signal);
  assert.ok(result);
  const template = f.agent.session.deriveMessages().find(message => message.source?.compactionId === result.compactionId);
  assert.ok(template.content.some(block => block.type === 'text' && block.text.startsWith(TEXT_PREFIX)));
  const makeCarrier = checkpoint => freezeMessage({ ...template, content: template.content.map(block => block.type === 'text' && block.text.startsWith(TEXT_PREFIX) ? { ...block, text: encodeCheckpoint(checkpoint) } : block) });
  return { template, makeCarrier, price: checkpoint => f.ctx.tokenMeter.estimateMessage(makeCarrier(checkpoint)), dispose: f.dispose };
}

function checkpointOf(message, identity) {
  const b = readStructuredCheckpoint(message, expected(identity));
  if (b) return b;
  if (!isCompactCheckpointSource(message.source)) return undefined;
  const text = message.content.find(block => block.type === 'text' && block.text.startsWith(TEXT_PREFIX));
  return text ? decodeCheckpoint(text.text, expected(identity)) : undefined;
}
function referenceTotal(f) {
  const measured = f.ctx.tokenMeter.measure(f.agent.session);
  assert.notEqual(measured.baseline.kind, 'usage', 'This reference estimate is only defined for the unanchored matrix.');
  return measured.nodes.reduce((total, node) => {
    const message = f.agent.session.deriveEventMessage(f.agent.session.eventAt(node.seq));
    const checkpoint = checkpointOf(message, f.provider.auth.identity);
    return total + (checkpoint ? nativeEstimate(checkpoint) - node.tokens : 0);
  }, measured.totalTokens);
}
function eventDelta(session, from) {
  const rows = session.snapshotEvents(from);
  return { events: rows, bytes: rows.reduce((sum, row) => sum + bytes(row) + 1, 0),
    starts: rows.filter(e => e.type === 'compaction/start').length,
    summaries: rows.filter(e => e.type === 'compaction/summary').length,
    ends: rows.filter(e => e.type === 'compaction/end').length };
}

export async function admissionTrial(variant, spec, calibration) {
  const priceCheckpoint = variant === 'B-native-estimate' ? nativeEstimate : calibration.price;
  const provider = new ControlledProvider({ cipherChars: spec.cipherChars });
  const f = await createFixture(variant, { priceCheckpoint, provider });
  try {
    const range = appendWork(f.agent.session, { ...spec, label: 'admission' });
    const before = f.measurement();
    const selected = before.nodes.filter(n => n.seq >= range.start && n.seq <= range.end);
    const turn = f.agent.session.seq;
    f.agent.session.append('turn/start', { turn });
    const startSeq = f.agent.session.seq;
    let result, error;
    try { result = await f.engine.compactRegion(range.start, range.end, f.agent, new AbortController().signal); }
    catch (e) { error = e; }
    const delta = eventDelta(f.agent.session, startSeq);
    const carrierEvent = result && delta.events.find(e => e.type === 'user/message' && e.data.source.compactionId === result.compactionId);
    const checkpoint = provider.lastCheckpoint;
    const after = f.measurement();
    const row = {
      caseId: `${spec.family}/${spec.bulkChars}/${spec.cipherChars}`, ...spec, variant,
      accepted: !!result, error: outcome(error),
      selectedStart: range.start, selectedEnd: range.end,
      selectedHostTokens: selected.reduce((sum, n) => sum + n.hostTokens, 0),
      selectedEffectiveTokens: selected.reduce((sum, n) => sum + n.effectiveTokens, 0),
      aFramedCheckpointPrice: checkpoint ? calibration.price(checkpoint) : null,
      nativeCheckpointEstimate: checkpoint ? nativeEstimate(checkpoint) : null,
      nativeCalls: provider.requests.length,
      inputHash: provider.requests[0] ? hash(provider.requests[0]) : null,
      inputBytes: provider.requests[0] ? bytes(provider.requests[0]) : null,
      outputHash: checkpoint ? hash(checkpoint) : null,
      encodedEnvelopeBytes: checkpoint ? bytes(encodeCheckpoint(checkpoint)) : null,
      carrierBytes: carrierEvent ? bytes(carrierEvent.data) : null,
      summaryUsage: result ? delta.events.find(e => e.type === 'compaction/summary')?.data.usage ?? null : null,
      compactionEventBytes: delta.bytes,
      hostTokensAfter: after.hostTokens,
      effectiveTokensAfter: after.effectiveTokens,
      referenceNativeEstimateAfter: referenceTotal(f),
      expandedHistoryHash: result ? hash(provider.wireProjection(f.agent.session.deriveMessages())) : null,
      starts: delta.starts, summaries: delta.summaries, ends: delta.ends,
    };
    assert.equal(row.nativeCalls, 1, `Every admission case must reach the common transport: ${row.caseId}/${variant}`);
    assert.equal(row.ends, 1, 'Every completed admission attempt must close its bracket');
    assert.equal(row.summaries, row.accepted ? 1 : 0);
    return row;
  } finally { await f.dispose(); }
}

export async function runMatrix(calibration, { families = ['ascii', 'cjk', 'tool'], bulkSizes = [4000, 16000, 64000], cipherSizes = [256, 1024, 4096, 8192, 16384, 32768, 65536, 131072] } = {}) {
  const rows = [];
  for (const family of families) for (const bulkChars of bulkSizes) for (const cipherChars of cipherSizes) {
    const triplet = [];
    for (const variant of VARIANTS) triplet.push(await admissionTrial(variant, { family, bulkChars, cipherChars }, calibration));
    const [a, matched, native] = triplet;
    assert.equal(a.inputHash, matched.inputHash, 'A/B matched must receive identical provider input');
    assert.equal(a.inputHash, native.inputHash, 'A/B native estimate must receive identical provider input');
    assert.equal(a.outputHash, matched.outputHash);
    assert.equal(a.outputHash, native.outputHash);
    assert.equal(a.selectedStart, matched.selectedStart);
    assert.equal(a.selectedEnd, matched.selectedEnd);
    assert.equal(a.accepted, matched.accepted, `Carrier-only ablation admission mismatch at ${a.caseId}`);
    assert.equal(a.selectedEffectiveTokens, matched.selectedEffectiveTokens);
    if (a.accepted) {
      assert.equal(a.expandedHistoryHash, matched.expandedHistoryHash, 'Carrier location alone must not change replay contents');
      assert.equal(a.effectiveTokensAfter, matched.effectiveTokensAfter);
      assert.deepEqual(a.summaryUsage, matched.summaryUsage, 'Storage comparison must preserve the same available accounting metadata.');
      assert.equal(a.referenceNativeEstimateAfter, matched.referenceNativeEstimateAfter);
      if (native.accepted) assert.equal(a.expandedHistoryHash, native.expandedHistoryHash);
    }
    rows.push(...triplet);
  }
  return rows;
}

export async function restoredRounds(variant, calibration) {
  const provider = new ControlledProvider({ cipherChars: 16384 });
  const f = await createFixture(variant, { provider, priceCheckpoint: variant === 'B-native-estimate' ? nativeEstimate : calibration.price });
  const rounds = [];
  const scratch = await mkdtemp(join(tmpdir(), 'compaction-ab-restore-'));
  const logPath = join(scratch, 'PROTOTYPE-synthetic-events.jsonl');
  let flushes = 0;
  f.ctx.on('session/flush', () => { flushes++; });
  try {
    for (let round = 0; round < 3; round++) {
      appendWork(f.agent.session, { family: 'tool', bulkChars: 64000, label: `restore-${round}` });
      const from = f.agent.session.seq;
      const result = await f.engine.compactNow(f.agent, new AbortController().signal);
      assert.ok(result);
      const delta = eventDelta(f.agent.session, from);
      const carrier = delta.events.find(e => e.type === 'user/message').data;
      const checkpoint = checkpointOf(carrier, provider.auth.identity);
      assert.equal(hash(checkpoint), hash(provider.lastCheckpoint), 'Opaque output including unknown fields must survive the carrier');
      const request = provider.requests.at(-1);
      if (round) assert.equal(request.input.find(item => item.type === 'compaction')?.id, `cmp-ab-${round}`);
      // JSONL serialization uses only public event snapshots; a seeded live
      // Session is restored through public store admission, not private logs.
      const jsonl = f.agent.session.snapshotEvents().map(e => JSON.stringify(e)).join('\n') + '\n';
      await writeFile(logPath, jsonl, { mode: 0o600 });
      const worker = spawnSync(process.execPath, [fileURLToPath(new URL('./restore-worker.js', import.meta.url)), logPath, result.compactionId, checkpoint.provider, checkpoint.model, checkpoint.identity], { encoding: 'utf8', timeout: 10000 });
      assert.equal(worker.status, 0, worker.stderr);
      const workerResult = JSON.parse(worker.stdout);
      assert.equal(workerResult.checkpointHash, hash(checkpoint), 'A separate process must recover the identical full opaque JSON.');
      const persisted = await readFile(logPath, 'utf8');
      const seed = persisted.trimEnd().split('\n').map(line => JSON.parse(line));
      f.agent.session = f.ctx.sessions.create(undefined, { seed });
      const header = f.agent.session.requestHeader();
      const normal = await provider.normalReplay({ messages: f.agent.session.deriveMessages(), system: header?.system, tools: header?.tools });
      rounds.push({ round: round + 1, inputHash: hash(request), outputHash: hash(checkpoint), jsonlBytes: bytes(persisted), separateProcessCheckpointVerified: true,
        normalInferenceInputHash: normal.inputHash, normalInferenceInputBytes: normal.inputBytes,
        expandedHistoryHash: hash(provider.wireProjection(f.agent.session.deriveMessages())),
        carrierBytes: bytes(carrier), compactionEventBytes: delta.bytes,
        hostTokensAfter: f.measurement().hostTokens, effectiveTokensAfter: f.measurement().effectiveTokens,
        referenceNativeEstimateAfter: referenceTotal(f),
        starts: delta.starts, summaries: delta.summaries, ends: delta.ends });
    }
    assert.equal(flushes, 3);
    // Current auth binding changes: both carrier types must reject before the
    // next provider request, not silently continue with opaque foreign state.
    const priorCalls = provider.requests.length;
    provider.changeAccount();
    let incompatible = false;
    try { await provider.compact({ messages: f.agent.session.deriveMessages() }); } catch { incompatible = true; }
    assert.equal(incompatible, true);
    assert.equal(provider.requests.length, priorCalls);
    const priorNormalCalls = provider.normalRequests.length;
    let normalIncompatible = false;
    try { await provider.normalReplay({ messages: f.agent.session.deriveMessages() }); } catch { normalIncompatible = true; }
    assert.equal(normalIncompatible, true);
    assert.equal(provider.normalRequests.length, priorNormalCalls);
    return { variant, rounds, flushes, wrongIdentityRejectedBeforeFetch: incompatible, normalReplayIdentityRejectedBeforeFetch: normalIncompatible };
  } finally { await f.dispose(); await rm(scratch, { recursive: true, force: true }); }
}

export const FAILURE_SCENARIOS = ['provider-error', 'abort-before', 'abort-during', 'split-tool-pair', 'rewrite-selected', 'append-tail-manual', 'append-tail-region', 'live-lock', 'no-open-turn', 'invalid-usage-commit', 'flush-error'];
export async function failureTrial(variant, scenario, calibration) {
  const provider = new ControlledProvider({ cipherChars: 256 });
  const f = await createFixture(variant, { provider, priceCheckpoint: variant === 'B-native-estimate' ? nativeEstimate : calibration.price });
  try {
    const range = appendWork(f.agent.session, { family: 'tool', bulkChars: 16000, label: 'failure' });
    const controller = new AbortController();
    const manual = ['append-tail-manual', 'flush-error', 'live-lock', 'invalid-usage-commit'].includes(scenario);
    if (!manual && scenario !== 'no-open-turn') f.agent.session.append('turn/start', { turn: f.agent.session.seq });
    if (scenario === 'live-lock') f.agent.session.append('compaction/start', { compactionId: 'already-live', turn: null });
    if (scenario === 'provider-error') provider.fail = true;
    if (scenario === 'invalid-usage-commit') provider.invalidUsage = true;
    if (scenario === 'abort-before') controller.abort();
    if (scenario === 'abort-during') provider.onFetch = () => controller.abort();
    if (scenario === 'rewrite-selected') provider.onFetch = () => f.agent.session.append('user/message', user('New source must not be overwritten.', 'replacement-user'), { surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.start }, sourceEventSeqs: [range.start] });
    if (scenario.startsWith('append-tail')) provider.onFetch = () => f.agent.session.append('user/message', user('Independent new tail.', 'appended-tail'), { surfaceOp: 'append' });
    if (scenario === 'flush-error') f.ctx.on('session/flush', () => { throw new Error('synthetic flush failure'); });
    const from = f.agent.session.seq;
    let result, error;
    try { result = manual ? await f.engine.compactNow(f.agent, controller.signal) : await f.engine.compactRegion(range.start, scenario === 'split-tool-pair' ? range.toolCallSeq : range.end, f.agent, controller.signal); }
    catch (e) { error = e; }
    const delta = eventDelta(f.agent.session, from);
    const outcomeCode = result ? 'success' : error?.code === 'persistence' ? 'persistence-error-after-replacement' : 'rejected';
    return { variant, scenario, outcome: outcomeCode, error: outcome(error), nativeCalls: provider.requests.length, nativeOutputs: provider.responses.length,
      starts: delta.starts, summaries: delta.summaries, ends: delta.ends,
      nativeReplacement: delta.events.some(e => e.type === 'user/message' && isCompactCheckpointSource(e.data.source)),
      appendedTailSurvived: !scenario.startsWith('append-tail') || f.agent.session.deriveMessages().some(m => m.id === 'appended-tail'),
      selectedRewriteSurvived: scenario !== 'rewrite-selected' || f.agent.session.deriveMessages().some(m => m.id === 'replacement-user') };
  } finally { await f.dispose(); }
}

export async function runFailures(calibration) {
  const rows = [];
  for (const scenario of FAILURE_SCENARIOS) {
    const group = [];
    for (const variant of VARIANTS) group.push(await failureTrial(variant, scenario, calibration));
    // A pre-aborted explicit region logs a failed bracket; B checks cancellation
    // before opening one. Preserve that trace difference in the report, while
    // requiring the same effects and a balanced, at-most-one attempt.
    const semantic = row => ({ outcome: row.outcome, nativeCalls: row.nativeCalls, nativeOutputs: row.nativeOutputs, balancedSingleAttempt: row.starts === row.ends && row.starts <= 1, summaries: row.summaries, nativeReplacement: row.nativeReplacement, appendedTailSurvived: row.appendedTailSurvived, selectedRewriteSurvived: row.selectedRewriteSurvived });
    assert.deepEqual(semantic(group[0]), semantic(group[1]), `Failure parity mismatch: ${scenario}`);
    assert.deepEqual(semantic(group[0]), semantic(group[2]), `Failure parity mismatch: ${scenario}`);
    const reference = group[0];
    assert.equal(semantic(reference).balancedSingleAttempt, true);
    if (scenario === 'rewrite-selected' || scenario.startsWith('append-tail')) assert.equal(reference.nativeOutputs, 1, 'Mutation must reach the post-provider stability check, not fail inside fixture transport.');
    assert.equal(reference.appendedTailSurvived, true);
    assert.equal(reference.selectedRewriteSurvived, true);
    if (scenario === 'invalid-usage-commit') { assert.equal(reference.nativeOutputs, 1); assert.ok(reference.error.codes.includes('commit'), 'Invalid usage must exercise host commit validation.'); }
    if (scenario === 'append-tail-manual') assert.equal(reference.outcome, 'success');
    else if (scenario === 'flush-error') { assert.equal(reference.outcome, 'persistence-error-after-replacement'); assert.equal(reference.nativeReplacement, true); }
    else { assert.equal(reference.outcome, 'rejected'); assert.equal(reference.nativeReplacement, false); }
    rows.push(...group);
  }
  return rows;
}

// Additional adversarial metering challenge, not a real-token oracle. All
// variants receive the identical synthetic provider usage AFTER their native
// checkpoint is in the request; that usage already covers its opaque payload.
export async function usageAnchorChallenge(variant, calibration) {
  const f = await createFixture(variant, { provider: new ControlledProvider({ cipherChars: 16384 }), priceCheckpoint: variant === 'B-native-estimate' ? nativeEstimate : calibration.price });
  try {
    appendWork(f.agent.session, { bulkChars: 64000, label: 'usage-anchor' });
    await f.engine.compactNow(f.agent, new AbortController().signal);
    const session = f.agent.session, turn = session.seq;
    session.append('turn/start', { turn });
    session.append('step/start', { turn, step: 1 });
    session.append('request/header', { header: session.requestHeader(), reason: 'series' });
    const fixtureUsage = { inputTokens: 10000, outputTokens: 10, totalTokens: 10010 };
    session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ source: { provider: ROUTE, model: MODEL }, content: [{ type: 'text', text: 'Synthetic reported-usage fixture.' }] }), usage: fixtureUsage }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step: 1 });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
    const host = f.ctx.tokenMeter.measure(session);
    assert.equal(host.baseline.kind, 'usage', 'The challenge must actually activate provider-usage reuse.');
    // 0.1.7 composes the usage baseline with the surface nodes that follow the
    // anchor, so the reported total alone is not the whole host total: the
    // anchor message itself is surface delta (17 heuristic tokens here). The
    // precondition that matters is that the REPORTED usage became the baseline.
    assert.equal(host.baseline.tokens, fixtureUsage.totalTokens, 'The reported usage must be reused as the baseline anchor.');
    assert.equal(host.totalTokens, host.baseline.tokens + host.surfaceDeltaTokens);
    const measured = f.measurement();
    const effective = measured.effectiveTokens;
    const naive = measured.nodes.reduce((total, node) => total + node.effectiveTokens - node.hostTokens, host.totalTokens);
    return { variant, baselineKind: host.baseline.kind, reportedFixtureTokens: fixtureUsage.totalTokens, baselineTokens: host.baseline.tokens,
      surfaceDeltaTokens: host.surfaceDeltaTokens, hostTokens: host.totalTokens,
      naiveEffectiveTokens: naive, naiveDuplicateAdjustment: naive - host.totalTokens,
      effectiveTokens: effective, duplicateAdjustment: effective - host.totalTokens,
      avoidsDoubleCounting: effective === host.totalTokens, realProviderUsage: false };
  } finally { await f.dispose(); }
}

export function summarizeResults(matrix, restoration, failures) {
  const counts = VARIANTS.map(variant => {
    const rows = matrix.filter(row => row.variant === variant);
    return { variant, total: rows.length, accepted: rows.filter(row => row.accepted).length, rejected: rows.filter(row => !row.accepted).length };
  });
  const byCase = new Map();
  for (const row of matrix) { if (!byCase.has(row.caseId)) byCase.set(row.caseId, {}); byCase.get(row.caseId)[row.variant] = row; }
  let bothAccepted = 0, aBatchBytes = 0, bBatchBytes = 0, aCarrierBytes = 0, bCarrierBytes = 0;
  const estimatorOnlyGains = [];
  for (const [caseId, group] of byCase) {
    const a = group['A-basic'], b = group['B-matched-price'], n = group['B-native-estimate'];
    if (a.accepted) { bothAccepted++; aBatchBytes += a.compactionEventBytes; bBatchBytes += b.compactionEventBytes; aCarrierBytes += a.carrierBytes; bCarrierBytes += b.carrierBytes; }
    if (!a.accepted && n.accepted) estimatorOnlyGains.push({ caseId, sourcePrice: a.selectedEffectiveTokens, aPrice: a.aFramedCheckpointPrice, nativeEstimate: n.nativeCheckpointEstimate });
  }
  return { admission: counts, matchedPriceAdmissionParity: true, identicalProviderInputsAcrossVariants: true,
    bothAccepted, storageBytesForBothAccepted: { aBatchBytes, bBatchBytes, aCarrierBytes, bCarrierBytes },
    estimatorOnlyGains, restorationRoundsPerVariant: restoration.map(r => ({ variant: r.variant, rounds: r.rounds.length, normalInferenceRounds: r.rounds.filter(row => row.normalInferenceInputHash).length, wrongIdentityRejectedBeforeFetch: r.wrongIdentityRejectedBeforeFetch, normalReplayIdentityRejectedBeforeFetch: r.normalReplayIdentityRejectedBeforeFetch })),
    failureScenariosPerVariant: failures.length / VARIANTS.length, failureSemanticParity: true };
}
