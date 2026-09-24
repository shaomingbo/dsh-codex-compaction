import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import Llm, { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Meter from '@deepseek-ai/dsh-token-meter';
import Commands from '@deepseek-ai/dsh-commands';
import * as CompactCommand from '@deepseek-ai/dsh-command-compact';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import * as NativeCompaction from '../compaction.js';
import { CodexLabAdapter } from '../provider.js';
import { tokenIdentity } from '../auth.js';
import { ROUTE } from '../constants.js';

test('human /compact executes official lifecycle through native converter, then recompacts restored opaque state', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const module of [Llm, Sessions, Projections, Meter, Commands]) await ctx.plugin(module);
  const accessToken = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'pipeline-fixture' } })).toString('base64url')}.sig`;
  const auth = { accessToken, ...tokenIdentity(accessToken) };
  const requests = [];
  const adapter = new CodexLabAdapter({ provider: openaiCodexProvider(), auth: { resolve: async () => auth }, fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const events = [{ type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: `opaque-round-${requests.length}` } }, { type: 'response.completed', response: { status: 'completed', id: `response-${requests.length}` } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  ctx.llm.registerAdapter([ROUTE], adapter);
  class NativeService extends Service { constructor() { super(ctx, 'codexCompaction'); } compact(options) { return adapter.compact(options); } }
  new NativeService();
  await ctx.plugin(NativeCompaction);
  await ctx.plugin(CompactCommand);
  const signal = new AbortController().signal;
  const agent = { ctx, session: ctx.sessions.create(), options: { provider: ROUTE, model: 'gpt-5.4' }, runMaintenance: async fn => fn(signal) };
  let flushes = 0;
  ctx.on('session/flush', () => { flushes++; });
  const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const assistant = text => createAssistantMessage({ source: { provider: ROUTE, model: 'gpt-5.4' }, content: [{ type: 'text', text }] });
  for (let round = 0; round < 3; round++) {
    const s = agent.session;
    s.append('request/header', { header: { config: agent.options }, reason: round ? 'resume' : 'initial' });
    // No header.system and no system/message event: 0.1.7 forbids header.system,
    // and the baseline fixture does not exercise the system leg.
    // 0.1.7 Basic owns selection and protects the recent tail, so the fixture
    // seeds two completed turns: a large historical turn to shadow and a small
    // live tail that must survive summarization.
    const firstTurn = s.seq;
    for (const turn of [firstTurn, firstTurn + 1]) {
      s.append('turn/start', { turn });
      s.append('user/message', user(turn === firstTurn ? 'Retain the exact fixture requirement.' : 'Continue from the retained state.'), { surfaceOp: 'append' });
      s.append('step/start', { turn, step: 1 });
      s.append('assistant/message', { turn, step: 1, stream: [], message: assistant(turn === firstTurn ? 'Historical analysis. '.repeat(2000) : 'Retained tail requirement.') }, { surfaceOp: 'append' });
      s.append('step/end', { turn, step: 1 });
      s.append('turn/end', { turn, reason: { kind: 'completed' } });
    }
    const result = await ctx.commands.execute(agent, '/compact', [], signal);
    assert.equal(result.result.kind, 'success', JSON.stringify(result));
    assert.equal(requests[round].input.at(-1).type, 'compaction_trigger');
    assert.equal(requests[round].input.some(i => i.role === 'assistant'), true);
    if (round) assert.equal(requests[round].input.find(i => i.type === 'compaction')?.encrypted_content, `opaque-round-${round}`);
    // A restored seed goes through public SessionStore admission, not a private log patch.
    agent.session = ctx.sessions.create(undefined, { seed: JSON.parse(JSON.stringify(s.snapshotEvents())) });
  }
  assert.equal(requests.length, 3);
  assert.equal(flushes, 3);
});
