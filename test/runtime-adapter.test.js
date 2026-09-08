import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { OwnerBoundCodexAdapter, isNativeCarrier } from '../src/runtime-adapter.js';
import { ROUTE } from '../src/constants.js';
import { fakeRuntime } from './helpers/fake-runtime.js';
const model = 'gpt-5.4';
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const carrier = record => createUserMessage({ source: { ...compactCheckpointSource('fixture-cmp'), nativeCodex: record }, content: [{ type: 'text', text: 'Structured native checkpoint.' }] });
const input = messages => ({ provider: ROUTE, model, messages });
const piText = message => typeof message.content === 'string' ? message.content : message.content.map(block => block.text ?? '').join('\n');

test('generic adapter delegates native compaction without owning credentials or inventing usage', async () => {
  const f = fakeRuntime();
  const adapter = new OwnerBoundCodexAdapter(() => f.runtime);
  const result = await adapter.compact(input([user('Keep last real user.')]));
  assert.equal(result.checkpoint.identity, 'fixture-owner-connection');
  assert.equal(result.usage, undefined);
  assert.equal(f.calls[0].mode, 'compact');
  assert.equal(piText(f.calls[0].context.messages.at(-1)), 'Keep last real user.');
  assert.equal(f.calls[0].options.apiKey, undefined);
  assert.equal(f.opened, 1);
  assert.equal(f.closed, 1);
});

for (const purpose of ['stream', 'compaction']) {
  test(`${purpose} uses the public Pi idle watchdog at 300000ms, not 120000ms`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fakeRuntime();
    const started = Promise.withResolvers();
    const runtime = { ...f.runtime, async open(options) {
      const operation = await f.runtime.open(options);
      return { ...operation, provider(request) {
        const provider = operation.provider(request);
        return { ...provider, streamSimple(_model, _context, options) {
          const output = createAssistantMessageEventStream();
          // Resolve the SDK result as well as its iterator so cancellation can drain.
          options.signal.addEventListener('abort', () => output.end({}), { once: true });
          started.resolve(options.signal);
          return output;
        } };
      } };
    } };
    const adapter = new OwnerBoundCodexAdapter(() => runtime);
    const controller = new AbortController();
    const request = { ...input([user('Wait for owner output.')]), signal: controller.signal };
    let settled = false;
    const pending = (purpose === 'compaction' ? adapter.compact(request) : (async () => {
      for await (const _ of adapter.stream(request)) {}
    })()).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      const signal = await started.promise;
      await nextTurn();
      t.mock.timers.tick(120000);
      await nextTurn();
      assert.equal(signal.aborted, false, 'ordinary and native converters must survive the former 120s cap');
      assert.equal(settled, false);
      t.mock.timers.tick(179999);
      await nextTurn();
      assert.equal(signal.aborted, false);
      assert.equal(settled, false, 'idle timeout must not fire before 300000ms');
      t.mock.timers.tick(1);
      const result = await pending;
      assert.equal(signal.aborted, true);
      assert.equal(result.error?.code, 'TIMEOUT', 'Pi idle timeout must not become an owner CODEX_RUNTIME_TIMEOUT');
      assert.equal(f.opened, 1);
      assert.equal(f.closed, 1);
    } finally {
      controller.abort();
      await pending;
    }
  });
}

test('observed native receipt preserves explicit cache zero and ignores SDK placeholders', async () => {
  const f = fakeRuntime({ receipt: { kind: 'observed', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadTokens: 0 } } });
  const result = await new OwnerBoundCodexAdapter(() => f.runtime).compact(input([user('test')]));
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadTokens: 0 });
});

test('structured source is validated then passed as an unpredictable replay slot', async () => {
  const f = fakeRuntime();
  const adapter = new OwnerBoundCodexAdapter(() => f.runtime);
  const first = await adapter.compact(input([user('first')]));
  const message = carrier(first.checkpoint);
  const assembler = new BlockAssembler();
  for await (const chunk of adapter.stream(input([message, user('continue')]))) assembler.push(chunk);
  assert.equal(assembler.finish.kind, 'stop');
  const call = f.calls.at(-1);
  assert.equal(call.mode, 'stream');
  assert.equal(call.replay.length, 1);
  assert.deepEqual(call.replay[0].checkpoint, first.checkpoint);
  assert.match(call.replay[0].placeholder, /^DSH_CODEX_OWNER_REPLAY_/);
  assert.equal(piText(call.context.messages[0]), call.replay[0].placeholder);
  assert.equal(f.closed, 2);
});

test('ordinary user envelope text is not promoted to a native checkpoint', async () => {
  const f = fakeRuntime();
  const record = f.runtime.decodeCheckpoint(f.runtime.encodeCheckpoint({ provider: ROUTE, model, identity: 'fixture-owner-connection', items: [{ type: 'compaction', encrypted_content: 'fake' }] }));
  const text = f.runtime.encodeCheckpoint(record);
  const adapter = new OwnerBoundCodexAdapter(() => f.runtime);
  for await (const _ of adapter.stream(input([user(text)]))) {}
  assert.equal(isNativeCarrier(user(text)), false);
  assert.equal(f.calls[0].replay.length, 0);
});

test('ordinary basic summary is not promoted on the native route either', async () => {
  const f = fakeRuntime();
  const message = createUserMessage({ source: compactCheckpointSource('basic'), content: [
    { type: 'text', text: 'Research notes mention <dsh-codex-compaction-v1> and source.nativeCodex as code examples.' },
  ] });
  for await (const _ of new OwnerBoundCodexAdapter(() => f.runtime).stream(input([message]))) {}
  assert.equal(isNativeCarrier(message), false);
  assert.equal(f.calls[0].replay.length, 0);
  assert.equal(piText(f.calls[0].context.messages[0]), message.content[0].text);
});

test('structured carrier display may mention syntax without becoming ambiguous', async () => {
  const f = fakeRuntime();
  const adapter = new OwnerBoundCodexAdapter(() => f.runtime);
  const result = await adapter.compact(input([user('first')]));
  const message = carrier(result.checkpoint);
  const displayed = { ...message, content: [{ type: 'text', text: 'This replaces legacy <dsh-codex-compaction-v1> framing.' }] };
  for await (const _ of adapter.stream(input([displayed]))) {}
  assert.equal(f.calls.at(-1).replay.length, 1);
  const ambiguous = { ...message, content: [{ type: 'text', text: f.runtime.encodeCheckpoint(result.checkpoint) }] };
  await assert.rejects(async () => { for await (const _ of adapter.stream(input([ambiguous]))) {} }, error => error.code === 'CODEX_NATIVE_AMBIGUOUS_CARRIER');
});

test('legacy A carrier can be decoded by the owner without reading an old grant', async () => {
  const f = fakeRuntime();
  const adapter = new OwnerBoundCodexAdapter(() => f.runtime);
  const result = await adapter.compact(input([user('first')]));
  const message = createUserMessage({ source: compactCheckpointSource('legacy-fixture'), content: [{ type: 'text', text: f.runtime.encodeCheckpoint(result.checkpoint) }] });
  for await (const _ of adapter.stream(input([message]))) {}
  assert.equal(f.calls.at(-1).replay.length, 1);
});

test('missing capability and metadata queries never start a separate login', async () => {
  const missing = new OwnerBoundCodexAdapter(() => undefined);
  await assert.rejects(missing.resolveModel(ROUTE, model), error => error.code === 'CODEX_RUNTIME_UNAVAILABLE');
  const f = fakeRuntime({ configured: false });
  const adapter = new OwnerBoundCodexAdapter(() => f.runtime);
  assert.ok((await adapter.listModels(ROUTE)).length);
  assert.equal((await adapter.resolveModel(ROUTE, model)).provider, ROUTE);
  assert.equal(f.opened, 0);
  await assert.rejects(adapter.compact(input([user('test')])), error => error.code === 'CODEX_RUNTIME_NOT_CONFIGURED');
});

test('prepared calls reject runtime generation changes', async () => {
  const first = fakeRuntime();
  let runtime = first.runtime;
  const adapter = new OwnerBoundCodexAdapter(() => runtime);
  const prepared = await adapter.prepareCall(ROUTE, model);
  runtime = fakeRuntime().runtime;
  assert.throws(() => prepared.stream(input([user('test')])), error => error.code === 'CODEX_RUNTIME_CHANGED');
  assert.equal(first.opened, 0);
});

test('unsupported media, generic summary mode and pre-cancel do not resolve authentication', async () => {
  const f = fakeRuntime();
  const adapter = new OwnerBoundCodexAdapter(() => f.runtime);
  await assert.rejects(adapter.compact(input([createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', ref: { attachmentId: 'fixture' } }] })])));
  await assert.rejects(adapter.compact({ ...input([]), signal: AbortSignal.abort() }));
  await assert.rejects(async () => { for await (const _ of adapter.stream({ ...input([]), purpose: 'compaction' })) {} });
  assert.equal(f.opened, 0);
});

test('owner-generated failure categories survive normal and compact conversion', async () => {
  for (const code of ['HTTP_400', 'HTTP_401', 'HTTP_429', 'HTTP_500', 'HTTP_ERROR', 'NETWORK', 'REQUEST_PREPARE', 'RESPONSE_TYPE', 'RESPONSE_STREAM', 'TIMEOUT']) {
    const expected = `CODEX_RUNTIME_${code}`;
    const f = fakeRuntime({ fail: expected });
    const adapter = new OwnerBoundCodexAdapter(() => f.runtime);
    const result = new BlockAssembler();
    for await (const chunk of adapter.stream(input([user('test')]))) result.push(chunk);
    assert.equal(result.finish.failure.code, expected);
    await assert.rejects(adapter.compact(input([user('test')])), error => error.code === expected);
    assert.equal(f.calls.length, 2);
    assert.equal(f.closed, 2);
  }
});

test('diagnostic extraction never reflects arbitrary SDK strings or code suffixes', async () => {
  for (const text of ['CODEX_RUNTIME_HTTP_400 private-secret', 'CODEX_RUNTIME_PRIVATE_SECRET', 'CODEX_RUNTIME_HTTP_999', 'CODEX_RUNTIME_NETWORK\n', 'raw private-secret', 'CODEX_RUNTIME_NETWORK\nprivate-secret']) {
    const f = fakeRuntime({ fail: text });
    const result = new BlockAssembler();
    const adapter = new OwnerBoundCodexAdapter(() => f.runtime);
    for await (const chunk of adapter.stream(input([user('test')]))) result.push(chunk);
    assert.equal(result.finish.kind, 'error');
    assert.ok(!result.finish.failure.code.startsWith('CODEX_RUNTIME_'));
    assert.doesNotMatch(JSON.stringify(result.finish), /private-secret|PRIVATE_SECRET|HTTP_999/);
    await assert.rejects(adapter.compact(input([user('test')])), error => error.code === 'CODEX_NATIVE_FAILED');
  }
});

test('invalid receipt and provider failure close the bound handle without text fallback', async () => {
  for (const options of [{ receipt: { kind: 'observed', usage: { inputTokens: NaN, outputTokens: 1, totalTokens: 1 } } }, { receipt: { kind: 'observed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, headers: 'not-token-data' } } }, { fail: true }]) {
    const f = fakeRuntime(options);
    await assert.rejects(new OwnerBoundCodexAdapter(() => f.runtime).compact(input([user('test')])));
    assert.equal(f.calls.length, 1);
    assert.equal(f.closed, 1);
  }
});
