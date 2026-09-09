# dsh-codex-compaction

[English](README.md)

**`0.3.3`** 修复原生检查点与用户/工具图片的混合回放，并支持同一 owner 下的混合历史
reader-text 摘要。采用公开 Pi 配置的图片像素/字节预算默认值，补充真实附件服务回归。
现有账户 owner **`5.1.3`** 即可配套，不要求同步升级账户包；保留 `0.3.2` + `5.1.3` 的期限修正。
修复运行时代码已通过原失败会话的真实回放；混合 Basic 压缩另有隔离集成证据。
精确 tag 身份与正式 tag 安装结果记录在 release，不能用本地 link 验收替代。

本配对保留 `0.3.1` + `5.1.2` 的历史恢复修正。
官方 `BasicCompactionEngine` 仍是唯一的主/自动压缩后端，本包在其上增加一个可选的、
由账户能力持有的**原生摘要/重放接缝**（标准 `openai-codex` 会话），并保留 legacy
结构化 reader。不改 DSH core，不重复登录。请使用下列匹配的固定 tag；发布身份与 tag
安装验收记录见 GitHub release。历史 `0.3.0`/`0.3.0-rc.1` 与账户包 `5.1.0`/`5.1.1`/`5.1.0-rc.1`/
`5.1.0-rc.2` tag 及旧验证证据保留。

## 安装（tag 存在后）

```bash
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.3.3
```

无参数等同 `install`；默认 profile 为 `web`。其他命令：

```bash
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.3.3 status
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.3.3 uninstall
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.3.3 install --profile <name> --source link:<local-path>
npx --yes --ignore-scripts github:shaomingbo/dsh-codex-compaction#v0.3.3 --help
```

- 安装器要求 PATH 上存在精确测试过的 `dsh` CLI **`0.1.2-rc.1`**，所有变更都委托给公开
  `dsh plugin` CLI 并带 `--ignore-scripts`（pnpm 11 的 remove 用 `--config.ignore-scripts=true`，
  不用其不支持的简写）。安装器核验 manifest 后置条件并如实报告失败；rc.1 不承诺回滚。
  只探测顶层 launcher help：plugin help 会初始化 profile。
- **`dsh` 缺失、版本不符或 plugin 命令失败时，安装器带指引地失败关闭。** 没有直接改 manifest
  的 fallback。请用 `dsh --version` 核对；历史上的 PATH CLI `0.1.2-alpha.3` 是另一个更旧的
  构建版本，会被拒绝。
- 配套账户包：同一发布系列的 **`dsh-token-usage` `5.1.3`**
  （发布后使用 `github:shaomingbo/dsh-token-usage#v5.1.3`）。它是能力配套包，不是 registry 依赖：
  本包从不猜测账户版本，而是在运行时预检 `codex-runtime/v1` 协议与认证 owner。相邻/更旧
  的 DSH 版本为不支持或未知；只声明 CI 矩阵实际验证过的范围。
- Bundle 变更需要用户自行重启对应 profile（Web GUI 需硬刷新）。任何脚本都不会启动、
  停止或替换运行中的宿主。

## 你得到什么

1. **标准会话保持标准。** 新的和既有的普通 `openai-codex` 会话继续使用官方 basic 自动压缩
   （触发、压力、溢出恢复、保留策略、meter、shrink 校验、commit/flush）。在你主动开启之前，
   默认路径不发生任何变化。
2. **按会话的原生压缩，默认关闭。** 在活动会话中运行 `/codex-native on`，即可让账户持有的
   原生 runtime 经同一个官方引擎产出压缩摘要。`/codex-native off` 只停止新建原生状态——
   既有原生状态仍可通过匹配 reader 读取。`inherit` 让会话回到 profile 默认（本发布中
   profile 默认为 **off**；正式启用 profile 默认是评审后的 rollout 步骤，不是打包默认值）。
   偏好跨宿主重启存活。
3. **诚实的边界。**
   - 原生摘要只有当官方 basic 在会话日志中完成历史替换后才算数。`/codex-context` 展示观察
     到的逻辑替换与最后一次尝试；它不独立确认宿主持有的磁盘持久化。
   - 每个 owner 租约最多**一次额外恢复请求**：Native retry 或透明文本 fallback——同
     账户、同模型、同端点，不叠加、不续期。取消、租约过期、身份/协议错误与无效 checkpoint
     不触发恢复；已含原生 carrier 的历史绝不文本 fallback。
   - **图片回放修复（0.3.3）：**普通原生 reader 通过宿主持久附件服务与公开 Pi 转换器
     支持用户图片和工具结果图片。无原生 carrier 的图片历史仍走官方 Basic；混合历史由
     同一 owner 绑定的 reader 按 Basic 指令执行一次 **reader-text** 摘要请求，再由 Basic
     提交可读文本摘要。这是主动选择的模式，不是失败 fallback，也不是原生图片压缩；
     v1 codec 仍只接受文本。附件缺失、纯文本模型、不支持的图片角色和损坏 carrier 仍拒绝。
     宿主原有的图片投影、总量限额与 offloading 策略保持不变。
   - **语义回忆是有损的，与安全拒绝是两回事。** 原生 checkpoint 重放的是压缩摘要，
     不是原始对话：envelope 格式与回放链路完全可以有效，模型仍可能回答不记得已压缩
     的细节。曾出现合成代码回忆失败。压缩不保证无损；关键状态、决策和代码引用应另存项目文件，
     需要时重新读取，不要只依赖可能再次被压缩的对话。
   - 未知 checkpoint、身份不匹配、损坏载荷会被拒绝——不透明的原生状态绝不静默
     重解释为普通文本。
   - `gpt-6-astra` 等自定义模型只经账户的可信 metadata 接缝解析（公开的宿主配置 profile
     字段，白名单）。缺失或冲突的 metadata 是具体的固定词表缺口，绝不编造数值。
4. **Legacy 兼容。** 既有结构化会话继续使用 `codex-native-lab` 路由与存档的 B 预设。
   `/codex-compact-setup` 仅为此兼容路径保留并明确标注 legacy；新用户应保持标准会话。
   旧日志绝不重写，旧 reader 全部保留。卸载整个包会同时移除 DSH bridge；请为原生历史
   保留匹配的 reader。

## 0.3.2 请求期限修正（配套 owner 5.1.3）

- 普通 owner `open` 使用 **1800000ms 总预算**、**120000ms setup 预算**。
  重放/文本转换器复用公开 DSH PiAiAdapter 的 **300000ms idle watchdog**，不另建 SSE
  监控器。准备期限、总时长与流静默是不同边界。
- `purpose: 'compaction'` 保持 **300000ms 总预算**（含 setup），不施加额外较短的 setup
  限制；其转换器 idle 仍为 **300000ms**。重试和同租约 fallback 不续期。
- owner factory 的 `timeoutMs` 仍表示总预算，显式短调用值保持原语义；新增
  `setupTimeoutMs` 默认 `min(timeoutMs, 120000)`，`compactionTimeoutMs` 默认
  `min(timeoutMs, 300000)`。这些是 owner factory 选项，不是 `open` 或本插件提供的任意期限覆盖。
- 既有诊断 `budgetMs` 仍为选中的总预算；新增可选 `totalBudgetMs`、`setupBudgetMs`、
  `timeoutBudgetMs`、`timeoutKind: 'setup' | 'total'`，只披露固定期限事实。
  owner 超时仍为 `CODEX_RUNTIME_TIMEOUT`；公开 Pi idle watchdog 仍明确为 **`TIMEOUT`**。
  不暴露凭据或 body 文本。
- 旧 owner 及缺少新诊断字段的情况保持读取兼容，但仍使用旧请求预算；单独更新 consumer
  不能解除 owner 旧总期限，**完整修复必须成对更新**。

tag 身份及 tag 安装结果记录在 release；当前 host 验收单独记录，不由本地测试推定。
下面历史验收不证明本次普通请求期限策略。

## 历史 0.3.1 恢复修正

`0.3.1` + `5.1.2` 当时的 Native 压缩租约/转换器最多 300 秒，普通请求租约及重放/文本转换器为 120 秒。
固定字段诊断包含阶段、耗时、字节/请求计数、`budgetMs` 与固定枚举 `eventCounts`，
不含原始内容或标识。详见[能力契约](docs/CODEX_RUNTIME_V1.md)。

合法 `response.completed`/`response.done` 加一个有效压缩项即完成 Native SSE，不再等待
HTTP EOF。完成前 EOF（含帧截断）或 socket 断开分类为可恢复的 `CODEX_RUNTIME_RESPONSE_STREAM`；
畸形协议为不可重试的 `CODEX_RUNTIME_RESPONSE_PROTOCOL`。首次停止原因
TIMEOUT/CANCELLED/CLOSED/DISPOSED 保留。**统一只允许一次额外请求**：网络/5xx/完成前断流
优先在 200ms 退避后重试 Native；其他白名单可用性故障可使用同租约文本 fallback。
两者不能叠加、更换账户或重置期限，已过期租约绝不文本 fallback。
Native→文本 fallback 是本插件策略，不是 Codex 官方行为声明。

一次完整尝试失败后，按 session/provider/model 暂缓新的接管压缩请求 60 秒；普通任务请求继续，
到期后由下一次官方触发自动尝试。`/codex-context` 和 `/codex-native status` 展示真实失败与允许
重试时间。只有观察到官方成功替换历史及正常 end 才清除失败状态，摘要流结束不等于提交成功。
状态有界且仅在进程内保存（重启清空），不新增命令、存储 schema 或模型容量覆盖。
若压缩持续失败并撞上窗口硬限制，任务仍可能失败，不能承诺不停顿。

获准的真实验收使用 300000ms 预算，耗时 157372ms，一次请求、合法 item + completed，官方
Basic 产生新历史替换，约 146849 tokens 被 shadowed。维护者已从磁盘 journal 读回
summary/user-message/end 与 command/done success。这证明该次记录结果，不证明 fsync、崩溃恢复
或全部超时根治。维护者已复验冻结生产候选：498 项（plugin 135 + legacy-A 46 + comparison 34 +
account 266 + paired 17）全绿，rc.1 临时 home 安装器闭环也通过；最终打包检查与发布 tag 换装仍是独立步骤。
参见[恢复验证](docs/RECOVERY_FIX.md)。

**已知非阻断限制：**取消可能误显示 `CODEX_RUNTIME_ERROR`。刷新可能取消等待中的手动命令，
尚无证据证明仅切 tab 就取消。该显示问题明确保留为限制，不阻断本次发版。

## 开发

Node >= 24，固定公开 DSH `0.1.2-rc.1`。安装无 lifecycle scripts。

```bash
pnpm install --frozen-lockfile --ignore-scripts
npm run check                       # 单元 + 冻结 legacy-A + 对比测试
npm pack --dry-run --ignore-scripts
git diff --check
node scripts/validate-cli.js         # 临时 DSH_HOME；不 boot
npm run test:accounts-integration -- <隔离的账户源>
                                     # 例如配套的 release worktree；脚本会创建
                                     # 临时源码/依赖快照，合成认证
```

配对集成套件把相邻的账户 checkout 复制到临时目录并在其中安装依赖，同时清除环境凭据。
**绝不 在 `node_modules` 链接到 live profile 的账户工作区中运行 `pnpm install`。**

离线测试只使用 fake auth/transport 与合成数据。不由此产生任何真实账户可用性、token、
成本或延迟结论。

参见[架构](docs/ARCHITECTURE.md)、[能力契约](docs/CODEX_RUNTIME_V1.md)、
[已验证事实](docs/VALIDATION.md)与[CHANGELOG](CHANGELOG.md)。

MIT。