import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Context, Service } from '@deepseek-ai/cordis';
import Llm, { LlmAdapter, BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import Commands from '@deepseek-ai/dsh-commands';
import Sessions from '@deepseek-ai/dsh-session';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import * as providerEntry from '../src/provider-entry.js';
import * as policy from '../src/index.js';
import { fakeRuntime } from './helpers/fake-runtime.js';
import { ROUTE, STANDARD_ROUTE } from '../src/constants.js';
import { CODEC_PREFIX, isNativeCarrier } from '../src/runtime-adapter.js';
import { BASIC_INSTRUCTION_FIRST_LINE, basicInstructionTail, blocksCarryNativeEnvelope } from '../src/native-checkpoint.js';
import { isRecoverableNativeFailure } from '../src/native-seam.js';

const ASTRA = { id: 'gpt-6-astra', contextWindow: 872000, maxTokens: 128000 };
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const instruction = () => createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
  content: [{ type: 'text', text: `${BASIC_INSTRUCTION_FIRST_LINE}\n\n(remaining pinned instruction body)` }] });
// Faithful official basic framing of a native summary block.
const framed = envelope => createUserMessage({ source: compactCheckpointSource('fixture-compaction'),
  content: [
    { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.\n\n<compacted-summary>' },
    { type: 'text', text: envelope },
    { type: 'text', text: '</compacted-summary>' },
  ] });
const committed = blocks => blocks[0].text;
const collect = async stream => {
  const assembler = new BlockAssembler();
  for await (const chunk of stream) assembler.push(chunk);
  return assembler;
};
// Middleware rejection can surface synchronously from llm.stream(); wrap it.
const attempt = (ctx, options) => (async () => collect(ctx.llm.stream(options)))();

async function fixture(t, { runtimeOptions = {}, profileNative, withOwner = true, prepOrder, withSessions = false, withPolicy = false } = {}) {
  const ctx = new Context();
  const hostCalls = [];
  for (const plugin of [Llm, Commands, ...(withSessions ? [Sessions] : [])]) await ctx.plugin(plugin);
  class HostRoute extends LlmAdapter {
    async *stream(options) {
      hostCalls.push(options);
      const text = '## Primary Request and Intent\n- host text summary';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter([STANDARD_ROUTE], new HostRoute());
  await ctx.plugin(providerEntry, profileNative === undefined ? undefined : { nativeCompaction: profileNative });
  if (withPolicy) {
    class Presets extends Service {
      constructor() { super(ctx, 'agentPresets'); }
      copy() {} read() {} resolve() {} serviceFor() { return undefined; }
    }
    new Presets();
  }
  const fake = fakeRuntime(runtimeOptions);
  if (withOwner) {
    await ctx.plugin({ name: 'fixture-owner', apply(owner) {
      // Mirrors the account plugin: capability provided first, its own
      // llm/stream preparation middleware registered in the same apply.
      owner.provide('codexRuntime', fake.runtime);
      owner.on('llm/stream', (options, next) => (async function* preparation() {
        prepOrder?.push('account-prep');
        yield* next();
      })());
    } });
  }
  if (withPolicy) await ctx.plugin(policy);
  t.after(() => ctx.fiber.dispose());
  return { ctx, fake, hostCalls, enable(session = 's1', mode = 'on') { ctx.codexBridge.setNativePreference(session, mode); } };
}

const compactRequest = (messages, { model = 'gpt-6-astra', session = 's1', provider = STANDARD_ROUTE } = {}) =>
  ({ provider, model, sessionId: session, purpose: 'compaction', messages });

test('pinned instruction line matches the installed official basic package', async () => {
  const source = await readFile(new URL('../node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js', import.meta.url), 'utf8');
  const captured = source.match(/"(You are now acting as a compaction engine[^"]*)"/)?.[1];
  assert.ok(captured, 'stock instruction present in the installed package');
  assert.equal(BASIC_INSTRUCTION_FIRST_LINE.startsWith(captured), true);
});

test('native takeover returns the owner codec envelope as the basic summary block', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA], receipt: { kind: 'observed', usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140, cacheReadTokens: 40 } } } });
  f.enable();
  const assembler = await collect(f.ctx.llm.stream(compactRequest([user('first real work'), user('second real work'), instruction()])));
  assert.equal(f.hostCalls.length, 0, 'host adapter bypassed');
  assert.equal(f.fake.calls[0].mode, 'compact');
  assert.equal(f.fake.calls.length, 1, 'exactly one native request');
  const blocks = assembler.blocks();
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].text.startsWith(`${CODEC_PREFIX}-v1>`), 'owner versioned envelope returned to basic');
  assert.ok(blocks[0].text.endsWith('</dsh-codex-compaction-v1>'));
  assert.deepEqual(assembler.usage, { inputTokens: 120, outputTokens: 20, totalTokens: 140, cacheReadTokens: 40 });
  const attemptRecord = f.ctx.codexBridge.nativePreferenceStatus('s1').lastAttempt;
  assert.equal(attemptRecord.kind, 'native');
  assert.equal(attemptRecord.outcome, 'native');
  assert.equal(attemptRecord.model, 'gpt-6-astra');
});

test('the stock basic instruction tail is stripped and never sent to the native compact request', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  f.enable();
  await collect(f.ctx.llm.stream(compactRequest([user('keep last real user'), instruction()])));
  const sent = f.fake.calls[0].context.messages;
  const text = message => typeof message.content === 'string' ? message.content : message.content.map(block => block.text ?? '').join('');
  assert.equal(sent.length, 1);
  assert.equal(text(sent.at(-1)), 'keep last real user');
});

test('account preparation middleware runs before the seam short-circuits', async t => {
  const prepOrder = [];
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] }, prepOrder });
  f.enable();
  await collect(f.ctx.llm.stream(compactRequest([user('work'), instruction()])));
  assert.deepEqual(prepOrder, ['account-prep']);
  await collect(f.ctx.llm.stream({ provider: STANDARD_ROUTE, model: 'gpt-6-astra', sessionId: 's1', messages: [user('ordinary')] }));
  assert.deepEqual(prepOrder, ['account-prep', 'account-prep']);
  assert.equal(f.hostCalls.length, 1, 'ordinary call still reaches the host adapter after preparation');
});

test('committed basic-native checkpoint round-trips through the reader', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  f.enable();
  const assembler = await collect(f.ctx.llm.stream(compactRequest([user('first'), instruction()])));
  const message = framed(committed(assembler.blocks()));
  assert.equal(isNativeCarrier(message), true);
  const record = f.ctx.codexBridge.readCheckpoint(message);
  assert.equal(record.model, 'gpt-6-astra');
  assert.equal(record.identity, 'fixture-owner-connection');
  // A second native summarization replays it as an opaque checkpoint slot.
  const assembler2 = await collect(f.ctx.llm.stream(compactRequest([message, user('later'), instruction()])));
  assert.ok(assembler2.blocks()[0].text.startsWith(CODEC_PREFIX));
  assert.equal(f.fake.calls.at(-1).mode, 'compact');
  assert.equal(f.fake.calls.at(-1).replay.length, 1);
  assert.equal(blocksCarryNativeEnvelope(assembler2.blocks()), true);
});

test('ordinary quotes and text summaries never become native state', () => {
  const quoted = createUserMessage({ source: compactCheckpointSource('text-summary'), content: [
    { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.\n\n<compacted-summary>' },
    { type: 'text', text: 'Notes: the codec uses `<dsh-codex-compaction-v1>` markers inline. This is documentation prose, not a complete block.' },
    { type: 'text', text: '</compacted-summary>' },
  ] });
  assert.equal(isNativeCarrier(quoted), false);
  assert.equal(basicInstructionTail(user('You are now acting as…')), false, 'a real user message is never treated as the instruction tail');
  assert.equal(basicInstructionTail(instruction()), true);
});

test('envelope-shaped garbage on a checkpoint source fails closed', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  const garbage = framed(`${CODEC_PREFIX}-v1>not valid json</dsh-codex-compaction-v1>`);
  assert.equal(isNativeCarrier(garbage), true, 'prefix detection stays strict');
  assert.throws(() => f.ctx.codexBridge.readCheckpoint(garbage), error => /CODEX|CHECKPOINT|JSON/.test(error.code ?? error.message));
});

test('recoverable native failure falls back once, inside the same owner lease', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA], fail: 'CODEX_RUNTIME_HTTP_503', failMode: 'once' } });
  f.enable();
  const assembler = await collect(f.ctx.llm.stream(compactRequest([user('work'), instruction()])));
  assert.equal(f.fake.calls.length, 2, 'one native attempt plus one text fallback');
  assert.equal(f.fake.calls[0].mode, 'compact');
  assert.equal(f.fake.calls[1].mode, 'stream', 'fallback is plain text through the account lease');
  const fallbackText = f.fake.calls[1].context.messages.at(-1)?.content;
  const tailSent = (typeof fallbackText === 'string' ? fallbackText : (fallbackText ?? []).map(part => part.text ?? '').join('')).startsWith(BASIC_INSTRUCTION_FIRST_LINE);
  assert.equal(tailSent, true, 'fallback keeps the stock instruction tail');
  assert.equal(f.hostCalls.length, 0, 'the original host route is never re-walked for the fallback');
  assert.equal(f.fake.calls[1].identity, f.fake.calls[0].identity, 'same account binding across both attempts');
  assert.equal(assembler.blocks()[0].text, 'fixture continued');
  const recorded = f.ctx.codexBridge.nativePreferenceStatus('s1').lastAttempt;
  assert.equal(recorded.kind, 'fallback');
  assert.equal(recorded.cause, 'CODEX_RUNTIME_HTTP_503');
});

test('a connection rotated between attempts can never substitute for the fallback account', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA], fail: 'CODEX_RUNTIME_HTTP_503', failMode: 'once', rotateIdentityOnFailure: 'account-b' } });
  f.enable();
  const assembler = await collect(f.ctx.llm.stream(compactRequest([user('work'), instruction()])));
  assert.equal(f.fake.calls[0].identity, 'fixture-owner-connection', 'native attempt started on account A');
  assert.equal(f.fake.state.currentIdentity, 'account-b', 'the current connection rotated to B after the failure');
  assert.equal(f.fake.calls[1].identity, 'fixture-owner-connection', 'the second real fetch still runs under the A-bound lease');
  assert.equal(f.hostCalls.length, 0, 'no fetch through unknown current credentials');
  assert.equal(assembler.blocks()[0].text, 'fixture continued');
});

test('client HTTP and auth failures no longer count as recoverable', () => {
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CODEX_RUNTIME_HTTP_401' })), false);
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CODEX_RUNTIME_HTTP_429' })), false);
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CODEX_RUNTIME_AUTH_FAILED' })), false);
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CODEX_RUNTIME_HTTP_ERROR' })), false);
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CODEX_RUNTIME_HTTP_503' })), true);
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CODEX_RUNTIME_NETWORK' })), true);
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CODEX_RUNTIME_TIMEOUT' })), true);
});

test('identity mismatch, bad checkpoints and cancellation never fall back', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  f.enable();
  const first = await collect(f.ctx.llm.stream(compactRequest([user('first'), instruction()])));
  const message = framed(committed(first.blocks()));
  const moved = await fixture(t, { runtimeOptions: { customModels: [ASTRA], identity: 'another-account' } });
  moved.enable();
  await assert.rejects(
    attempt(moved.ctx, compactRequest([message, user('later'), instruction()])),
    error => /CHECKPOINT_IDENTITY|CODEX_RUNTIME/.test(error?.code ?? error?.failure?.code ?? ''),
  );
  assert.equal(moved.hostCalls.length, 0, 'no text fallback after an identity failure');
  assert.equal(moved.fake.calls.length, 0, 'no second native request');
  const cancelled = AbortSignal.abort();
  await assert.rejects(
    attempt(f.ctx, { ...compactRequest([user('x'), instruction()]), signal: cancelled }),
    () => true,
  );
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CODEX_NATIVE_INVALID_RESULT' })), false);
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CHECKPOINT_IDENTITY' })), false);
  assert.equal(isRecoverableNativeFailure(Object.assign(new Error('x'), { code: 'CODEX_RUNTIME_UNKNOWN_MODEL' })), false);
});

test('carrier histories never fall back to text even on recoverable native failure', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA], fail: 'CODEX_RUNTIME_HTTP_503', failMode: 'once' } });
  f.enable();
  const seeded = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  seeded.enable();
  const first = await collect(seeded.ctx.llm.stream(compactRequest([user('first'), instruction()])));
  const message = framed(committed(first.blocks()));
  await assert.rejects(attempt(f.ctx, compactRequest([message, user('later'), instruction()])), () => true);
  assert.equal(f.hostCalls.length, 0, 'carriers never reach the plain adapter through a fallback');
  const recorded = f.ctx.codexBridge.nativePreferenceStatus('s1').lastAttempt;
  assert.equal(recorded.kind, 'native');
  assert.equal(recorded.outcome, 'failed');
});

test('carrier histories fail closed on every guard branch, never the plain adapter', async t => {
  // R0-1 regression: with a valid native carrier in the compacted region, the
  // inapplicable-gate, unrecognized-tail and lease-failure branches must all
  // reject explicitly; only a no-carrier history may continue to next().
  const envelopeOf = async () => {
    const seeded = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
    seeded.enable();
    const first = await collect(seeded.ctx.llm.stream(compactRequest([user('first'), instruction()])));
    return framed(committed(first.blocks()));
  };
  const carrier = await envelopeOf();

  const inapplicable = await fixture(t, { runtimeOptions: { customModels: [ASTRA], applicable: false, applicabilityReason: 'ROUTE_ENDPOINT' } });
  inapplicable.enable();
  await assert.rejects(
    attempt(inapplicable.ctx, compactRequest([carrier, user('later'), instruction()])),
    error => error.code === 'CODEX_NATIVE_REPLAY_UNAVAILABLE' && /ROUTE_ENDPOINT/.test(error.message),
  );
  assert.equal(inapplicable.hostCalls.length, 0);

  const unrecognized = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  unrecognized.enable();
  await assert.rejects(
    attempt(unrecognized.ctx, compactRequest([carrier, user('later'), user('a plain last user message')])),
    error => error.code === 'CODEX_NATIVE_READER_REQUIRED',
  );
  assert.equal(unrecognized.hostCalls.length, 0);

  const leaseless = await fixture(t, { runtimeOptions: { customModels: [ASTRA], configured: false, applicable: true } });
  leaseless.enable();
  await assert.rejects(
    attempt(leaseless.ctx, compactRequest([carrier, user('later'), instruction()])),
    error => error.code === 'CODEX_NATIVE_REPLAY_UNAVAILABLE',
  );
  assert.equal(leaseless.hostCalls.length, 0);
  assert.equal(leaseless.fake.calls.length, 0);

  // No-carrier histories keep the original path on the same branches.
  const plain = await fixture(t, { runtimeOptions: { customModels: [ASTRA], applicable: false, applicabilityReason: 'ROUTE_ENDPOINT' } });
  plain.enable();
  const assembler = await collect(plain.ctx.llm.stream(compactRequest([user('work'), instruction()])));
  assert.equal(plain.hostCalls.length, 1);
  assert.ok(assembler.blocks()[0].text.startsWith('## Primary Request'));
});

test('ordinary calls with native carriers replay natively; the host adapter never sees opaque state', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  f.enable();
  const first = await collect(f.ctx.llm.stream(compactRequest([user('first'), instruction()])));
  const message = framed(committed(first.blocks()));
  const hostBefore = f.hostCalls.length;
  const assembler = await collect(f.ctx.llm.stream({ provider: STANDARD_ROUTE, model: 'gpt-6-astra', sessionId: 's1', messages: [message, user('continue')] }));
  assert.equal(f.hostCalls.length, hostBefore, 'plain adapter bypassed for carrier history');
  assert.equal(f.fake.calls.at(-1).mode, 'stream');
  assert.equal(f.fake.calls.at(-1).replay.length, 1);
  assert.ok(assembler.blocks().length >= 1);
});

test('carrier history is never summarized through the plain adapter while native is off', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  f.enable();
  const first = await collect(f.ctx.llm.stream(compactRequest([user('first'), instruction()])));
  const message = framed(committed(first.blocks()));
  f.enable('s1', 'off');
  await assert.rejects(
    attempt(f.ctx, compactRequest([message, user('later'), instruction()])),
    error => error.code === 'CODEX_NATIVE_READER_REQUIRED',
  );
  assert.equal(f.hostCalls.length, 0);
  // OFF stops new native creation only; existing native state still replays
  // through its matching reader rather than the plain adapter.
  const replayed = await attempt(f.ctx, { provider: STANDARD_ROUTE, model: 'gpt-6-astra', sessionId: 's1', messages: [message, user('continue')] });
  assert.equal(replayed.blocks().length, 1);
  assert.equal(f.fake.calls.at(-1).mode, 'stream');
  assert.equal(f.hostCalls.length, 0, 'the plain adapter never receives opaque state');
});

test('image histories stay on the original path and are reported, never taken over', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  f.enable();
  const imageHistory = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', ref: { attachmentId: 'fixture' } }] });
  const assembler = await collect(f.ctx.llm.stream(compactRequest([imageHistory, user('look at this'), instruction()])));
  assert.equal(f.fake.calls.length, 0, 'native never opened');
  assert.equal(f.hostCalls.length, 1, 'original basic path preserved');
  assert.ok(assembler.blocks()[0].text.startsWith('## Primary Request'));
  const recorded = f.ctx.codexBridge.nativePreferenceStatus('s1').lastAttempt;
  assert.equal(recorded.kind, 'none');
  assert.equal(recorded.reason, 'images-present');
});

test('carriers plus unsupported media are rejected explicitly, not dropped or faked', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  f.enable();
  const first = await collect(f.ctx.llm.stream(compactRequest([user('first'), instruction()])));
  const message = framed(committed(first.blocks()));
  const imageHistory = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', ref: { attachmentId: 'fixture' } }] });
  await assert.rejects(
    attempt(f.ctx, compactRequest([message, imageHistory, instruction()])),
    error => error.code === 'CODEX_NATIVE_TEXT_ONLY',
  );
  await assert.rejects(
    attempt(f.ctx, { provider: STANDARD_ROUTE, model: 'gpt-6-astra', sessionId: 's1', messages: [message, imageHistory] }),
    error => error.code === 'CODEX_NATIVE_TEXT_ONLY',
  );
  assert.equal(f.hostCalls.length, 0);
});

test('inapplicable route or model stays untouched and records the concrete reason', async t => {
  const inapplicable = await fixture(t, { runtimeOptions: { customModels: [ASTRA], applicable: false, applicabilityReason: 'ROUTE_ENDPOINT' } });
  inapplicable.enable();
  await collect(inapplicable.ctx.llm.stream(compactRequest([user('work'), instruction()])));
  assert.equal(inapplicable.hostCalls.length, 1);
  assert.equal(inapplicable.fake.calls.length, 0);
  assert.equal(inapplicable.ctx.codexBridge.nativePreferenceStatus('s1').lastAttempt.reason, 'inapplicable:ROUTE_ENDPOINT');

  const unknown = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  unknown.enable();
  await collect(unknown.ctx.llm.stream(compactRequest([user('work'), instruction()], { model: 'gpt-nonexistent' })));
  assert.equal(unknown.hostCalls.length, 1);
  assert.equal(unknown.ctx.codexBridge.nativePreferenceStatus('s1').lastAttempt.reason, 'inapplicable:UNKNOWN_MODEL');
});

test('an unrecognized tail is not intercepted even while native is enabled', async t => {
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  f.enable();
  await collect(f.ctx.llm.stream(compactRequest([user('plain last message')])));
  assert.equal(f.fake.calls.length, 0);
  assert.equal(f.hostCalls.length, 1);
  assert.equal(f.ctx.codexBridge.nativePreferenceStatus('s1').lastAttempt.reason, 'instruction-tail-unrecognized');
});

test('native preference defaults off and /codex-native controls per-session inheritance', async t => {
  const off = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  await collect(off.ctx.llm.stream(compactRequest([user('work'), instruction()])));
  assert.equal(off.fake.calls.length, 0, 'no takeover without explicit preference');
  assert.equal(off.hostCalls.length, 1);
  assert.equal(off.ctx.codexBridge.nativePreferenceStatus('s1').effective, false);

  const profile = await fixture(t, { runtimeOptions: { customModels: [ASTRA] }, profileNative: true });
  await collect(profile.ctx.llm.stream(compactRequest([user('work'), instruction()])));
  assert.equal(profile.fake.calls.length, 1, 'profile default enables takeover');
  profile.ctx.codexBridge.setNativePreference('s1', 'off');
  await collect(profile.ctx.llm.stream(compactRequest([user('more'), instruction()], { session: 's1' })));
  assert.equal(profile.fake.calls.length, 1, 'session off overrides profile on');
  const status = profile.ctx.codexBridge.nativePreferenceStatus('s1');
  assert.equal(status.session, 'off');
  assert.equal(status.profile, true);
  assert.equal(status.effective, false);
  profile.ctx.codexBridge.setNativePreference('s1', 'inherit');
  assert.equal(profile.ctx.codexBridge.nativePreferenceStatus('s1').effective, true);
  // Preferences are never silently evicted into profile inheritance.
  profile.ctx.codexBridge.setNativePreference('other', 'off');
  for (let i = 0; i < 5000; i++) profile.ctx.codexBridge.nativeState.recordAttempt(`bulk-${i}`, { kind: 'none', reason: 'bulk' });
  assert.equal(profile.ctx.codexBridge.nativePreferenceStatus('other').session, 'off');
});

test('provider config surface stays closed and legacy route registration survives', async t => {
  await assert.rejects(fixture(t, { profileNative: 'yes' }), error => error.code === 'CODEX_NATIVE_CONFIG');
  const f = await fixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  assert.ok(f.ctx.llm.listProviders().some(p => p.id === ROUTE), 'legacy lab route still registered');
  assert.ok(f.ctx.llm.listProviders().some(p => p.id === STANDARD_ROUTE), 'host route untouched');
});

test('without the account capability carriers fail closed and ordinary calls proceed', async t => {
  const f = await fixture(t, { withOwner: false });
  await collect(f.ctx.llm.stream({ provider: STANDARD_ROUTE, model: 'anything', sessionId: 's1', messages: [user('ordinary')] }));
  assert.equal(f.hostCalls.length, 1);
  const stale = framed('<dsh-codex-compaction-v1>{"version":1}</dsh-codex-compaction-v1>');
  await assert.rejects(
    attempt(f.ctx, { provider: STANDARD_ROUTE, model: 'anything', sessionId: 's1', messages: [stale] }),
    error => error.code === 'CODEX_NATIVE_READER_UNAVAILABLE',
  );
  assert.equal(f.hostCalls.length, 1);
});

test('policy commands report attempt versus committed state through the bridge', async t => {
  const ctx = new Context();
  for (const plugin of [Llm, Commands]) await ctx.plugin(plugin);
  await ctx.plugin(providerEntry);
  const fake = fakeRuntime({ customModels: [ASTRA] });
  class Presets extends Service {
    constructor() { super(ctx, 'agentPresets'); }
    copy() {} read() {} resolve() {}
    serviceFor() { return { config: { auto: true }, compactIfNeeded() {} }; }
  }
  new Presets();
  await ctx.plugin({ name: 'fixture-owner', apply(owner) { owner.provide('codexRuntime', fake.runtime); } });
  const policyFiber = await ctx.plugin(policy);
  t.after(() => ctx.fiber.dispose());
  const agent = { session: { id: 's1', seq: 0, eventAt: () => null, snapshotEvents: () => [], requestHeader: () => ({ config: { provider: STANDARD_ROUTE, model: 'gpt-6-astra' } }) }, options: { provider: STANDARD_ROUTE, model: 'gpt-6-astra' } };
  const native = ctx.commands.find(agent, 'codex-native');
  const turnedOn = await native.handler({ agent, rawInput: 'on', signal: new AbortController().signal });
  assert.match(turnedOn.text, /Effective: ON/);
  assert.match(turnedOn.text, /resolved context 872000/);
  const status = await native.handler({ agent, rawInput: 'status', signal: new AbortController().signal });
  assert.match(status.text, /ready/);
  assert.match(status.text, /none yet/);
  const badUsage = await native.handler({ agent, rawInput: 'bogus', signal: new AbortController().signal });
  assert.equal(badUsage.kind, 'error');
  const context = await ctx.commands.find(agent, 'codex-context').handler({ agent, rawInput: '', signal: new AbortController().signal });
  assert.match(context.text, /Basic automatic compaction: on/);
  assert.match(context.text, /Native preference: effective ON/);
  assert.match(context.text, /no observed compaction yet/);
  await policyFiber.dispose();
});

// ---- Restart survival: the persisted host command log is the only durable store ----
// The host refuses session logs containing unknown event types that are not
// marked ignorable, and the public append API cannot mark them, so no plugin
// event type may ever enter the log. Recovery therefore reads only the
// host-written command/run + command/done lifecycle events.

async function commandFixture(t, options = {}) {
  const f = await fixture(t, { withSessions: true, withPolicy: true, ...options });
  const session = f.ctx.sessions.create();
  const signal = new AbortController().signal;
  const agent = { ctx: f.ctx, session, options: { provider: STANDARD_ROUTE, model: 'gpt-6-astra' }, runMaintenance: async action => action(signal) };
  return { ...f, agent, signal, command: async line => f.ctx.commands.execute(agent, line, [], signal) };
}

test('native session preference survives a restart through persisted public command events', async t => {
  const f = await commandFixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  const applied = await f.command('/codex-native on');
  assert.equal(applied.result.kind, 'success');
  const restored = f.ctx.sessions.create(undefined, { seed: JSON.parse(JSON.stringify(f.agent.session.snapshotEvents())) });
  const assembler = await collect(f.ctx.llm.stream(compactRequest([user('work'), instruction()], { session: restored.id })));
  assert.equal(f.hostCalls.length, 0, 'recovered ON still drove the native takeover for the restored session');
  assert.equal(f.fake.calls[0].mode, 'compact');
  assert.ok(assembler.blocks()[0].text.startsWith(CODEC_PREFIX));
  const status = f.ctx.codexBridge.nativePreferenceStatus(restored.id);
  assert.equal(status.session, 'on');
  assert.equal(status.effective, true);
});

test('persisted off stays off after restart even when the profile default is on', async t => {
  const f = await commandFixture(t, { runtimeOptions: { customModels: [ASTRA] }, profileNative: true });
  const applied = await f.command('/codex-native off');
  assert.equal(applied.result.kind, 'success');
  const restored = f.ctx.sessions.create(undefined, { seed: JSON.parse(JSON.stringify(f.agent.session.snapshotEvents())) });
  await collect(f.ctx.llm.stream(compactRequest([user('work'), instruction()], { session: restored.id })));
  assert.equal(f.hostCalls.length, 1, 'recovered OFF kept the original path despite the profile default');
  assert.equal(f.fake.calls.length, 0);
  const status = f.ctx.codexBridge.nativePreferenceStatus(restored.id);
  assert.equal(status.session, 'off');
  assert.equal(status.effective, false);
});

test('failed and status-only invocations never become persisted preference', async t => {
  const f = await commandFixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  assert.equal((await f.command('/codex-native bogus')).result.kind, 'error');
  assert.equal((await f.command('/codex-native status')).result.kind, 'success');
  const restored = f.ctx.sessions.create(undefined, { seed: JSON.parse(JSON.stringify(f.agent.session.snapshotEvents())) });
  await collect(f.ctx.llm.stream(compactRequest([user('work'), instruction()], { session: restored.id })));
  assert.equal(f.hostCalls.length, 1, 'no takeover without a persisted preference');
  assert.equal(f.fake.calls.length, 0);
  const status = f.ctx.codexBridge.nativePreferenceStatus(restored.id);
  assert.equal(status.session, 'inherit');
  assert.equal(status.effective, false);
});

test('a later inherit clears a persisted on and returns to the profile default', async t => {
  const f = await commandFixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  assert.equal((await f.command('/codex-native on')).result.kind, 'success');
  assert.equal((await f.command('/codex-native inherit')).result.kind, 'success');
  const restored = f.ctx.sessions.create(undefined, { seed: JSON.parse(JSON.stringify(f.agent.session.snapshotEvents())) });
  await collect(f.ctx.llm.stream(compactRequest([user('work'), instruction()], { session: restored.id })));
  assert.equal(f.hostCalls.length, 1, 'inherit restored the profile default, not the older on');
  assert.equal(f.fake.calls.length, 0);
  const status = f.ctx.codexBridge.nativePreferenceStatus(restored.id);
  assert.equal(status.session, 'inherit');
  assert.equal(status.effective, false);
});

test('an unpaired command/run is not a committed preference', async t => {
  const f = await commandFixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  const orphan = f.ctx.sessions.create();
  orphan.append('command/run', { commandId: 'cmd-orphan', name: 'codex-native', args: 'on', source: { kind: 'user' } });
  const status = f.ctx.codexBridge.nativePreferenceStatus(orphan.id);
  assert.equal(status.session, 'inherit', 'a crashed preference command never applied');
  assert.equal(status.effective, false);
});

test('a cancelled ON commits no live preference and diverges from nothing after restore', async t => {
  // R0-2 regression: cancellation during the command's async probe must leave
  // the live state equal to the recovered command log (done=error is ignored
  // by recovery), even when the probe swallows the cancellation and returns.
  const f = await commandFixture(t, { runtimeOptions: { customModels: [ASTRA] } });
  const cancellation = new AbortController();
  f.fake.runtime.applicability = async () => { cancellation.abort(); return { applicable: true, model: { contextWindow: 872000 } }; };
  await assert.rejects(
    f.ctx.commands.execute(f.agent, '/codex-native on', [], cancellation.signal),
    error => error.name === 'AbortError' || error.code === 'CODEX_RUNTIME_CANCELLED',
  );
  const done = f.agent.session.snapshotEvents().findLast(event => event.type === 'command/done');
  assert.equal(done?.data.kind, 'error');
  const now = f.ctx.codexBridge.nativePreferenceStatus(f.agent.session.id);
  assert.equal(now.effective, false, 'a cancelled ON must not enable native');
  assert.equal(now.session, 'inherit');
  const restored = f.ctx.sessions.create(undefined, { seed: JSON.parse(JSON.stringify(f.agent.session.snapshotEvents())) });
  const after = f.ctx.codexBridge.nativePreferenceStatus(restored.id);
  assert.equal(after.effective, now.effective, 'cancelled command must not diverge across restoration');
  assert.equal(after.session, now.session);
});
