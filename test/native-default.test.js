import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { NativeSessionState } from '../src/native-seam.js';
import * as nativePolicy from '../src/native-policy.js';
import { CodexRuntimeBridge } from '../src/runtime-service.js';
import { engineFixture, user } from './helpers/engine.js';

test('native policy row accepts only { nativeDefault: boolean } and publishes a frozen resolver', () => {
  const provide = [];
  const ctx = { provide: (name, value) => provide.push([name, value]) };
  nativePolicy.apply(ctx, { nativeDefault: true });
  nativePolicy.apply(ctx, {});
  assert.equal(provide.length, 2);
  const [name, value] = provide[0];
  assert.equal(name, 'codexNativePolicy');
  assert.equal(Object.isFrozen(value), true);
  assert.equal(value.presetNativeDefault(), true);
  assert.equal(provide[1][1].presetNativeDefault(), false, 'an absent flag defaults the preset to Basic');
  assert.throws(() => nativePolicy.apply(ctx, { nativeDefault: 'yes' }), /nativeDefault\?: boolean, efficiencyGuard\?: boolean \| object/);
  assert.throws(() => nativePolicy.apply(ctx, { nativeDefault: true, extra: 1 }), /nativeDefault\?: boolean, efficiencyGuard\?: boolean \| object/);
});

test('preference resolution: explicit session value beats preset default; inherit follows it', () => {
  const state = new NativeSessionState(false, undefined, { now: () => 0, delay: async () => {} });
  // Standard preset default (false): inherit/unset stays Basic.
  assert.equal(state.effective('s', false), false);
  assert.equal(state.sessionPreference('s'), 'inherit');
  // Native preset default: inherit and never-set become native ON, including
  // sessions created before the preset default existed.
  assert.equal(state.effective('old-session', true), true);
  // Explicit values override either default.
  state.setSession('a', 'off', { presetNative: true });
  assert.equal(state.effective('a', true), false);
  state.setSession('b', 'on', { presetNative: false });
  assert.equal(state.effective('b', false), true);
  state.setSession('c', 'reader-text', { presetNative: false });
  assert.equal(state.sessionPreference('c'), 'reader-text');
  assert.equal(state.effective('c', false), true);
  // inherit drops back to the preset default.
  state.setSession('b', 'inherit', { presetNative: true });
  assert.equal(state.effective('b', true), true);
});

test('status separates capability, preset default, session preference and effective', () => {
  const state = new NativeSessionState(false, undefined, { now: () => 0, delay: async () => {} });
  const status = state.nativeStatus('s', { presetNative: true, capability: true });
  assert.deepEqual(
    { capability: status.capability, preset: status.preset, session: status.session, effective: status.effective, summarizationMode: status.summarizationMode },
    { capability: true, preset: true, session: 'inherit', effective: true, summarizationMode: 'native' });
  const disabled = state.nativeStatus('s', { presetNative: true, capability: false });
  assert.equal(disabled.capability, false);
  assert.equal(disabled.effective, false, 'the global capability gate turns native off regardless of preference');
  state.setSession('s', 'off', { presetNative: true, capability: true });
  assert.equal(state.nativeStatus('s', { presetNative: true }).effective, false);
});

test('bridge resolves the preset default per agent and never from the root bridge alone', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const nativeAgent = { id: 'native' };
  const standardAgent = { id: 'standard' };
  ctx.provide('agentPresets', {
    serviceFor: (agent, service) => (service === 'codexNativePolicy' && agent === nativeAgent ? { presetNativeDefault: () => true } : undefined),
  });
  const bridge = new CodexRuntimeBridge(ctx, () => { throw new Error('unused'); }, { profileNative: false });
  assert.equal(bridge.presetNativeDefault(nativeAgent), true);
  assert.equal(bridge.presetNativeDefault(standardAgent), false);
  const status = await bridge.nativePreferenceStatus(nativeAgent, 's');
  assert.equal(status.preset, true);
  assert.equal(status.effective, true);
  const standardStatus = await bridge.nativePreferenceStatus(standardAgent, 's');
  assert.equal(standardStatus.preset, false);
  assert.equal(standardStatus.effective, false, 'a standard preset session stays Basic even while the root bridge exists');
});

test('engine: inherit on the Native preset summarizes natively; absent policy keeps Basic', async t => {
  const native = await engineFixture(t, { presetNative: true });
  const nativeResult = await native.summarize();
  assert.match(nativeResult.summary[0].text, /^<dsh-codex-compaction-v1>/);
  assert.equal(native.hostCalls.length, 0);
  assert.equal(native.fake.calls.length, 1);

  const standard = await engineFixture(t, {});
  const standardResult = await standard.summarize();
  assert.equal(standardResult.summary[0].text, 'host summary');
  assert.equal(standardResult.llmStreamCall, true);
  assert.equal(standard.fake.calls.length, 0, 'no policy row means the preset default stays Basic');
});

test('engine: explicit OFF beats the preset default; explicit ON beats a Basic preset default', async t => {
  const off = await engineFixture(t, { presetNative: true });
  off.enable('off');
  const offResult = await off.summarize();
  assert.equal(offResult.summary[0].text, 'host summary');
  assert.equal(off.fake.calls.length, 0);

  const on = await engineFixture(t, {});
  on.enable('on');
  const onResult = await on.summarize();
  assert.match(onResult.summary[0].text, /^<dsh-codex-compaction-v1>/);
  assert.equal(on.hostCalls.length, 0);
});

test('engine: capability disabled keeps Basic even with the preset default ON', async t => {
  const f = await engineFixture(t, { presetNative: true, capability: false });
  const result = await f.summarize();
  assert.equal(result.summary[0].text, 'host summary');
  assert.equal(f.fake.calls.length, 0);
});

test('carrier readability reports presence and the replay gate without history writes', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const bridge = new CodexRuntimeBridge(ctx, () => { throw new Error('unused'); }, {});
  bridge.nativeApplicability = async model => (model === 'ok' ? { applicable: true } : { applicable: false, reason: 'NOT_CONFIGURED' });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
  const session = {
    deriveMessages: () => messages,
    requestHeader: () => ({ config: { provider: 'openai-codex', model: 'ok' } }),
  };
  assert.deepEqual(await bridge.carrierReadability(session, {}, undefined), { kind: 'absent', carriers: 0 });
  messages.push({ role: 'user', source: compactCheckpointSource('test'), content: [{ type: 'text', text: '<dsh-codex-compaction-v1>opaque' }] });
  assert.deepEqual(await bridge.carrierReadability(session, {}, undefined), { kind: 'present', carriers: 1, readable: true });
  session.requestHeader = () => ({ config: { provider: 'openai-codex', model: 'bad' } });
  assert.deepEqual(await bridge.carrierReadability(session, {}, undefined), { kind: 'present', carriers: 1, readable: false, reason: 'NOT_CONFIGURED' });
});
