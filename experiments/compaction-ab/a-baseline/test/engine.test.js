import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Llm, { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
import Sessions, { Session } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Meter from '@deepseek-ai/dsh-token-meter';
import { NativeBasicCompactionEngine } from '../compaction.js';
import { encodeCheckpoint, decodeCheckpoint } from '../checkpoint.js';
import { ROUTE } from '../constants.js';
const model = 'gpt-5.4';
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const assistant = text => createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: ROUTE, model } });
const signal = () => new AbortController().signal;
async function fixture(t, compact) {
  const ctx = new Context();
  for (const p of [Llm, Sessions, Projections, Meter]) await ctx.plugin(p);
  class NativeService extends Service { constructor() { super(ctx, 'codexCompaction'); } compact(input) { return compact(input); } }
  new NativeService();
  const engine = new NativeBasicCompactionEngine(ctx);
  const session = ctx.sessions.create();
  session.append('request/header', { header: { config: { provider: ROUTE, model } }, reason: 'initial' });
  // The Agent admission double is the only runtime double: real basic,
  // Session, meter, projection and flush events exercise the public contract.
  const agent = { session, options: { provider: ROUTE, model }, runMaintenance: async fn => fn(signal()) };
  t.after(() => ctx.fiber.dispose());
  return { ctx, engine, session, agent };
}
function nativeResult() {
  return { summary: [{ type: 'text', text: encodeCheckpoint({ provider: ROUTE, model, identity: 'fixture-identity', items: [{ type: 'compaction', encrypted_content: 'opaque-native-fixture' }] }) }], provider: ROUTE, model };
}
function addWork(session) {
  const turn = session.seq;
  session.append('turn/start', { turn });
  session.append('user/message', user('Keep exact requirements and next action.'), { surfaceOp: 'append' });
  session.append('step/start', { turn, step: 1 });
  session.append('assistant/message', { turn, step: 1, stream: [], message: assistant('Large old tool analysis. '.repeat(400)) }, { surfaceOp: 'append' });
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  session.append('turn/start', { turn: turn + 1 });
  session.append('user/message', user('Continue from the latest state.'), { surfaceOp: 'append' });
  session.append('step/start', { turn: turn + 1, step: 1 });
  session.append('assistant/message', { turn: turn + 1, step: 1, stream: [], message: assistant('Latest state retained verbatim.') }, { surfaceOp: 'append' });
  session.append('step/end', { turn: turn + 1, step: 1 });
  session.append('turn/end', { turn: turn + 1, reason: { kind: 'completed' } });
}

test('official basic commits native text via normal lifecycle and flush, then restores three rounds', async t => {
  const calls = [];
  const f = await fixture(t, async input => { calls.push(input); return nativeResult(); });
  const root = await mkdtemp(join(tmpdir(), 'codex-basic-jsonl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'events.jsonl');
  // Public persistence seam fixture, not the host's full persistence plugin.
  f.ctx.on('session/flush', async session => writeFile(path, session.snapshotEvents().map(e => JSON.stringify(e)).join('\n') + '\n'));
  for (let round = 0; round < 3; round++) {
    addWork(f.agent.session);
    const result = await f.engine.compactNow(f.agent, signal());
    assert.ok(result.shadowedSeqs.length > 0);
    const stored = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const last = stored.slice(-4).map(e => e.type);
    assert.deepEqual(last, ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
    const restored = Session.create(f.agent.session.id, stored, f.agent.session.header);
    const derived = restored.deriveMessages();
    const carrier = derived.find(m => m.content.some(b => b.type === 'text' && b.text.startsWith('<dsh-codex-compaction-v1>')));
    assert.ok(carrier);
    const text = carrier.content.find(b => b.type === 'text' && b.text.startsWith('<dsh-codex-compaction-v1>')).text;
    assert.equal(decodeCheckpoint(text, { provider: ROUTE, model, identity: 'fixture-identity' }).items[0].encrypted_content, 'opaque-native-fixture');
    // Re-enter a seeded live session through the public store (a detached
    // read-only Session cannot participate in a manual durability checkpoint).
    f.agent.session = f.ctx.sessions.create(undefined, { seed: stored });
  }
  assert.equal(calls.length, 3);
  assert.equal(f.engine.config.auto, false);
});

test('native failure closes lifecycle and does not replace history', async t => {
  const f = await fixture(t, async () => { throw new Error('native unavailable'); });
  addWork(f.session);
  const before = [...f.session.surface.nodes];
  await assert.rejects(f.engine.compactNow(f.agent, signal()), error => error.code === 'summary' && error.cause?.message === 'native unavailable');
  assert.deepEqual([...f.session.surface.nodes], before);
  assert.equal(f.session.snapshotEvents().filter(e => e.type === 'compaction/end').length, 1);
  assert.equal(f.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 0);
});

test('basic shrink validation is kept and cannot be bypassed by a native result', async t => {
  const f = await fixture(t, async () => ({ summary: [{ type: 'text', text: 'oversized'.repeat(10000) }], provider: ROUTE, model }));
  addWork(f.session);
  const before = [...f.session.surface.nodes];
  await assert.rejects(f.engine.compactNow(f.agent, signal()), error => error.code === 'summary' && /not smaller/.test(error.cause?.message));
  assert.deepEqual([...f.session.surface.nodes], before);
});

test('flush failure is not reported as an unmodified session', async t => {
  const f = await fixture(t, async () => nativeResult());
  addWork(f.session);
  f.ctx.on('session/flush', () => { throw new Error('fixture disk unavailable'); });
  const generation = f.session.surface.replaceGeneration;
  await assert.rejects(f.engine.compactNow(f.agent, signal()), error => error.code === 'persistence');
  assert.ok(f.session.surface.replaceGeneration > generation);
});

test('manual-only config and foreign routes fail closed', async t => {
  const f = await fixture(t, async () => nativeResult());
  assert.throws(() => new NativeBasicCompactionEngine(f.ctx, { auto: true }), /manual/);
  f.session.append('request/header', { header: { config: { provider: 'foreign', model } }, reason: 'change' });
  addWork(f.session);
  await assert.rejects(f.engine.compactNow(f.agent, signal()), error => error.code === 'summary' && error.cause?.code === 'CODEX_LAB_ROUTE_REQUIRED');
  assert.equal(f.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 0);
});
