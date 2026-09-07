# Validation — 验证事实 / Verified facts

De-identified facts only: no real session ids, private paths, fixture keys, or
checkpoint hashes appear here. These results are NOT a proof of lossless recall
or of superiority over any other compaction implementation.

本文件只含去标识化事实：不含真实会话 ID、私密路径、夹具密钥或 checkpoint 哈希。
这些结果**不是**无损回忆的证明，也不构成相对任何其他压缩实现的优劣证明。

## Environment / 环境

- DSH host: `0.1.2-rc.1`; Node 24.18; macOS arm64.
- SDK pins: auth `@earendil-works/pi-ai` 0.82.1, native protocol module 0.84.4 alias.

## Offline test suites / 离线测试

All synthetic data, fake auth/transport, temporary `DSH_HOME`:

- Compaction core: 121 tests; frozen legacy-A baseline: 46; comparison suite: 34.
- Companion account package: 240 tests.
- Paired cross-plugin isolation suite: 12 tests (temporary snapshot install,
  real official basic engine + seam + owner runtime, fake transport).

全部使用合成数据、fake 认证/传输与临时 `DSH_HOME`：压缩核心 121；冻结 legacy-A
基线 46；对比套件 34；配套账户包 240；配对跨插件隔离套件 12（临时快照安装、真实
官方 basic 引擎 + 接缝 + owner 运行时、fake 传输）。

## Controlled live budget / 受控真实预算

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