import test from 'node:test';
import assert from 'node:assert/strict';
import { compactionSystemPrompt, replaceSurfaceOp } from '../src/compatibility.js';
import { Session } from '/Users/shaomingbo/.dsh/plugin-lab/isolated/dsh-015-rc.1/prefix/node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.5-rc.1_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-scope@0._19a3f679910325ead5ac78e2fac662f7/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { createSystemMessage } from '/Users/shaomingbo/.dsh/plugin-lab/isolated/dsh-015-rc.1/prefix/node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.1_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-llm/lib/index.js';

test('replaceSurfaceOp uses start/end on the installed 0.1.2-rc.1 homogeneous host', () => {
  assert.deepEqual(replaceSurfaceOp(3, 9), { op: 'replace', start: 3, end: 9 });
});

test('compactionSystemPrompt reads V3 snapshotEvents content blocks as the current system head', () => {
  const systemMessage = { role: 'system', content: [{ type: 'text', text: 'synthetic-v3-instruction' }] };
  const session = {
    requestHeader: () => ({ config: { provider: 'synthetic', model: 'synthetic' } }),
    snapshotEvents: () => [{ type: 'system/message', seq: 0, data: { message: systemMessage } }],
  };
  assert.equal(compactionSystemPrompt(session, [{ role: 'user', content: [{ type: 'text', text: 'ordinary turn' }] }]), 'synthetic-v3-instruction');
  assert.equal(compactionSystemPrompt(session, [systemMessage]), 'synthetic-v3-instruction');
});

test('compactionSystemPrompt does not revive a cleared system head', () => {
  const session = {
    requestHeader: () => ({}),
    snapshotEvents: () => [
      { type: 'system/message', seq: 0, data: { message: { role: 'system', content: [{ type: 'text', text: 'old-instruction' }] } } },
      { type: 'system/message', seq: 1, data: { message: { role: 'system', content: [] } } },
    ],
  };
  assert.equal(compactionSystemPrompt(session, []), undefined);
});

test('compactionSystemPrompt still accepts legacy requestHeader.system and string message content', () => {
  assert.equal(compactionSystemPrompt({ requestHeader: () => ({ system: 'from-header' }) }, []), 'from-header');
  assert.equal(compactionSystemPrompt({ requestHeader: () => ({}) }, [{ role: 'system', content: 'from-messages' }]), 'from-messages');
});

test('compactionSystemPrompt keeps head A after A→B→A clears only the tail surface node', () => {
  const events = {
    0: { type: 'system/message', seq: 0, data: { message: { role: 'system', content: [{ type: 'text', text: 'A: retained complete system prompt' }] } } },
    1: { type: 'system/message', seq: 1, data: { message: { role: 'system', content: [{ type: 'text', text: 'B: changed complete system prompt' }] } } },
    2: { type: 'system/message', seq: 2, data: { message: { role: 'system', content: [] } } },
  };
  const session = {
    requestHeader: () => ({}),
    surface: { nodes: [0, 2] },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [events[0], events[1], events[2]],
  };
  assert.equal(compactionSystemPrompt(session, []), 'A: retained complete system prompt');
});

test('compactionSystemPrompt treats an empty surface head with no later text as no prompt', () => {
  const session = {
    requestHeader: () => ({}),
    surface: { nodes: [0] },
    eventAt: () => ({ type: 'system/message', data: { message: { role: 'system', content: [] } } }),
  };
  assert.equal(compactionSystemPrompt(session, [{ role: 'system', content: 'stale-messages' }]), undefined);
});

test('compactionSystemPrompt follows published 0.1.5 Session surface after A→B→A tail clear', () => {
  const session = Session.create('compaction-system-normalization');
  const head = session.append('system/message', {
    turn: 1, step: 1, message: createSystemMessage('A: retained complete system prompt', 'dsh-agent-loop'),
  }, { surfaceOp: 'append' });
  const tail = session.append('system/message', {
    turn: 1, step: 2, message: createSystemMessage('B: changed complete system prompt', 'dsh-agent-loop'),
  }, { surfaceOp: 'append' });
  session.append('system/message', {
    turn: 1, step: 3, message: createSystemMessage('', 'dsh-agent-loop'),
  }, { surfaceOp: { op: 'replace', startSeq: tail.seq, endSeq: tail.seq }, sourceEventSeqs: [tail.seq] });
  assert.equal(head.seq, 0);
  assert.equal(compactionSystemPrompt(session, []), 'A: retained complete system prompt');
});
