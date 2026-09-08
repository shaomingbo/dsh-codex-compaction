# Request deadlines and compaction recovery / 请求期限与压缩恢复

## 0.3.2 + 5.1.3 correction / 请求期限修正

The companion pair separates ordinary setup, total duration and converter inactivity:
ordinary owner `open` selects **1800000ms total** and **120000ms setup**, while the companion
replay/text converter uses the existing public PiAiAdapter **300000ms idle watchdog** instead
of 120000ms. No new SSE monitor is added. Owner setup/total errors retain
`CODEX_RUNTIME_TIMEOUT`; the public Pi idle error retains **`TIMEOUT`** with a fixed idle-timeout
message, never arbitrary upstream details.

Compaction-purpose opens retain **300000ms total**, including setup, with no separately shorter
setup cap; native converter idle stays **300000ms**. Retry and same-lease fallback do not renew
the original deadline. Owner factory `timeoutMs` retains total-budget and explicit short-call
semantics; `setupTimeoutMs` defaults to `min(timeoutMs, 120000)` and `compactionTimeoutMs` to
`min(timeoutMs, 300000)`. The consumer cannot supply arbitrary durations through `open`.

Existing diagnostic `budgetMs` still denotes total budget. Optional nonnegative safe-integer
`totalBudgetMs`, `setupBudgetMs`, `timeoutBudgetMs` and strict `timeoutKind` (`setup` or `total`)
distinguish selected budgets and deadline failures, without bodies, credentials or raw messages.
Old owners/readers remain compatible with missing optional fields, but updating the consumer
alone cannot change an old owner's total cap: both companion updates are needed.

本次配对为 **compaction 0.3.2 + owner 5.1.3**：普通总预算 1800000ms、setup 120000ms、
公开 Pi idle 300000ms；compaction 总预算仍为 300000ms 且没有额外较短的 setup 限制。
旧 owner 读取兼容但不自动获得新总预算，完整修复必须成对更新。tag 身份及 tag 安装结果
记录在 release；当前 host 验收单独记录，此处不宣称发布或 live 验收已完成。
下方 498 项、157372ms 等记录均属于旧配对，不作为本次实测。

### Local paired evidence / 本地配对证据

The coordinating maintainer reports 275 owner tests and 25 paired tests passing, including an
actual elapsed 130018ms tool-argument stream with fake credentials/transport. This exercises
the real local owner/converter composition beyond the old 120-second cap; it is not a real
upstream request or a current-host acceptance test. The final companion full-suite rerun after
the idle diagnostic change passed 138 main + 46 legacy + 34 comparison tests; both package
pack dry-runs and diff checks passed. Temporary-home public installer cycles and actual
installed ESM entry loads passed for account on alpha.3 and the pair on rc.1, using local links.
Those probes covered first/repeat install, read-only status, config dump, uninstall and repeat
uninstall without starting a server or touching the real profile. Fixed-tag probes and
current-host acceptance are separate release/deployment records.

协调维护者已实测 owner 275 项、paired 25 项通过，含实际耗时 130018ms 的假凭据/传输工具
参数流；idle 诊断修改后的 companion 全量复验通过 138 main + 46 legacy + 34 comparison。
两包 pack dry-run/diff 检查通过。临时 HOME 的公开安装器首装/重装/status/dump/卸载/重复卸载
及实际安装入口 ESM 加载通过：账户安装器 alpha.3、配对 rc.1，使用本地 link，未启动服务器。
这些证据不代表真实上游、固定 tag 安装或当前 host 验收；后续分别记账。

## Historical 0.3.1 + 5.1.2 scope and evidence / 历史范围与证据

**All remaining sections preserve the 0.3.1 + 5.1.2 policy and evidence.** Their ordinary
120-second limits and acceptance results are historical, not the current policy above.

The recovery fix has passed an authorized real acceptance run on the original instance.
The release pair is compaction 0.3.1 + account 5.1.2; tag identity and release-tag
installation checks are recorded separately in the GitHub releases. The frozen production candidate's full regression has been rerun; final
packaging checks and release-tag installation remain separate maintainer steps. The production compaction target remains published DSH 0.1.2-rc.1.
Account auth SDK 0.82.1 and native protocol alias 0.84.4 stay pinned; no dependency or
checkpoint version changes.

Historical stage: the initial source correction below was synthetic-only, with no commit,
tag, installation, profile mutation or host restart at that stage. Those limits describe the
initial stage, not the later real acceptance documented here.

A synthetic differential reproduced the completion defect: the same valid native compaction
item and completed event succeeded when the HTTP body closed, but timed out when it stayed
open. Existing codec tests passed while that regression failed. An actual runtime with fake
auth/fetch also reproduced lease TIMEOUT becoming CLOSED when fallback reused the dead handle.
These prove code defects, not that either explains every timeout in a particular live session.

本地差分验证：相同合法压缩项及 completed 事件，HTTP body 关闭则成功，不关闭则超时；
既有 codec 测试未捕获。真实 runtime 配合假认证/传输还复现了 TIMEOUT 被 CLOSED 覆盖。
这些是源码缺陷证据，不能据此推断某真实会话的所有超时均由同一原因造成。

## Implemented boundaries / 实现边界

- Completed/done plus one valid compaction item is the stream boundary. Stop reading and
  release the reader there; ignore later bytes even in the same chunk. Before the boundary,
  malformed/duplicate items, incomplete status, UTF-8, JSON and resource guards still apply.
- EOF before completion (including a truncated JSON/SSE/UTF-8 frame) and socket-read disconnect are retryable RESPONSE_STREAM;
  native protocol rejection is RESPONSE_PROTOCOL. No partial checkpoint is committed.
- First stop reason survives handle reuse: TIMEOUT, CANCELLED, CLOSED or DISPOSED. Keep the
  original lease deadline: native compaction 300 seconds, ordinary requests 120 seconds;
  never renew or reopen it for recovery. Native converters use 300 seconds; replay/text
  converters stay at 120 seconds. The earlier completion-only stage used 120 seconds for both.
- Standard seam permits at most one extra request: network/5xx/stream failure prefers a
  native retry with 200ms cancellable delay; other allowlisted availability failure can use
  one text fallback. Both share the same lease/account/model and cannot stack. Expired leases,
  cancellation, protocol and identity errors do not trigger recovery. Carrier histories never
  fall back to text. The runtime adds no hidden retries; legacy behavior is preserved.
- Process-local, bounded admission state is keyed by session/provider/model. A terminal
  failure sets a 60-second interval; overlapping or deferred requests open no lease and do
  not extend that interval. Ordinary generation is not blocked or paused. The next eligible
  official compaction trigger retries, without a timer job, new command or storage schema.
- Public compaction events correlate failure/commit once per transaction. Only matching
  clean compaction/end plus replacement source evidence clears failures; shrink rejection
  and commit rejection do not. Status commands separate output from observed replacement.

任务继续不意味着无上限运行：压缩长期不可用时，上游窗口硬限制仍可能使任务失败。
冷却内官方仍可能记录快速失败事件，不是再次发出远程压缩请求。重启清空冷却状态；
仅更新 consumer 不会使旧 runtime 自动获得新的流完成语义或错误分类。

## Fixed-field diagnostics / 固定字段诊断

The separately approved phase-probe increment is included in this release as optional `operation.diagnostics()`
(and the same fixed snapshot on open-time failures). The consumer accepts only fixed enums
and nonnegative integer timing/count fields, keeping old owners compatible. `/codex-context`
and `/codex-native status` show the last finished attempt's diagnostic snapshot.

It distinguishes model metadata, account binding, request preparation, waiting for headers,
waiting for body, reading SSE and validated completion. Timings use a monotonic clock and
are milliseconds since the original lease started. Request counts are lease-wide; response
counters describe the latest request. Event names are mapped to a fixed vocabulary, never
copied verbatim. Only byte counts are retained, not the counted content. Closing the lease
freezes elapsed time and prevents late uncooperative I/O from changing the sample.

No prompt, tools, headers, token, account id, URL, SSE payload or opaque item enters the
snapshot. Samples are process-local and vanish on restart. The historical phase-only probe
did not change deadlines, recovery budgets, profile defaults, credential handling or
request-body semantics. The separately approved Native-only budget increment below did
change the native deadline. A completed protocol marker alone still does not prove official
history replacement or explain every earlier timeout.

## Native-only 300s budget / 原生专属期限

After the historical phase-probe acceptance, a separately approved increment selected a
300000ms owner lease only for compaction opens; ordinary owner requests remain 120000ms.
The native converter's idle guard is also 300000ms: an isolated regression demonstrated
that changing only the owner still failed at the converter's old 120000ms boundary, since
no pi chunk is emitted until native completion. A mock-clock real-owner/Basic test completes
and replaces history at 200000ms, with one request and one auth resolution. That test is
synthetic, separate from the later real acceptance below.

The owner deadline begins once at open, including metadata/auth. Neither retry nor fallback
renews it. The transport's internal maximum permits 300000ms but remains subordinate to the
owner's abort signal. No recovery count, delay, endpoint or request-payload semantics change.
Diagnostics add actual `budgetMs` and bounded fixed-enum `eventCounts`; raw names/content
remain excluded. This accepted release policy is not a latency SLA or an all-timeout fix.

## Verification / 验证

### Historical 0.3.1 + 5.1.2 frozen candidate / 历史冻结候选

The maintainer reran **498 passing tests**: `npm run check` gives plugin **135**, frozen
legacy-A **46**, comparison **34**; `node scripts/test-accounts.js <account-source>` gives
account **266** and paired **17**. Tests use synthetic data/auth/transport and fresh isolated
source/dependency snapshots with frozen lockfiles and disabled lifecycle scripts.
`scripts/validate-cli.js` also passed a real rc.1 temporary-home install/repeat/status/
`--dump-config`/uninstall cycle, without booting a host or touching the live instance.
Final documentation/package/diff checks and release-tag verification remain separate.

### Authorized real acceptance / 获准真实验收

- Selected `budgetMs`: **300000**; elapsed: **157372ms**; **one request**.
- One valid native compaction item plus completed event; official `BasicCompactionEngine`
  produced a **new history replacement**, with approximately **146849 tokens shadowed**.
- The maintainer read `compaction/summary`, the replacement `user/message`, `compaction/end`
  and `command/done` success from the **disk journal**. This verifies the recorded result
  for this run; it does not prove fsync, crash recovery, lossless recall or all-timeout recovery.
- The observed launcher was alpha.3, while the actual Web/Basic dependencies were rc.1.
  This mixed instance is not a pure-alpha.3 runtime acceptance test. Compaction publicly
  supports rc.1 only. The account installer's existing alpha.3 + rc.1 scope is unchanged;
  both account temporary-home install/dump checks remain final release gates.

真实验收已完成：新预算 **300000ms**，耗时 **157372ms**，**一次请求**，合法 item + completed，
官方 Basic 新历史替换，约 **146849 tokens** 被 shadowed。维护者从磁盘 journal 读回
summary/user-message/end 和 command/done success；这不是 fsync、崩溃恢复或全部超时根治证明。
当前冻结候选 **498 = 135 + 46 + 34 + 266 + 17** 已复验全绿；历史阶段不替代本轮证据。

### Historical synthetic correction stage / 历史合成修正阶段

The initial correction stage used synthetic data/auth/transport only, with zero real-account
calls at that stage. Its passing counts were plugin **132**, legacy-A **46**, comparison
**34**, account **260**, paired **16**. At that point live loading and recovery of a large
session were unverified; that historical limitation is superseded by the authorized run above,
not erased or retroactively treated as live evidence.

- Paired tests exercised the actual runtime, standard seam, official BasicCompactionEngine,
  public pre-step trigger and logical history replacement: open body completion, EOF retry,
  preserved timeout, 60-second suppression, successful reset and continued ordinary replay.
- Unit coverage includes byte splits, UTF-8/CRLF, ignored post-terminal invalid/oversized tails,
  protocol limits, abort/dispose races, same-account binding, recovery budget, per-key isolation,
  single-flight, retry cancellation and failed commit not clearing prior failures.
- Historical package dry-runs and whitespace/syntax checks remain in their task delivery.

## Official references and limitations / 官方参考及限制

Cancellation may still display `CODEX_RUNTIME_ERROR`; this is a known non-blocking release
limitation, not a claim that cancellation itself is fixed. A refresh may cancel a pending
manual command; tab switching alone has not been demonstrated to cause cancellation.
Native-to-text fallback is this plugin's policy, not an official Codex guarantee. Persistent
upstream failure, exhausted budgets and hard context limits can still fail the task.

取消可能误显示 `CODEX_RUNTIME_ERROR`，作为非阻断限制保留。刷新可能取消等待中的手动命令；
不能据此声称仅切 tab 就取消。此修复不承诺所有超时根治或所有任务持续推进。

- [Codex fixed v2 implementation](https://github.com/openai/codex/blob/dac98cb6356f7aa10404c60fcb9d8f8c51d246e0/codex-rs/core/src/compact_remote_v2.rs): completes on the completed event; bounded remote retry.
- [PR #23951](https://github.com/openai/codex/pull/23951/files): its fallback is WebSocket to HTTPS, not Native to text. This plugin already uses HTTPS/SSE.
- [Commit ba8b5d9](https://github.com/openai/codex/commit/ba8b5d9018bf82aa397363e1b9847b01fcd26eb3): propagates final automatic-compaction failure to stop the turn. Our approved fail-open task behavior is a deliberate different tradeoff, not an official guarantee of uninterrupted work.

These historical source references were obtained through targeted official-page search
excerpts; direct full-text fetch was unavailable. They do not assert current-main behavior
or which released Codex versions contain the changes. Independent local regressions above
are the acceptance evidence for this correction.
