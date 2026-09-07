import { failure } from './constants.js';
import { StructuredCodexCompactionEngine } from './structured-engine.js';

export const name = 'dsh-codex-compaction/compaction';
export const inject = ['tokenMeter', 'sessions', 'codexBridge'];
export { StructuredCodexCompactionEngine };

/** Agent-preset entry: only the structured manual backend is mounted here. */
export function apply(ctx, config = {}) {
  if (Object.keys(config).some(key => key !== 'auto') || (config.auto !== undefined && config.auto !== false)) {
    throw failure('CODEX_NATIVE_MANUAL_ONLY', 'This candidate supports manual native compaction only.');
  }
  if (ctx.get('compaction') !== undefined) throw failure('CODEX_NATIVE_ENGINE_COLLISION', 'Use an isolated native preset; do not mount two compaction engines in one realm.');
  new StructuredCodexCompactionEngine(ctx, {
    compact: (input, agent, signal) => ctx.codexBridge.compact(input, agent, signal),
    readCheckpoint: message => ctx.codexBridge.readCheckpoint(message),
    validateCheckpoint: record => ctx.codexBridge.validateCheckpoint(record),
    estimateCheckpoint: record => ctx.codexBridge.estimateCheckpoint(record),
  });
}
