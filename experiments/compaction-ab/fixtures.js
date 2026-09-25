// Controlled engineering fixtures. Never authenticate or call a real endpoint.
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { Context, Service, Llm, Sessions, Projections, Meter, BlockAssembler, createUserMessage, createAssistantMessage, createToolResultMessage, freezeMessage } from './a-host.js';
import * as ABackend from './a-baseline/compaction.js';
import { CodexLabAdapter } from './a-baseline/provider.js';
import { encodeCheckpoint, decodeCheckpoint } from './a-baseline/checkpoint.js';
import { tokenIdentity } from './a-baseline/auth.js';
import { ROUTE } from './a-baseline/constants.js';
import { StructuredCompactionEngine, readStructuredCheckpoint, measureEffective } from './b-backend.js';
import { isCompactCheckpointSource } from './b-host.js';

export const MODEL = 'gpt-5.4';
export const VARIANTS = ['A-basic', 'B-matched-price', 'B-native-estimate'];
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
export const TEXT_PREFIX = '<dsh-codex-compaction-v1>';
const fixed = (message, id) => freezeMessage({ ...message, id });
export const user = (text, id) => fixed(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), id);
const assistant = (content, id) => fixed(createAssistantMessage({ source: { provider: ROUTE, model: MODEL }, content }), id);
export const expected = identity => ({ provider: ROUTE, model: MODEL, identity });
const bodyText = (family, size) => (family === 'cjk' ? '保留准确路径和任务约束，不重启宿主。' : 'Historical analysis: verified fixture file; keep pending work. ').repeat(Math.ceil(size / (family === 'cjk' ? 10 : 30))).slice(0, size);

export function appendWork(session, { family = 'ascii', bulkChars = 16000, label = 'round' } = {}) {
  const turn = session.seq;
  session.append('request/header', { header: { config: { provider: ROUTE, model: MODEL },
    ...(family === 'tool' ? { tools: [{ name: 'read_file', description: 'Read a synthetic fixture', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] } : {}) }, reason: session.requestHeader() ? 'change' : 'initial' });
  session.append('turn/start', { turn });
  session.append('user/message', user('Do not restart DSH. Preserve /fixture/source.ts and pending validation.', `${label}-user`), { surfaceOp: 'append' });
  session.append('step/start', { turn, step: 1 });
  let toolCallSeq;
  if (family === 'tool') {
    const callId = `${label}-call`;
    const event = session.append('assistant/message', { turn, step: 1, stream: [], message: assistant([{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"/fixture/source.ts"}' }], `${label}-assistant`) }, { surfaceOp: 'append' });
    toolCallSeq = event.seq;
    session.append('tool/call', { turn, step: 1, callId, name: 'read_file', arguments: '{"path":"/fixture/source.ts"}' });
    const message = fixed(createToolResultMessage({ callId, content: [{ type: 'text', text: bodyText(family, bulkChars) }], isError: false }), `${label}-tool`);
    session.append('tool/result', { turn, step: 1, message }, { surfaceOp: 'append' });
  } else {
    session.append('assistant/message', { turn, step: 1, stream: [], message: assistant([{ type: 'text', text: bodyText(family, bulkChars) }], `${label}-assistant`) }, { surfaceOp: 'append' });
  }
  session.append('step/end', { turn, step: 1 });
  session.append('step/start', { turn, step: 2 });
  session.append('assistant/message', { turn, step: 2, stream: [], message: assistant([{ type: 'text', text: 'Latest tail: continue with validation.' }], `${label}-tail`) }, { surfaceOp: 'append' });
  session.append('step/end', { turn, step: 2 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  const nodes = [...session.surface.nodes];
  return { start: nodes[0], end: nodes.at(-2), tail: nodes.at(-1), toolCallSeq };
}

function fakeAuth(account) {
  const accessToken = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.fixture`;
  return { accessToken, ...tokenIdentity(accessToken) };
}
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
export class ControlledProvider {
  constructor({ cipherChars = 1024, onFetch, fail = false } = {}) {
    this.auth = fakeAuth('ab-fixture-account');
    this.cipherChars = cipherChars;
    this.onFetch = onFetch;
    this.fail = fail;
    this.requests = [];
    this.normalRequests = [];
    this.responses = [];
    this.adapter = new CodexLabAdapter({ provider: openaiCodexProvider(), auth: { resolve: async () => this.auth }, fetch: async (_url, init) => {
      const raw = typeof init.body === 'string' ? init.body : Buffer.from(new Headers(init.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body) : init.body).toString('utf8');
      const body = JSON.parse(raw);
      if (body.input.at(-1)?.type !== 'compaction_trigger') {
        this.normalRequests.push(body);
        return sse([
          { type: 'response.created', response: { id: 'resp-ab-normal' } },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-ab-normal', role: 'assistant', content: [] } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Synthetic continuation.' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-ab-normal', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic continuation.', annotations: [] }] } },
          { type: 'response.completed', response: { id: 'resp-ab-normal', status: 'completed', output: [] } },
        ]);
      }
      this.requests.push(body);
      await this.onFetch?.(body);
      if (this.fail) return new Response('synthetic provider failure', { status: 503 });
      const item = { type: 'compaction', id: `cmp-ab-${this.responses.length + 1}`, encrypted_content: 'A'.repeat(this.cipherChars), opaqueExtra: { nested: [0, false, '保留未知字段'] } };
      this.responses.push(item);
      return sse([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: `resp-ab-${this.responses.length}`, status: 'completed' } }]);
    } });
  }
  changeAccount() { this.auth = fakeAuth('different-ab-account'); }
  bridge(messages) {
    return messages.map(message => {
      const structured = readStructuredCheckpoint(message, expected(this.auth.identity));
      if (!structured) return message;
      return freezeMessage({ ...message, content: [{ type: 'text', text: encodeCheckpoint(structured) }] });
    });
  }
  async compact(input) {
    const result = await this.adapter.compact({ ...input, provider: ROUTE, model: MODEL, messages: this.bridge(input.messages) });
    this.lastCheckpoint = decodeCheckpoint(result.summary[0].text, expected(this.auth.identity));
    return this.invalidUsage ? { ...result, usage: { inputTokens: NaN } } : result;
  }
  async summarize(input, _agent, signal) {
    const result = await this.compact({ ...input, signal });
    return { ...decodeCheckpoint(result.summary[0].text, expected(this.auth.identity)), ...(result.usage === undefined ? {} : { usage: result.usage }) };
  }
  async normalReplay(input) {
    const assembler = new BlockAssembler();
    for await (const chunk of this.adapter.stream({ ...input, provider: ROUTE, model: MODEL, messages: this.bridge(input.messages) })) assembler.push(chunk);
    if (assembler.finish.kind !== 'stop' || assembler.blocks()[0]?.text !== 'Synthetic continuation.') throw new Error('Synthetic normal continuation did not traverse the provider adapter.');
    return { inputHash: hash(this.normalRequests.at(-1)), inputBytes: bytes(this.normalRequests.at(-1)) };
  }
  wireProjection(messages) {
    // Inspection projection, not a new provider request. Actual request hashes
    // in the matrix and restored rounds come from the real converter above.
    return messages.flatMap(message => {
      const structured = readStructuredCheckpoint(message, expected(this.auth.identity));
      if (structured) return structured.items;
      const text = message.content.find(block => block.type === 'text' && block.text.startsWith(TEXT_PREFIX));
      if (isCompactCheckpointSource(message.source) && text) return decodeCheckpoint(text.text, expected(this.auth.identity)).items;
      return [{ role: message.role, content: message.content, source: message.source.kind === 'model' ? { ...message.source, replayState: undefined } : message.source }];
    });
  }
}

export function nativeEstimate(checkpoint) {
  let total = 16;
  for (const item of checkpoint.items) {
    if (item.type === 'compaction') total += Math.ceil(Math.max(Math.floor(item.encrypted_content.length * 3 / 4) - 650, 0) / 4);
    else total += Math.ceil(JSON.stringify(item).length / 4);
  }
  return total;
}

export async function createFixture(variant, { priceCheckpoint = nativeEstimate, provider = new ControlledProvider(), sessionId = 'ab-session' } = {}) {
  const ctx = new Context();
  for (const module of [Llm, Sessions, Projections, Meter]) await ctx.plugin(module);
  class NativeService extends Service { constructor() { super(ctx, 'codexCompaction'); } compact(input) { return provider.compact(input); } }
  new NativeService();
  ctx.llm.registerAdapter([ROUTE], provider.adapter);
  if (variant === 'A-basic') await ctx.plugin(ABackend);
  else await ctx.plugin({ name: `ab-${variant}`, inject: ['llm', 'tokenMeter', 'sessions'], apply(child) {
    new StructuredCompactionEngine(child, { summarize: (input, agent, signal) => provider.summarize(input, agent, signal), priceCheckpoint });
  } });
  const session = ctx.sessions.create(sessionId);
  const agent = { ctx, session, options: { provider: ROUTE, model: MODEL }, runMaintenance: async callback => callback(new AbortController().signal) };
  return { ctx, agent, provider, variant, priceCheckpoint, engine: ctx.compaction, dispose: () => ctx.fiber.dispose(),
    measurement() {
      const host = ctx.tokenMeter.measure(agent.session);
      if (variant === 'A-basic') return { hostTokens: host.totalTokens, effectiveTokens: host.totalTokens, nodes: host.nodes.map(n => ({ seq: n.seq, hostTokens: n.tokens, effectiveTokens: n.tokens })) };
      return measureEffective(agent.session, ctx.tokenMeter, priceCheckpoint);
    } };
}

export function outcome(error) {
  if (!error) return null;
  const codes = [];
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) if (e.code) codes.push(e.code);
  return { name: error.name, codes, message: String(error.message).slice(0, 200) };
}
