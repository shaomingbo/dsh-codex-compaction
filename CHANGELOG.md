# Changelog

## 0.3.0

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