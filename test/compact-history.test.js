import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Llm, { LlmAdapter, BlockAssembler, createAssistantMessage, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import * as providerEntry from '../src/provider-entry.js';
import { fakeRuntime } from './helpers/fake-runtime.js';
import { assistantStopReason, sanitizeCompactHistory } from '../src/compact-history.js';
import { BASIC_INSTRUCTION_FIRST_LINE, basicInstructionTail } from '../src/native-checkpoint.js';
import { ROUTE, STANDARD_ROUTE } from '../src/constants.js';
import { engineFixture } from './helpers/engine.js';

const MODEL = 'gpt-6-astra';
const replay = (stopReason, blockTypes, extras = {}) => ({
  response: {
    kind: 'pi-ai', version: extras.version ?? 2, api: 'openai-codex-responses',
    provider: extras.provider ?? 'openai-codex', model: extras.model ?? MODEL, stopReason,
    ...(extras.responseId !== undefined ? { responseId: extras.responseId } : {}),
    ...(extras.responseModel !== undefined ? { responseModel: extras.responseModel } : {}),
  },
  blocks: blockTypes.map(type => ({ type })),
});
const assistant = ({ text, tools = [], stopReason, extraContent = [], replayVersion = 2, sourceProvider = 'openai-codex', replayExtras = {} }) => {
  const content = [
    ...(text ? [{ type: 'text', text }] : []),
    ...tools.map(tool => ({ type: 'tool-call', id: tool.id, name: tool.name ?? 'read_file', arguments: tool.arguments ?? '{}' })),
    ...extraContent,
  ];
  const blockTypes = content.map(block => block.type === 'reasoning' ? 'reasoning' : block.type === 'tool-call' ? 'tool-call' : 'text');
  return createAssistantMessage({
    source: { provider: sourceProvider, model: MODEL, ...(stopReason ? { replayState: replay(stopReason, blockTypes, { version: replayVersion, ...replayExtras }) } : {}) },
    content,
  });
};

test('real user text that quotes compaction markers is never treated as the Basic instruction', () => {
  const quoted = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `${BASIC_INSTRUCTION_FIRST_LINE}\n<dsh-codex-compaction-v1>not-a-checkpoint</dsh-codex-compaction-v1>\n<compacted-summary>` }] });
  assert.equal(basicInstructionTail(quoted), false);
  const kept = sanitizeCompactHistory([quoted]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].content[0].text.includes(BASIC_INSTRUCTION_FIRST_LINE), true);
});

test('cancelled assistant partial text survives and is not wrapped into one user dump', () => {
  const history = [
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep BIZ-USER-1 and <conversation> tags exactly.' }] }),
    assistant({ text: 'Partial BIZ-CANCEL-TEXT before abort.', stopReason: 'aborted' }),
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after cancel.' }] }),
  ];
  const sanitized = sanitizeCompactHistory(history);
  assert.equal(sanitized.length, 3);
  assert.equal(assistantStopReason(sanitized[1]), undefined);
  assert.equal(sanitized[1].role, 'assistant');
  assert.equal(sanitized[1].content[0].text.includes('BIZ-CANCEL-TEXT'), true);
  assert.equal(sanitized.some(message => message.role === 'user' && JSON.stringify(message).includes('BIZ-CANCEL-TEXT') && JSON.stringify(message).includes('BIZ-USER-1')), false);
});

test('nested tool-result content is payload and does not create extra pairing ids', () => {
  const history = [
    assistant({
      text: 'Completed BIZ-NESTED-TEXT with a finished tool.',
      tools: [{ id: 'call-complete', name: 'read_file' }],
      stopReason: 'error',
    }),
    createToolResultMessage({
      callId: 'call-complete',
      content: [
        { type: 'text', text: 'BIZ-NESTED-OUTER' },
        { type: 'tool-result', toolCallId: 'nested-inner', content: [{ type: 'text', text: 'BIZ-NESTED-INNER' }], isError: false },
      ],
      isError: false,
    }),
  ];
  assert.throws(() => sanitizeCompactHistory(history), { code: 'CODEX_NATIVE_UNSAFE_HISTORY' });
});

test('failed assistant keeps completed text and paired tools, dropping only unpaired calls', () => {
  const history = [
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Investigate BIZ-USER-2.' }] }),
    assistant({
      text: 'Completed BIZ-FAIL-TEXT with a finished tool.',
      tools: [{ id: 'call-complete', name: 'read_file' }, { id: 'call-dangling', name: 'read_file' }],
      stopReason: 'error',
    }),
    createToolResultMessage({ callId: 'call-complete', content: [{ type: 'text', text: 'BIZ-TOOL-RESULT' }], isError: false }),
  ];
  const sanitized = sanitizeCompactHistory(history);
  const assistantMessage = sanitized.find(message => message.role === 'assistant');
  const calls = assistantMessage.content.filter(block => block.type === 'tool-call').map(block => block.id);
  assert.deepEqual(calls, ['call-complete']);
  assert.equal(assistantMessage.content.some(block => block.type === 'text' && block.text.includes('BIZ-FAIL-TEXT')), true);
  assert.equal(JSON.stringify(sanitized).includes('call-dangling'), false);
  assert.equal(JSON.stringify(sanitized).includes('BIZ-TOOL-RESULT'), true);
  assert.equal(assistantStopReason(assistantMessage), undefined);
});

test('an aborted turn with only an unpaired tool is omitted rather than forged successful', () => {
  const history = [
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'BIZ-USER-3' }] }),
    assistant({ tools: [{ id: 'call-never-finished' }], stopReason: 'aborted' }),
  ];
  const sanitized = sanitizeCompactHistory(history);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].role, 'user');
  assert.equal(JSON.stringify(sanitized).includes('call-never-finished'), false);
});

test('tool results without any surviving tool call fail closed', () => {
  const history = [
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'BIZ-USER-4' }] }),
    createToolResultMessage({ callId: 'call-orphan', content: [{ type: 'text', text: 'orphan' }], isError: true }),
  ];
  assert.throws(() => sanitizeCompactHistory(history), error => error.code === 'CODEX_NATIVE_UNSAFE_HISTORY');
});

test('successful unpaired tool calls fail closed instead of inventing a result', () => {
  const history = [
    assistant({ text: 'ok', tools: [{ id: 'call-open' }] }),
  ];
  assert.throws(() => sanitizeCompactHistory(history), error => error.code === 'CODEX_NATIVE_UNSAFE_HISTORY');
});

test('unsupported replay metadata is not stripped into a successful compact', () => {
  const broken = assistant({ text: 'Partial BIZ-BAD-REPLAY', stopReason: 'aborted', replayVersion: 999 });
  assert.throws(() => sanitizeCompactHistory([broken]), error => error.code === 'CODEX_NATIVE_REPLAY_INCOMPATIBLE');
});

test('a user message between a failed tool call and its result is rejected', () => {
  const history = [
    assistant({ text: 'BIZ-FAIL-TEXT', tools: [{ id: 'call-complete' }], stopReason: 'error' }),
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'interrupting user' }] }),
    createToolResultMessage({ callId: 'call-complete', content: [{ type: 'text', text: 'BIZ-TOOL-RESULT' }], isError: false }),
  ];
  assert.throws(() => sanitizeCompactHistory(history), error => error.code === 'CODEX_NATIVE_UNSAFE_HISTORY');
});

test('a later assistant tool call cannot start before prior calls have results', () => {
  const history = [
    assistant({ tools: [{ id: 'call-a' }], stopReason: 'error' }),
    assistant({ tools: [{ id: 'call-b' }], stopReason: 'error' }),
    createToolResultMessage({ callId: 'call-a', content: [{ type: 'text', text: 'A' }], isError: false }),
    createToolResultMessage({ callId: 'call-b', content: [{ type: 'text', text: 'B' }], isError: false }),
  ];
  assert.throws(() => sanitizeCompactHistory(history), error => error.code === 'CODEX_NATIVE_UNSAFE_HISTORY');
});

test('legacy lab source with native openai-codex replay remains compactable', () => {
  const generated = assistant({
    text: 'Legacy generated BIZ-LAB-REPLAY.',
    stopReason: 'stop',
    sourceProvider: ROUTE,
  });
  const sanitized = sanitizeCompactHistory([
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the lab session.' }] }),
    generated,
  ]);
  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[1].source.provider, 'openai-codex');
  assert.equal(sanitized[1].content[0].text.includes('BIZ-LAB-REPLAY'), true);
});

test('non-string optional replay ids fail closed instead of being stripped', () => {
  assert.throws(() => sanitizeCompactHistory([
    assistant({ text: 'bad id', stopReason: 'aborted', replayExtras: { responseId: 123 } }),
  ]), error => error.code === 'CODEX_NATIVE_REPLAY_INCOMPATIBLE');
  assert.throws(() => sanitizeCompactHistory([
    assistant({ text: 'bad model', stopReason: 'aborted', replayExtras: { responseModel: { invalid: true } } }),
  ]), error => error.code === 'CODEX_NATIVE_REPLAY_INCOMPATIBLE');
});

test('the standard compact seam keeps cancelled text and never wraps the transcript', async t => {
  const f = await engineFixture(t, { runtimeOptions: { customModels: [{ id: MODEL, contextWindow: 872000, maxTokens: 128000, input: ['text', 'image'] }] } });
  const { fake } = f;
  f.session.append('request/header', { header: { config: { provider: STANDARD_ROUTE, model: MODEL } }, reason: 'initial' });
  f.enable();
  const instruction = createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    content: [{ type: 'text', text: `${BASIC_INSTRUCTION_FIRST_LINE}\n\n(remaining pinned instruction body)` }] });
  await f.summarize([
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep BIZ-USER-SEAM and compaction_trigger in this user text.' }] }),
    assistant({ text: 'Partial BIZ-SEAM-CANCEL', stopReason: 'aborted' }),
  ]);
  const sent = fake.calls[0].context.messages;
  const texts = sent.map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(block => block.text ?? '').join('\n'));
  assert.equal(texts.some(text => text.includes('BIZ-USER-SEAM')), true);
  assert.equal(texts.some(text => text.includes('BIZ-SEAM-CANCEL')), true);
  assert.equal(texts.some(text => text.includes(BASIC_INSTRUCTION_FIRST_LINE)), false);
  assert.equal(texts.filter(text => text.includes('BIZ-USER-SEAM') && text.includes('BIZ-SEAM-CANCEL')).length, 0);
});

test('invalid replay fails closed on the compact seam without a native request', async t => {
  const f = await engineFixture(t, { runtimeOptions: { customModels: [{ id: MODEL, contextWindow: 872000, maxTokens: 128000, input: ['text', 'image'] }] } });
  const { fake } = f;
  f.session.append('request/header', { header: { config: { provider: STANDARD_ROUTE, model: MODEL } }, reason: 'initial' });
  f.enable();
  const broken = assistant({ text: 'Partial BIZ-BAD-REPLAY', stopReason: 'aborted', replayVersion: 999 });
  const instruction = createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    content: [{ type: 'text', text: `${BASIC_INSTRUCTION_FIRST_LINE}\n\n(remaining pinned instruction body)` }] });
  await assert.rejects(f.summarize([createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'BIZ-USER-SEAM' }] }), broken]), error => error.code === 'CODEX_NATIVE_REPLAY_INCOMPATIBLE');
  assert.equal(fake.calls.length, 0);
});
