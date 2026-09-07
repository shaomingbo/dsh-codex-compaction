# dsh-codex-compaction

[中文](README.zh.md)

`0.3.0` is the **stable release**: the stock official `BasicCompactionEngine` stays
the primary and only automatic compaction backend, and this package adds an optional
account-owned **native summarization/replay seam** for standard `openai-codex` sessions
plus the legacy structured reader. No DSH core patches, no second login. The fixed
tag below is assumed only after the maintainer has actually pushed and verified it;
the historical RC tags (`0.3.0-rc.1`, and `5.1.0-rc.1`/`5.1.0-rc.2` for the companion
account package) are retained.

## Install (after the tag exists)

```bash
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0
```

No arguments means `install`; default profile is `web`. Other commands:

```bash
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0 status
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0 uninstall
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0 install --profile <name> --source link:<local-path>
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0 --help
```

- The installer requires the exact tested `dsh` CLI **`0.1.2-rc.1`** on PATH and delegates
  every mutation to the public `dsh plugin` CLI with `--ignore-scripts` (pnpm 11 remove
  uses `--config.ignore-scripts=true`, not its unsupported shorthand). It verifies
  manifest postconditions and reports failures honestly; rc.1 does not promise rollback.
  Only top-level launcher help is probed: plugin help would initialize a profile.
- **If `dsh` is missing, a different version, or the plugin command fails, the installer
  fails closed with guidance.** There is no direct-manifest fallback. Check
  `dsh --version`; note the historical PATH CLI `0.1.2-alpha.3` is a different, older
  build than the tested `0.1.2-rc.1` and is rejected.
- Companion account package: **`dsh-token-usage` `5.1.0`** from the same release
  train (`github:shaomingbo/dsh-token-usage#v5.1.0`). It is a capability companion,
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
   - At most **one transparent text fallback** per recoverable native failure, inside
     the same owner lease — same account, model and endpoint. Cancellation, identity
     mismatch, invalid checkpoints and histories that already contain native carriers
     never fall back; those requests fail with a fixed error code.
   - **Image histories are not taken over** in this first release; they keep the stock
     text path. Native carriers mixed with unsupported media are rejected explicitly.
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