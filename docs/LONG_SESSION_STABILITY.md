# Long-session native compaction stability

Offline, synthetic evidence only. Not a live-account, semantic-recall, or token-oracle claim.

## Baseline

| Item | Value |
| --- | --- |
| Compaction checkout | `e78085d` `dsh-codex-compaction@0.3.3` plus this unreleased stability delta |
| Host peers | published DSH `0.1.2-rc.1`, pi-ai native alias `0.84.4` |
| Paired owner | published `dsh-token-usage@5.1.3` (`dddb7f2`), isolated snapshot via `scripts/test-accounts.js` |
| Architecture | official Basic owns trigger/selection/shrink/commit; owner runtime owns codec/transport/replay estimate; this plugin owns the public seam |

The sibling accounts working tree may be on an unrelated branch. Pairing never installs into that workspace and never uses a fake runtime as a substitute for the owner.

## Coverage

| ID | Scenario | Result |
| --- | --- | --- |
| P0-A 异常历史 | 取消/失败 assistant、完成工具、未完成工具留在 tail、用户 marker | **通过**（配对 wire） |
| P0-A replay 校验 | `version:999` 在发请求前 `CODEX_NATIVE_REPLAY_INCOMPATIBLE` | **通过** |
| P0-A 工具时序 | call → user → result 拒绝，不把双 result 送上 wire | **通过** |
| P0-B 连续压缩 | 三轮 Basic；旧 HIST 不回灌；无收益只认 shrink cause | **通过** |
| P0-C 计量 | 宿主成帧估计 vs `JSON.stringify(items)/4` vs 字节 vs 替换后压力阈值 | **表征通过；接通 Basic 与“真实占用”均 blocked** |
| P1-A 取消 | 远端中取消；远端成功后提交前取消；提交后取消非回滚；选区内 replace | **通过**（选区内为拒绝提交/宿主拒绝，不是完整回退 API） |
| P1-B 持久化 | 成功 journal 重建；flush 失败不改磁盘；rename 后通知失败磁盘已新；均不进 native cooldown | **通过** |
| P1-C 分叉 | checkpoint 前后 fork；两分支普通重放；同 ctx `create({seed})` | **部分覆盖**（不是第二进程独立 context） |
| P1-D 超限 | 大工具+system+tools+checkpoint 检查转换后 wire 或 owner 治理码；HTTP 400 正负对照 | **部分覆盖**（未宣称线上超窗口语义） |
| P1-E 429 | 一次请求、无 fallback | **通过** |
| Retry-After | owner 无 `retryAfterMs` | **blocked** |
| 附件 store | 仅当测试 importer 找不到该包本身才 skip | **skip（布局）**，不是包内部缺依赖的通行证 |
| 真实账号 | 按任务禁止 | **未运行** |

`npm test` covers unit/seam. Paired tests run only through `node scripts/test-accounts.js <isolated-account-source>`.

This iteration: `npm run check` **175 plugin + 46 legacy-A + 34 comparison passed**, 4 durable-attachment cases skipped (package not resolvable from this importer). Isolated pairing against owner `v5.1.3` `dddb7f2`: **275 account + 41 integration passed**, 1 existing optional 130s realtime case skipped. `npm pack --dry-run --ignore-scripts` and `git diff --check` passed. No live profile, credentials, or real model requests.

## Confirmed fixes

1. Error/aborted pi-ai replay used to skip the whole assistant turn. Compact sanitizes **only after** the replay envelope is a supported pi-ai v2, source-aligned, block-aligned record. Invalid metadata (`version:999`, non-string `responseId`/`responseModel`, kind/block mismatch) stays `CODEX_NATIVE_REPLAY_INCOMPATIBLE` with **zero** compact requests. Lab-route messages (`source.provider=codex-native-lab`, `replay.provider=openai-codex`) use the same remap `prepareHistory` already applied, so generated legacy history remains compactable.
2. Tool pairing is ordered: a user/assistant text message cannot interrupt an unmatched call, and a later assistant cannot open new calls while prior calls are unmatched. Those structures are rejected instead of letting the SDK insert `No result provided` and then emit the real result.

## Already correct (regressions only)

- Basic instruction tail is recognized by plugin source, not user substrings.
- Checkpoint detection is compact-source + envelope prefix, not marker quotes.
- `compaction_trigger` is request-only; owner codec rejects it in checkpoints.
- Native retry and text fallback do not stack; 429/cancel are not fallback entries.
- Observed usage excludes cache-read from `inputTokens`; unavailable ≠ fabricated 0.

## Blocked / not claimed

- **P0-C Basic 定价接口：** shrink/pressure 仍用宿主 `estimateMessage`（成帧信封）。没有公开钩子。
- **P0-C owner 估计本身：** `estimateCheckpoint` = `ceil(JSON.stringify(items).length / 4)`，`basis` 为 `native-replay-json-utf16/4`，`exact: false`。items 含 `encrypted_content`，**不是**已验证的原生上下文占用。接通 Basic 接口也不会自动变成精确 occupancy。
- **P1-E Retry-After：** 无公开 `retryAfterMs`。保持不重试、不 fallback。
- **保存成功后的通知失败 / 跨进程独立 context：** 没有另造第二套事务或伪造 export API。

## Host guarantees this plugin does not replace

- Tool-pairing cuts exclude unpaired tools from the compacted span.
- Shrink rejection of a non-smaller framed summary.
- `session/flush` listeners are the durability seam.
- Overflow recovery only for `CONTEXT_WINDOW_EXCEEDED`.
