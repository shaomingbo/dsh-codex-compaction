// Capability-contract double only. Real account implementation is tested by
// the opt-in isolated cross-repository integration suite, not by this double.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { encodeCheckpoint, decodeCheckpoint } from '../../experiments/compaction-ab/a-baseline/checkpoint.js';
import { ROUTE } from '../../src/constants.js';

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export function fakeRuntime({ identity = 'fixture-owner-connection', receipt = { kind: 'unavailable' }, configured = true, fail = false, failMode = 'always', customModels = [], applicable = true, applicabilityReason = 'ROUTE_ENDPOINT', rotateIdentityOnFailure, retentionSupport = false } = {}) {
  const pinned = openaiCodexProvider().getModels();
  const template = { ...pinned[0] };
  // Custom models simulate the account's trusted-resolver materialization.
  const catalog = [...pinned, ...customModels.map(entry => ({ ...template, name: entry.id, ...entry }))];
  const calls = [];
  let opened = 0, closed = 0;
  // The "current connection" a fresh open would bind; a failed compact can
  // rotate it to simulate an account switch between native and fallback.
  let currentIdentity = identity;
  const state = { get currentIdentity() { return currentIdentity; } };
  const validateCheckpoint = (record, expected) => {
    if (record?.version !== 1 || record.protocol !== 'responses.compaction-trigger.v2') throw new Error('fixture unsupported checkpoint');
    return decodeCheckpoint(encodeCheckpoint(record), expected ?? record);
  };
  const runtime = {
    protocol: 'codex-runtime/v1',
    describe: () => ({ protocol: 'codex-runtime/v1', route: ROUTE, authOwner: 'dsh-token-usage', configured,
      ...(retentionSupport ? { retentionHints: { supported: true, algorithm: 'source-aware-v1', version: 1 } } : {}) }),
    models: () => structuredClone(catalog),
    encodeCheckpoint,
    decodeCheckpoint(text, expected) {
      if (typeof text !== 'string' || !text.startsWith('<dsh-codex-compaction')) return undefined;
      const binding = expected ?? JSON.parse(text.slice('<dsh-codex-compaction-v1>'.length, -'</dsh-codex-compaction-v1>'.length));
      return decodeCheckpoint(text, binding);
    },
    validateCheckpoint,
    estimateCheckpoint: () => ({ tokens: 100, basis: 'fixture-estimate', exact: false }),
    applicability({ provider, model } = {}) {
      if (provider !== 'openai-codex') return { applicable: false, reason: 'PROVIDER' };
      if (!applicable) return { applicable: false, reason: applicabilityReason };
      const entry = catalog.find(m => m.id === model);
      if (!entry) return { applicable: false, reason: 'UNKNOWN_MODEL' };
      return { applicable: true, model: { id: entry.id, contextWindow: entry.contextWindow } };
    },
    async open({ model, signal }) {
      signal?.throwIfAborted(); opened++;
      if (!configured) throw Object.assign(new Error('fixture login missing'), { code: 'CODEX_RUNTIME_NOT_CONFIGURED' });
      const selected = catalog.find(m => m.id === model);
      if (!selected) throw Object.assign(new Error('fixture missing model'), { code: 'CODEX_RUNTIME_UNKNOWN_MODEL' });
      const binding = Object.freeze({ provider: ROUTE, model, identity: currentIdentity });
      let done = false, compactDone = false;
      return {
        binding,
        close() { if (!done) closed++; done = true; },
        compactionUsage: () => structuredClone(compactDone && !done ? receipt : { kind: 'unavailable' }),
        provider({ mode, replay, retentionHints }) {
          replay.forEach(item => validateCheckpoint(item.checkpoint, binding));
          if (retentionHints !== undefined && (retentionHints.version !== 1 || retentionHints.algorithm !== 'source-aware-v1' || !Array.isArray(retentionHints.items))) throw new Error('fixture: malformed retention hints');
          return {
            id: 'openai-codex', name: 'Fake owner', getModels: () => [structuredClone(selected)],
            auth: { apiKey: { name: 'Bound fixture', resolve: async () => ({ auth: {} }) } },
            streamSimple(_model, context, options) {
              const callIndex = calls.push({ mode, identity: binding.identity, replay: structuredClone(replay), ...(retentionHints === undefined ? {} : { retentionHints: structuredClone(retentionHints) }), context: structuredClone(context), options: { apiKey: options.apiKey, headers: options.headers } });
              const output = createAssistantMessageEventStream();
              const message = { role: 'assistant', content: [], api: selected.api, provider: 'openai-codex', model, usage: usage(), stopReason: 'stop', timestamp: 0 };
              queueMicrotask(() => {
                // 'always' keeps every call failing (category mapping tests);
                // 'once' fails only the first request so a fallback attempt
                // through the same lease can still succeed.
                if (fail && (failMode === 'always' || callIndex === 1)) {
                  if (mode === 'compact' && rotateIdentityOnFailure) currentIdentity = rotateIdentityOnFailure;
                  output.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: typeof fail === 'string' ? fail : 'fixture failure' } });
                  return;
                }
                const text = mode === 'compact' ? encodeCheckpoint({ ...binding, items: [{ type: 'compaction', encrypted_content: 'fixture-opaque' }] }) : 'fixture continued';
                output.push({ type: 'start', partial: message });
                message.content.push({ type: 'text', text: '' });
                output.push({ type: 'text_start', contentIndex: 0, partial: message });
                message.content[0].text = text;
                output.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
                output.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
                compactDone = mode === 'compact';
                output.push({ type: 'done', reason: 'stop', message });
              });
              return output;
            },
          };
        },
      };
    },
  };
  return { runtime, calls, state, get opened() { return opened; }, get closed() { return closed; } };
}
