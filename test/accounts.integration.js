// Explicit paired-checkout suite. Run only via scripts/test-accounts.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat, mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { Context, Service } from '@deepseek-ai/cordis';
import Llm, { LlmAdapter, BlockAssembler, createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Meter from '@deepseek-ai/dsh-token-meter';
import Commands from '@deepseek-ai/dsh-commands';
import * as CompactCommand from '@deepseek-ai/dsh-command-compact';
import * as providerEntry from '../src/provider-entry.js';
import * as policy from '../src/index.js';
import * as compaction from '../src/compaction.js';
import { ROUTE } from '../src/constants.js';
import { fakeAttachments, imageBlock, imageData } from './helpers/images.js';
import { isNativeCarrier } from '../src/runtime-adapter.js';
import { registerRequestDeadlineTests } from './helpers/request-deadline.js';
const root = process.env.ACCOUNT_SNAPSHOT_ROOT;
if (!root || !basename(root).startsWith('dsh-codex-account-snapshot-') || (await lstat(join(root, 'node_modules'))).isSymbolicLink()) throw new Error('An isolated installed account snapshot is required; no live workspace fallback.');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const entry = manifest.exports?.['./codex-runtime'];
if (manifest.name !== 'dsh-token-usage' || typeof entry !== 'string' || !entry.startsWith('./') || entry.includes('..')) throw new Error('Missing public owner capability export.');
const { createCodexRuntime } = await import(pathToFileURL(resolve(root, entry)).href);
const { createCodexModelFacts } = await import(pathToFileURL(resolve(root, 'lib/capabilities/codex-native/model-facts.js')).href);
const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');
const MODEL = 'gpt-5.4';
const token = account => `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.signature`;
const sse = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
async function fixture(t, { failStatus, responseMime } = {}) {
  const reply = events => { const response = sse(events); if (responseMime) response.headers.set('content-type', responseMime); return response; };
  const ctx = new Context();
  for (const p of [Llm, Sessions, Projections, Meter, Commands]) await ctx.plugin(p);
  class Presets extends Service { constructor() { super(ctx, 'agentPresets'); } copy() {} read() {} resolve() {} serviceFor() { return ctx.compaction; } }
  new Presets();
  class Original extends LlmAdapter { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; } }
  ctx.llm.registerAdapter(['openai-codex'], new Original());
  let account = 'existing-fixture-account', resolutions = 0;
  const requests = [];
  const runtime = createCodexRuntime({ configured: () => true,
    resolveOAuth: async () => { resolutions++; return { apiKey: token(account), headers: { 'chatgpt-account-id': account } }; },
    fetchImpl: async (url, init) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : JSON.parse(Buffer.from(new Headers(init.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body) : init.body).toString('utf8'));
      requests.push({ body, authorization: new Headers(init.headers).get('authorization'), account: new Headers(init.headers).get('chatgpt-account-id'), url });
      if (failStatus) return new Response('fixture error body must not escape', { status: failStatus });
      if (body.input.at(-1)?.type === 'compaction_trigger') return reply([
        { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque-fixture'.repeat(200), extra: { retained: [false, 1], future: { type: 'profile', image: 'opaque metadata', file_id: 'opaque-ref' } } } },
        { type: 'response.completed', response: { id: 'native-fixture', status: 'completed', usage: { input_tokens: 120, output_tokens: 20, total_tokens: 140, input_tokens_details: { cached_tokens: 40 } } } },
      ]);
      return reply([
        { type: 'response.created', response: { id: 'normal-fixture' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'message-fixture', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'continued' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'message-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'continued', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'normal-fixture', status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 1, total_tokens: 21 } } },
      ]);
    }, timeoutMs: 30000 });
  const owner = await ctx.plugin({ name: 'isolated-accounts-native-entry', apply(ownerCtx) { ownerCtx.provide('codexRuntime', runtime); ownerCtx.on('dispose', () => runtime.dispose()); } });
  await ctx.plugin(providerEntry); await ctx.plugin(policy); await ctx.plugin(compaction); await ctx.plugin(CompactCommand);
  const signal = new AbortController().signal;
  const agent = { ctx, session: ctx.sessions.create(), options: { provider: ROUTE, model: MODEL }, runMaintenance: async action => action(signal) };
  t.after(() => ctx.fiber.dispose());
  return { ctx, runtime, owner, agent, requests, signal, get resolutions() { return resolutions; }, changeAccount() { account = 'changed-fixture-account'; } };
}
function addHistory(session) {
  const turn = session.seq;
  session.append('request/header', { header: { config: { provider: ROUTE, model: MODEL }, system: 'Preserve exact fixture constraints.' }, reason: session.requestHeader() ? 'series' : 'initial' });
  session.append('turn/start', { turn });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep /fixture/source.ts and do not restart the host.' }] }), { surfaceOp: 'append' });
  for (let step = 0; step < 2; step++) {
    session.append('step/start', { turn, step });
    session.append('assistant/message', { turn, step, message: createAssistantMessage({ source: { provider: ROUTE, model: MODEL }, content: [{ type: 'text', text: step ? 'Latest preserved tail.' : 'Historical fixture. '.repeat(4000) }] }) }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step });
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

test('real owner and B share one connection for three restored rounds with generic-MIME SSE', async t => {
  const f = await fixture(t, { responseMime: 'text/plain' });
  let flushes = 0; f.ctx.on('session/flush', () => { flushes++; });
  assert.equal(f.resolutions, 0);
  assert.equal(f.ctx.get('authorization'), undefined);
  assert.equal(f.ctx.get('credentials'), undefined);
  for (let round = 0; round < 3; round++) {
    addHistory(f.agent.session);
    const result = await f.ctx.commands.execute(f.agent, '/compact', [], f.signal);
    assert.equal(result.result.kind, 'success', JSON.stringify(result));
    const event = f.agent.session.snapshotEvents().findLast(e => e.type === 'compaction/summary');
    assert.deepEqual(event.data.usage, { inputTokens: 80, outputTokens: 20, totalTokens: 140, cacheReadTokens: 40 });
    const checkpoint = f.agent.session.deriveMessages().find(m => m.source.nativeCodex);
    assert.ok(checkpoint);
    assert.deepEqual(checkpoint.source.nativeCodex.items.at(-1).extra, { retained: [false, 1], future: { type: 'profile', image: 'opaque metadata', file_id: 'opaque-ref' } });
    assert.doesNotMatch(JSON.stringify(checkpoint), /existing-fixture-account|fixture\.ey/);
    f.agent.session = f.ctx.sessions.create(undefined, { seed: JSON.parse(JSON.stringify(f.agent.session.snapshotEvents())) });
    const assembler = new BlockAssembler();
    for await (const chunk of f.ctx.llm.stream({ provider: ROUTE, model: MODEL, messages: f.agent.session.deriveMessages(), signal: f.signal })) assembler.push(chunk);
    assert.equal(assembler.finish.kind, 'stop');
    assert.equal(assembler.blocks()[0].text, 'continued');
    assert.ok(f.requests.at(-1).body.input.some(item => item.type === 'compaction'));
    assert.deepEqual(f.requests.at(-1).body.input.find(item => item.type === 'compaction').extra, checkpoint.source.nativeCodex.items.at(-1).extra);
  }
  assert.equal(f.resolutions, 6);
  assert.equal(flushes, 3);
  assert.ok(f.requests.every(r => r.account === 'existing-fixture-account' && r.authorization === `Bearer ${token('existing-fixture-account')}`));
  assert.ok(f.ctx.llm.listProviders().some(p => p.id === 'openai-codex'));
  const before = f.requests.length;
  f.changeAccount();
  const rejected = new BlockAssembler();
  for await (const chunk of f.ctx.llm.stream({ provider: ROUTE, model: MODEL, messages: f.agent.session.deriveMessages(), signal: f.signal })) rejected.push(chunk);
  assert.equal(rejected.finish.kind, 'error');
  assert.match(rejected.finish.failure.code, /IDENTITY/);
  assert.equal(f.requests.length, before);
});

test('real owner compact accepts a generated lab-route message whose replay provider is openai-codex', async t => {
  const f = await fixture(t);
  const assembler = new BlockAssembler();
  for await (const chunk of f.ctx.llm.stream({
    provider: ROUTE, model: MODEL,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Say continued.' }] })],
    signal: f.signal,
  })) assembler.push(chunk);
  assert.equal(assembler.finish.kind, 'stop');
  assert.ok(assembler.replayState, 'ordinary generation must persist a real replay envelope');
  const generated = createAssistantMessage({
    source: { provider: ROUTE, model: MODEL, replayState: assembler.replayState },
    content: assembler.blocks(),
  });
  const turn = f.agent.session.seq;
  f.agent.session.append('request/header', { header: { config: { provider: ROUTE, model: MODEL }, system: 'Preserve exact fixture constraints.' }, reason: 'initial' });
  f.agent.session.append('turn/start', { turn });
  f.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep BIZ-LAB-GENERATED.' }] }), { surfaceOp: 'append' });
  f.agent.session.append('step/start', { turn, step: 0 });
  f.agent.session.append('assistant/message', { turn, step: 0, message: generated }, { surfaceOp: 'append' });
  f.agent.session.append('step/end', { turn, step: 0 });
  f.agent.session.append('step/start', { turn, step: 1 });
  f.agent.session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ source: { provider: ROUTE, model: MODEL }, content: [{ type: 'text', text: 'Historical lab fixture. '.repeat(4000) }] }) }, { surfaceOp: 'append' });
  f.agent.session.append('step/end', { turn, step: 1 });
  f.agent.session.append('step/start', { turn, step: 2 });
  f.agent.session.append('assistant/message', { turn, step: 2, message: createAssistantMessage({ source: { provider: ROUTE, model: MODEL }, content: [{ type: 'text', text: 'Latest preserved tail.' }] }) }, { surfaceOp: 'append' });
  f.agent.session.append('step/end', { turn, step: 2 });
  f.agent.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  const before = f.requests.length;
  const result = await f.ctx.commands.execute(f.agent, '/compact', [], f.signal);
  assert.equal(result.result.kind, 'success', JSON.stringify(result));
  assert.ok(f.requests.length > before);
  assert.equal(f.requests.at(-1).body.input.at(-1)?.type, 'compaction_trigger');
});

test('real owner HTTP categories survive the registered bridge without error bodies or retry', async t => {
  for (const status of [400, 401, 429, 500]) {
    const f = await fixture(t, { failStatus: status });
    const result = new BlockAssembler();
    for await (const chunk of f.ctx.llm.stream({ provider: ROUTE, model: MODEL, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic' }] })] })) result.push(chunk);
    assert.equal(result.finish.kind, 'error');
    assert.equal(result.finish.failure.code, `CODEX_RUNTIME_HTTP_${status}`);
    assert.doesNotMatch(JSON.stringify(result.finish), /fixture error body/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.resolutions, 1);
  }
});

test('account capability unload withdraws only the native route and leaves the foreign guard', async t => {
  const f = await fixture(t);
  addHistory(f.agent.session);
  await f.ctx.compaction.compactNow(f.agent, f.signal);
  const messages = f.agent.session.deriveMessages();
  await f.owner.dispose();
  assert.deepEqual(f.ctx.llm.listProviders().map(p => p.id), ['openai-codex']);
  await assert.rejects(async () => { for await (const _ of f.ctx.llm.stream({ provider: 'openai-codex', model: MODEL, messages })) {} }, error => error.code === 'CODEX_NATIVE_READER_UNAVAILABLE');
});

// ---- New main path: official basic purpose=compaction over the standard route ----
const ASTRA = 'gpt-6-astra';
const SOL = 'gpt-5.6-sol';
const astraProfile = () => ({ id: ASTRA, contextWindow: 872000, maxTokens: 128000, input: ['text', 'image'],
  reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } });

async function standardFixture(t, { failFirstStatus, responseMime, settingsRoute, deferEngine = false, nativeReply, ordinaryReply, timeoutMs = 30000, compactionTimeoutMs = timeoutMs } = {}) {
  const route = { apiKeyEnv: 'OPENAI_CODEX_ACCESS_TOKEN', ...(settingsRoute ?? {}), models: settingsRoute?.models ?? [astraProfile()] };
  const reply = events => { const response = sse(events); if (responseMime) response.headers.set('content-type', responseMime); return response; };
  const ctx = new Context();
  const hostCalls = [];
  for (const p of [Llm, Sessions, Projections, Meter, Commands]) await ctx.plugin(p);
  class Original extends LlmAdapter {
    // Public host-resolved capacity: the configured custom Astra profile and
    // the pinned Sol catalog entry use their real context windows.
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: model === ASTRA ? 872000 : 272000 } };
    }
    async *stream(options) {
      hostCalls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '## host text summary' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '## host text summary' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['openai-codex'], new Original());
  await ctx.plugin(providerEntry);
  let account = 'standard-fixture-account', fetches = 0, resolutions = 0;
  const requests = [];
  const facts = createCodexModelFacts({ getSettings: () => ({ providers: { 'openai-codex': route } }), credentialRef: 'OPENAI_CODEX_ACCESS_TOKEN' });
  const runtime = createCodexRuntime({ configured: () => true,
    resolveOAuth: async () => { resolutions++; return { apiKey: token(account), headers: { 'chatgpt-account-id': account } }; },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : zstdDecompressSync(init.body).toString());
      requests.push({ body, account: new Headers(init.headers).get('chatgpt-account-id'), fetches });
      fetches++;
      if (failFirstStatus && fetches === 1) return new Response('transient fixture failure', { status: failFirstStatus });
      if (body.input.some(item => item.type === 'compaction_trigger')) {
        const events = [
          { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque-standard-fixture'.repeat(120) } },
          { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 20, total_tokens: 140, input_tokens_details: { cached_tokens: 40 } } } },
        ];
        return nativeReply ? nativeReply({ events, fetches, signal: init.signal }) : reply(events);
      }
      if (ordinaryReply) return ordinaryReply({ signal: init.signal });
      return reply([
        { type: 'response.created', response: { id: 'standard-fixture', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'standard-message', role: 'assistant', content: [], status: 'in_progress' } },
        { type: 'response.content_part.added', item_id: 'standard-message', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: 'standard-message', output_index: 0, content_index: 0, delta: 'continued' },
        { type: 'response.output_text.done', item_id: 'standard-message', output_index: 0, content_index: 0, text: 'continued' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'standard-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'continued', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'standard-fixture', status: 'completed', usage: { input_tokens: 20, output_tokens: 1, total_tokens: 21 } } },
      ]);
    }, timeoutMs, compactionTimeoutMs, resolveModelFacts: facts.resolveModelFacts, routeStatus: facts.routeStatus });
  const owner = await ctx.plugin({ name: 'isolated-accounts-native-entry', apply(ownerCtx) { ownerCtx.provide('codexRuntime', runtime); ownerCtx.on('dispose', () => runtime.dispose()); } });
  const signal = new AbortController().signal;
  const session = ctx.sessions.create();
  const agent = { ctx, session, options: { provider: 'openai-codex', model: ASTRA }, runMaintenance: async action => action(signal) };
  // One engine per context (the compaction service is a singleton); deferred
  // fixtures build it after the synthetic history exists so test-only
  // thresholds can be derived from the measured pressure.
  const makeEngine = config => new BasicCompactionEngine(ctx, config);
  const engine = deferEngine ? undefined : makeEngine({ auto: false });
  t.after(() => ctx.fiber.dispose());
  return { ctx, runtime, owner, agent, engine, makeEngine, requests, hostCalls, signal, get resolutions() { return resolutions; },
    addStandardHistory(target = session, model = ASTRA) {
      const turn = target.seq;
      target.append('request/header', { header: { config: { provider: 'openai-codex', model }, system: 'Preserve exact fixture constraints.' }, reason: target.requestHeader() ? 'series' : 'initial' });
      target.append('turn/start', { turn });
      target.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep /fixture/standard.ts exactly as written.' }] }), { surfaceOp: 'append' });
      // Official manual compaction retains the final surface node, so the
      // large historical content must not be the tail — mirror the legacy
      // fixture's two steps: big history first, small preserved tail last.
      for (let step = 0; step < 2; step++) {
        target.append('step/start', { turn, step });
        target.append('assistant/message', { turn, step, message: createAssistantMessage({ source: { provider: 'openai-codex', model }, content: [{ type: 'text', text: step ? 'Latest preserved tail.' : 'Historical standard fixture. '.repeat(4000) }] }) }, { surfaceOp: 'append' });
        target.append('step/end', { turn, step });
      }
      target.append('turn/end', { turn, reason: { kind: 'completed' } });
    },
    enable(mode = 'on') { ctx.codexBridge.setNativePreference(session.id, mode); } };
}

test('official basic commits a native checkpoint for a custom model through the standard route', async t => {
  const f = await standardFixture(t);
  f.addStandardHistory();
  f.enable();
  const result = await f.engine.compactNow(f.agent, f.signal);
  assert.equal(typeof result.compactionId, 'string');
  assert.ok(result.compactionId.length > 0);
  assert.equal(typeof result.summarySeq, 'number');
  assert.ok(Array.isArray(result.shadowedSeqs) && result.shadowedSeqs.length > 0);
  assert.equal(typeof result.shadowedTokenCount, 'number');
  assert.ok(result.endSeq > result.summarySeq, 'the durable close event follows the committed summary');
  const event = f.agent.session.eventAt(result.summarySeq);
  assert.equal(event.type, 'compaction/summary');
  assert.ok(event, 'basic recorded the summary');
  assert.equal(event.data.provider, 'openai-codex');
  assert.equal(event.data.model, ASTRA);
  // inputTokens excludes cacheReadTokens, matching the runtime's documented
  // receipt contract and the legacy B path (120 input - 40 cached = 80).
  assert.deepEqual(event.data.usage, { inputTokens: 80, outputTokens: 20, totalTokens: 140, cacheReadTokens: 40 });
  const replacement = f.agent.session.deriveMessages().find(m => m.source.kind === 'plugin' && m.source.plugin === 'compact');
  assert.ok(replacement, 'replacement checkpoint message committed');
  const blocks = replacement.content;
  assert.equal(blocks.length, 3, 'official framing kept');
  assert.ok(blocks[0].text.includes('<compacted-summary>'));
  assert.equal(blocks[2].text, '</compacted-summary>');
  const envelope = blocks[1].text;
  assert.ok(envelope.startsWith('<dsh-codex-compaction-v1>'));
  const record = f.ctx.codexBridge.readCheckpoint(replacement);
  assert.equal(record.model, ASTRA);
  assert.equal(record.identity.length, 64);
  assert.equal(f.hostCalls.length, 0, 'the host adapter never ran');
  const nativeRequest = f.requests[0].body;
  assert.equal(nativeRequest.model, ASTRA);
  assert.ok(nativeRequest.input.some(item => item.type === 'compaction_trigger'));
  assert.ok(!JSON.stringify(nativeRequest).includes('You are now acting as a compaction engine'), 'stock instruction never reaches the native request');
  assert.equal(f.requests[0].account, 'standard-fixture-account');
  const attempt = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).lastAttempt;
  assert.equal(attempt.kind, 'native');
  assert.equal(attempt.outcome, 'native');
});

test('explicit reader-text command re-summarizes a native carrier through real owner and Basic, with benefit evidence', async t => {
  const f = await standardFixture(t);
  class Presets extends Service {
    constructor() { super(f.ctx, 'agentPresets'); }
    copy() {} read() {} resolve() {} serviceFor() { return f.engine; }
  }
  new Presets();
  await f.ctx.plugin(policy);
  f.addStandardHistory(); f.enable();
  await f.engine.compactNow(f.agent, f.signal);
  assert.equal(f.ctx.codexBridge.compactionProgress(f.agent.session).native.kind, 'observed');
  const command = await f.ctx.commands.execute(f.agent, '/codex-native reader-text', [], f.signal);
  assert.equal(command.result.kind, 'success');
  const before = f.requests.length;
  await f.engine.compactNow(f.agent, f.signal);
  assert.equal(f.requests.length, before + 1, 'one reader call, no preliminary native compact');
  const wire = f.requests.at(-1).body;
  assert.ok(wire.input.some(item => item.type === 'compaction'));
  assert.ok(!wire.input.some(item => item.type === 'compaction_trigger'));
  assert.ok(JSON.stringify(wire).includes('You are now acting as a compaction engine'));
  assert.ok(!JSON.stringify(wire).includes('<dsh-codex-compaction'));
  assert.equal(f.hostCalls.length, 0);
  assert.equal(f.agent.session.deriveMessages().some(isNativeCarrier), false);
  const benefit = f.ctx.codexBridge.compactionProgress(f.agent.session);
  assert.equal(benefit.latest.outcome, 'committed');
  assert.ok(benefit.latest.netFreedTokens > 0, JSON.stringify(benefit));
  assert.ok(benefit.latest.beforePressure.tokens > benefit.latest.afterPressure.tokens);
  assert.equal(benefit.native.kind, 'absent');
  const context = await f.ctx.commands.execute(f.agent, '/codex-context', [], f.signal);
  assert.match(context.result.text, /Compaction benefit: committed/);
  assert.match(context.result.text, /old span size, not net freed/);
  assert.doesNotMatch(JSON.stringify(benefit), /encrypted_content|standard-fixture-account|opaque-standard-fixture/);
});

for (const [mode, retries, expectedRequests] of [['on', 1, 6], ['on', 0, 3], ['reader-text', 1, 1]]) {
  test(`retained-client plateau: ${mode}, retries=${retries} makes ${expectedRequests} requests across three pressure checks`, async t => {
    const f = await standardFixture(t, { deferEngine: true, nativeReply: async ({ fetches }) => sse([
      { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'o'.repeat(24000 - fetches * 1000) } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]) });
    const session = f.agent.session;
    const lease = await f.runtime.open({ model: ASTRA });
    const envelope = f.runtime.encodeCheckpoint({ ...lease.binding, items: [
      ...Array.from({ length: 76 }, (_, i) => ({ role: 'user', content: [{ type: 'input_text', text: `Report ${i}: ` + 'x'.repeat(3350) }] })),
      { type: 'compaction', encrypted_content: 'o'.repeat(24000) },
    ] });
    lease.close();
    session.append('request/header', { header: { config: f.agent.options, system: 'fixture system '.repeat(4000) }, reason: 'initial' });
    const turn = 0;
    session.append('turn/start', { turn });
    session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'compact', compactionId: 'fixture-plateau' }, content: [{ type: 'text', text: envelope }] }), { surfaceOp: 'append' });
    for (const step of [0, 1]) {
      session.append('step/start', { turn, step });
      session.append('assistant/message', { turn, step,
        message: createAssistantMessage({ source: f.agent.options, content: [{ type: 'text', text: step ? 'tail'.repeat(44000) : 'old work '.repeat(2400) }] }),
        ...(step ? { usage: { inputTokens: 224000, outputTokens: 1000, totalTokens: 225000 } } : {}),
      }, { surfaceOp: 'append' });
      session.append('step/end', { turn, step });
    }
    const engine = f.makeEngine({ auto: false, thresholdRatio: 217600 / 872000, retainTokens: 44000, compactionRetries: retries });
    f.enable(mode);
    assert.equal(f.ctx.tokenMeter.measure(session).totalTokens, 225000, 'synthetic usage anchor, not live provider measurement');
    for (let step = 0; step < 3; step++) {
      if (mode === 'on') await assert.rejects(engine.compactIfNeeded(f.agent, 'pressure', f.signal), /still above threshold/);
      else await engine.compactIfNeeded(f.agent, 'pressure', f.signal);
      assert.equal(f.ctx.tokenMeter.measure(session).totalTokens < 217600, mode === 'reader-text');
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'new work '.repeat(220) }] }), { surfaceOp: 'append' });
    }
    assert.equal(f.requests.length, expectedRequests);
    assert.equal(f.hostCalls.length, 0);
    const measured = f.ctx.codexBridge.compactionProgress(session);
    assert.equal(measured.latest.outcome, 'committed');
    assert.ok(measured.latest.netFreedTokens > 0);
    assert.equal(measured.native.kind, mode === 'reader-text' ? 'absent' : 'observed');
    if (mode === 'on') assert.equal(measured.native.clients, 76);
  });
}

test('explicit reader-text failure leaves the real Basic surface untouched and records failed benefit', async t => {
  const f = await standardFixture(t, { ordinaryReply: async () => new Response('synthetic error', { status: 503 }) });
  f.addStandardHistory(); f.enable();
  await f.engine.compactNow(f.agent, f.signal);
  const before = JSON.stringify(f.agent.session.deriveMessages());
  f.enable('reader-text');
  const requests = f.requests.length;
  await assert.rejects(f.engine.compactNow(f.agent, f.signal));
  assert.equal(f.requests.length, requests + 1);
  assert.equal(JSON.stringify(f.agent.session.deriveMessages()), before);
  assert.equal(f.hostCalls.length, 0);
  const benefit = f.ctx.codexBridge.compactionProgress(f.agent.session);
  assert.equal(benefit.latest.outcome, 'failed');
  assert.equal(benefit.latest.netFreedTokens, null);
});

test('committed native state replays through the standard route on later ordinary requests', async t => {
  const f = await standardFixture(t);
  f.addStandardHistory();
  f.enable();
  await f.engine.compactNow(f.agent, f.signal);
  const replacement = f.agent.session.deriveMessages().find(m => m.source.kind === 'plugin' && m.source.plugin === 'compact');
  const assembler = new BlockAssembler();
  for await (const chunk of f.ctx.llm.stream({ provider: 'openai-codex', model: ASTRA, sessionId: f.agent.session.id, messages: [replacement, createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] })] })) assembler.push(chunk);
  assert.equal(assembler.finish.kind, 'stop');
  assert.equal(assembler.blocks()[0].text, 'continued');
  assert.ok(f.requests.at(-1).body.input.some(item => item.type === 'compaction'), 'opaque checkpoint replayed as a native item');
  assert.equal(f.hostCalls.length, 0);
});

for (const nested of [false, true]) {
  test(`real owner replays checkpoint with ${nested ? 'tool' : 'user'} image and Basic commits a readable summary`, async t => {
    const f = await standardFixture(t);
    const attachments = fakeAttachments();
    f.ctx.provide('attachments', attachments);
    f.addStandardHistory(); f.enable();
    await f.engine.compactNow(f.agent, f.signal);
    const session = f.agent.session;
    const checkpoint = session.deriveMessages().find(isNativeCarrier);
    assert.ok(checkpoint);
    const image = createUserMessage({ source: { kind: 'user' }, content: nested
      ? [{ type: 'tool-result', toolCallId: 'fixture-image-call', content: [imageBlock()] }] : [imageBlock()] });
    const toolCall = createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [
      { type: 'tool-call', id: 'fixture-image-call', name: 'read_image', arguments: '{}' },
    ] });
    const messages = [checkpoint, ...(nested ? [toolCall] : []), image];
    const original = JSON.stringify(messages);
    const request = { provider: 'openai-codex', model: ASTRA, sessionId: session.id, messages, signal: f.signal };
    const assembler = new BlockAssembler();
    for await (const chunk of f.ctx.llm.stream(request)) assembler.push(chunk);
    assert.equal(assembler.finish.kind, 'stop');
    const assertWire = body => {
      assert.ok(body.input.some(item => item.type === 'compaction'), 'opaque state expanded to native wire item');
      assert.ok(!body.input.some(item => item.type === 'compaction_trigger'), 'no text-only native compact request');
      const images = body.input.flatMap(item => [...(Array.isArray(item.content) ? item.content : []), ...(Array.isArray(item.output) ? item.output : [])]).filter(part => part.type === 'input_image');
      assert.equal(images.length, 1, 'the actual owner fetch receives the image');
      assert.equal(images[0].image_url, `data:image/png;base64,${imageData.toString('base64')}`);
      assert.doesNotMatch(JSON.stringify(body), /DSH_CODEX_OWNER_REPLAY_|<dsh-codex-compaction/);
    };
    assertWire(f.requests.at(-1).body);
    assert.equal(JSON.stringify(messages), original);
    // Add the same mixed history through public session events, then let the
    // real Basic engine select, summarize, shrink and commit it (no hand-built summary).
    const turn = session.seq;
    session.append('turn/start', { turn });
    session.append('step/start', { turn, step: 0 });
    if (nested) session.append('assistant/message', { turn, step: 0, message: toolCall }, { surfaceOp: 'append' });
    if (nested) {
      session.append('tool/call', { turn, step: 0, callId: 'fixture-image-call', name: 'read_image', arguments: '{}' });
      session.append('tool/result', { turn, step: 0, message: createToolResultMessage({ callId: 'fixture-image-call', content: [imageBlock()], isError: false }) }, { surfaceOp: 'append' });
    } else session.append('user/message', image, { surfaceOp: 'append' });
    session.append('assistant/message', { turn, step: 0, message: createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Image investigation history. '.repeat(4000) }] }) }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step: 0 });
    session.append('step/start', { turn, step: 1 });
    session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Keep the final tail.' }] }) }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step: 1 });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
    const before = f.requests.length;
    const result = await f.engine.compactNow(f.agent, f.signal);
    assert.equal(typeof result.summarySeq, 'number');
    assert.equal(f.requests.length, before + 1, 'one owner lease/request for mixed summarization');
    assertWire(f.requests.at(-1).body);
    assert.match(JSON.stringify(f.requests.at(-1).body), /You are now acting as a compaction engine/);
    assert.equal(f.ctx.codexBridge.nativePreferenceStatus(session.id).lastAttempt.outcome, 'reader-text');
    assert.equal(session.deriveMessages().some(isNativeCarrier), false, 'Basic replaces the compacted carrier with readable text');
    assert.ok(session.deriveMessages().some(m => m.content.some(b => b.text === 'continued')));
    assert.equal(f.hostCalls.length, 0, 'neither request walks the stock adapter');
    assert.equal(attachments.reads.length, 2);
    assert.ok(f.requests.every(r => r.account === 'standard-fixture-account'));
    const restored = f.ctx.sessions.create(undefined, { seed: JSON.parse(JSON.stringify(session.snapshotEvents())) });
    const after = new BlockAssembler();
    for await (const chunk of f.ctx.llm.stream({ ...request, messages: restored.deriveMessages() })) after.push(chunk);
    assert.equal(after.finish.kind, 'stop');
    assert.equal(f.hostCalls.length, 1, 'restored readable summary needs no opaque reader');
  });
}

test('failed mixed reader summary leaves the real Basic history unchanged and never retries stock', async t => {
  const f = await standardFixture(t, { ordinaryReply: () => new Response('synthetic failure', { status: 503 }) });
  f.ctx.provide('attachments', fakeAttachments());
  f.addStandardHistory(); f.enable();
  await f.engine.compactNow(f.agent, f.signal);
  const session = f.agent.session;
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [imageBlock()] }), { surfaceOp: 'append' });
  f.addStandardHistory();
  const before = JSON.stringify(session.deriveMessages());
  const requests = f.requests.length;
  await assert.rejects(f.engine.compactNow(f.agent, f.signal));
  assert.equal(JSON.stringify(session.deriveMessages()), before);
  assert.equal(f.requests.length, requests + 1);
  assert.equal(f.hostCalls.length, 0);
  assert.equal(f.ctx.codexBridge.nativePreferenceStatus(session.id).lastAttempt.outcome, 'failed');
});

test('one in-lease native retry after a recoverable server failure never walks stock', async t => {
  const f = await standardFixture(t, { failFirstStatus: 503 });
  f.addStandardHistory();
  f.enable();
  await f.engine.compactNow(f.agent, f.signal);
  const event = f.agent.session.snapshotEvents().findLast(e => e.type === 'compaction/summary');
  assert.ok(event, 'basic committed the successful native retry');
  assert.deepEqual(event.data.usage, { inputTokens: 80, outputTokens: 20, totalTokens: 140, cacheReadTokens: 40 });
  committedNativeReplacement(f.agent.session, f.ctx);
  assert.ok(f.requests.every(request => request.body.input.some(item => item.type === 'compaction_trigger')));
  assert.equal(f.resolutions, 1, 'retry reuses the original bound connection');
  assert.equal(f.requests.length, 2, 'native attempt plus one native retry');
  assert.equal(f.requests[1].account, f.requests[0].account, 'same account across both fetches');
  assert.equal(f.hostCalls.length, 0, 'the fallback never re-walked the host route');
  const attempt = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).lastAttempt;
  assert.equal(attempt.kind, 'native');
  assert.equal(attempt.outcome, 'native');
  assert.equal(attempt.cause, 'CODEX_RUNTIME_HTTP_503');
});

test('native compaction can finish after 120s without widening ordinary request leases', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await standardFixture(t, { timeoutMs: 120000, compactionTimeoutMs: 300000,
    nativeReply: async ({ events }) => { await new Promise(resolve => setTimeout(resolve, 200000)); return sse(events); },
  });
  f.addStandardHistory(); f.enable();
  let settled = false;
  const result = f.engine.compactNow(f.agent, f.signal);
  result.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1);
  t.mock.timers.tick(120001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'neither the owner lease nor the converter may cancel native compaction at 120s');
  t.mock.timers.tick(80000);
  assert.ok((await result).shadowedSeqs.length > 0);
  committedNativeReplacement(f.agent.session, f.ctx);
  const attempt = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).lastAttempt;
  assert.equal(attempt.diagnostics.budgetMs, 300000);
  assert.equal(attempt.diagnostics.requests, 1); assert.equal(f.resolutions, 1); assert.equal(f.hostCalls.length, 0);
});

test('complete native SSE commits history without waiting for HTTP EOF', async t => {
  let body, cancelled = false;
  const f = await standardFixture(t, { timeoutMs: 1000, nativeReply: ({ events }) => {
    body = new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
      // No close: a complete protocol response must not wait for HTTP EOF.
    }, cancel() { cancelled = true; } });
    return new Response(body);
  } });
  f.addStandardHistory(); f.enable();
  const result = await f.engine.compactNow(f.agent, f.signal);
  assert.ok(result.shadowedSeqs.length > 0); assert.ok(result.endSeq > result.summarySeq);
  committedNativeReplacement(f.agent.session, f.ctx);
  assert.equal(cancelled, true); assert.equal(body.locked, false);
  assert.equal(f.requests.length, 1); assert.equal(f.resolutions, 1); assert.equal(f.hostCalls.length, 0);
});

test('premature native EOF retries once on the same auth resolution and commits native history', async t => {
  const f = await standardFixture(t, { nativeReply: ({ events, fetches }) => fetches === 1
    ? new Response(`data: ${JSON.stringify(events[0])}\n\ndata: {"type":"response.compl`)
    : sse(events) });
  f.addStandardHistory(); f.enable();
  const result = await f.engine.compactNow(f.agent, f.signal);
  assert.ok(result.shadowedSeqs.length > 0);
  committedNativeReplacement(f.agent.session, f.ctx);
  assert.equal(f.requests.length, 2); assert.equal(f.resolutions, 1); assert.equal(f.hostCalls.length, 0);
  assert.ok(f.requests.every(request => request.body.input.some(item => item.type === 'compaction_trigger')));
  assert.equal(f.requests[0].account, f.requests[1].account);
  const attempt = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).lastAttempt;
  assert.equal(attempt.kind, 'native'); assert.equal(attempt.outcome, 'native');
  assert.equal(attempt.cause, 'CODEX_RUNTIME_RESPONSE_STREAM');
});

test('native operation timeout preserves TIMEOUT with no retry or text fallback', async t => {
  let body, cancelled = false;
  const f = await standardFixture(t, { timeoutMs: 30, nativeReply: ({ events }) => {
    body = new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(`data: ${JSON.stringify(events[0])}\n\n`));
    }, cancel() { cancelled = true; } });
    return new Response(body);
  } });
  f.addStandardHistory(); f.enable();
  // Basic's public manual error wraps the original owner failure as cause.
  await assert.rejects(f.engine.compactNow(f.agent, f.signal), error => error.cause?.code === 'CODEX_RUNTIME_TIMEOUT');
  assert.equal(f.requests.length, 1); assert.equal(f.resolutions, 1); assert.equal(f.hostCalls.length, 0);
  assert.equal(cancelled, true); assert.equal(body.locked, false);
  assert.equal(summariesOf(f.agent.session).length, 0);
  const attempt = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).lastAttempt;
  assert.equal(attempt.failure, 'CODEX_RUNTIME_TIMEOUT'); assert.equal(attempt.kind, 'native');
  assert.equal(attempt.diagnostics.phase, 'reading-sse');
  assert.equal(attempt.diagnostics.httpStatus, 200); assert.equal(attempt.diagnostics.requests, 1);
  assert.equal(attempt.diagnostics.lastEvent, 'compaction-item');
  assert.ok(attempt.diagnostics.itemMs >= 0); assert.equal(attempt.diagnostics.completedMs, undefined);
  assert.doesNotMatch(JSON.stringify(attempt.diagnostics), /standard-fixture-account|encrypted_content/);
});

test('automatic consecutive steps suppress failed native requests for 60 seconds until a committed recovery', async t => {
  let now = 1000, failing = true;
  const f = await standardFixture(t, { deferEngine: true, nativeReply: ({ events }) => sse(failing ? events.slice(0, 1) : events) });
  f.ctx.codexBridge.nativeState.recovery.now = () => now;
  f.addStandardHistory();
  const measured = f.ctx.tokenMeter.measure(f.agent.session);
  f.makeEngine({ auto: true, modelPolicies: [{ provider: 'openai-codex', model: ASTRA, thresholdRatio: (measured.totalTokens - 1000) / 872000, retainTokens: 0 }] });
  f.enable(); openTurn(f.agent.session, 1);
  const step = () => f.ctx.waterfall('agent/pre-step', { agent: f.agent, signal: f.signal }, () => 'pre-step-final');
  await step();
  assert.equal(f.requests.length, 2, 'one attempt plus one native retry, no text fallback');
  assert.equal(f.resolutions, 1); assert.equal(summariesOf(f.agent.session).length, 0);
  let status = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).recovery[0];
  assert.equal(status.failures, 1); assert.equal(status.nextAllowedAt, 61000); assert.equal(status.coolingDown, true);
  failing = false;
  for (now of [1001, 30000, 60999]) await step();
  assert.equal(f.requests.length, 2, 'consecutive automatic steps do not send new network requests inside the interval');
  assert.equal(f.resolutions, 1, 'suppressed steps do not reacquire credentials');
  now = 61000;
  await step(); closeTurn(f.agent.session, 1);
  assert.equal(f.requests.length, 3); assert.equal(f.resolutions, 2); assert.equal(f.hostCalls.length, 0);
  committedNativeReplacement(f.agent.session, f.ctx);
  const summary = summariesOf(f.agent.session).at(-1);
  const replacementEvent = f.agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.sourceEventSeqs?.includes(summary.seq));
  assert.ok(replacementEvent, 'public replacement event references the committed summary');
  const end = f.agent.session.snapshotEvents().findLast(event => event.type === 'compaction/end');
  assert.equal(end.data.compactionId, summary.data.compactionId); assert.equal(end.data.error, undefined);
  status = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).recovery[0];
  assert.equal(status.failures, 0); assert.equal(status.nextAllowedAt, 0); assert.equal(status.coolingDown, false);
  assert.equal(status.lastFailure, undefined); assert.equal(status.inFlight, false);
});

test('disabled preference keeps official basic entirely on the original path', async t => {
  const f = await standardFixture(t);
  f.addStandardHistory();
  await f.engine.compactNow(f.agent, f.signal);
  assert.equal(f.requests.length, 0, 'no native fetch');
  assert.equal(f.hostCalls.length, 1, 'stock text path through the host adapter');
  const event = f.agent.session.snapshotEvents().findLast(e => e.type === 'compaction/summary');
  assert.ok(event);
});

test('applicability reflects real profile facts for the custom model', async t => {
  const f = await standardFixture(t);
  const verdict = await f.ctx.codexBridge.nativeApplicability(ASTRA, f.signal);
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.model.contextWindow, 872000);
  assert.equal(verdict.model.maxTokens, 128000);
  const foreign = await standardFixture(t, { settingsRoute: { apiKeyEnv: 'OTHER_REF' } });
  assert.equal((await foreign.ctx.codexBridge.nativeApplicability(ASTRA, foreign.signal)).reason, 'ROUTE_AUTH');
  const missing = await standardFixture(t, { settingsRoute: { models: [] } });
  assert.equal((await missing.ctx.codexBridge.nativeApplicability(ASTRA, missing.signal)).reason, 'UNKNOWN_MODEL', 'an id absent from the pinned catalog and the profile is unknown, not a metadata gap');
});

// ---- Official automatic entry points (registered by BasicCompactionEngine auto:true) ----

const summariesOf = session => session.snapshotEvents().filter(event => event.type === 'compaction/summary');
const committedNativeReplacement = (session, ctx) => {
  const replacement = session.deriveMessages().find(message => message.source.kind === 'plugin' && message.source.plugin === 'compact');
  assert.ok(replacement, 'a durable replacement checkpoint message was committed');
  const envelope = replacement.content.find(block => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('<dsh-codex-compaction-v1>'));
  assert.ok(envelope, 'the replacement carries the native envelope');
  return { replacement, record: ctx.codexBridge.readCheckpoint(replacement) };
};
// The automatic current-turn triggers fire inside a live turn (the agent
// pre-step boundary), so each test opens one before emitting the event.
const openTurn = (session, turn) => session.append('turn/start', { turn });
const closeTurn = (session, turn) => session.append('turn/end', { turn, reason: { kind: 'completed' } });

test('the registered agent/pre-step pressure entry compacts a custom model natively', async t => {
  const f = await standardFixture(t, { deferEngine: true });
  f.addStandardHistory();
  const measured = f.ctx.tokenMeter.measure(f.agent.session);
  const thresholdRatio = (measured.totalTokens - 1000) / 872000;
  f.makeEngine({ auto: true, modelPolicies: [{ provider: 'openai-codex', model: ASTRA, thresholdRatio, retainTokens: 0 }] });
  f.enable();
  assert.equal(summariesOf(f.agent.session).length, 0, 'nothing compacted before the step boundary');
  const nativeBefore = f.requests.length;
  openTurn(f.agent.session, 1);
  await f.ctx.waterfall('agent/pre-step', { agent: f.agent, signal: f.signal }, () => 'pre-step-final');
  closeTurn(f.agent.session, 1);
  const summaries = summariesOf(f.agent.session);
  assert.equal(summaries.length, 1, 'the automatic entry compacted exactly once');
  assert.equal(summaries[0].data.provider, 'openai-codex');
  assert.equal(summaries[0].data.model, ASTRA);
  assert.deepEqual(summaries[0].data.usage, { inputTokens: 80, outputTokens: 20, totalTokens: 140, cacheReadTokens: 40 });
  const { record } = committedNativeReplacement(f.agent.session, f.ctx);
  assert.equal(record.model, ASTRA);
  assert.equal(f.requests.length - nativeBefore, 1, 'one native compact request, no recursive interception');
  assert.equal(f.requests.at(-1).body.model, ASTRA);
  assert.ok(f.requests.at(-1).body.input.some(item => item.type === 'compaction_trigger'));
  assert.equal(f.hostCalls.length, 0, 'the stock text summarizer never ran');
});

test('the registered agent/pre-step pressure entry also serves the pinned Sol model', async t => {
  const f = await standardFixture(t, { deferEngine: true, settingsRoute: { models: [] } });
  f.agent.options.model = SOL;
  f.addStandardHistory(undefined, SOL);
  const measured = f.ctx.tokenMeter.measure(f.agent.session);
  const thresholdRatio = (measured.totalTokens - 1000) / 272000;
  f.makeEngine({ auto: true, modelPolicies: [{ provider: 'openai-codex', model: SOL, thresholdRatio, retainTokens: 0 }] });
  f.enable();
  openTurn(f.agent.session, 1);
  await f.ctx.waterfall('agent/pre-step', { agent: f.agent, signal: f.signal }, () => 'pre-step-final');
  closeTurn(f.agent.session, 1);
  const summaries = summariesOf(f.agent.session);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].data.model, SOL, 'pinned Sol metadata serves the automatic path without a profile entry');
  const { record } = committedNativeReplacement(f.agent.session, f.ctx);
  assert.equal(record.model, SOL);
  assert.equal(f.requests.length, 1, 'one native compact request');
  assert.equal(f.requests[0].body.model, SOL);
  assert.equal(f.hostCalls.length, 0);
});

test('context-overflow recovery retries once through the native seam and stays bounded', async t => {
  const f = await standardFixture(t, { deferEngine: true });
  f.addStandardHistory();
  f.makeEngine({ auto: true, maxOverflowRetries: 1 });
  f.enable();
  const overflow = { agent: f.agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: f.signal };
  openTurn(f.agent.session, 1);
  const first = await f.ctx.waterfall('agent/request-error', overflow, () => 'overflow-final');
  assert.deepEqual(first, { kind: 'retry' }, 'the first overflow recovered natively and requested a retry');
  assert.equal(summariesOf(f.agent.session).length, 1);
  const { record } = committedNativeReplacement(f.agent.session, f.ctx);
  assert.equal(record.model, ASTRA);
  assert.equal(f.requests.length, 1, 'one native compact through the recovery path');
  assert.equal(f.hostCalls.length, 0);
  const second = await f.ctx.waterfall('agent/request-error', overflow, () => 'overflow-final');
  assert.equal(second, 'overflow-final', 'bounded: the configured retry budget is exhausted');
  assert.equal(summariesOf(f.agent.session).length, 1, 'no second compaction past the bound');
  assert.equal(f.requests.length, 1);
  closeTurn(f.agent.session, 1);
});

test('a real-schema-materialized Sol profile (input omitted) compacts natively end to end', async t => {
  // Materialize a real settings section through the exported public Config:
  // the YAML-like entry declares only reasoningEfforts, and the real schema
  // resolves the omitted input list to [] — the documented absent-or-empty
  // inherits contract. The owner must treat [] as undeclared, not as an
  // explicit empty override that disables the model.
  const { Config } = await import('@deepseek-ai/dsh-llm-pi-ai');
  const section = Config({ providers: { 'openai-codex': {
    apiKeyEnv: 'OPENAI_CODEX_ACCESS_TOKEN',
    models: [{ id: SOL, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } }],
  } } });
  const materialized = section.providers['openai-codex'].models;
  assert.deepEqual(materialized, [{ id: SOL, input: [], reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
    compat: { chatTemplateArgs: {}, chatTemplateKwargs: {} } }],
    'the real public schema materializes an omitted input list to an empty array (and materializes empty compat objects); the whitelist drops the non-fact fields downstream');

  const f = await standardFixture(t, { settingsRoute: { models: materialized } });
  const verdict = await f.ctx.codexBridge.nativeApplicability(SOL, f.signal);
  assert.equal(verdict.applicable, true, 'a schema-materialized empty input array must not disable Sol');
  assert.equal(verdict.model.contextWindow, 272000, 'capacity comes from the pinned catalog merge');
  assert.deepEqual(verdict.model.input, ['text', 'image'], 'modalities inherit the pinned catalog default');

  f.agent.options.model = SOL;
  f.addStandardHistory(undefined, SOL);
  f.enable();
  await f.engine.compactNow(f.agent, f.signal);
  const summaries = summariesOf(f.agent.session);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].data.model, SOL);
  const { record } = committedNativeReplacement(f.agent.session, f.ctx);
  assert.equal(record.model, SOL);
  assert.equal(f.requests.length, 1, 'one native compact request for Sol');
  assert.equal(f.requests[0].body.model, SOL);
  assert.equal(f.hostCalls.length, 0, 'the stock text summarizer never ran');
});

registerRequestDeadlineTests(standardFixture);

// ---- Long-session native stability (P0/P1) ----
const replayState = (model, stopReason, blockTypes) => ({
  response: { kind: 'pi-ai', version: 2, api: 'openai-codex-responses', provider: 'openai-codex', model, stopReason },
  blocks: blockTypes.map(type => ({ type })),
});
const errorAssistant = (model, { text, tools = [], stopReason, replayVersion = 2 }) => {
  const content = [
    ...(text ? [{ type: 'text', text }] : []),
    ...tools.map(tool => ({ type: 'tool-call', id: tool.id, name: tool.name ?? 'read_file', arguments: '{}' })),
  ];
  const state = replayState(model, stopReason, content.map(block => block.type === 'tool-call' ? 'tool-call' : 'text'));
  state.response.version = replayVersion;
  return createAssistantMessage({
    source: { provider: 'openai-codex', model, replayState: state },
    content,
  });
};
const wireBlob = body => JSON.stringify(body.input);
const assertNativeCompactWire = (body, { mustInclude = [], mustExclude = [] } = {}) => {
  assert.equal(body.input.at(-1)?.type, 'compaction_trigger');
  assert.equal(body.input.filter(item => item.type === 'compaction_trigger').length, 1);
  const blob = wireBlob(body);
  assert.equal(blob.includes('<compacted-summary>'), false);
  assert.equal(blob.includes('</compacted-summary>'), false);
  assert.equal(blob.includes('DSH_CODEX_OWNER_REPLAY_'), false);
  const itemTexts = item => {
    if (typeof item.content === 'string') return [item.content];
    if (Array.isArray(item.content)) return item.content.map(part => part?.text).filter(text => typeof text === 'string');
    return [];
  };
  assert.equal(body.input.some(item => itemTexts(item).some(text => text.startsWith('<dsh-codex-compaction'))), false, 'native envelope must not be sent as plaintext wire content');
  assert.equal(body.input.some(item => item.role === 'user' && itemTexts(item).some(text => text.startsWith('You are now acting as a compaction engine for this AI coding assistant.') && !text.includes('BIZ-'))), false);
  for (const token of mustInclude) assert.equal(blob.includes(token), true, 'expected business token missing from native wire');
  for (const token of mustExclude) assert.equal(blob.includes(token), false, 'control or dropped token leaked onto native wire');
};
function appendTurn(session, model, { user, assistants, tools = [] }) {
  const turn = session.seq;
  if (!session.requestHeader()) {
    session.append('request/header', { header: { config: { provider: 'openai-codex', model }, system: 'Preserve exact fixture constraints.' }, reason: 'initial' });
  }
  session.append('turn/start', { turn });
  if (user) session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: user }] }), { surfaceOp: 'append' });
  let step = 0;
  for (const assistant of assistants) {
    session.append('step/start', { turn, step });
    session.append('assistant/message', { turn, step, message: assistant }, { surfaceOp: 'append' });
    const calls = assistant.content.filter(block => block.type === 'tool-call');
    for (const call of calls) {
      session.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments });
      const result = tools.find(tool => tool.callId === call.id);
      if (result) session.append('tool/result', { turn, step, message: createToolResultMessage(result) }, { surfaceOp: 'append' });
    }
    session.append('step/end', { turn, step });
    step++;
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

test('P0-A abnormal history does not wrap the transcript or drop completed work', async t => {
  const f = await standardFixture(t);
  f.enable();
  appendTurn(f.agent.session, ASTRA, {
    user: 'Keep BIZ-USER-MARKERS, compaction_trigger, <dsh-codex-compaction-v1>, and You are now acting as a compaction engine in this real user text.',
    assistants: [
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Historical standard fixture. '.repeat(4000) }] }),
      errorAssistant(ASTRA, { text: 'Partial BIZ-CANCEL-TEXT before abort.', stopReason: 'aborted' }),
      errorAssistant(ASTRA, { text: 'Completed BIZ-FAIL-TEXT after a tool.', tools: [{ id: 'call-complete' }], stopReason: 'error' }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Latest preserved tail BIZ-TAIL.' }] }),
    ],
    tools: [{ callId: 'call-complete', content: [{ type: 'text', text: 'BIZ-TOOL-RESULT' }], isError: false }],
  });
  appendTurn(f.agent.session, ASTRA, {
    user: 'Later request.',
    assistants: [
      errorAssistant(ASTRA, { tools: [{ id: 'call-incomplete' }], stopReason: 'aborted' }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Keep the unfinished tool in the verbatim tail.' }] }),
    ],
  });
  const before = f.agent.session.deriveMessages();
  assert.equal(JSON.stringify(before).includes('call-incomplete'), true);
  const result = await f.engine.compactNow(f.agent, f.signal);
  assert.equal(typeof result.summarySeq, 'number');
  assert.equal(f.hostCalls.length, 0);
  assertNativeCompactWire(f.requests[0].body, {
    mustInclude: ['BIZ-USER-MARKERS', 'BIZ-CANCEL-TEXT', 'BIZ-FAIL-TEXT', 'BIZ-TOOL-RESULT'],
    mustExclude: ['call-incomplete'],
  });
  const blob = wireBlob(f.requests[0].body);
  assert.equal(blob.includes('BIZ-USER-MARKERS') && blob.includes('BIZ-CANCEL-TEXT') && f.requests[0].body.input.filter(item => JSON.stringify(item).includes('BIZ-USER-MARKERS') && JSON.stringify(item).includes('BIZ-CANCEL-TEXT')).length === 0, true);
  const after = f.agent.session.deriveMessages();
  assert.equal(JSON.stringify(after).includes('call-incomplete'), true, 'unpaired cancelled tool stays in the host-retained tail');
  assert.equal(JSON.stringify(after).includes('BIZ-TAIL') || JSON.stringify(after).includes('unfinished tool'), true);
});

test('P0-A nested tool-result content remains compactable on the real owner', async t => {
  const f = await standardFixture(t);
  f.enable();
  appendTurn(f.agent.session, ASTRA, {
    user: 'Investigate BIZ-NESTED-USER.',
    assistants: [
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Historical nested fixture. '.repeat(4000) }] }),
      errorAssistant(ASTRA, { text: 'Completed BIZ-NESTED-TEXT.', tools: [{ id: 'call-nested' }], stopReason: 'error' }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Tail.' }] }),
    ],
    tools: [{
      callId: 'call-nested',
      content: [
        { type: 'text', text: 'BIZ-NESTED-OUTER' },
        { type: 'tool-result', toolCallId: 'nested-inner', content: [{ type: 'text', text: 'BIZ-NESTED-INNER' }], isError: false },
      ],
      isError: false,
    }],
  });
  const result = await f.engine.compactNow(f.agent, f.signal);
  assert.equal(typeof result.summarySeq, 'number');
  assert.equal(f.requests.length, 1);
  const blob = wireBlob(f.requests[0].body);
  assert.equal(blob.includes('BIZ-NESTED-OUTER') || blob.includes('BIZ-NESTED-INNER') || blob.includes('BIZ-NESTED-TEXT'), true);
  assert.equal(f.requests[0].body.input.filter(item => item.type === 'function_call_output').length <= 1, true);
});

test('P0-A invalid replay stays fail-closed and does not send a compact request', async t => {
  const f = await standardFixture(t);
  f.enable();
  appendTurn(f.agent.session, ASTRA, {
    user: 'Keep BIZ-BAD-REPLAY-USER.',
    assistants: [
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Historical standard fixture. '.repeat(4000) }] }),
      errorAssistant(ASTRA, { text: 'Partial BIZ-BAD-REPLAY', stopReason: 'aborted', replayVersion: 999 }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Tail.' }] }),
    ],
  });
  await assert.rejects(f.engine.compactNow(f.agent, f.signal), error => (error?.cause?.code ?? error?.code) === 'CODEX_NATIVE_REPLAY_INCOMPATIBLE');
  assert.equal(f.requests.length, 0);
  assert.equal(summariesOf(f.agent.session).length, 0);
  assert.equal(f.hostCalls.length, 0);
});

test('P0-A interrupted tool pairing is rejected instead of duplicating results on the wire', async t => {
  const f = await standardFixture(t);
  f.enable();
  const session = f.agent.session;
  const turn = session.seq;
  session.append('request/header', { header: { config: { provider: 'openai-codex', model: ASTRA }, system: 'Preserve exact fixture constraints.' }, reason: 'initial' });
  session.append('turn/start', { turn });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Investigate BIZ-ORDER-USER.' }] }), { surfaceOp: 'append' });
  session.append('step/start', { turn, step: 0 });
  const failed = errorAssistant(ASTRA, { text: 'Completed BIZ-ORDER-TEXT.', tools: [{ id: 'call-order' }], stopReason: 'error' });
  session.append('assistant/message', { turn, step: 0, message: failed }, { surfaceOp: 'append' });
  session.append('tool/call', { turn, step: 0, callId: 'call-order', name: 'read_file', arguments: '{}' });
  session.append('step/end', { turn, step: 0 });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Interrupting BIZ-ORDER-USER-2.' }] }), { surfaceOp: 'append' });
  session.append('tool/result', { turn, step: 0, message: createToolResultMessage({ callId: 'call-order', content: [{ type: 'text', text: 'BIZ-ORDER-RESULT' }], isError: false }) }, { surfaceOp: 'append' });
  session.append('step/start', { turn, step: 1 });
  session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Historical order fixture. '.repeat(4000) }] }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  await assert.rejects(f.engine.compactNow(f.agent, f.signal), error => (error?.cause?.code ?? error?.code) === 'CODEX_NATIVE_UNSAFE_HISTORY');
  assert.equal(f.requests.length, 0);
  assert.equal(summariesOf(f.agent.session).length, 0);
});

test('P0-A a later assistant tool call with unmatched prior calls is rejected with no wire request', async t => {
  const f = await standardFixture(t);
  f.enable();
  const session = f.agent.session;
  const turn = session.seq;
  session.append('request/header', { header: { config: { provider: 'openai-codex', model: ASTRA }, system: 'Preserve exact fixture constraints.' }, reason: 'initial' });
  session.append('turn/start', { turn });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Investigate BIZ-TWO-CALLS.' }] }), { surfaceOp: 'append' });
  session.append('step/start', { turn, step: 0 });
  session.append('assistant/message', { turn, step: 0, message: errorAssistant(ASTRA, { text: 'First call.', tools: [{ id: 'call-a' }], stopReason: 'error' }) }, { surfaceOp: 'append' });
  session.append('tool/call', { turn, step: 0, callId: 'call-a', name: 'read_file', arguments: '{}' });
  session.append('step/end', { turn, step: 0 });
  session.append('step/start', { turn, step: 1 });
  session.append('assistant/message', { turn, step: 1, message: errorAssistant(ASTRA, { text: 'Second call.', tools: [{ id: 'call-b' }], stopReason: 'error' }) }, { surfaceOp: 'append' });
  session.append('tool/call', { turn, step: 1, callId: 'call-b', name: 'read_file', arguments: '{}' });
  session.append('step/end', { turn, step: 1 });
  session.append('tool/result', { turn, step: 0, message: createToolResultMessage({ callId: 'call-a', content: [{ type: 'text', text: 'A' }], isError: false }) }, { surfaceOp: 'append' });
  session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: 'call-b', content: [{ type: 'text', text: 'B' }], isError: false }) }, { surfaceOp: 'append' });
  session.append('step/start', { turn, step: 2 });
  session.append('assistant/message', { turn, step: 2, message: createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Historical two-call fixture. '.repeat(4000) }] }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn, step: 2 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  await assert.rejects(f.engine.compactNow(f.agent, f.signal), error => (error?.cause?.code ?? error?.code) === 'CODEX_NATIVE_UNSAFE_HISTORY');
  assert.equal(f.requests.length, 0);
});

test('P0-A non-string replay responseId fails closed with no compact request', async t => {
  const f = await standardFixture(t);
  f.enable();
  const broken = errorAssistant(ASTRA, { text: 'Partial BIZ-BAD-ID', stopReason: 'aborted' });
  const state = structuredClone(broken.source.replayState);
  state.response.responseId = 123;
  appendTurn(f.agent.session, ASTRA, {
    user: 'Keep BIZ-BAD-ID-USER.',
    assistants: [
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Historical standard fixture. '.repeat(4000) }] }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA, replayState: state }, content: broken.content }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Tail.' }] }),
    ],
  });
  await assert.rejects(f.engine.compactNow(f.agent, f.signal), error => (error?.cause?.code ?? error?.code) === 'CODEX_NATIVE_REPLAY_INCOMPATIBLE');
  assert.equal(f.requests.length, 0);
});

test('P0-B three official Basic rounds do not accumulate wrappers or replaced history', async t => {
  const f = await standardFixture(t);
  f.enable();
  for (const round of [1, 2, 3]) {
    appendTurn(f.agent.session, ASTRA, {
      user: `Keep BIZ-R${round}-USER exactly once.`,
      assistants: [
        createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: `Historical BIZ-R${round}-HIST. `.repeat(4000) }] }),
        createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: `Tail BIZ-R${round}-TAIL.` }] }),
      ],
    });
    if (round === 2) {
      appendTurn(f.agent.session, ASTRA, {
        user: 'Recovered after a cancelled turn.',
        assistants: [errorAssistant(ASTRA, { text: 'Partial BIZ-R2-CANCEL', stopReason: 'aborted' })],
      });
    }
    const result = await f.engine.compactNow(f.agent, f.signal);
    assert.equal(typeof result.summarySeq, 'number');
    const body = f.requests.at(-1).body;
    assertNativeCompactWire(body, { mustInclude: [`BIZ-R${round}-USER`] });
    assert.equal(body.input.filter(item => JSON.stringify(item).includes(`BIZ-R${round}-USER`)).length, 1, 'real user text is not duplicated on the wire');
    for (const prior of [1, 2, 3]) {
      if (prior >= round) continue;
      assert.equal(wireBlob(body).includes(`BIZ-R${prior}-HIST`), false, 'replaced historical assistant text must not reappear on a later wire');
      assert.ok(body.input.filter(item => JSON.stringify(item).includes(`BIZ-R${prior}-USER`)).length <= 1);
    }
    const { record } = committedNativeReplacement(f.agent.session, f.ctx);
    assert.equal(record.items.some(item => item.type === 'compaction_trigger'), false);
    assert.equal(record.items.filter(item => item.type === 'compaction').length, 1);
    const replacement = f.agent.session.deriveMessages().find(isNativeCarrier);
    assert.equal((replacement.content ?? []).filter(block => block.type === 'text' && block.text.includes('<compacted-summary>')).length, 1);
  }
  assert.equal(f.requests.length, 3);
  assert.equal(f.hostCalls.length, 0);
  const beforeAgain = JSON.stringify(committedNativeReplacement(f.agent.session, f.ctx).record.items);
  const beforeUsers = f.agent.session.deriveMessages().filter(message => message.source?.kind === 'user').length;
  try {
    const result = await f.engine.compactNow(f.agent, f.signal);
    if (result) {
      const next = committedNativeReplacement(f.agent.session, f.ctx).record;
      assert.equal(JSON.stringify(next.items).includes('<compacted-summary>'), false);
      assert.equal(JSON.stringify(next.items).includes('DSH_CODEX_OWNER_REPLAY_'), false);
      assert.equal(JSON.stringify(next.items).includes('BIZ-R1-HIST'), false);
      assert.ok(JSON.stringify(next.items).length < beforeAgain.length * 3, 'no-new-content compact must not grow from wrapping');
    }
  } catch (error) {
    assert.equal(error.code, 'summary');
    assert.match(String(error.cause?.message ?? ''), /summary is not smaller than the shadowed content/);
    assert.equal(JSON.stringify(committedNativeReplacement(f.agent.session, f.ctx).record.items), beforeAgain);
  }
  assert.equal(f.agent.session.deriveMessages().filter(message => message.source?.kind === 'user').length >= beforeUsers, true);
});

test('P0-C standard-path metering distinguishes host estimate, native replay estimate, bytes and usage', async t => {
  const f = await standardFixture(t, {
    nativeReply: ({ events }) => sse([
      { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque-meter-fixture'.repeat(800) } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]),
  });
  f.enable();
  f.addStandardHistory();
  const shadowed = f.ctx.tokenMeter.measure(f.agent.session);
  const result = await f.engine.compactNow(f.agent, f.signal);
  assert.equal(typeof result.summarySeq, 'number');
  const replacement = f.agent.session.deriveMessages().find(message => message.source.kind === 'plugin' && message.source.plugin === 'compact');
  const envelope = replacement.content.find(block => block.type === 'text' && block.text.startsWith('<dsh-codex-compaction-v1>')).text;
  const record = f.ctx.codexBridge.readCheckpoint(replacement);
  const hostEstimate = f.ctx.tokenMeter.estimateMessage(replacement);
  const nativeEstimate = f.ctx.codexBridge.estimateCheckpoint(record);
  const bytes = Buffer.byteLength(envelope, 'utf8');
  assert.equal(nativeEstimate.exact, false);
  assert.equal(nativeEstimate.basis, 'native-replay-json-utf16/4');
  assert.equal(Number.isFinite(nativeEstimate.tokens) && nativeEstimate.tokens >= 0, true);
  assert.equal(hostEstimate < shadowed.totalTokens, true, 'Basic shrink used the host meter on the framed envelope');
  assert.equal(bytes > nativeEstimate.tokens, true, 'serialization bytes are not the native replay token estimate');
  const summary = summariesOf(f.agent.session).at(-1);
  assert.equal(summary.data.usage, undefined, 'unobserved provider usage stays unavailable, not a fabricated zero');
  const after = f.ctx.tokenMeter.measure(f.agent.session);
  const comparison = {
    hostFramedEstimate: hostEstimate,
    nativeReplayEstimate: nativeEstimate.tokens,
    nativeBasis: nativeEstimate.basis,
    envelopeBytes: bytes,
    shadowedHostTokens: result.shadowedTokenCount,
    postReplaceHostTokens: after.totalTokens,
  };
  assert.equal(comparison.nativeReplayEstimate === comparison.hostFramedEstimate, false,
    'standard Basic shrink/pressure still prices the framed envelope, not the owner replay estimate');
  assert.equal(nativeEstimate.tokens, Math.ceil(JSON.stringify(record.items).length / 4),
    'owner estimate is JSON.stringify(items)/4, including opaque ciphertext, not a verified native context occupancy');
  const mid = nativeEstimate.tokens + Math.floor((after.totalTokens - nativeEstimate.tokens) / 2);
  assert.equal(after.totalTokens > nativeEstimate.tokens, true);
  assert.equal(after.totalTokens >= mid, true, 'host post-replace pressure would use framed occupancy');
  assert.equal(nativeEstimate.tokens >= mid, false, 'the same threshold would not fire if priced by the owner JSON estimate');
  const auto = await standardFixture(t, {
    deferEngine: true,
    nativeReply: ({ events }) => sse([
      { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque-meter-fixture'.repeat(800) } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]),
  });
  auto.enable();
  auto.addStandardHistory();
  const engine = auto.makeEngine({
    auto: true,
    compactionRetries: 0,
    modelPolicies: [{ provider: 'openai-codex', model: ASTRA, thresholdRatio: mid / 872000, retainTokens: 0 }],
  });
  await engine.compactNow(auto.agent, auto.signal);
  const post = auto.ctx.tokenMeter.measure(auto.agent.session);
  const beforeAuto = auto.requests.length;
  openTurn(auto.agent.session, 2);
  await auto.ctx.waterfall('agent/pre-step', { agent: auto.agent, signal: auto.signal }, () => 'pre-step-final');
  closeTurn(auto.agent.session, 2);
  assert.equal(auto.requests.length > beforeAuto, post.totalTokens >= mid,
    'post-replace automatic pressure follows the host meter, not the owner JSON estimate');
});

test('P1-A cancel before replace leaves history unchanged; cancel after commit is not a rollback', async t => {
  const abortDuring = new AbortController();
  const f = await standardFixture(t, {
    nativeReply: ({ events }) => {
      abortDuring.abort();
      return sse(events);
    },
  });
  f.enable();
  f.addStandardHistory();
  const before = JSON.stringify(f.agent.session.deriveMessages());
  await assert.rejects(f.engine.compactNow(f.agent, abortDuring.signal));
  assert.equal(JSON.stringify(f.agent.session.deriveMessages()), before);
  assert.equal(summariesOf(f.agent.session).length, 0);
  assert.equal(f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).recovery.every(entry => !entry.inFlight), true);

  let released;
  const mutate = await standardFixture(t, {
    nativeReply: ({ events }) => {
      mutate.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'BIZ-NEW-AFTER-SELECT' }] }), { surfaceOp: 'append' });
      return sse(events);
    },
  });
  mutate.enable();
  mutate.addStandardHistory();
  const mutated = await mutate.engine.compactNow(mutate.agent, mutate.signal);
  assert.equal(typeof mutated.summarySeq, 'number');
  const messages = mutate.agent.session.deriveMessages();
  assert.equal(JSON.stringify(messages).includes('BIZ-NEW-AFTER-SELECT'), true, 'selected-span commit keeps messages appended outside the span');
  assert.equal(messages.some(isNativeCarrier), true);
  released = mutate.ctx.codexBridge.nativePreferenceStatus(mutate.agent.session.id);
  assert.equal(released.recovery.every(entry => !entry.inFlight), true);

  const afterCommit = new AbortController();
  const committed = await standardFixture(t);
  committed.enable();
  committed.addStandardHistory();
  const originalFlush = committed.ctx.sessions.flush.bind(committed.ctx.sessions);
  committed.ctx.sessions.flush = async session => {
    afterCommit.abort();
    return originalFlush(session);
  };
  await assert.rejects(committed.engine.compactNow(committed.agent, afterCommit.signal));
  assert.equal(committed.agent.session.deriveMessages().some(isNativeCarrier), true, 'post-replace cancel is not a rollback');

  const beforeCommit = new AbortController();
  const remoteDone = await standardFixture(t);
  remoteDone.enable();
  remoteDone.addStandardHistory();
  const beforeRemote = JSON.stringify(remoteDone.agent.session.deriveMessages());
  const summarize = remoteDone.engine.summarize.bind(remoteDone.engine);
  remoteDone.engine.summarize = async (...args) => {
    const result = await summarize(...args);
    beforeCommit.abort();
    return result;
  };
  await assert.rejects(remoteDone.engine.compactNow(remoteDone.agent, beforeCommit.signal));
  assert.equal(JSON.stringify(remoteDone.agent.session.deriveMessages()), beforeRemote);
  assert.equal(summariesOf(remoteDone.agent.session).length, 0);
  assert.ok(remoteDone.requests.length >= 1, 'remote compact finished before the pre-commit cancel');

  const inSpan = await standardFixture(t, {
    nativeReply: ({ events }) => {
      const span = inSpan.agent.session.surface.nodes;
      inSpan.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'BIZ-INSPAN-REWRITE' }] }), {
        surfaceOp: { op: 'replace', start: span[0], end: span[span.length - 1] },
      });
      return sse(events);
    },
  });
  inSpan.enable();
  inSpan.addStandardHistory();
  const beforeSpan = JSON.stringify(inSpan.agent.session.deriveMessages());
  try {
    await inSpan.engine.compactNow(inSpan.agent, inSpan.signal);
    assert.equal(JSON.stringify(inSpan.agent.session.deriveMessages()).includes('BIZ-INSPAN-REWRITE'), true,
      'if in-span replace was allowed, a successful compact must not drop the rewritten history');
  } catch {
    const afterSpan = JSON.stringify(inSpan.agent.session.deriveMessages());
    assert.equal(afterSpan.includes('<dsh-codex-compaction-v1>'), false, 'a rejected in-span rewrite must not commit a stale checkpoint');
    assert.ok(afterSpan === beforeSpan || afterSpan.includes('BIZ-INSPAN-REWRITE'));
  }
});

test('P1-B persistence failure after commit is not retried as a native network error', async t => {
  const f = await standardFixture(t);
  f.enable();
  f.addStandardHistory();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-journal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let failFlush = false;
  let failAfterSave = false;
  f.ctx.on('session/flush', async session => {
    const events = session.snapshotEvents();
    const path = join(dir, `${session.id}.jsonl`);
    if (failFlush) throw Object.assign(new Error('injected journal flush failure'), { code: 'CODEX_TEST_FLUSH' });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, events.map(event => JSON.stringify(event)).join('\n'));
    await rename(tmp, path);
    if (failAfterSave) throw Object.assign(new Error('injected post-save notify failure'), { code: 'CODEX_TEST_NOTIFY' });
  });
  await f.engine.compactNow(f.agent, f.signal);
  const restored = f.ctx.sessions.create(undefined, {
    seed: (await readFile(join(dir, `${f.agent.session.id}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
  });
  assert.equal(restored.deriveMessages().some(isNativeCarrier), true);

  failFlush = true;
  appendTurn(f.agent.session, ASTRA, {
    user: 'BIZ-AFTER-FLUSH',
    assistants: [
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'More historical fixture. '.repeat(4000) }] }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'New tail.' }] }),
    ],
  });
  const requests = f.requests.length;
  const firstIdentity = f.ctx.codexBridge.readCheckpoint(f.agent.session.deriveMessages().find(isNativeCarrier)).identity;
  await assert.rejects(f.engine.compactNow(f.agent, f.signal), error => error.code === 'persistence' || error.cause?.code === 'CODEX_TEST_FLUSH' || /durability|persistence/i.test(String(error)));
  assert.equal(f.requests.length, requests + 1, 'flush failure must not open another native compact');
  assert.equal(f.agent.session.deriveMessages().some(isNativeCarrier), true);
  assert.equal(f.hostCalls.length, 0);
  const disk = (await readFile(join(dir, `${f.agent.session.id}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(disk.length < f.agent.session.snapshotEvents().length, 'failed flush must not rewrite the journal');
  const fromDisk = f.ctx.sessions.create(undefined, { seed: disk });
  assert.equal(fromDisk.deriveMessages().some(isNativeCarrier), true);
  assert.equal(f.ctx.codexBridge.readCheckpoint(fromDisk.deriveMessages().find(isNativeCarrier)).identity, firstIdentity);
  assert.equal(JSON.stringify(fromDisk.deriveMessages()).includes('BIZ-AFTER-FLUSH'), false);
  const recovery = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).recovery;
  assert.equal(recovery.every(entry => !entry.inFlight), true);
  assert.equal(recovery.every(entry => !entry.coolingDown), true, 'a local persistence failure must not start native-network cooldown');

  failFlush = false;
  failAfterSave = true;
  appendTurn(f.agent.session, ASTRA, {
    user: 'BIZ-AFTER-SAVE',
    assistants: [
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Post-save historical fixture. '.repeat(4000) }] }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Post-save tail.' }] }),
    ],
  });
  const afterSaveRequests = f.requests.length;
  await assert.rejects(f.engine.compactNow(f.agent, f.signal), error => error.code === 'persistence' || error.cause?.code === 'CODEX_TEST_NOTIFY' || /durability|persistence/i.test(String(error)));
  assert.equal(f.requests.length, afterSaveRequests + 1);
  const diskAfterSave = (await readFile(join(dir, `${f.agent.session.id}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(diskAfterSave.length >= disk.length, 'rename already succeeded before the notify failure');
  const fromDiskAfterSave = f.ctx.sessions.create(undefined, { seed: diskAfterSave });
  assert.equal(JSON.stringify(fromDiskAfterSave.deriveMessages()).includes('BIZ-AFTER-SAVE') || fromDiskAfterSave.deriveMessages().some(isNativeCarrier), true);
  const afterNotify = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).recovery;
  assert.equal(afterNotify.every(entry => !entry.inFlight), true);
  assert.equal(afterNotify.every(entry => !entry.coolingDown), true);
});

test('P1-C public fork before and after a checkpoint keeps history boundaries', async t => {
  const f = await standardFixture(t);
  f.enable();
  f.addStandardHistory();
  const beforeSeq = f.agent.session.snapshotEvents().at(-1).seq;
  const pre = f.ctx.sessions.fork(f.agent.session, beforeSeq);
  await f.engine.compactNow(f.agent, f.signal);
  const afterSeq = f.agent.session.snapshotEvents().at(-1).seq;
  const post = f.ctx.sessions.fork(f.agent.session, afterSeq);
  assert.equal(pre.deriveMessages().some(isNativeCarrier), false);
  assert.equal(JSON.stringify(pre.deriveMessages()).includes('Keep /fixture/standard.ts'), true);
  assert.equal(post.deriveMessages().some(isNativeCarrier), true);
  f.ctx.codexBridge.setNativePreference(post.id, 'on');
  const postAgent = { ...f.agent, session: post, options: { provider: 'openai-codex', model: ASTRA }, runMaintenance: async action => action(f.signal) };
  appendTurn(post, ASTRA, {
    user: 'BIZ-FORK-CONTINUE',
    assistants: [
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Fork continuation history. '.repeat(4000) }] }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Fork tail.' }] }),
    ],
  });
  await f.engine.compactNow(postAgent, f.signal);
  assert.equal(JSON.stringify(post.deriveMessages()).includes('BIZ-FORK-CONTINUE') || f.requests.at(-1).body.input.some(item => JSON.stringify(item).includes('BIZ-FORK-CONTINUE')), true);
  assert.equal(pre.deriveMessages().some(isNativeCarrier), false);
  const replay = async (session, expectCompaction) => {
    const before = f.requests.length;
    const assembler = new BlockAssembler();
    for await (const chunk of f.ctx.llm.stream({ provider: 'openai-codex', model: ASTRA, sessionId: session.id, messages: session.deriveMessages(), signal: f.signal })) assembler.push(chunk);
    assert.equal(assembler.finish.kind, 'stop');
    if (expectCompaction) {
      assert.ok(f.requests.length > before);
      assert.equal(f.requests.at(-1).body.input.some(item => item.type === 'compaction'), true);
    } else {
      assert.equal(f.requests.length, before, 'a pre-checkpoint fork must not replay opaque native state');
    }
  };
  f.ctx.codexBridge.setNativePreference(pre.id, 'on');
  await replay(pre, false);
  await replay(post, true);
  const rebuilt = f.ctx.sessions.create(undefined, { seed: JSON.parse(JSON.stringify(post.snapshotEvents())) });
  f.ctx.codexBridge.setNativePreference(rebuilt.id, 'on');
  await replay(rebuilt, true);
  assert.equal(f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).recovery.every(entry => !entry.inFlight), true);
  assert.equal(f.ctx.codexBridge.nativePreferenceStatus(post.id).recovery.every(entry => !entry.inFlight), true);
  assert.equal(f.ctx.codexBridge.nativePreferenceStatus(pre.id).recovery.every(entry => !entry.inFlight), true);
});

test('P1-D oversized converted compact input fails closed without treating HTTP 400 as overflow', async t => {
  const f = await standardFixture(t);
  f.enable();
  f.addStandardHistory();
  await f.engine.compactNow(f.agent, f.signal);
  const session = f.agent.session;
  const turn = session.seq;
  session.append('request/header', {
    header: {
      config: { provider: 'openai-codex', model: ASTRA },
      system: `${'SYSTEM-OVERFLOW '.repeat(2000)}\nPreserve exact fixture constraints.`,
      tools: [{ name: 'read_file', description: 'Read a file. '.repeat(400), parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    },
    reason: 'series',
  });
  session.append('turn/start', { turn });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'BIZ-OVERFLOW-USER' }] }), { surfaceOp: 'append' });
  session.append('step/start', { turn, step: 0 });
  session.append('assistant/message', { turn, step: 0, message: createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [
    { type: 'tool-call', id: 'call-huge', name: 'read_file', arguments: '{}' },
  ] }) }, { surfaceOp: 'append' });
  session.append('tool/call', { turn, step: 0, callId: 'call-huge', name: 'read_file', arguments: '{}' });
  session.append('tool/result', { turn, step: 0, message: createToolResultMessage({ callId: 'call-huge', content: [{ type: 'text', text: 'HUGE-TOOL-OUTPUT '.repeat(80_000) }], isError: false }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn, step: 0 });
  session.append('step/start', { turn, step: 1 });
  session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ source: { provider: 'openai-codex', model: ASTRA }, content: [{ type: 'text', text: 'Tail after huge tool.' }] }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  const before = f.requests.length;
  try {
    const result = await f.engine.compactNow(f.agent, f.signal);
    assert.equal(typeof result.summarySeq, 'number');
    assert.ok(f.requests.length > before, 'the converted compact request must actually be sent');
    const body = f.requests.at(-1).body;
    assert.equal(body.input.at(-1)?.type, 'compaction_trigger');
    assert.ok(body.input.some(item => item.type === 'compaction'), 'prior checkpoint must be on the converted wire');
    assert.match(JSON.stringify(body), /HUGE-TOOL-OUTPUT/);
    assert.ok(JSON.stringify(body.instructions ?? body).includes('SYSTEM-OVERFLOW') || JSON.stringify(body).includes('SYSTEM-OVERFLOW'));
    assert.ok((body.tools?.length ?? 0) >= 1 || JSON.stringify(body).includes('read_file'));
    assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') > 100_000, 'converted request size is inspected, not just source message size');
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? '';
    assert.ok(/BODY_SIZE|RETENTION_SIZE|JSON_LIMIT|CHECKPOINT_SIZE|SSE_SIZE/.test(String(code)), `oversized converted input must fail as owner governance, not summary/replay (${code})`);
    assert.equal(summariesOf(f.agent.session).length, 1);
  }
  assert.equal(f.hostCalls.length, 0);

  const classified = await standardFixture(t, { deferEngine: true });
  classified.enable();
  classified.addStandardHistory();
  classified.makeEngine({ auto: true, maxOverflowRetries: 1 });
  openTurn(classified.agent.session, 1);
  const http400 = await classified.ctx.waterfall('agent/request-error', { agent: classified.agent, failure: { code: 'HTTP_400' }, signal: classified.signal }, () => 'original-error');
  assert.equal(http400, 'original-error', 'plain HTTP 400 is not a context-overflow recovery entry');
  assert.equal(classified.requests.length, 0);
  const overflow = await classified.ctx.waterfall('agent/request-error', { agent: classified.agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: classified.signal }, () => 'original-error');
  assert.deepEqual(overflow, { kind: 'retry' }, 'a real overflow still enters native recovery on the same auto engine');
  assert.equal(classified.requests.length, 1);
  closeTurn(classified.agent.session, 1);
});

test('P1-E HTTP 429 is not a text-fallback entry and does not add attempts', async t => {
  const f = await standardFixture(t, { failFirstStatus: 429 });
  f.enable();
  f.addStandardHistory();
  await assert.rejects(f.engine.compactNow(f.agent, f.signal), error => (error?.cause?.code ?? error?.code) === 'CODEX_RUNTIME_HTTP_429');
  assert.equal(f.requests.length, 1);
  assert.equal(f.hostCalls.length, 0);
  assert.equal(summariesOf(f.agent.session).length, 0);
  const attempt = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id).lastAttempt;
  assert.equal(attempt.kind, 'native');
  assert.equal(attempt.outcome, 'failed');
});
