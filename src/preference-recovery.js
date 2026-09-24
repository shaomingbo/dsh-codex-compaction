// Read only public command lifecycle events; never append plugin event types.
export const PREFERENCE_COMMAND = 'codex-native';
const MODES = new Set(['on', 'off', 'inherit', 'reader-text']);

export function preferenceFromEvents(events) {
  const pending = new Map();
  let latest;
  for (const event of events) {
    if (event.type === 'command/run') {
      const data = event.data;
      if (data?.name === PREFERENCE_COMMAND && typeof data.commandId === 'string'
        && typeof data.args === 'string') pending.set(data.commandId, data.args);
    } else if (event.type === 'command/done') {
      const args = pending.get(event.data?.commandId);
      pending.delete(event.data?.commandId);
      if (event.data?.kind === 'success' && args !== undefined && MODES.has(args.trim())) latest = args.trim();
    }
  }
  return latest;
}

/** Public live-preferred asynchronous projection, not deprecated Session reads. */
export function commandLogPreferenceRecovery(ctx) {
  return async sessionId => {
    const query = ctx.get?.('sessionQuery');
    if (!query) throw new Error('sessionQuery is required to recover native preference');
    const snapshot = await query.readSession(sessionId);
    return preferenceFromEvents(snapshot.events);
  };
}
