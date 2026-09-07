# Compaction A/B protocol — preregistered engineering experiment

Question: does inheriting basic justify retaining a text envelope, or does an independent public CompactionEngine offer enough structural benefit to warrant owning its lifecycle? This experiment does not choose a production architecture.

## Variants

- **A-basic**: existing production NativeBasicCompactionEngine; real official selection/transaction and text-envelope pricing.
- **B-matched-price**: independent structured backend; checkpoint pricing calibrated from an ACTUAL successful A carrier (same framing/body) through the same official meter. This ablation separates storage location from the chosen price model.
- **B-native-estimate**: same B implementation, with a disclosed opaque replay heuristic (decoded base64 length minus 650 framing bytes, divided by four; ordinary retained item JSON length divided by four, +16). This is an estimate copied in spirit from the researched design, NOT provider token truth.

No opaque payload is treated as free merely because source metadata is invisible to the default meter. Report both the host meter and the backend's effective estimate.

## Controls

All variants use the same pinned DSH 0.1.2-rc.1 public libraries, pi-ai 0.84.4, model identifier, history, exact selected region and deterministic fake Codex response. The actual existing provider converter/NativeTransport is shared. A bridge projects structured B checkpoints into the same validated provider replay path for the experiment only. Compare provider-visible input hashes (not representations in DSH storage) to test fairness.

No credentials, live histories, real account requests, server boot, profile install, core changes, production route/preset changes, stage or commit. Prototype B is not exported or packed. The current 94-test production suite remains a separate regression baseline.

## Matrix fixed before results

- History families: ASCII assistant logs, CJK assistant logs, paired tool-result bulk.
- Bulk sizes in JavaScript characters: 4,000 / 16,000 / 64,000.
- Synthetic base64-shaped ciphertext lengths: 256 / 1,024 / 4,096 / 8,192 / 16,384 / 32,768 / 65,536 / 131,072.
- Every Cartesian-product case runs all three variants; do not report only favorable cases.
- Explicit region tests have an open owning turn and identical range. Manual restoration/failure tests use the appropriate public idle maintenance contract.

## Metrics

Admission or rejection; selected canonical/effective price; encoded carrier price and byte length; complete compaction-event batch byte length (including any duplicated summary/carrier payload); host/effective post-pressure; protocol request/response sizes; provider input identity; exact opaque JSON equality after storage/replay. Wall-clock timings, if recorded, are local harness overhead only and cannot rank model latency.

Restoration: three rounds, JSONL/public-session restore, identical provider-visible native inputs, no loss of opaque unknown fields. These test state plumbing, not semantic memory or task success.

Failure scenarios: provider failure, cancellation before/during, invalid tool pairing, selected-history rewrite, tail append (manual versus explicit region), active lock, missing turn, nonshrinking output, invalid summarizer usage rejected by the host commit, and manual flush failure. Distinguish replacement visibility from durability and require matched semantics, not matched English error strings.

Maintenance: list the public host contracts and responsibilities each variant owns. Source size is an inventory, not an empirical upgrade-cost measure. No multi-version portability claim follows from a single pinned runtime.

## Interpretation gates

A versus B-matched-price must have equivalent input and admission decisions. A mismatch is a fairness/implementation defect to investigate, not a victory for either variant. If B-native-estimate admits more cases, that proves sensitivity to the chosen estimator, not lower real model usage. Identical expanded wire input means moving the carrier alone saves no provider-context tokens.

Real service availability, token accuracy, semantic task fidelity, full DSH application/production-persistence restoration, images, automatic-trigger behavior and upgrade maintenance cost remain unmeasured unless explicitly tested later. Report limitations next to conclusions. Decide direction with the user after the report, not in the experimental implementation.

## Execution amendments (grid and pricing comparisons unchanged)

- Preserve the observed pre-cancel trace difference (A opens/closes one failed bracket; B opens none). The parity gate compares safety effects and balanced attempts, not exact trace counts.
- Fix the history-rewrite fault fixture to include the public sourceEventSeqs contract; assert a native output was actually produced before rejection, so a fixture transport error cannot masquerade as a successful stability test.
- Add a separate-process JSONL checkpoint reader and actual normal-inference converter replay after each restored round. Synthetic replies prove request plumbing only, not task recall.
- Add an adversarial reported-usage anchor challenge. The initial B formula double-counted opaque state already covered by usage; preserve that observation, repair the prototype through public prefix replay, and compare original/corrected formulas. Include same-count later anchors, post-anchor replacement, interruption and nonnegative clamping. Synthetic usage is explicitly not a provider-token oracle.
