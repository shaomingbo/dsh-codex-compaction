# Validation — 验证事实 / Verified facts

De-identified facts only: no real session ids, private paths, fixture keys, or
checkpoint hashes appear here. These results are NOT a proof of lossless recall
or of superiority over any other compaction implementation.

本文件只含去标识化事实：不含真实会话 ID、私密路径、夹具密钥或 checkpoint 哈希。
这些结果**不是**无损回忆的证明，也不构成相对任何其他压缩实现的优劣证明。

## 0.3.1 + 5.1.2 acceptance / 本次真实验收

The recovery fix has passed an authorized real run on the original instance. The release
pair is compaction `0.3.1` + account `5.1.2`; tag identity is recorded in the GitHub releases.
Release-tag installation and final packaging checks are separate release steps, not inferred
from this run; the frozen production candidate's full regression has also been rerun. See [RECOVERY_FIX.md](RECOVERY_FIX.md) for the behavior and stage history.

- Selected native budget: **300000ms**; elapsed: **157372ms**; **one request**.
- A valid native compaction item and completed event were observed. Official
  `BasicCompactionEngine` produced a **new history replacement**; approximately **146849
  tokens** were shadowed. This is a host history observation, not provider billing or
  evidence of lossless semantic recall.
- The maintainer read `compaction/summary`, the replacement `user/message`, `compaction/end`
  and `command/done` success back from the **disk journal**. This corroborates the recorded
  result for this run, beyond the status command's logical observation; it does not prove
  fsync, crash recovery or elimination of all timeouts.
- The live launcher was `0.1.2-alpha.3`, but the actual Web/Basic dependencies were
  `0.1.2-rc.1`. Do not interpret this mixed environment as full pure-alpha.3 runtime
  compatibility. Public compaction support remains exactly rc.1; the account installer
  retains its existing alpha.3 + rc.1 scope, with both temporary-home install/dump checks
  assigned to final release validation.
- The maintainer reran the frozen production candidate: **498 = plugin 135 + legacy-A 46 +
  comparison 34 + account 266 + paired 17**, all passing. `npm run check` covers the first
  three suites; `scripts/test-accounts.js` covers the isolated account and paired suites.
- `scripts/validate-cli.js` passed the real rc.1 temporary-home install/repeat/status/
  `--dump-config`/uninstall cycle, with no host boot or live-instance operation. Final
  documentation/package/diff checks and account installer checks on both supported CLI
  versions remain distinct release gates.

本次修复已在原实例通过获准的真实验收：新预算 **300000ms**，耗时 **157372ms**，
**一次请求**、合法 item + completed，官方 Basic 产生**新历史替换**，约 **146849 tokens**
被 shadowed。维护者已从**磁盘 journal** 读回 summary、替换 user-message、end 与
command/done success；这是该次记录结果的证据，不证明 fsync、崩溃恢复、无损回忆或全部超时根治。
启动器 alpha.3 与实际 Web/Basic rc.1 的混合现场，不证明纯 alpha.3 完整运行兼容。
维护者已复验冻结生产候选，全量 **498 = 135 + 46 + 34 + 266 + 17** 通过；compaction 的真实
rc.1 临时 home 安装/重复安装/status/dump/卸载闭环通过，不 boot、不碰现网。最终文档/打包/
差异检查、账户安装器两个支持 CLI 版本的临时 home 验证、发布 tag 核验及换装仍是独立门禁。

### Known non-blocking limitation / 已知非阻断限制

Cancellation may still display `CODEX_RUNTIME_ERROR`. Refreshing can cancel a pending manual
command; tab switching alone has not been demonstrated to cause cancellation. This display
issue is retained as a limitation and does not block this release. Persistent upstream failures,
expired budgets and hard context limits remain possible; Native-to-text fallback is this
plugin's policy, not an official Codex fallback guarantee.

取消仍可能误显示 `CODEX_RUNTIME_ERROR`，明确作为不阻断本次发版的限制。刷新可能取消等待中的
手动命令，不证明仅切 tab 就取消。持续上游故障、预算耗尽与窗口硬限制仍可能导致失败；
Native→文本 fallback 是本插件策略，不能称为 Codex 官方保证。

## Historical 0.3.0 environment / 历史 0.3.0 环境

- DSH host: `0.1.2-rc.1`; Node 24.18; macOS arm64.
- SDK pins: auth `@earendil-works/pi-ai` 0.82.1, native protocol module 0.84.4 alias.

## Historical 0.3.0 offline suites / 历史 0.3.0 离线测试

All synthetic data, fake auth/transport, temporary `DSH_HOME`:

- Compaction core: 121 tests; frozen legacy-A baseline: 46; comparison suite: 34.
- Companion account package: 240 tests.
- Paired cross-plugin isolation suite: 12 tests (temporary snapshot install,
  real official basic engine + seam + owner runtime, fake transport).

全部使用合成数据、fake 认证/传输与临时 `DSH_HOME`：压缩核心 121；冻结 legacy-A
基线 46；对比套件 34；配套账户包 240；配对跨插件隔离套件 12（临时快照安装、真实
官方 basic 引擎 + 接缝 + owner 运行时、fake 传输）。

## Historical 0.3.0 controlled live budget / 历史 0.3.0 受控真实预算

A human-approved live trial used 16 real requests: 10 ordinary, 5 native
compactions, 1 stock text compaction; 0 automatic title requests.

经人类批准的真实试用共 16 次请求：10 次普通调用、5 次原生压缩、1 次官方文本压缩；
0 次自动标题请求。

- **Astra (custom model via the trusted metadata seam):** a real automatic
  native replacement, a real ordinary continuation, and a second real native
  compaction ran; after an actual host restart the session recalled the
  synthetic state key exactly (the pre-restart replay plaintext contained no key).
- **Sol (pinned catalog model):** the 5.1.0-rc.1 schema-materialized empty
  input-array defect was fixed in 5.1.0-rc.2; afterwards a real automatic
  native replacement and a real ordinary continuation succeeded. However, the
  model failed to recall tool-borne fixture facts (a synthetic state key and
  three constraints). The official selection verifiably contained those facts;
  an offline bounded simulation showed the local conversion chain and replay
  do not drop them; the actual HTTP exchange was not captured, so no cause is
  concluded here, and the different input paths do not license comparing the
  two models' quality.
- **Legacy B reader:** on the real 5.1.0-rc.2 host, pre-existing structured
  histories passed the current owner binding validation and historical
  checkpoint bytes remained identical (hash values withheld as private).

- **Astra（经可信 metadata 接缝的自定义模型）**：真实自动原生替换、真实普通续写与
  第二次真实原生压缩均完成；在实际宿主重启后，会话精确回忆出合成状态码（重启前
  的重放明文不含该码）。
- **Sol（pinned 目录模型）**：5.1.0-rc.1 的 schema 物化空 input 数组缺陷已在
  5.1.0-rc.2 修复；此后真实自动原生替换与真实普通续写通过。但模型未能回忆工具
  承载的夹具事实（一个合成状态码与三条约束）。官方选区经核验包含这些事实；离线
  有界模拟显示本地转换链与重放不会丢弃它们；实际 HTTP 交互未被捕获，因此此处
  不下任何结论，两条不同的输入路径也不得用于比较两个模型的质量优劣。
- **Legacy B reader**：在真实 5.1.0-rc.2 宿主上，既有结构化历史通过当前 owner
  binding 校验，历史 checkpoint 字节保持相同（哈希值作为私密信息不公开）。

## Release posture / 发布姿态

The profile native default remains **off**; stock basic automatic compaction
stays exactly as-is, and native automation applies only after an explicit
per-session `/codex-native on` (or a separately reviewed profile default).
Release candidates `0.3.0-rc.1` (compaction) and `5.1.0-rc.1`/`5.1.0-rc.2`
(account) are retained as historical tags.

profile 级原生默认保持 **off**；官方 basic 自动压缩原样不变；原生自动化仅在显式
按会话 `/codex-native on`（或另行评审的 profile 默认）之后生效。`0.3.0-rc.1`
（压缩包）与 `5.1.0-rc.1`/`5.1.0-rc.2`（账户包）候选 tag 作为历史保留。