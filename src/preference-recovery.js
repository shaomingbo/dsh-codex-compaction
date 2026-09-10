// Restart survival for the per-session native preference. The host's
// persistence layer refuses to interpret a session log containing an event
// type outside its known vocabulary unless the event carries the ignorable
// marker — and the public append API cannot set that marker — so a plugin
// event type must NEVER enter a session log. Recovery therefore reads only
// the host-written public command lifecycle events (command/run followed by
// a matching command/done), which the durable log already persists and the
// command service guarantees for every /codex-native invocation.
export const PREFERENCE_COMMAND = 'codex-native';
const MODES = new Set(['on', 'off', 'inherit', 'reader-text']);

/**
 * Build a synchronous recovery callback over the live session store.
 * Returns 'on' | 'off' | 'inherit' for the last successfully applied
 * /codex-native preference argument, or undefined when the session has no
 * durable preference. A command/run counts only when its command/done pair
 * succeeded; failed, status-only, unrecognized and unpaired invocations are
 * skipped, so a crashed command can never resurrect as a preference.
 */
export function commandLogPreferenceRecovery(ctx) {
  return sessionId => {
    const store = ctx.get?.('sessions');
    const session = typeof store?.get === 'function' ? store.get(sessionId) : undefined;
    if (!session || typeof session.snapshotEvents !== 'function') return undefined;
    const pending = new Map();
    let latest;
    for (const event of session.snapshotEvents()) {
      if (event.type === 'command/run') {
        const data = event.data;
        if (data?.name === PREFERENCE_COMMAND && typeof data.commandId === 'string'
          && typeof data.args === 'string') pending.set(data.commandId, data.args);
        continue;
      }
      if (event.type !== 'command/done') continue;
      const args = pending.get(event.data?.commandId);
      pending.delete(event.data?.commandId);
      if (event.data?.kind !== 'success' || args === undefined) continue;
      const mode = args.trim();
      if (MODES.has(mode)) latest = mode;
    }
    return latest;
  };
}