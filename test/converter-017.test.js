import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { OwnerBoundCodexAdapter, resolvedOwnerProfile } from '../src/runtime-adapter.js';
import { fakeRuntime } from './helpers/fake-runtime.js';
import { user } from './helpers/engine.js';
const target = { provider: 'openai-codex', model: 'gpt-5.4' };
const consume = async stream => { const a = new BlockAssembler(); for await (const c of stream) a.push(c); return a; };
async function fixture(options) {
  const fake = fakeRuntime(options);
  const operation = await fake.runtime.open({ model: target.model });
  const provider = operation.provider({ mode: 'stream', replay: [] });
  const bridge = new OwnerBoundCodexAdapter(() => fake.runtime);
  return { fake, operation, provider, bridge };
}
test('0.1.7 real converter resolves legal model and prepareCall streams successfully, maxRetries=0', async () => {
  const f = await fixture();
  try {
    const converter = f.bridge.converter(f.provider);
    assert.equal((await converter.resolveModel(target.provider, target.model)).id, target.model);
    assert.equal(converter.providerRetryPolicy(target.provider).maxRetries, 0);
    const call = await converter.prepareCall(target.provider, target.model);
    const a = await consume(call.stream({ ...target, messages: [user('hello')] }));
    assert.equal(a.finish.kind, 'stop'); assert.equal(f.fake.calls.length, 1);
  } finally { f.operation.close(); }
});
test('modelErrors diagnostics reject INVALID_CONFIG before any transport call', async () => {
  const f = await fixture();
  try {
    const converter = f.bridge.converter(f.provider, { modelErrors: new Map([[target.model, 'synthetic invalid model']]) });
    assert.throws(() => converter.prepareCall(target.provider, target.model), { code: 'INVALID_CONFIG' });
    await assert.rejects(consume(converter.stream({ ...target, messages: [user('x')] })), { code: 'INVALID_CONFIG' });
    assert.equal(f.fake.calls.length, 0);
  } finally { f.operation.close(); }
});
test('unknown model refuses both prepareCall and stream with zero sends', async () => {
  const f = await fixture();
  try {
    const converter = f.bridge.converter(f.provider);
    assert.throws(() => converter.prepareCall(target.provider, 'not-in-catalog'), { code: 'UNKNOWN_MODEL' });
    await assert.rejects(consume(converter.stream({ ...target, model: 'not-in-catalog', messages: [user('x')] })));
    assert.equal(f.fake.calls.length, 0);
  } finally { f.operation.close(); }
});
test('negative control: exact pre-fix missing-modelErrors profile fails the legal-model assertion', async () => {
  const f = await fixture();
  try {
    const profile = resolvedOwnerProfile(f.provider, f.bridge.retry);
    for (const field of ['streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes']) assert.ok(Number.isFinite(profile[field]) && profile[field] > 0);
    assert.ok(profile.modelErrors instanceof Map); assert.ok(profile.configuredMaxTokens instanceof Map);
    delete profile.modelErrors;
    const old = new PiAiAdapter({ profiles: () => new Map([[target.provider, profile]]), resolveApiKey: async () => undefined,
      auth: { credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw Error('no writes'); }, delete: async () => {} }, authContext: { env: async () => undefined, fileExists: async () => false } } });
    assert.throws(() => old.prepareCall(target.provider, target.model), TypeError);
    assert.equal(f.fake.calls.length, 0);
  } finally { f.operation.close(); }
});
test('prepareCall terminal provider error is preserved without retries', async () => {
  const f = await fixture({ fail: 'CODEX_RUNTIME_NETWORK' });
  try {
    const converter = f.bridge.converter(f.provider);
    const call = await converter.prepareCall(target.provider, target.model);
    assert.equal((await consume(call.stream({ ...target, messages: [user('x')] }))).finish.kind, 'error');
    assert.equal(f.fake.calls.length, 1);
  } finally { f.operation.close(); }
});
for (const kind of ['cancel', 'idle']) test(`real prepared converter ${kind} settles and aborts fake transport`, async () => {
  const f = await fixture();
  const started = Promise.withResolvers();
  let calls = 0;
  const provider = { ...f.provider, streamSimple(_model, _context, options) {
    calls++;
    const stream = createAssistantMessageEventStream();
    options.signal.addEventListener('abort', () => stream.end({}), { once: true });
    started.resolve(options.signal);
    return stream;
  } };
  const controller = new AbortController();
  try {
    const converter = f.bridge.converter(provider, { streamIdleTimeoutMs: 25 });
    const call = await converter.prepareCall(target.provider, target.model);
    const done = consume(call.stream({ ...target, messages: [user('x')], signal: controller.signal })).then(value => ({ value }), error => ({ error }));
    const transportSignal = await started.promise;
    if (kind === 'cancel') controller.abort(new Error('synthetic cancellation'));
    const result = await done;
    assert.equal(transportSignal.aborted, true);
    assert.equal(calls, 1);
    if (kind === 'idle') assert.equal(result.error?.code, 'TIMEOUT');
    else assert.ok(result.error || result.value.finish.kind === 'aborted');
  } finally { controller.abort(); f.operation.close(); }
});
