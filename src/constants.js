export const PLUGIN = 'dsh-codex-compaction';
export const ROUTE = 'codex-native-lab';
export const STANDARD_ROUTE = 'openai-codex';
export const PRESET = 'codex-native-b';
export const NATIVE_PROVIDER = 'openai-codex';
export const TARGET_DSH = '0.1.7-alpha.1';
export const TARGET_DSH_VERSIONS = Object.freeze(['0.1.7-alpha.1']);
/** Bumped when the engine's summarization/selection-relevant algorithm or
 * config semantics change; part of the deterministic failure fingerprint. */
export const ENGINE_ALGORITHM_VERSION = 'dsh-codex-compaction/engine/2026-09-24';
/** Display name of the declarative codex-native-b preset. */
export const PRESET_DISPLAY_NAME = 'Codex Native';
/** Legacy model-category label for the ROUTE adapter. This route is the
 * legacy reader surface, not the default model routing of the preset. */
export const DISPLAY_NAME = 'Codex Legacy Reader (Accounts & Usage)';
export function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
