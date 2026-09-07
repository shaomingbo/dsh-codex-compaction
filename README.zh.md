# dsh-codex-compaction

[English](README.md)

`0.3.0-rc.1` 是 **发布候选（RC）**：官方 `BasicCompactionEngine` 仍是唯一的主/自动压缩后端，
本包在其上增加一个可选的、由账户能力持有的**原生摘要/重放接缝**（标准 `openai-codex` 会话），
并保留 legacy 结构化 reader。不改 DSH core，不重复登录。**RC 候选不是稳定版**：固定 tag 仅在
实际推送并核验后才成立。

## 安装（tag 存在后）

```bash
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0-rc.1
```

无参数等同 `install`；默认 profile 为 `web`。其他命令：

```bash
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0-rc.1 status
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0-rc.1 uninstall
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0-rc.1 install --profile <name> --source link:<local-path>
npx --yes github:shaomingbo/dsh-codex-compaction#v0.3.0-rc.1 --help
```

- 安装器要求 PATH 上存在精确测试过的 `dsh` CLI **`0.1.2-rc.1`**，所有变更都委托给公开
  `dsh plugin` CLI 并带 `--ignore-scripts`（pnpm 11 的 remove 用 `--config.ignore-scripts=true`，
  不用其不支持的简写）。安装器核验 manifest 后置条件并如实报告失败；rc.1 不承诺回滚。
  只探测顶层 launcher help：plugin help 会初始化 profile。
- **`dsh` 缺失、版本不符或 plugin 命令失败时，安装器带指引地失败关闭。** 没有直接改 manifest
  的 fallback。请用 `dsh --version` 核对；历史上的 PATH CLI `0.1.2-alpha.3` 是另一个更旧的
  构建版本，会被拒绝。
- 配套账户包：同一发布系列的 **`dsh-token-usage` `5.1.0-rc.1`**
  （`github:shaomingbo/dsh-token-usage#v5.1.0-rc.1`）。它是能力配套包，不是 registry 依赖：
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
   既有原生状态仍可通过匹配 reader 读取。`inherit` 让会话回到 profile 默认（RC 中 profile
   默认为 **off**；正式启用 profile 默认是评审后的 rollout 步骤，不是打包默认值）。
   偏好跨宿主重启存活。
3. **诚实的边界。**
   - 原生摘要只有当官方 basic 在会话日志中完成历史替换后才算数。`/codex-context` 展示观察
     到的逻辑替换与最后一次尝试；它不独立确认宿主持有的磁盘持久化。
   - 每次可恢复的原生故障最多**一次透明文本 fallback**，且发生在同一 owner 租约内——同
     账户、同模型、同端点。取消、身份不匹配、无效 checkpoint 以及已含原生 carrier 的历史
     绝不 fallback；这些请求以固定错误码失败。
   - **图片历史在本首发版本不被接管**；它们保持官方文本路径。原生 carrier 混入不支持
     媒体会被显式拒绝。
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

参见[架构](docs/ARCHITECTURE.md)、[能力契约](docs/CODEX_RUNTIME_V1.md)与
[CHANGELOG](CHANGELOG.md)。

MIT。