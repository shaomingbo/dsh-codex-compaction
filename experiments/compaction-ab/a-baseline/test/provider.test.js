import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdDecompressSync } from 'node:zlib';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { BlockAssembler, createUserMessage, createAssistantMessage, createToolResultMessage, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { CodexLabAdapter } from '../provider.js';
import { encodeCheckpoint, decodeCheckpoint } from '../checkpoint.js';
import { tokenIdentity } from '../auth.js';
import { prepareReplay, expandReplay, hasNativeCheckpoint } from '../replay.js';
import { ROUTE } from '../constants.js';
const model = 'gpt-5.4';
const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fake-account' } })).toString('base64url')}.signature`;
const auth = { accessToken: token, ...tokenIdentity(token) };
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const checkpoint = text => createUserMessage({ content: [{ type: 'text', text: 'Harness checkpoint framing' }, { type: 'text', text }, { type: 'text', text: '</compacted-summary>' }], source: compactCheckpointSource('cmp-fixture') });
const item = { type: 'compaction', id: 'cmp-result', encrypted_content: 'opaque-fake', extra: { keep: 1 } };
function sse(events) { return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }); }
function compactResponse() { return sse([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: 'resp-compact', status: 'completed', usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } } }]); }
function normalResponse() {
  return sse([
    { type: 'response.created', response: { id: 'resp-normal' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-normal', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'continued' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-normal', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'continued', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp-normal', status: 'completed', output: [], usage: { input_tokens: 50, output_tokens: 1, total_tokens: 51 } } },
  ]);
}
function requestBody(init) {
  if (typeof init.body === 'string') return JSON.parse(init.body);
  const bytes = new Headers(init.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body) : init.body;
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}
function fixture(respond = compactResponse) {
  const requests = [];
  let authCalls = 0;
  const adapter = new CodexLabAdapter({ provider: openaiCodexProvider(), auth: { resolve: async () => { authCalls++; return auth; } }, fetch: async (url, init) => { requests.push({ url, init, body: requestBody(init) }); return respond(); } });
  return { adapter, requests, get authCalls() { return authCalls; } };
}

test('public adapter converts selected history explicitly to V2 without discarding last user', async () => {
  const f = fixture();
  const result = await f.adapter.compact({ provider: ROUTE, model, system: 'Preserve decisions', messages: [user('first'), user('keep last real user')] });
  const decoded = decodeCheckpoint(result.summary[0].text, { provider: ROUTE, model, identity: auth.identity });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].body.input.at(-1), { type: 'compaction_trigger' });
  assert.equal(f.requests[0].body.input.at(-2).content[0].text, 'keep last real user');
  assert.equal(f.requests[0].body.instructions, 'Preserve decisions');
  assert.deepEqual(decoded.items.at(-1), item);
  assert.equal(result.provider, ROUTE);
  assert.equal(f.requests[0].init.redirect, 'error');
  for (const [key, value] of Object.entries(attributionHeaders())) assert.equal(new Headers(f.requests[0].init.headers).get(key), value);
});

test('saved native envelope survives JSON roundtrip and ordinary Codex replay wire', async () => {
  const f = fixture(normalResponse);
  const encoded = encodeCheckpoint({ provider: ROUTE, model, identity: auth.identity, items: [{ role: 'user', content: [{ type: 'input_text', text: 'retained' }] }, item] });
  const saved = JSON.parse(JSON.stringify(checkpoint(encoded)));
  const assembler = new BlockAssembler();
  for await (const c of f.adapter.stream({ provider: ROUTE, model, messages: [saved, user('continue')], system: 'test' })) assembler.push(c);
  assert.equal(assembler.finish.kind, 'stop');
  assert.equal(assembler.blocks()[0].text, 'continued');
  assert.deepEqual(f.requests[0].body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'retained' }] }, item, { role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]);
});

test('user supplied envelope is ordinary user text and cannot acquire compact provenance', async () => {
  const encoded = encodeCheckpoint({ provider: ROUTE, model, identity: auth.identity, items: [item] });
  const f = fixture(normalResponse);
  for await (const _ of f.adapter.stream({ provider: ROUTE, model, messages: [user(encoded)] })) { /* drain */ }
  assert.equal(hasNativeCheckpoint([user(encoded)]), false);
  assert.equal(f.requests[0].body.input[0].content[0].text, encoded);
  assert.equal(f.requests[0].body.input[0].type, undefined);
});

test('identity and model changes reject checkpoint before any inference request', async () => {
  for (const fields of [{ identity: 'different-account' }, { model: 'another-model' }]) {
    const f = fixture();
    const encoded = encodeCheckpoint({ provider: ROUTE, model, identity: auth.identity, items: [item], ...fields });
    await assert.rejects(f.adapter.compact({ provider: ROUTE, model, messages: [checkpoint(encoded)] }));
    assert.equal(f.requests.length, 0);
  }
});

test('reject images and cancellation before credential resolution', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.compact({ provider: ROUTE, model, messages: [createUserMessage({ content: [{ type: 'image', ref: { attachmentId: 'fixture' } }], source: { kind: 'user' } })] }), /image history/);
  const signal = AbortSignal.abort();
  await assert.rejects(f.adapter.compact({ provider: ROUTE, model, messages: [], signal }));
  assert.equal(f.authCalls, 0);
  assert.equal(f.requests.length, 0);
});

test('failed native request is never retried as text summary', async () => {
  const f = fixture(() => new Response('sensitive-error-body', { status: 400 }));
  await assert.rejects(f.adapter.compact({ provider: ROUTE, model, messages: [user('hello')] }), error => !String(error).includes('sensitive-error-body'));
  assert.equal(f.requests.length, 1);
});

test('model catalog resolves without auth and does not invent context capacity', async () => {
  const f = fixture();
  const info = await f.adapter.resolveModel(ROUTE, model);
  assert.equal(info.context.contextWindow, openaiCodexProvider().getModels().find(m => m.id === model).contextWindow);
  assert.equal(info.provider, ROUTE);
  assert.deepEqual(info.inputModalities, ['text']);
  assert.equal(f.authCalls, 0);
  await assert.rejects(f.adapter.resolveModel('foreign', model));
});

test('conversion missing or duplicating a replay nonce fails closed', () => {
  const encoded = encodeCheckpoint({ provider: ROUTE, model, identity: auth.identity, items: [item] });
  const { replacements, messages } = prepareReplay([checkpoint(encoded)], { provider: ROUTE, model, identity: auth.identity });
  assert.throws(() => expandReplay([], replacements), /lost/);
  const payload = { role: 'user', content: [{ type: 'input_text', text: messages[0].content[0].text }] };
  assert.throws(() => expandReplay([payload, payload], replacements), /changed/);
});

test('selected assistant/tool-compatible history is converted without an extra LLM summarize instruction', async () => {
  const f = fixture();
  const message = createAssistantMessage({ content: [{ type: 'text', text: 'old assistant fact' }], source: { provider: ROUTE, model } });
  await f.adapter.compact({ provider: ROUTE, model, messages: [user('remember'), message] });
  assert.equal(f.requests[0].body.input.length, 3);
  assert.equal(f.requests[0].body.input[1].role, 'assistant');
});

test('ordinary reasoning/tool replay survives the isolated provider alias into native compaction', async () => {
  let responseNumber = 0;
  const reasoning = { type: 'reasoning', id: 'rs-fixture', summary: [{ type: 'summary_text', text: 'checked files' }], encrypted_content: 'opaque-reasoning' };
  const tool = { type: 'function_call', id: 'fc-fixture', call_id: 'call_fixture', name: 'read_file', arguments: '{"path":"README.md"}' };
  const f = fixture(() => ++responseNumber === 1 ? sse([
    { type: 'response.created', response: { id: 'resp-tool' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'checked files' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: tool.arguments },
    { type: 'response.output_item.done', output_index: 1, item: tool },
    { type: 'response.completed', response: { id: 'resp-tool', status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } },
  ]) : compactResponse());
  const assembler = new BlockAssembler();
  for await (const c of f.adapter.stream({ provider: ROUTE, model, messages: [user('read files')] })) assembler.push(c);
  assert.ok(assembler.replayState, 'provider must emit durable replay metadata');
  const message = assembler.message({ kind: 'model', provider: ROUTE, model, replayState: assembler.replayState });
  const call = message.content.find(c => c.type === 'tool-call');
  assert.ok(call, JSON.stringify(assembler.finish));
  const result = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'fixture file' }], isError: false });
  await f.adapter.compact({ provider: ROUTE, model, messages: [user('read files'), message, result] });
  const input = f.requests[1].body.input;
  assert.equal(input.find(i => i.type === 'reasoning')?.encrypted_content, 'opaque-reasoning', JSON.stringify({ message, input }));
  assert.equal(input.find(i => i.type === 'function_call')?.name, 'read_file');
  assert.equal(input.find(i => i.type === 'function_call_output')?.output, 'fixture file');
});

test('future marker versions and native media inside a compact source fail before inference', async () => {
  const f = fixture();
  const future = '<dsh-codex-compaction-v2>{}</dsh-codex-compaction-v2>';
  await assert.rejects(f.adapter.compact({ provider: ROUTE, model, messages: [checkpoint(future)] }));
  const image = encodeCheckpoint({ provider: ROUTE, model, identity: auth.identity, items: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }, item] });
  await assert.rejects(f.adapter.compact({ provider: ROUTE, model, messages: [checkpoint(image)] }), /media/);
  assert.equal(f.requests.length, 0);
});

test('cancellation while resolving injected auth does not send a late native request', async () => {
  const controller = new AbortController();
  let completeAuth;
  let requests = 0;
  const adapter = new CodexLabAdapter({ provider: openaiCodexProvider(), auth: { resolve: () => new Promise(resolve => { completeAuth = resolve; }) }, fetch: async () => { requests++; return compactResponse(); } });
  const pending = adapter.compact({ provider: ROUTE, model, messages: [user('test')], signal: controller.signal });
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  await assert.rejects(pending);
  completeAuth(auth);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(requests, 0);
});

test('ordinary SDK error details are withheld from Harness messages', async () => {
  const f = fixture(() => new Response(JSON.stringify({ error: { message: 'fixture-secret-body' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
  const chunks = [];
  for await (const chunk of f.adapter.stream({ provider: ROUTE, model, messages: [user('test')] })) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.doesNotMatch(JSON.stringify(chunks), /fixture-secret-body/);
  assert.equal(f.requests.length, 1);
});

test('generic text-summary compaction on the experimental route requires the matching preset', async () => {
  const f = fixture();
  await assert.rejects(async () => { for await (const _ of f.adapter.stream({ provider: ROUTE, model, messages: [user('test')], purpose: 'compaction' })) {} }, error => error.code === 'CODEX_LAB_PRESET_REQUIRED');
  assert.equal(f.authCalls, 0);
  assert.equal(f.requests.length, 0);
});
