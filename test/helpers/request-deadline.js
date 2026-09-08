// Paired owner + official basic + public Pi converter regression, fake credentials only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';

export function registerRequestDeadlineTests(standardFixture) {
  async function prepare(t, { realTime = false } = {}) {
    if (!realTime) t.mock.timers.enable({ apis: ['setTimeout'] });
    let controller, signal, cancelled = 0;
    const f = await standardFixture(t, { timeoutMs: 1800000, compactionTimeoutMs: 300000,
      ordinaryReply: ({ signal: wireSignal }) => {
        signal = wireSignal;
        return new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { cancelled++; } }),
          { headers: { 'content-type': 'text/event-stream' } });
      } });
    f.addStandardHistory(); f.enable();
    await f.engine.compactNow(f.agent, f.signal);
    // Serialize/reload the official checkpoint before replay, matching resumed sessions.
    const messages = JSON.parse(JSON.stringify(f.agent.session.deriveMessages()));
    const assembler = new BlockAssembler(), chunks = [];
    let settled = false;
    const completion = (async () => {
      for await (const chunk of f.ctx.llm.stream({ provider: 'openai-codex', model: 'gpt-6-astra',
        sessionId: f.agent.session.id, messages })) { chunks.push(chunk); assembler.push(chunk); }
    })().then(() => { settled = true; }, error => { settled = true; throw error; });
    // Attach immediately so failure while advancing the test clock is never unhandled.
    completion.catch(() => {});
    await immediate();
    assert.ok(controller, 'the real native SDK made the replay request');
    assert.ok(f.requests.at(-1).body.input.some(item => item.type === 'compaction'));
    const raw = text => controller.enqueue(new TextEncoder().encode(text));
    return { f, assembler, chunks, completion, raw,
      send: event => raw(`data: ${JSON.stringify(event)}\n\n`),
      get signal() { return signal; }, get cancelled() { return cancelled; }, get settled() { return settled; } };
  }
  const created = f => f.send({ type: 'response.created', response: { id: 'deadline-response', status: 'in_progress' } });
  const end = f => f.send({ type: 'response.completed', response: { id: 'deadline-response', status: 'completed', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
  function begin(f, kind) {
    created(f);
    const item = kind === 'tool' ? { type: 'function_call', id: 'fc_deadline', call_id: 'call_deadline', name: 'fixture_write', arguments: '' }
      : kind === 'reasoning' ? { type: 'reasoning', id: 'rs_deadline', summary: [] }
      : { type: 'message', id: 'msg_deadline', role: 'assistant', content: [] };
    f.send({ type: 'response.output_item.added', output_index: 0, item });
    if (kind === 'reasoning') f.send({ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } });
    if (kind === 'text') f.send({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    return item;
  }
  function delta(f, kind, text) {
    const type = kind === 'tool' ? 'response.function_call_arguments.delta' : kind === 'reasoning' ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta';
    f.send({ type, output_index: 0, content_index: 0, summary_index: 0, delta: text });
  }
  function finish(f, kind, item, text) {
    if (kind === 'tool') item = { ...item, arguments: text };
    else if (kind === 'reasoning') item = { ...item, summary: [{ type: 'summary_text', text }] };
    else item = { ...item, content: [{ type: 'output_text', text, annotations: [] }] };
    f.send({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed' } }); end(f);
  }
  for (const kind of ['text', 'reasoning', 'tool']) {
    test(`ordinary native ${kind} replay survives 120s and output renews idle, not total`, async t => {
      const f = await prepare(t), item = begin(f, kind);
      const first = kind === 'tool' ? '{"content":"' : 'a';
      delta(f, kind, first); await immediate();
      for (let i = 0; i < 3; i++) {
        t.mock.timers.tick(120001); await immediate();
        assert.equal(f.signal.aborted, false);
        assert.equal(f.settled, false);
        delta(f, kind, 'x'); await immediate();
      }
      if (kind === 'tool') {
        assert.equal(f.chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').length, 0,
          'partial streamed arguments are not executable calls');
      }
      const text = first + 'xxx' + (kind === 'tool' ? '"}' : '');
      if (kind === 'tool') delta(f, kind, '"}');
      finish(f, kind, item, text); await f.completion;
      assert.equal(f.assembler.finish.kind, kind === 'tool' ? 'tool-calls' : 'stop');
      if (kind === 'tool') {
        assert.equal(f.chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').length, 1);
        assert.deepEqual(JSON.parse(f.assembler.blocks()[0].arguments), { content: 'xxx' });
      }
      assert.equal(f.f.requests.length, 2, 'one compact and one replay, no hidden retries');
      assert.equal(f.f.hostCalls.length, 0);
      assert.equal(f.cancelled, 1, 'stream reader is released on completion');
    });
  }
  for (const phase of ['first-output', 'mid-output', 'heartbeat']) {
    test(`ordinary ${phase} idle stops at 300s without waiting for the 30-minute owner cap`, async t => {
      const f = await prepare(t);
      if (phase !== 'first-output') { begin(f, 'text'); delta(f, 'text', 'a'); await immediate(); }
      t.mock.timers.tick(299999); await immediate();
      assert.equal(f.settled, false);
      if (phase === 'heartbeat') { f.raw(': keepalive\n\n'); await immediate(); }
      t.mock.timers.tick(1);
      await assert.rejects(f.completion, error => {
        assert.equal(error.code, 'TIMEOUT');
        assert.match(error.message, /idle timeout after 300000ms without model output/);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(f.signal.aborted, true);
      assert.equal(f.cancelled, 1);
    });
  }
  test('continuous native replay still ends at its original absolute total deadline', async t => {
    const f = await prepare(t); begin(f, 'text');
    for (let i = 0; i < 14; i++) { delta(f, 'text', 'x'); await immediate(); t.mock.timers.tick(120000); await immediate(); }
    assert.equal(f.settled, false); delta(f, 'text', 'x'); await immediate();
    t.mock.timers.tick(120000); await f.completion;
    assert.equal(f.assembler.finish.kind, 'aborted');
    assert.equal(f.assembler.finish.failure.message, 'CODEX_RUNTIME_TIMEOUT');
    assert.equal(f.f.requests.length, 2);
  });
  test('real-time 130-second native replay completes with production budgets', { skip: process.env.CODEX_REALTIME_DEADLINE !== '1', timeout: 180000 }, async t => {
    const f = await prepare(t, { realTime: true }), started = performance.now(), item = begin(f, 'tool');
    delta(f, 'tool', '{"content":"');
    for (let i = 0; i < 13; i++) { await delay(10000); delta(f, 'tool', 'x'); }
    assert.equal(f.signal.aborted, false);
    delta(f, 'tool', '"}'); finish(f, 'tool', item, '{"content":"' + 'x'.repeat(13) + '"}');
    await f.completion;
    assert.ok(performance.now() - started > 120000);
    assert.equal(f.assembler.finish.kind, 'tool-calls');
    assert.equal(f.assembler.blocks().filter(b => b.type === 'tool-call').length, 1);
    console.log(JSON.stringify({ realTimeReplayMs: Math.round(performance.now() - started), realCredentials: false, liveProfileTouched: false }));
  });
}
