# 显式 reader-text 与压缩收益诊断（未发布）

本扩展基于 0.3.3，不代表该历史 tag 已包含新功能。保持官方 Basic 为唯一自动压缩引擎，不改 DSH core、token meter、账户 owner 或原生 codec。生产换装和真实模型验收需分别授权。

## 何时使用

原生压缩的 owner 会在新 opaque 项外保留有预算上限的 client 消息。多次压缩可以只缩小 opaque 部分，仍留下大段 client 文本。官方 Basic 的“比旧段小”校验可能通过，但总压力仍高，导致同轮重试和下一步再次触发。界面显示的 shadowed tokens 是旧段大小，不是净释放。

本扩展让已有的 owner reader 读取完整原生历史，并按 Basic 指令生成短文本摘要。不是在客户端截断保留文本、删掉 opaque，或假报 usage。

## 用法

安装本候选后，在使用适用的标准 `openai-codex` 模型的会话中：

Web 中先从 `/` 候选或“指令”菜单选择 `codex-native`，看到参数输入提示后输入 `reader-text` 等参数并执行。不要将整行命令当作普通聊天文本发送。插件通过公开的 `input.hint` 声明参数入口。

1. `/codex-context`：查看最近现场观测的收益和当前原生载荷长度。
2. `/codex-native reader-text`：显式选择同 owner 的文本重整策略。只改变本会话的后续压缩，不立即改历史，也不改变普通生成请求。
3. 等待下一次官方自动压缩；需要立即尝试时，在会话空闲后使用官方 `/compact`。
4. `/codex-context`：核对逻辑提交、压缩前后压力、净收益，并检查摘要是否保留关键目标、约束、候选、证据位置和下一步。
5. `/codex-native on`：后续改回原生输出；`off` / `inherit` 保留原语义。

偏好通过成功配对的公开 `command/run` + `command/done` 事件恢复。失败、取消、未配对命令不恢复为已生效。不会新增私有持久化事件、配置存储或全局默认开关。

`off` 不是已有原生历史的迁移命令：旧 carrier 仍需要其匹配 owner；不能把 envelope 当普通文字交给 stock adapter。成功 reader-text 重整只替换 Basic 选中的历史范围，保留尾部及其他有效 carrier；不能据此推断整个会话已不需要 reader。

## 安全与质量边界

- 一个 reader-text 尝试只打开一个 compaction-purpose owner 租约、进行一次流式请求；保留 Basic 完整指令、原生 wire replay、账户/模型/端点绑定和所有原校验。
- 不先做 native compact；reader 错误也不回退 stock、不补做 native。缺 owner、损坏或异账户载荷、取消、失败终态、缺失成功 finish 都不能提交。
- Basic 仍负责 retention、maxTokens、缩水校验、事务、并发检查和 overflow。若返回摘要仍不足够短，Basic 自己仍可能重试；本插件不靠冷却来隐藏持续超限。
- 图片混合历史继续走已有安全 reader；显式模式也可处理无 carrier 的可用历史。未选择显式模式时，旧 native/default/image 分支不变。
- 显式 reader-text 在完整 Basic 指令之后追加类型保留提示：在既有 Critical Context 中用 JSON literals 保留关键结构化事实的原始标量类型，避免数字与字符串互转；不改历史或 Basic 原文，不影响非显式分支。这是摘要指导，不是 schema 校验器。
- 文本摘要是有损重整；可能丢失细节或类型。实测曾出现整数 `36721` 被回答为字符串 `"36721"`，不能把内容相同算成严格类型保真通过。先保存关键项目状态，独立验证关键约束、类型和证据可恢复性；提示调整也不保证所有后续回答满足 schema。
- 未实现或开启自动低收益切换，也没有在这里增加报告节流/消息去重。真实质量验收前不改变默认策略。

## 诊断语义

`/codex-context` 新增两类信息：

- **Compaction benefit**：最近观察到的生命周期、压缩前后公开 meter 压力及 anchor kind、旧段 fixed-heuristic tokens、完整 framed replacement tokens、二者差值（可负）、耗时、两次 start 之间的 step 数。
- **Native footprint**：当前有效 carrier 数、retained client 消息数及文本 UTF-16 长度、opaque UTF-16 长度。这些不是 provider token 数，更不代表解密后语义大小；无内容、密文或账户标识进入诊断输出。

`committed` 只表示观察到了匹配 summary 引用的真实 surface replace，加上 matching clean end。摘要流结束、出现 summary 事件或仅把摘要 append 到尾部都不算。

净收益基于一致的消息启发式，不拿可能 usage-anchored / clamp 的压力相减冒充消息节省。不改写 usage。发生外部 surface/header 改变、事件缺口、错误、未知/损坏测量时，净收益显示 unknown。提交成功与容量足够是不同结论；不从局部成功推断当前模型已经离开触发阈值。

观测只保留最多 256 个会话的最新元数据（LRU），不缓存正文或完整历史。无压缩在途的普通事件只更新计数，不遍历 surface/header。重启后重新现场观测，不伪造历史 pre/post 数值；这不影响偏好恢复和原有逻辑提交查询。诊断不独立证明宿主磁盘已 flush。

## 隔离回归

生产源码/链接/配置、真实账户和会话不参与测试。使用公开 DSH 0.1.2-rc.1 的 Basic、Session、meter 和账户 owner 5.1.3 模块；SDK 为原项目锁定值，传输和授权仅为注入 fixture。

`test/accounts.integration.js` 包含三组同构实验：76 条 retained client、24K opaque、225K 合成 usage anchor，以及 217600 的压力阈值。连续三次压力检查：

- native、Basic retries=1：6 次请求，仍高于阈值。
- native、Basic retries=0：3 次请求，仍高于阈值。
- 显式 reader-text、retries=1：1 次请求，降到阈值下，后两次无需压缩。

另覆盖真实公开命令到 Basic 的完整链路、reader 503 不改变 surface、失败收益 unknown、所有原图像/身份/恢复分支。具体候选执行记录另存实验室 evidence，不把历史测试数字当将来候选的证明。

通用检验入口：`npm run check`、`npm pack --dry-run --ignore-scripts`、`git diff --check`；配对检验使用 `node scripts/test-accounts.js <显式隔离账户源码目录>`。在本机必须通过 Lab 的 `develop` 入口启动，使用其隔离 HOME/DSH_HOME/cwd/cache/tmp 和白名单环境；不能直接从生产环境继承认证变量执行。
