# Controlled compaction A/B — experiment, not a shipped backend

[中文实验报告](../../docs/COMPACTION_AB_REPORT.md)

Run from the repository checkout:

```bash
npm run test:compaction-ab
npm run experiment:compaction-ab
```

The runner now writes `experiments/compaction-ab/rerun-results.json`; the original `results.json` and report digest are preserved. A is frozen in `a-baseline/` after B became the candidate direction. Its added archive comments/import paths change source hashes, not the historical experiment's numeric claims. No credentials, real sessions, provider traffic, server, installed profile, production backend or account plugin is changed. All actual DSH imports use the pinned published public interfaces. The B backend is not exported from package.json and `experiments/` is not in the package file list.

## What is compared

- A: the existing `NativeBasicCompactionEngine`, backed by actual basic transaction/selection logic.
- B-matched: a separate public CompactionEngine carrying structured source JSON, with the **same output price** as an actual A-framed checkpoint. This is the carrier-location control.
- B-native-estimate: the same B implementation with a disclosed synthetic opaque pricing heuristic. It is not an authoritative token count.

The 72-case grid and interpretation rules are in [PROTOCOL.md](PROTOCOL.md). Each case runs all variants; provider request/output hashes, selected ranges, prices and admission are recorded. Same-price admission divergence aborts the run instead of being counted as a win.

Three restored rounds use scratch JSONL and a separate Node process that reads/validates the exact native checkpoint, followed by a new live SessionStore seed for the next request. This is not a full DSH application or production-persistence restart and does not measure semantic recall.

The failure matrix records both safety outcomes and raw bracket traces. A pre-aborted explicit region records a failed bracket while B exits before opening it; both must make no provider call/replacement and leave no unmatched attempt. The difference remains visible, not normalized away.

## Usage-anchor challenge and prototype repair

The initial B total formula added the hidden checkpoint price to `host.totalTokens` even when a reusable provider-usage baseline already included that checkpoint. The original measured values and source hash are retained in `usage-anchor-observation.json`.

The extended challenge compares the initial formula with the corrected prototype. The correction must account for **current hidden delta minus the hidden delta covered by the usage anchor**, using only public host observation/replay. Same-count later anchors, changes after the anchor and host clamping require their own tests. If an anchor cannot be verified, the prototype must fail rather than invent a number. No production engine is changed by this repair.

Synthetic usage in this challenge is explicitly a test input to exercise the real host's usage-baseline branch. It is not a real-account observation or a token oracle. The full runner requires the corrected prototype not to double-count it and separately exposes the initial formula's excess.

## Evidence boundary

Passing test plumbing does not establish real Codex availability, actual context savings, task-fidelity gains, automatic-trigger quality or upgrade-maintenance cost. Source size is an ownership inventory, not a performance or architecture score. Read the experiment report and raw results before choosing a rollout direction; neither variant is automatically selected or deployed.
