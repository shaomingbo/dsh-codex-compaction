import { Context } from '@deepseek-ai/cordis';
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Meter from '@deepseek-ai/dsh-token-meter';
import * as provider from '../../src/provider-entry.js';
import * as compaction from '../../src/compaction.js';
import { fakeRuntime } from './fake-runtime.js';
export const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
export async function engineFixture(t, { runtimeOptions, withOwner = true, config = {}, capability = true } = {}) {
  const ctx = new Context();
  for (const plugin of [Llm, Sessions, Projections, Meter]) await ctx.plugin(plugin);
  ctx.provide('sessionQuery', { readSession: async id => ({ events: ctx.sessions.get(id)?.snapshotEvents() ?? [] }) });
  const hostCalls = [];
  class Host extends LlmAdapter {
    async *stream(options) {
      hostCalls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'host summary' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'host summary' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['openai-codex', 'foreign'], new Host());
  await ctx.plugin(provider, { nativeCompaction: capability });
  const fake = fakeRuntime(runtimeOptions);
  if (withOwner) await ctx.plugin({ name: 'synthetic-owner', apply: owner => { owner.provide('codexRuntime', fake.runtime); } });
  await ctx.plugin(compaction, { auto: false, ...config });
  const session = ctx.sessions.create('synthetic');
  const target = { provider: 'openai-codex', model: 'gpt-5.4' };
  session.append('request/header', { header: { config: target }, reason: 'initial' });
  const agent = { session, options: target, runMaintenance: fn => fn(new AbortController().signal) };
  const engine = ctx.compaction;
  t.after(() => ctx.fiber.dispose());
  return { ctx, fake, session, agent, engine, hostCalls,
    enable: (mode = 'on') => ctx.codexBridge.setNativePreference(session.id, mode),
    summarize: (messages = [user('work')], signal) => engine.summarize({ messages }, agent, signal) };
}
