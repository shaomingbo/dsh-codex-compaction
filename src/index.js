import { assertPolicyCompatibility } from './compatibility.js';
import { setupPreset } from './preset-setup.js';
import { blocksCarryNativeEnvelope } from './native-checkpoint.js';
import { PLUGIN, STANDARD_ROUTE, failure } from './constants.js';

export const name = PLUGIN;
export const inject = ['commands', 'agentPresets', 'codexBridge'];

const attemptText = attempt => {
  if (!attempt) return 'none yet';
  const when = new Date(attempt.at).toISOString();
  if (attempt.outcome === 'running' || attempt.outcome === 'retrying') return `${attempt.kind} ${attempt.outcome} at ${when} (model ${attempt.model}); no completed summary yet`;
  if (attempt.outcome === 'failed') return `${attempt.kind} attempt FAILED at ${when} (native cause ${attempt.cause}; final ${attempt.failure ?? attempt.cause}; model ${attempt.model})`;
  if (attempt.kind === 'native' && attempt.outcome === 'native') return `native summarization streamed at ${when} (model ${attempt.model}; durable only after basic commits)`;
  if (attempt.kind === 'reader-text' && attempt.outcome === 'reader-text') return `${attempt.reason === 'explicit-reader-text' ? 'EXPLICIT READER-TEXT' : 'IMAGE HISTORY'} read natively into a text summary at ${when} (model ${attempt.model}; not a failure fallback; durable only after basic commits)`;
  if (attempt.kind === 'fallback') return `TEXT FALLBACK output completed at ${when} after recoverable native failure ${attempt.cause} (model ${attempt.model}; history replacement still requires basic commit)`;
  return `not taken over at ${when} (${attempt.reason}; model ${attempt.model})`;
};

const diagnosticText = status => status?.lastAttempt?.diagnostics
  ? `Diagnostic v1 (timings in ms from lease start): ${JSON.stringify(status.lastAttempt.diagnostics)}`
  : 'Diagnostic v1: no phase sample yet.';

const progressText = sample => {
  const last = sample?.latest;
  const pressure = value => value ? `~${value.tokens} (${value.baseline} anchor)` : 'unknown';
  const observed = last
    ? `Compaction benefit: ${last.outcome}; pressure ${pressure(last.beforePressure)} -> ${pressure(last.afterPressure)}; old span ~${last.shadowedTokens ?? '?'}; framed replacement ~${last.framedReplacementTokens ?? '?'}; net saved ~${last.netFreedTokens ?? '?'} heuristic tokens (${last.comparison.basis}${last.comparison.reason ? `: ${last.comparison.reason}` : ''}); interval ${last.stepInterval ?? '?'} steps; duration ${last.durationMs ?? '?'}ms.`
    : 'Compaction benefit: no live observation yet; restart does not invent historical pre/post measurements.';
  const native = sample?.native;
  const footprint = native?.kind === 'observed'
    ? `Native footprint: ${native.carriers} carriers, ${native.clients} retained client messages, ${native.retainedUtf16Units} retained text UTF-16 units, ${native.opaqueUtf16Units} opaque UTF-16 units (lengths, NOT provider token counts).`
    : `Native footprint: ${native?.kind ?? 'unavailable'}.`;
  return `${observed}\n${footprint}\nShadowed tokens are the old span size, not net freed space. Logical replacement is not a claim of disk persistence or sufficient remaining capacity.`;
};

const recoveryText = status => (status?.recovery ?? []).map(entry =>
  `Recovery ${entry.provider}/${entry.model}: ${entry.failures} consecutive failures; ${entry.inFlight ? 'request in flight' : entry.coolingDown ? `deferred until ${new Date(entry.nextAllowedAt).toISOString()}` : 'next official trigger may attempt'}${entry.lastFailure ? `; last failure ${entry.lastFailure}` : ''}.`
).join('\n') || 'Recovery: no tracked failures. State is process-local; ordinary task requests are not paused.';

/**
 * Correlate the latest compaction summary with its observed logical terminal
 * state in the session log: the matching clean compaction/end plus a
 * replacement user message citing that summary. This observes the logical
 * history replacement only — the HOST owns disk flushing, so this command
 * never independently confirms durable persistence; a summary without that
 * logical proof stays explicitly pending. Native HTTP completion alone is
 * never treated as a replacement.
 */
function committedText(session) {
  let latest = undefined;
  const cited = new Set();
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq);
    if (event?.type === 'compaction/summary') latest = event;
    if (event?.type === 'user/message' && latest !== undefined) {
      for (const citedSeq of event.sourceEventSeqs ?? []) if (session.eventAt(citedSeq)?.type === 'compaction/summary') cited.add(citedSeq);
    }
  }
  if (latest === undefined) return 'no observed compaction yet';
  const id = latest.data?.compactionId;
  const replaced = [...cited].some(seq => session.eventAt(seq)?.data?.compactionId === id);
  const ended = session.snapshotEvents().find(event => event.type === 'compaction/end' && event.data?.compactionId === id && event.data?.error === undefined);
  const confirmed = replaced && ended !== undefined;
  const kind = blocksCarryNativeEnvelope(latest.data?.summary) ? 'NATIVE checkpoint' : 'text summary';
  return confirmed
    ? `logical history replacement observed at event ${latest.seq}: ${kind}`
      + ` (provider ${latest.data?.provider ?? 'unknown'}, model ${latest.data?.model ?? 'unknown'}, shadowed ~${latest.data?.shadowedTokenCount ?? '?'} tokens); disk persistence is host-owned and not independently confirmed here`
    : `PENDING at event ${latest.seq} (no observed replacement/close pair): ${kind}`
      + ` (provider ${latest.data?.provider ?? 'unknown'}, model ${latest.data?.model ?? 'unknown'}, shadowed ~${latest.data?.shadowedTokenCount ?? '?'} tokens)`;
}

/** Policy/configuration entry. No OAuth, provider route, catalog or HTTP ownership. */
export function apply(ctx, config = {}) {
  if (Object.keys(config).length) throw failure('CODEX_NATIVE_CONFIG', 'This candidate accepts no implicit routing, credential or automatic-compaction configuration.');
  assertPolicyCompatibility(ctx);
  ctx.effect(() => ctx.commands.register({
    name: 'codex-compact-setup',
    description: 'Legacy compatibility: create the archived structured B preset (manual-only; not needed for standard sessions)',
    async handler(invocation) {
      if (invocation.rawInput.trim()) return { kind: 'error', text: 'Usage: /codex-compact-setup (no arguments)' };
      ctx.codexBridge.describe(); // Presence, not a login or network probe.
      return { kind: 'success', text: await setupPreset(ctx.agentPresets, { signal: invocation.signal }) };
    },
  }));
  ctx.effect(() => ctx.commands.register({
    name: 'codex-native',
    description: 'Per-session native Codex compaction preference for standard openai-codex sessions',
    input: { hint: 'on | off | inherit | reader-text | status' },
    // recordInput stays enabled: the persisted command/run arguments are the
    // only restart-safe store for this per-session preference (see
    // src/preference-recovery.js — no plugin event type may enter a session log).
    async handler(invocation) {
      const argument = invocation.rawInput.trim();
      if (!['', 'on', 'off', 'inherit', 'reader-text', 'status'].includes(argument)) {
        return { kind: 'error', text: 'Usage: /codex-native [on|off|inherit|reader-text|status]' };
      }
      const session = invocation.agent?.session;
      if (!session?.id) return { kind: 'error', text: 'This command needs a live session.' };
      const target = session.requestHeader()?.config ?? invocation.agent?.options ?? {};
      // Failure-prone async probing runs BEFORE the preference changes. A
      // cancelled or failed probe therefore leaves the live state equal to
      // the durable command log (recovery ignores command/done kind=error),
      // so this process and a restored one cannot diverge.
      const applicability = target.model ? await ctx.codexBridge.nativeApplicability(target.model, invocation.signal) : { applicable: false, reason: 'NO_MODEL' };
      // A cancellation that raced the probe — even if the probe swallowed it
      // and returned a verdict — must not commit the preference. Returning
      // (not throwing) keeps the host's aborted-command wrapper from leaking
      // an unhandled rejection; the command system still settles this as a
      // cancelled command. This synchronous check-to-commit span cannot be
      // interleaved with cancellation.
      if (invocation.signal?.aborted) {
        return { kind: 'error', text: 'The preference command was cancelled before it could commit; nothing changed.' };
      }
      if (argument === 'reader-text' && (target.provider !== STANDARD_ROUTE || !applicability.applicable)) {
        return { kind: 'error', text: 'Reader-text requires an applicable standard openai-codex route and its Accounts native reader; no preference changed.' };
      }
      if (argument && argument !== 'status') ctx.codexBridge.setNativePreference(session.id, argument);
      const status = ctx.codexBridge.nativePreferenceStatus(session.id);
      const preference = `Profile default: ${status.profile ? 'on' : 'off'}. Session: ${status.session}. Effective: ${status.effective ? 'ON' : 'OFF'}.`;
      const readiness = target.model
        ? (applicability.applicable
          ? `Native applicability for ${target.provider ?? 'openai-codex'}/${target.model}: ready${applicability.model?.contextWindow ? ` (resolved context ${applicability.model.contextWindow})` : ''}.`
          : `Native applicability for ${target.provider ?? '?'}/${target.model ?? '?'}: NOT available (${applicability.reason}). Requests stay on the original path.`)
        : 'No routed model yet; native applicability unknown until a request selects a model.';
      const history = `Last summarization attempt: ${attemptText(status.lastAttempt)}.`;
      const mode = `Summarization mode: ${status.summarizationMode}. Reader-text replays native state through the same owner into a text summary; it applies to the next official compaction, not ordinary generation. Use /compact while idle to request it now; /codex-native on returns to native output. No automatic strategy switch is enabled.`;
      return { kind: 'success', text: [`Native Codex compaction preference.`, preference, mode, readiness, history, recoveryText(status), diagnosticText(status),
        'Profile enablement is a reviewed rollout step; OFF only stops new native creation, existing native state stays readable.'].join('\n') };
    },
  }));
  ctx.effect(() => ctx.commands.register({
    name: 'codex-context',
    description: 'Show compaction mode, native readiness, last attempt and committed result',
    async handler(invocation) {
      if (invocation.rawInput.trim()) return { kind: 'error', text: 'Usage: /codex-context (no arguments)' };
      const session = invocation.agent?.session;
      const engine = ctx.agentPresets.serviceFor(invocation.agent, 'compaction');
      if (typeof engine?.measureEffective === 'function') {
        ctx.codexBridge.describe();
        const measured = engine.measureEffective(session);
        const bases = [...new Set(measured.nodes.flatMap(node => node.estimate?.basis ? [node.estimate.basis] : []))];
        return { kind: 'success', text: `Native effective context: ~${measured.effectiveTokens} tokens (estimate, not an exact provider count). Host meter: ${measured.hostTokens}. Basis: ${bases.join(', ') || 'host heuristic; no native checkpoint yet'}. Anchor: ${measured.anchorAdjustment.kind}. Automatic compaction: structured manual-only.` };
      }
      if (engine?.config && typeof engine.compactIfNeeded === 'function') {
        const target = session?.requestHeader()?.config ?? invocation.agent?.options ?? {};
        const status = session ? ctx.codexBridge.nativePreferenceStatus(session.id) : null;
        const applicability = target.model ? await ctx.codexBridge.nativeApplicability(target.model, invocation.signal) : { applicable: false, reason: 'NO_MODEL' };
        const auto = `Basic automatic compaction: ${engine.config.auto === false ? 'off' : 'on'} (official backend; triggers, retention, meter and shrink checks stay official).`;
        const native = status
          ? [`Native preference: effective ${status.effective ? 'ON' : 'OFF'} (session ${status.session}, profile ${status.profile ? 'on' : 'off'}).`,
            target.model ? (applicability.applicable
              ? `Native readiness for ${target.provider ?? 'openai-codex'}/${target.model}: ready.`
              : `Native readiness for ${target.provider ?? '?'}/${target.model ?? '?'}: NOT available (${applicability.reason}); text path continues unchanged.`)
              : 'Native readiness: unknown until a model is routed.',
            `Summarization mode: ${status.summarizationMode}.`,
            `Last attempt: ${attemptText(status.lastAttempt)}.`].join('\n')
          : 'Native preference: no live session.';
        const committed = session ? `Observed compaction result: ${committedText(session)}.` : 'Observed compaction result: no live session.';
        const benefit = progressText(ctx.codexBridge.compactionProgress(session));
        return { kind: 'success', text: [auto, native, recoveryText(status), diagnosticText(status), benefit, committed,
          'A streamed native summary counts only after official basic replaces history in the session log; this status observes that logical replacement and does not independently confirm host-owned disk persistence.'].join('\n') };
      }
      return { kind: 'error', text: 'No compaction engine serves this session. Start a standard openai-codex session to see basic automatic compaction and native readiness; the legacy structured preset is compatibility-only.' };
    },
  }));
}
