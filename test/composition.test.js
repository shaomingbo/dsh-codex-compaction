import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import Commands from '@deepseek-ai/dsh-commands';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import * as policy from '../src/index.js';
import * as providerEntry from '../src/provider-entry.js';
import { fakeRuntime } from './helpers/fake-runtime.js';
import { ROUTE } from '../src/constants.js';
async function fixture(t) {
  const ctx = new Context();
  let selectedEngine, lastAgent;
  class Presets extends Service {
    constructor() { super(ctx, 'agentPresets'); }
    async copy() { throw new Error('no implicit preset writes'); }
    async read() { throw new Error('no implicit preset writes'); }
    async resolve() { throw new Error('no implicit preset writes'); }
    serviceFor(agent) { lastAgent = agent; return selectedEngine; }
  }
  new Presets();
  for (const module of [Llm, Commands, providerEntry]) await ctx.plugin(module);
  const policyFiber = await ctx.plugin(policy);
  t.after(() => ctx.fiber.dispose());
  return { ctx, policyFiber, setEngine(engine) { selectedEngine = engine; }, get lastAgent() { return lastAgent; } };
}

async function mountOwner(ctx, runtime) {
  return ctx.plugin({ name: 'fixture-accounts-owner', apply(owner) { owner.provide('codexRuntime', runtime); } });
}

test('provider registration follows account capability, not a second login implementation', async t => {
  const { ctx } = await fixture(t);
  assert.ok(ctx.codexBridge);
  assert.deepEqual(ctx.llm.listProviders(), []);
  const f = fakeRuntime();
  const owner = await mountOwner(ctx, f.runtime);
  assert.deepEqual(ctx.llm.listProviders().map(p => p.id), [ROUTE]);
  assert.ok((await ctx.llm.listModels(ROUTE)).length);
  assert.equal(f.opened, 0);
  assert.equal(ctx.get('authorization'), undefined);
  assert.equal(ctx.get('credentials'), undefined);
  await owner.dispose();
  assert.deepEqual(ctx.llm.listProviders(), []);
});

test('policy entry can unload while provider route and reader remain', async t => {
  const f = await fixture(t);
  await mountOwner(f.ctx, fakeRuntime().runtime);
  assert.ok(f.ctx.commands.list({}).some(c => c.name === 'codex-compact-setup'));
  await f.policyFiber.dispose();
  assert.ok(f.ctx.llm.listProviders().some(p => p.id === ROUTE));
  assert.ok(!f.ctx.commands.list({}).some(c => c.name === 'codex-compact-setup'));
});

test('foreign guard remains when account owner disappears', async t => {
  const { ctx } = await fixture(t);
  let calls = 0;
  class Foreign extends LlmAdapter { async *stream() { calls++; yield { type: 'finish', reason: { kind: 'stop' } }; } }
  ctx.llm.registerAdapter(['foreign'], new Foreign());
  const f = fakeRuntime();
  const owner = await mountOwner(ctx, f.runtime);
  const record = f.runtime.decodeCheckpoint(f.runtime.encodeCheckpoint({ provider: ROUTE, model: 'gpt-5.4', identity: 'fixture-owner-connection', items: [{ type: 'compaction', encrypted_content: 'fixture' }] }));
  const message = createUserMessage({ source: { ...compactCheckpointSource('fixture'), nativeCodex: record }, content: [{ type: 'text', text: 'structured checkpoint' }] });
  await owner.dispose();
  await assert.rejects(async () => { for await (const _ of ctx.llm.stream({ provider: 'foreign', model: 'test', messages: [message] })) {} }, error => error.code === 'CODEX_NATIVE_FOREIGN_REPLAY');
  assert.equal(calls, 0);
});

test('ordinary basic checkpoint mentioning native syntax stays on its original provider', async t => {
  const { ctx } = await fixture(t);
  let calls = 0;
  class Foreign extends LlmAdapter { async *stream() { calls++; yield { type: 'finish', reason: { kind: 'stop' } }; } }
  ctx.llm.registerAdapter(['foreign'], new Foreign());
  const message = createUserMessage({ source: compactCheckpointSource('ordinary-basic-summary'), content: [
    { type: 'text', text: 'Checkpoint preamble\n\n<compacted-summary>' },
    { type: 'text', text: 'Research notes: codec uses `<dsh-codex-compaction-v1>...</dsh-codex-compaction-v1>`. This is documentation, not native state.' },
    { type: 'text', text: '</compacted-summary>' },
  ] });
  for await (const _ of ctx.llm.stream({ provider: 'foreign', model: 'test', messages: [message] })) {}
  assert.equal(calls, 1);
});

test('legacy native-looking blocks remain guarded even when malformed or unsupported', async t => {
  const { ctx } = await fixture(t);
  let calls = 0;
  class Foreign extends LlmAdapter { async *stream() { calls++; yield { type: 'finish', reason: { kind: 'stop' } }; } }
  ctx.llm.registerAdapter(['foreign'], new Foreign());
  for (const text of ['<dsh-codex-compaction-v1>broken', '<dsh-codex-compaction-v99>{}</dsh-codex-compaction-v99>']) {
    const message = createUserMessage({ source: compactCheckpointSource('legacy'), content: [{ type: 'text', text }] });
    await assert.rejects(async () => { for await (const _ of ctx.llm.stream({ provider: 'foreign', model: 'test', messages: [message] })) {} }, error => error.code === 'CODEX_NATIVE_FOREIGN_REPLAY');
  }
  assert.equal(calls, 0);
});

test('context command shows effective estimate and addresses the receiving agent preset', async t => {
  const f = await fixture(t);
  const owner = fakeRuntime();
  await mountOwner(f.ctx, owner.runtime);
  const agent = { session: { id: 'fixture-session' } };
  f.setEngine({ measureEffective(session) { assert.equal(session, agent.session); return { hostTokens: 106, effectiveTokens: 3105, nodes: [{ estimate: { basis: 'fixture-estimate' } }], anchorAdjustment: { kind: 'no-usage' } }; } });
  const command = f.ctx.commands.find(agent, 'codex-context');
  const result = await command.handler({ agent, rawInput: '', signal: new AbortController().signal });
  assert.match(result.text, /~3105/);
  assert.match(result.text, /Host meter: 106/);
  assert.match(result.text, /not an exact provider count/);
  assert.equal(f.lastAgent, agent);
  assert.equal(owner.opened, 0);
});

test('setup without the owner capability fails before any preset copy', async t => {
  const { ctx } = await fixture(t);
  const command = ctx.commands.find({}, 'codex-compact-setup');
  await assert.rejects(command.handler({ rawInput: '', signal: new AbortController().signal }), error => error.code === 'CODEX_RUNTIME_UNAVAILABLE');
});
