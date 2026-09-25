import { PRESET, PRESET_DISPLAY_NAME } from './constants.js';

/** Read-only compatibility command. Bundle declarations own preset registration. */
export async function setupPreset(roster, { signal } = {}) {
  signal?.throwIfAborted();
  await roster.resolve(PRESET);
  signal?.throwIfAborted();
  return `Declarative preset ${PRESET} (${PRESET_DISPLAY_NAME}) is available. Native summarization defaults ON for sessions on this preset; /codex-native off or reader-text opts out per session, and standard presets keep Basic text summarization. No preset file, session, provider, login or preference was changed.`;
}
