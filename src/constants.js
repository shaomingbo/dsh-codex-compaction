export const PLUGIN = 'dsh-codex-compaction';
export const ROUTE = 'codex-native-lab';
export const STANDARD_ROUTE = 'openai-codex';
export const PRESET = 'codex-native-b';
export const NATIVE_PROVIDER = 'openai-codex';
export const TARGET_DSH = '0.1.2-rc.1';
export const TARGET_DSH_VERSIONS = Object.freeze(['0.1.2-rc.1', '0.1.5-rc.1']);
export const DISPLAY_NAME = 'Codex Native B — legacy reader (Accounts & Usage, manual-only)';
export function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
