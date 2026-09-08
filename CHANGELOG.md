# Changelog

## 0.3.2

Companion: `dsh-token-usage` `5.1.3`. Tag identity and tag-installation results are recorded
in the release; current-host acceptance is recorded separately. This entry does not claim
publication or live acceptance is complete; the `0.3.1` evidence below remains historical.

- Ordinary owner opens select 1800000ms total and 120000ms setup budgets. The companion
  replay/text converter now uses the public PiAiAdapter idle watchdog at 300000ms instead
  of 120000ms; no additional SSE monitor is introduced.
- Compaction-purpose opens retain a 300000ms total deadline including setup, without a
  separate shorter setup deadline. Native converter idle remains 300000ms. Recovery never
  renews the original lease.
- Owner factory `timeoutMs` retains total-budget and explicit short-call semantics.
  `setupTimeoutMs` defaults to `min(timeoutMs, 120000)` and `compactionTimeoutMs` to
  `min(timeoutMs, 300000)`; callers cannot override durations through `open`.
- Diagnostic `budgetMs` remains the selected total budget. The consumer allowlists optional
  nonnegative safe integers `totalBudgetMs`, `setupBudgetMs`, `timeoutBudgetMs` and the strict
  `timeoutKind` enum `setup`/`total`, never credentials or body text. Owner deadline failures
  retain `CODEX_RUNTIME_TIMEOUT`; public Pi idle failures retain `TIMEOUT`.
- Old owners/readers remain compatible, but do not acquire new owner request budgets from
  a consumer-only update. Both companion packages are required for the complete correction.

## 0.3.1

Paired with `dsh-token-usage` `5.1.2`. The recovery fix has passed an authorized real
acceptance run and the frozen production candidate's full regression. Final packaging,
tag identity and release-tag installation results are recorded in the GitHub release.

- Native SSE completes at a valid completed/done event with one valid compaction item,
  not HTTP EOF. The account owner classifies premature EOF/socket failure as recoverable
  `CODEX_RUNTIME_RESPONSE_STREAM`, malformed protocol as non-retryable
  `CODEX_RUNTIME_RESPONSE_PROTOCOL`, and preserves the first lease stop reason.
- Native compaction leases and native converters get 300000ms; ordinary request leases
  and replay/text converters remain 120000ms. Recovery never renews the original lease.
- One shared extra request per lease: one native retry after 200ms for network/5xx/stream
  failures OR one allowlisted text fallback, never both. Same account/model/endpoint;
  no recovery on expired/cancelled leases or protocol/identity failures, and no text fallback
  for native carrier histories. This is plugin policy, not an official Codex Native-to-text fallback.
- Bounded process-local failure suppression lasts 60 seconds per session/provider/model.
  Ordinary generation continues; only an observed official history replacement with a clean
  end clears failure state. No new command, persistent event schema or model-capacity override.
- Fixed-field diagnostics expose phases, budget, timings and bounded event/byte/request
  counts without raw content, account identifiers or credentials.
- De-identified real acceptance: budget 300000ms, elapsed 157372ms, one request, valid item
  plus completed event, a new official Basic history replacement, and approximately 146849
  tokens shadowed. The maintainer read `compaction/summary`, `user/message`, `compaction/end`
  and successful `command/done` back from the disk journal. This proves this run's recorded
  result, not fsync, crash recovery, lossless recall or elimination of all timeouts.
- The maintainer reran the frozen production candidate: 498 passing tests (plugin 135 +
  legacy-A 46 + comparison 34 + account 266 + paired 17). `scripts/validate-cli.js` passed
  the real rc.1 temporary-home install/repeat/status/dump/uninstall cycle without booting a
  host. See [validation](docs/VALIDATION.md).
- Known non-blocking limitation: cancellation can display `CODEX_RUNTIME_ERROR`.
  Refreshing may cancel a pending manual command; tab switching alone has not been shown
  to cause cancellation. Window hard limits and persistent upstream failures still apply.
- Public compaction compatibility remains exactly DSH `0.1.2-rc.1`. The account installer
  retains its existing alpha.3 + rc.1 scope; a mixed alpha.3 launcher / rc.1 Web+Basic
  environment is not proof of full native runtime compatibility on pure alpha.3.

## 0.3.0 (historical stable release)

First stable release. Content equals the reviewed `0.3.0-rc.1` candidate plus
the follow-ups below; the RC tags remain as history.

- **Stable identity:** installer default source pins `#v0.3.0`; a check.js
  contract now verifies the installer source and every packaged `files` entry
  stay in lockstep with the package version.
- **Public validation facts:** a de-identified `docs/VALIDATION.md` (bilingual)
  documents the verified environment, offline suite counts (121/46/34 core,
  240 account, 12 paired), the controlled 16-request live budget, the Astra
  restart-recall pass, the Sol RC1 empty-input fix and its post-fix native
  pass with the honest recall-failure note, and the legacy-reader byte
  compatibility result — with no private identifiers. None of it claims
  lossless recall or superiority over other implementations.
- **Semantic-recall documentation:** README now separates lossy semantic
  recall from safety refusals (already in the RC delta).

No production logic changed relative to `0.3.0-rc.1` + the already-released
follow-up commits; see the RC entry below for the feature set.

## 0.3.0-rc.1 (release candidate)

First official-basic release candidate. The stock `BasicCompactionEngine` stays the
primary and only automatic backend; this package adds an optional account-owned
native summarization/replay seam plus the legacy structured reader.

### New main path

- The official basic engine's `purpose=compaction` `llm/stream` call can be taken
  over, per session, by the account-owned `codex-runtime/v1` native runtime
  (provider `openai-codex`). Triggers, meter, retention, shrink checks, commit
  and flush all stay official.
- The native summary is the owner codec's existing versioned V1 text envelope,
  framed and committed by official basic with its own checkpoint source. No
  new wrapper or preamble dependency.
- Native carrier histories replay through their exact model/account binding on
  the standard route; they never reach the plain adapter, on any guard branch.
- One transparent text fallback per recoverable native failure, inside the
  same owner lease (same account/model/endpoint). Cancellation, identity
  mismatch, invalid checkpoints and carrier histories never fall back.
- `gpt-6-astra` metadata resolves through the account's trusted
  `createCodexModelFacts` seam from public host-configured profile fields
  (whitelisted: id/name/contextWindow/maxTokens/input/reasoningEfforts);
  pinned catalog entries such as `gpt-5.6-sol` honor configured overrides.
  Fixed-vocabulary metadata gaps only; no invented values, no URLs/headers/
  credentials cross the seam.

### Controls

- `/codex-native on|off|inherit|status` — per-session preference, profile
  default OFF for the RC. Explicit preferences survive host restarts by
  reading the host's own persisted public command lifecycle events only
  (no plugin session-log event types are introduced).
- `/codex-context` — basic automatic mode, native readiness, last attempt and
  the observed logical history replacement. It honestly does not claim
  independent confirmation of host-owned disk persistence.
- `/codex-compact-setup` is legacy compatibility only: it creates the
  archived structured B preset and does not point new users at it.

### Legacy compatibility

- The `codex-native-lab` route, the structured B preset and the A-baseline
  experiment reader remain available for pre-existing structured sessions.
  Old logs are never rewritten; existing readers are preserved.

### Packaging

- Installer delegates every mutation to the public `dsh plugin` CLI (exact
  tested version `0.1.2-rc.1`), disables lifecycle scripts, verifies manifest
  postconditions, and reports failures without fabricating rollback.
- Companion account package: `dsh-token-usage` `5.1.0-rc.1` (same release
  train). The account package is not a registry dependency; capability
  preflight (`codex-runtime/v1` protocol and auth owner) is checked at
  runtime instead of guessing package versions.

### Earlier local-only baselines

- `0.2.0-alpha.1` and the archived A/B experiments were local candidates
  that never reached a published tag.