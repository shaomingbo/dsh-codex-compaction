// Durable-fix first end-to-end path (paired, isolated): the REAL agent-preset
// registry mounts the REAL preset row structure; the REAL owner runtime from
// the isolated candidate snapshot serves model facts and a fake native
// transport (mock auth + canned SSE, disclosed); the REAL Basic engine owns
// selection/transactions; the observer reads REAL committed events; the next
// request replays the carrier through the same owner.
//
// Run only via scripts/test-accounts.js (isolated account snapshot required).
// Trimming disclosure: the preset rows mounted here are the compaction-relevant
// subset of cordis.patch.yml (persona/tool rows belong to unrelated packages
// absent from this checkout); their row configs are copied verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { Context, Service } from '@deepseek-ai/cordis';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Meter from '@deepseek-ai/dsh-token-meter';
import Commands from '@deepseek-ai/dsh-commands';
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import * as providerEntry from '../src/provider-entry.js';
import * as policy from '../src/index.js';
import { isNativeCarrier } from '../src/runtime-adapter.js';

// The real module Loader service (transitive dependency of the preset
// registry, resolved through it) plus the cordis:group builtin the host
// itself installs — the official mount mechanism, not a stub.
const registryRequire = createRequire(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset-registry/package.json')) + '/');
const { Loader, Group } = await import(registryRequire.resolve('@deepseek-ai/cordis-plugin-loader'));
const { createScope } = await import(registryRequire.resolve('@deepseek-ai/dsh-scope'));

const root = process.env.ACCOUNT_SNAPSHOT_ROOT;
if (!root || !basename(root).startsWith('dsh-codex-account-snapshot-') || (await lstat(join(root, 'node_modules'))).isSymbolicLink()) throw new Error('An isolated installed account snapshot is required; no live workspace fallback.');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const entry = manifest.exports?.['./codex-runtime'];
if (manifest.name !== 'dsh-token-usage' || typeof entry !== 'string') throw new Error('Missing public owner capability export.');
const { createCodexRuntime } = await import(pathToFileURL(resolve(root, entry)).href);

const ROUTE = 'codex-native-lab';
const MODEL = 'gpt-6-sol';
const token = account => `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.signature`;
const sse = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

/** The compaction-relevant preset rows from cordis.patch.yml, verbatim. */
const PRESET_PLUGINS = [
  { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true, codexNativePolicy: true },
    config: [
      { id: 'codex-native-policy', name: 'dsh-codex-compaction/native-policy', config: { nativeDefault: true } },
      { id: 'compaction-basic', name: 'dsh-codex-compaction/compaction', config: { compactionRetries: 1 } },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    ] },
];

test('durable e2e: official preset mount, native default, real Basic commit, observer, owner replay', async t => {
  const requests = [];
  // Mock auth + transport (disclosed): a synthetic account token and canned
  // SSE bodies. No real account, credential, or network is involved.
  const runtime = createCodexRuntime({
    configured: () => true,
    resolveOAuth: async () => ({ apiKey: token('durable-e2e-fixture'), headers: { 'chatgpt-account-id': 'durable-e2e-fixture' } }),
    fetchImpl: async (url, init) => {
      const raw = typeof init.body === 'string' ? init.body : zstdDecompressSync(init.body).toString('utf8');
      requests.push({ url, body: JSON.parse(raw) });
      if (requests.at(-1).body.input.at(-1)?.type === 'compaction_trigger') return sse([
        { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'durable-e2e-opaque-payload' } },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 90, output_tokens: 5, total_tokens: 95 } } },
      ]);
      return sse([
        { type: 'response.created', response: { id: 'next-request', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'replayed-continuation' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'replayed-continuation', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'next-request', status: 'completed', usage: { input_tokens: 30, output_tokens: 2, total_tokens: 32 } } },
      ]);
    },
    timeoutMs: 30_000,
  });
  t.after(() => runtime.dispose());

  const ctx = new Context();
  for (const plugin of [Llm, Sessions, Projections, Meter, Commands]) await ctx.plugin(plugin);
  ctx.provide('sessionQuery', { readSession: async id => ({ events: ctx.sessions.get(id)?.snapshotEvents() ?? [] }) });
  // Real module Loader + the cordis:group builtin, as the host installs them.
  await ctx.plugin(Loader, { baseUrl: import.meta.url });
  ctx.loader.builtins.group = Group;
  // Minimal settings service: the real registry only gates auto-generation
  // through it; the mount mechanism under test stays fully real.
  class SettingsStub extends Service { constructor() { super(ctx, 'settings'); } configure() {} }
  new SettingsStub();
  await ctx.plugin(AgentPresetRegistry, { default: 'codex-native-b' });
  await ctx.plugin(providerEntry, { nativeCompaction: true });
  await ctx.plugin(policy);
  await ctx.plugin({ name: 'isolated-owner-runtime', apply(ownerCtx) {
    ownerCtx.provide('codexRuntime', runtime);
    ownerCtx.on('dispose', () => runtime.dispose());
  } });
  // Official preset registration through the real AgentPreset module.
  await ctx.plugin(AgentPreset, { id: 'codex-native-b', name: 'Codex Native',
    description: '原生压缩默认开启；适合长任务；由 Accounts & Usage 提供账号能力。', order: 9, plugins: PRESET_PLUGINS });
  t.after(() => ctx.fiber.dispose());

  const presets = ctx.get('agentPresets');
  // --- Official mount: a scoped agent context joins the preset revision. ---
  const session = ctx.sessions.create('durable-e2e');
  session.append('request/header', { header: { config: { provider: 'openai-codex', model: MODEL } }, reason: 'initial' });
  const agentScope = createScope(ctx, Symbol('durable-e2e-agent'));
  const agentCtx = agentScope.ctx;
  t.after(() => agentScope.dispose());
  const mounted = await presets.mount(agentCtx, 'codex-native-b');
  assert.equal(mounted.id, 'codex-native-b');
  const signal = new AbortController().signal;
  const agent = { ctx: agentCtx, session, options: { provider: 'openai-codex', model: MODEL }, runMaintenance: async action => action(signal) };

  // The preset-mounted services resolve per agent through the real registry.
  const engine = presets.serviceFor(agent, 'compaction');
  assert.equal(typeof engine?.compactNow, 'function');
  const nativePolicy = presets.serviceFor(agent, 'codexNativePolicy');
  assert.equal(nativePolicy?.presetNativeDefault?.(), true, 'the preset-local native default is mounted ON');
  const bridge = agentCtx.get('codexBridge');
  assert.equal(bridge.presetNativeDefault(agent), true);
  // No explicit session preference: inherit follows the preset default.
  const status = await bridge.nativePreferenceStatus(agent, session.id);
  assert.deepEqual([status.capability, status.preset, status.session, status.effective], [true, true, 'inherit', true]);

  // --- Real Basic transaction with the candidate owner's new model facts. ---
  // Assistant-heavy history: the shadowed span is mostly non-retained
  // assistant work, so the native envelope (retained client tail + opaque)
  // is far smaller than the replaced content.
  const turn = session.seq;
  session.append('turn/start', { turn });
  for (let index = 0; index < 16; index++) {
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Fixture request ${index}.` }] }), { surfaceOp: 'append' });
    session.append('step/start', { turn, step: index });
    session.append('assistant/message', { turn, step: index, stream: [], message: { role: 'assistant', source: { provider: 'openai-codex', model: MODEL }, content: [{ type: 'text', text: `Fixture worklog ${index}. `.repeat(2200) }] } }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step: index });
  }
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Latest tail request.' }] }), { surfaceOp: 'append' });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });

  const result = await engine.compactNow(agent, signal);
  assert.ok(result);
  assert.ok(result.shadowedSeqs.length > 0);
  // The native transport received the request bound to the new model id.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, MODEL);
  assert.equal(requests[0].body.input.at(-1).type, 'compaction_trigger');
  // Real committed events, 0.1.7 shapes.
  const events = session.snapshotEvents();
  const summary = events.find(event => event.type === 'compaction/summary');
  const replacement = events.find(event => event.type === 'user/message' && (event.sourceEventSeqs ?? []).includes(summary.seq));
  const end = events.find(event => event.type === 'compaction/end');
  assert.equal(end.data.error, undefined);
  assert.equal(replacement.surfaceOp.op, 'replace');
  assert.equal(replacement.surfaceOp.startSeq, summary.data.shadowedRange.start);
  assert.equal(replacement.surfaceOp.endSeq, summary.data.shadowedRange.end);
  assert.equal(summary.data.model, MODEL);
  // The observer reads the REAL lifecycle: committed with comparable savings.
  const progress = bridge.compactionProgress(session);
  assert.equal(progress.counts.committed, 1);
  assert.equal(progress.latest.outcome, 'committed');
  assert.equal(typeof progress.latest.netFreedTokens, 'number');
  assert.equal(progress.latest.comparison.reason, null);

  // --- The next request replays the committed carrier through the owner. ---
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue with the fixture' }] }), { surfaceOp: 'append' });
  const messages = session.deriveMessages();
  assert.ok(messages.some(isNativeCarrier), 'the committed replacement is a native carrier');
  // The provider entry's global seam intercepts carriers on llm/stream and
  // replays them through the same owner runtime; drive the public path.
  const llm = agentCtx.get('llm');
  const streamed = [];
  for await (const chunk of llm.stream({ provider: 'openai-codex', model: MODEL, messages, signal })) streamed.push(chunk);
  assert.ok(streamed.some(chunk => chunk.type === 'text-delta' && chunk.text === 'replayed-continuation'));
  assert.equal(requests.length, 2, 'the replay went through the same owner runtime');
  const replayBody = requests[1].body;
  assert.ok(JSON.stringify(replayBody.input).includes('durable-e2e-opaque-payload'),
    'the opaque checkpoint payload reached the next native request via owner replay');
});

test('durable e2e: candidate owner catalog serves Sol/Luna facts for both routes', async () => {
  const runtime = createCodexRuntime({ configured: () => true, resolveOAuth: async () => { throw new Error('unused'); } });
  try {
    const ids = runtime.models().map(model => model.id);
    assert.ok(ids.includes('gpt-6-sol') && ids.includes('gpt-6-luna'), `catalog: ${ids.join(',')}`);
    const sol = runtime.models().find(model => model.id === 'gpt-6-sol');
    assert.equal(sol.contextWindow, 272_000);
    assert.equal(sol.maxTokens, 128_000);
    assert.deepEqual(sol.input, ['text', 'image']);
    assert.equal(sol.thinkingLevelMap.off, 'none');
    assert.equal(sol.thinkingLevelMap.minimal, 'low');
    const verdict = await runtime.applicability({ provider: 'openai-codex', model: 'gpt-6-luna' });
    assert.deepEqual(verdict, { applicable: true, model: { id: 'gpt-6-luna', contextWindow: 272_000, maxTokens: 128_000, input: ['text', 'image'] } });
    assert.deepEqual(runtime.describe().retentionHints, { supported: true, algorithm: 'source-aware-v1', version: 1 });
  } finally { runtime.dispose(); }
});

test('cross-seam retention: consumer hints map through owner transport end to end', async t => {
  const requests = [];
  const runtime = createCodexRuntime({
    configured: () => true,
    resolveOAuth: async () => ({ apiKey: token('retention-e2e'), headers: { 'chatgpt-account-id': 'retention-e2e' } }),
    fetchImpl: async (url, init) => {

      const raw = typeof init.body === 'string' ? init.body : zstdDecompressSync(init.body).toString('utf8');
      requests.push(JSON.parse(raw));
      return sse([
        // The opaque payload must not contain the synthetic account id: the
        // owner's credential-echo guard legitimately refuses a result whose
        // native JSON repeats account/token facts, so an accidental substring
        // collision would test the guard instead of the retention seam.
        { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque-native-payload-not-a-secret' } },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
      ]);
    },
    timeoutMs: 30_000,
  });
  t.after(() => runtime.dispose());
  const ctx = new Context();
  for (const plugin of [Llm, Sessions, Projections, Meter, Commands]) await ctx.plugin(plugin);
  ctx.provide('sessionQuery', { readSession: async () => ({ events: [] }) });
  const providerEntry = await import('../src/provider-entry.js');
  await ctx.plugin(providerEntry);
  await ctx.plugin({ name: 'isolated-owner', apply(oc) { oc.provide('codexRuntime', runtime); } });
  t.after(() => ctx.fiber.dispose());

  // DSH messages with known source kinds (consumer-side classification). The
  // fixture distinguishes the two R1 §E outcomes through one seam:
  //  - 'shared instruction body' is authoritative once and a notice once, so its
  //    source is ambiguous and MUST fall back conservatively (both copies kept);
  //  - 'repeated notice body' is a host-generated notice twice, which is a
  //    provable duplicate whose older copy may leave the retained copy.
  const createUser = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const createNotice = text => ({ role: 'user', source: { kind: 'plugin', plugin: 'dsh-subagent' }, content: [{ type: 'text', text }] });
  const { buildRetentionHints } = await import('../src/runtime-adapter.js');
  const messages = [
    createUser('shared instruction body'),
    createNotice('shared instruction body'),
    createNotice('repeated notice body'),
    createNotice('repeated notice body'),
    createNotice('one-off notice'),
    createUser('final tail'),
  ];
  const hints = buildRetentionHints(messages);

  // Verify consumer-side hint construction: categories come from source
  // metadata, and a text claimed by two different sources degrades to unknown.
  assert.equal(hints.algorithm, 'source-aware-v1');
  const digestOf = text => createHash('sha256').update(text).digest('hex');
  const categoryOf = text => hints.items.find(item => item.digest === digestOf(text))?.category;
  assert.equal(categoryOf('shared instruction body'), 'unknown', 'conflicting sources degrade to unknown');
  assert.equal(categoryOf('repeated notice body'), 'host-notice');
  assert.equal(categoryOf('one-off notice'), 'host-notice');
  assert.equal(categoryOf('final tail'), 'user-instruction');
  assert.ok(!JSON.stringify(hints).includes('instruction body'), 'no message text crosses the seam');

  // Drive through the real owner adapter → converter → transport
  const bridge = ctx.get('codexBridge');
  const lease = await bridge.adapter.seamLease({ model: 'gpt-6-sol', signal: new AbortController().signal });
  try {
    // The owner transport receives hints through the provider({retentionHints}) seam.
    const result = await bridge.adapter.seamCompactOnLease(lease, {
      model: 'gpt-6-sol', messages, signal: new AbortController().signal, retention: true,
    });
    assert.ok(result.envelope.startsWith('<dsh-codex-compaction-v1'));
    // The full request is still sent: every original text reaches the wire,
    // including BOTH copies of the duplicated notice.
    const wire = requests[0];
    const wireJson = JSON.stringify(wire.input);
    for (const text of ['shared instruction body', 'repeated notice body', 'one-off notice', 'final tail']) {
      assert.ok(wireJson.includes(text), `full request still sends: ${text}`);
    }
    assert.equal((wireJson.match(/repeated notice body/g) ?? []).length, 2, 'both duplicate copies reach the wire');
    assert.equal(wire.input.at(-1).type, 'compaction_trigger');
    // Decode the checkpoint to verify what the retained copy actually holds.
    const record = runtime.decodeCheckpoint(result.envelope, lease.binding);
    const retainedTexts = record.items
      .filter(i => i.role)
      .map(i => typeof i.content === 'string' ? i.content : (i.content ?? []).map(p => p.text ?? '').join(''));
    // R1 §E ambiguity fallback: a text whose source is ambiguous is never dropped.
    assert.equal(retainedTexts.filter(t => t.includes('shared instruction body')).length, 2,
      'ambiguous same-text sources fall back conservatively (both copies kept)');
    // R1 §E provable duplicate: exactly the newest host-notice copy survives.
    assert.equal(retainedTexts.filter(t => t.includes('repeated notice body')).length, 1,
      'a provable host-notice duplicate leaves only one retained copy');
    assert.ok(retainedTexts.some(t => t.includes('one-off notice')), 'non-duplicate notice kept');
    assert.ok(retainedTexts.some(t => t.includes('final tail')), 'user tail kept');
    // The opaque native state is carried through unchanged, never rewritten.
    assert.equal(record.items.find(item => item.type === 'compaction')?.encrypted_content,
      'opaque-native-payload-not-a-secret');
  } finally { lease.close(); }
});
