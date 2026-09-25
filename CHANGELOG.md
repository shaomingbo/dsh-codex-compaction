# Changelog

## 0.5.0 — 0.1.7-alpha.1 durable native compaction (isolated verification complete)

- **Owner Settings catalog projection**: `models.preview` / `models.apply` expose the
  versioned Codex catalog to Accounts & Usage, binding a catalog revision, Settings
  revision and preview digest; apply is idempotent, revision-guarded and rejects
  malformed/duplicate/unknown targets instead of writing a half list. Sol and Luna
  are filled from verified Codex facts (`contextWindow=272000`, `maxTokens=128000`,
  text+image; `off→none`, `minimal→low`).
- **Codex Native preset default**: preset-local `nativeDefault` (true only on
  `codex-native-b`), explicit per-session `on/off/reader-text` wins, `inherit` and
  never-set follow the CURRENT preset, and status reports capability, preset default,
  session preference, effective mode and carrier readability separately. The global
  native capability flag stays a separate gate and never carries preference.
- **Deterministic failures**: the pure-local history/schema precheck now runs before
  any lease, and deterministic bad inputs are fingerprint-blocked (session, route,
  config/algorithm version, normalized input digest, fixed error class) instead of
  riding the transient cooldown. Process-local state; a restart re-runs the precheck.
- **Preset-scoped efficiency guard** (default off, experimental): defers an automatic
  low-gain native request (`<4096` heuristic tokens freed or `<10%` of the replaced
  content, within 60 s and without ≥4096 surface growth) with zero HTTP and a fixed
  reason; manual compaction bypasses the efficiency deferral but not the safety
  checks. No fabricated commit, no hidden retry, no automatic reader-text.
- **Source-aware retention** (`source-aware-v1`, ships behind the preset's
  experimental `sourceRetention` switch, default off): the full request is still
  sent; only provably duplicated host-generated copies may leave the retained
  checkpoint copy. Ambiguous same-text sources fall back conservatively, real user
  content/constraints/unknown items are never dropped, and an old owner without the
  capability marker receives no hints.
- **Observer and history correctness**: replacement ranges are read from the 0.1.7
  `surfaceOp`/`sourceEventSeqs` schema, committed requires a source-linked summary →
  replacement → clean end, comparison-unknown is distinct from failure, and V4
  tool-role history (top-level tool payloads, durable images) is accepted while
  legacy V3 wrappers still fail closed.
- **Installer/packaging**: host `peerDependencies` removed again (they make
  `npx github:…#tag` auto-resolve the whole host tree and hit ERESOLVE); the
  compatibility contract stays gated by the installer's dsh CLI matrix
  (`0.1.7-alpha.1`). Bilingual README install commands pinned to `v0.5.0`.
- **Test scope**: the Structured B compaction A/B experiment is repaired under
  0.1.7 and re-included in `npm run check` (reversing the 0.4.5 scope reduction
  now that the suite passes), alongside a same-corpus old/new efficiency benchmark.
- Verified only in isolation: packaged candidates, isolated 0.1.7 host, and the
  paired account snapshot. Real-account/GUI/production claims stay separate.

## 0.4.6 — installer: drop npm host peers; version-derived default source

- Host packages (@deepseek-ai/cordis, dsh-*) are provided by the DSH profile
  runtime, not npm peers. The peer declarations made `npx github:…#tag`  auto-resolve the whole host tree and fail with ERESOLVE (dsh-agent
  ^0.1.7-alpha.1 resolves to 0.1.7-rc.1, whose cordis ~4.0.4 conflicts with
  the exact 4.0.3 pin). peerDependencies removed; compatibility stays gated
  by the installer's dsh CLI matrix.
- Installer DEFAULT_SOURCE is now derived from the package version
  (scripts/check.js lockstep contract adapted accordingly).

## 0.4.5 — check scope: Structured B archive suite moves out of default check

- `npm run check` no longer runs `test:compaction-ab`. The retired Structured B
  archive experiment fails 23/34 against DSH 0.1.7 solely on seeded-fixture
  shape drift (17× invalid `user/message` replace `surfaceOp`; 6×
  `header.system` in `request/header`), with no shipped-engine paths involved.
  Per the approved 2026-09-24 gate-scope change, the explicit suites remain
  available (`npm run test:compaction-ab`, `npm run experiment:compaction-ab`);
  legacy-a stays in the default check. Historical failure log is archived with
  the release task evidence.
- Version contract sync: installer default source, check.js pin and bilingual
  README install commands move to v0.4.5. Shipped engine (143 tests) and
  legacy-a (46) are unchanged and green.

## 0.4.2 — Session V3 current-surface system prompt

- Structured compaction reads the current model-visible system prompt from
  `session.surface.nodes` + `eventAt`, so A→B→A normalization that clears only
  the tail still keeps head A. Empty later nodes stay dormant; a fully empty
  surface is "no prompt".
- Verified against published DSH `0.1.5-rc.1` Session plus `0.1.2-rc.1` host
  installer matrix. Does not claim `0.1.5-*`.

## 0.4.1 — long-session native compact stability

- Compact-path sanitization keeps completed text and paired tools from error/aborted
  assistant turns. Replay metadata is validated after the lab-route→native provider remap.
  Interrupted call/result order is rejected; nested tool-result payload is not extra pairing.
- Official Basic still owns shrink/pressure. Owner `estimateCheckpoint` remains
  `JSON.stringify(items)/4` and is not a verified native occupancy oracle.

## 0.4.0 — explicit reader-text and compaction benefit

- Add restart-safe `/codex-native reader-text` on applicable standard routes. It uses
  one owner-bound stream with native replay and Basic's complete instruction, including
  text-only histories. `/codex-native on` restores native output; defaults are unchanged.
- Reader failures do not try native compact or the stock adapter, and cannot commit a
  summary. Identity, protocol, cancellation, image and legacy guards remain intact.
- Add bounded metadata-only benefit observation through public session events. Report
  real replacement/clean-end proof, before/after pressure and anchors, heuristic old
  span minus framed replacement, duration, step interval, and retained/opaque lengths.
  Missing or incomparable evidence is unknown; ordinary idle events do not scan history.
- Preserve Basic's complete instruction and add JSON scalar-type fidelity guidance only
  for explicit reader-text. A finite real opaque-only fixture recovered all seven facts
  and types after the correction; this is not a general schema or automatic-policy guarantee.
- Accept exact CLI 0.1.2-alpha.3 alongside 0.1.2-rc.1; host package pins stay rc.1.
- Accept optional SDK diagnostic terminal phases failed/cancelled/timed-out. Proposed
  owner 5.1.5 supplies them and omits unavailable wire counters; older owners remain valid.
- No core/meter/owner-codec changes, automatic strategy selection, publication or deployment.
  Real validation and synthetic integration evidence are recorded separately.

## 0.3.3

Companion remains published `dsh-token-usage` `5.1.3`; no owner contract or codec change.

- Replay user and tool-result images alongside native checkpoints through the public
  PiAiAdapter attachment/access resolvers and the existing account-owned stream.
- For mixed carrier/image histories, official Basic uses one compaction-budget owner
  lease and its full instruction to obtain a readable `reader-text` summary. Basic
  still owns validation, usage, shrinking and commit. No retry or stock fallback on
  reader-text failure; legacy structured native compaction remains text-only.
- Materialize all three image bounds from the published Pi Config schema. Omitting
  pixel/byte budgets caused the real attachment store to reject valid references with
  `INVALID_ATTACHMENT_REF`; stricter mocks and real temporary-store tests cover it.
- Preserve model image capability, carrier/identity/role guards, host image offloading,
  and the 0.3.2 setup/idle/total deadline behavior. No old history or images are rewritten.
- The repaired runtime passed a real original-session reply with normal completion and
  no tools. Mixed Basic compression is tested in isolation, not claimed as an additional
  live compaction. Release identity and fixed-tag installation results are recorded in
  the GitHub release, separately from local-link acceptance.

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