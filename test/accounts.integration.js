// Explicit paired-checkout suite. Run only via scripts/test-accounts.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
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
