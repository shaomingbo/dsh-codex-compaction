// Archived A baseline: preserve pre-B production behavior for the A/B experiment.
export const PLUGIN = 'dsh-codex-compaction';
export const ROUTE = 'codex-native-lab';
export const PRESET = 'codex-native-lab';
export const NATIVE_PROVIDER = 'openai-codex';
export const TARGET_DSH = '0.1.2-rc.1';
export const DISPLAY_NAME = 'Codex Native Lab (experimental)';
export function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
