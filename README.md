# dsh-codex-compaction

[中文](README.zh.md)

## Unreleased 0.1.7-alpha.1 migration candidate

This worktree targets **only DSH 0.1.7-alpha.1**. It has not been installed, published or GUI-accepted; the existing package/tag version remains historical, not a distribution of these changes. Sections below describe the old release and do not extend this candidate's support matrix.

Select the declarative `codex-native-b` preset (standard plugins with a summarize-only `BasicCompactionEngine` subclass). `/codex-native on`, `reader-text`, or `off` is per-session; default is off. `nativeCompaction` enables capability, not preference. Basic alone selects, prunes, meters and persists. Owner-direct summaries never claim `llmStreamCall:true`; native usage comes only from observed receipts. Middleware is replay-only. Setup no longer copies or rewrites presets. Recovery uses public asynchronous `sessionQuery.readSession` command events. No automatic update of existing session preset snapshots is claimed.

Synthetic tests retain the pi-ai 0.84.4 owner double against the target adapter. Live owner/pi-ai 0.85.1 replay, GUI, installation and production migration remain unverified. See `THIRD_PARTY_NOTICES.md` for copied standard declaration/instruction licensing.

**0.4.2:** Session V3 current-surface system prompt for structured compaction, plus the
`0.4.1` long-session native compact stability line. Does not claim `0.1.5-*`.

**Historical `0.3.3`** repairs user/tool-image replay alongside native checkpoints and adds
owner-bound reader-text summarization for mixed histories. It uses the published Pi
configuration defaults, including image pixel/byte budgets, with real attachment-store
regressions. No account update is required beyond the existing **`5.1.3`** companion.
The `0.3.2` + `5.1.3` deadline corrections are retained. The repaired runtime passed an
authorized original-session replay; mixed Basic summarization is separately covered by
isolated integration tests. Exact tag identity and tag-installation results belong in the release.

This pair retains the historical recovery correction from `0.3.1` + `5.1.2`.
The stock official `BasicCompactionEngine` stays the primary
and only automatic compaction backend; this package adds an optional account-owned
**native summarization/replay seam** for standard `openai-codex` sessions plus the
legacy structured reader. No DSH core patches, no second login. Use the matching fixed
tags below; publication identity and tag installation checks are recorded in GitHub releases. Historical
`0.3.0`/`0.3.0-rc.1` and companion `5.1.0`/`5.1.1`/`5.1.0-rc.1`/`5.1.0-rc.2`
tags and their validation evidence are retained.

## Install (after the tag exists)

```bash
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.4.6
```

No arguments means `install`; default profile is `web`. Other commands:

```bash
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.4.6 status
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.4.6 uninstall
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.4.6 install --profile <name> --source link:<local-path>
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.4.6 --help
```

- The installer requires the exact `dsh` CLI **`0.1.2-alpha.3`, `0.1.2-rc.1`, `0.1.5-rc.1`, or `0.1.5-rc.2`** on PATH and delegates
  every mutation to the public `dsh plugin` CLI with `--ignore-scripts` (pnpm 11 remove
  uses `--config.ignore-scripts=true`, not its unsupported shorthand). It verifies
  manifest postconditions and reports failures honestly; rc.1 does not promise rollback.
  Only top-level launcher help is probed: plugin help would initialize a profile.
- **If `dsh` is missing, a different version, or the plugin command fails, the installer
  fails closed with guidance.** There is no direct-manifest fallback. Check
  `dsh --version`. This exact launcher matrix does not widen the plugin's pinned
  **0.1.2-rc.1 host packages**, nor identify the version of an already running GUI.
- Proposed companion for corrected SDK-stream diagnostics: **`dsh-token-usage` `5.1.5`**
  (`github:shaomingbo/dsh-token-usage#v5.1.5`, only after publication and acceptance).
  Older compatible owners still execute, but their stale/missing diagnostics are not fixed by this consumer. It is a capability companion,
  not a registry dependency: this package never guesses account versions and instead
  preflights the `codex-runtime/v1` protocol and auth owner at runtime. Adjacent/older
  DSH versions are unsupported or unknown; only what the CI matrix runs is claimed.
- Bundle changes need a user-performed restart of the corresponding profile (and a hard
  refresh for the Web GUI). No script starts, stops or replaces the running host.

## What you get

1. **Standard sessions stay standard.** New and existing plain `openai-codex` sessions
   keep the official basic automatic compaction (triggers, pressure, overflow recovery,
   retention, meter, shrink checks, commit/flush). Nothing about the default path changes
   until you opt in.
2. **Per-session native compaction, off by default.** Run `/codex-native on` in a live
   session to let the account-owned native runtime produce the compaction summary
   through the same official engine. `/codex-native off` stops new native creation —
   existing native state stays readable through its matching reader. `inherit` returns
   the session to the profile default (profile default is **off** in this release;
   enabling it is a reviewed rollout step, not a packaging default). Preferences
   survive host restarts.
3. **Honest boundaries.**
   - A native summary counts only after official basic replaces history in the session
     log. `/codex-context` shows the observed logical replacement and the last attempt;
     it does not independently confirm host-owned disk persistence.
   - At most **one extra recovery request** per owner lease: native retry OR transparent
     text fallback — same account, model and endpoint, never stacked or renewed.
     Cancellation, expired leases, identity/protocol errors and invalid checkpoints do
     not trigger recovery. Histories with native carriers never fall back to text.
   - **Image replay repair (0.3.3):** ordinary native-reader requests support user
     and tool-result images through the host's durable attachment service and public Pi
     conversion. Image-only histories still use stock Basic. Mixed native-carrier/image
     histories use one owner-bound **reader-text** summarization request with Basic's
     instruction, then Basic commits a readable text summary. This is an intentional
     mode, not a failure fallback or native image compaction; the v1 codec stays text-only.
     Missing attachments, text-only models, invalid media roles and damaged carriers
     still fail closed. Host image projection/offloading limits remain unchanged.
   - **Semantic recall is lossy, distinct from safety refusals.** A native checkpoint
     replays a compacted summary, not the original conversation: the envelope format
     and the replay chain can be entirely valid and the model may still answer that it
     does not remember already-compacted details. Compaction does not guarantee
     lossless recall; keep critical state, decisions and code references in project files and
     reread them when needed. An earlier synthetic-code recall failed despite valid replay.
   - Unknown checkpoints, identity mismatches and damaged payloads are refused —
     opaque native state is never silently reinterpreted as ordinary text.
   - `gpt-6-astra` and other custom models resolve only through the account's trusted
     metadata seam (public host-configured profile fields, whitelisted). Missing or
     conflicting metadata is a concrete fixed-vocabulary gap, never an invented value.
4. **Legacy compatibility.** Pre-existing structured sessions keep the
   `codex-native-lab` route and the archived B preset. `/codex-compact-setup` now exists
   only for that compatibility path and is clearly marked legacy; new users should stay
   on standard sessions. Old logs are never rewritten and old readers are preserved.
   Uninstalling the entire package removes the DSH bridge too; keep a matching reader
   for native histories.

## 0.3.2 request deadline correction (paired with owner 5.1.3)

- Ordinary owner `open` uses a **1800000ms total budget** and **120000ms setup budget**.
  The replay/text converter uses the existing public DSH PiAiAdapter **300000ms idle
  watchdog**, not a new SSE monitor. Setup, total duration and stream inactivity are distinct.
- `purpose: 'compaction'` retains its **300000ms total budget** including setup, with no
  separate shorter setup cap. Its converter idle allowance stays **300000ms**. Retries and
  same-lease fallback never renew the owner deadline.
- Owner factory `timeoutMs` remains the total-budget option, including explicit short-call
  values. New `setupTimeoutMs` defaults to `min(timeoutMs, 120000)`;
  `compactionTimeoutMs` defaults to `min(timeoutMs, 300000)`. These are owner factory
  settings, not duration overrides exposed by `open` or this plugin.
- Existing diagnostic `budgetMs` still means the selected total budget. Optional
  `totalBudgetMs`, `setupBudgetMs`, `timeoutBudgetMs` and `timeoutKind: 'setup' | 'total'`
  disclose deadline facts only. Owner deadline errors retain `CODEX_RUNTIME_TIMEOUT`;
  the public Pi idle watchdog retains **`TIMEOUT`**. No credentials or body text are exposed.
- Older owners remain readable/compatible with optional diagnostics absent, but keep their
  old request budgets. Updating only the consumer cannot remove the owner's old total cap;
  **update the pair together** for the complete correction.

Tag identity and tag-installation results are recorded in the release; current-host acceptance
is recorded separately, not inferred from local tests. Historical acceptance below is not
evidence for the new ordinary-request deadline policy.

## Historical 0.3.1 recovery correction

In `0.3.1` + `5.1.2`, native compaction leases/converters got up to 300 seconds, while ordinary
request leases and replay/text converters stayed at 120 seconds. Fixed-field diagnostics report phases, timings,
byte/request counts, `budgetMs` and fixed-enum `eventCounts`, never raw content or identifiers.
See [the contract](docs/CODEX_RUNTIME_V1.md).

Native SSE finishes at a valid `response.completed`/`response.done` with one valid compaction
item, without waiting for HTTP EOF. Premature EOF (including truncated frames) or socket failure
is recoverable `CODEX_RUNTIME_RESPONSE_STREAM`; malformed protocol is non-retryable
`CODEX_RUNTIME_RESPONSE_PROTOCOL`. The first lease stop reason (TIMEOUT/CANCELLED/CLOSED/DISPOSED)
is preserved. There is **one shared extra request**: network/5xx/premature stream failures prefer
one native retry after 200ms; other allowlisted availability failures may use one same-lease
text fallback. These cannot stack, change accounts or reset the deadline; expired leases never
receive fallback. Native-to-text fallback is plugin policy, not an official Codex behavior claim.

After a terminal attempt fails, this plugin suppresses new taken-over compaction requests for
60 seconds per session/provider/model. Ordinary task requests continue; the next eligible
official trigger retries automatically. `/codex-context` and `/codex-native status` disclose
the failure and next allowed time. Only an observed successful official history replacement
with a clean end clears failure state; streaming a summary alone does not. This state is bounded
and process-local (reset by restart), with no new command, storage schema or model-capacity
override. Persistent compaction failures and hard context limits can still stop a task.

An authorized real run selected 300000ms, completed in 157372ms with one request and a valid
item plus completed event, and produced a new official Basic history replacement with about
146849 tokens shadowed. The maintainer read summary/user-message/end and successful command/done
back from the disk journal. This is evidence for that run, not fsync, crash recovery or a fix
for every timeout. The maintainer reran the frozen production candidate: 498 tests passed
(plugin 135 + legacy-A 46 + comparison 34 + account 266 + paired 17), as did the rc.1 temporary-home
installer cycle. Final packaging checks and release-tag installation remain separate steps. See [recovery validation](docs/RECOVERY_FIX.md).

**Known non-blocking limitation:** cancellation may display `CODEX_RUNTIME_ERROR`.
Refreshing can cancel a pending manual command; tab switching alone has not been shown to
cancel it. This display issue is retained as a limitation, not a release blocker.

## Development

Node >= 24, pinned public DSH `0.1.2-rc.1`. No install lifecycle scripts.

```bash
pnpm install --frozen-lockfile --ignore-scripts
npm run check                       # unit + frozen legacy-A + comparison tests
npm pack --dry-run --ignore-scripts
git diff --check
node scripts/validate-cli.js         # temporary DSH_HOME; no boot
npm run test:accounts-integration -- <isolated-account-source>
                                     # e.g. the paired release worktree; the script
                                     # builds a temporary source/dependency snapshot
```

The paired integration suite copies the sibling account checkout into a temporary
directory and installs dependencies there with ambient credentials cleared. **Never run
`pnpm install` in an account workspace whose `node_modules` links to the live profile.**

Offline tests use fake auth/transport and synthetic data only. No real-account
availability, token, cost or latency claim follows from them.

See [architecture](docs/ARCHITECTURE.md), [capability contract](docs/CODEX_RUNTIME_V1.md),
[verified validation facts](docs/VALIDATION.md), and [CHANGELOG](CHANGELOG.md).

MIT.