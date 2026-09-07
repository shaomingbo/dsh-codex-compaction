// Archived A baseline: preserve pre-B production behavior for the A/B experiment.
import { BasicCompactionEngine } from './compatibility.js';
import { ROUTE, failure } from './constants.js';

export const name = 'dsh-codex-compaction/compaction';
export const inject = [...BasicCompactionEngine.inject, 'codexCompaction'];
export class NativeBasicCompactionEngine extends BasicCompactionEngine {
  constructor(ctx, config = {}) {
    if (Object.keys(config).some(key => key !== 'auto') || (config.auto !== undefined && config.auto !== false)) {
      throw failure('CODEX_LAB_MANUAL_ONLY', 'This release only supports manual native compaction (auto:false).');
    }
    super(ctx, { auto: false });
  }
  async summarize(input, agent, signal) {
    const target = agent.session.requestHeader()?.config ?? agent.options;
    if (target.provider !== ROUTE || typeof target.model !== 'string' || !target.model) {
      throw failure('CODEX_LAB_ROUTE_REQUIRED', `Native compaction requires the ${ROUTE} experimental route.`);
    }
    return this.ctx.codexCompaction.compact({ ...input, provider: ROUTE, model: target.model, sessionId: agent.session.id, signal });
  }
}
export function apply(ctx, config = {}) {
  if (ctx.get('compaction') !== undefined) throw failure('CODEX_LAB_ENGINE_COLLISION', 'Mount the native subclass in an isolated experimental preset instead of alongside the default engine.');
  new NativeBasicCompactionEngine(ctx, config);
}
