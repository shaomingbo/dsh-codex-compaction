import { PRESET } from './constants.js';

/** Read-only compatibility command. Bundle declarations own preset registration. */
export async function setupPreset(roster, { signal } = {}) {
  signal?.throwIfAborted();
  await roster.resolve(PRESET);
  signal?.throwIfAborted();
  return `Declarative preset ${PRESET} is available. Select it for Basic-owned compaction with the optional owner reader; /codex-native on or reader-text opts in per session (default off). No preset file, session, provider, login or default was changed.`;
}
