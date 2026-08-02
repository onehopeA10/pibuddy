# PiBuddy 产品级实施总控提示词

> 使用方法：把本文件和 `PiBuddy-desktop-agent-source-audit-2026-08-02.md` 一起放进项目根目录的 `docs/`，或同时提供给 Coding Agent。每次只把下方 `TARGET_MILESTONE` 改成一个里程碑执行。推荐第一次填写 `M0-M1`，不要第一次就填写 `ALL`。

---

## 可直接复制给 Coding Agent 的总提示词

你现在是 PiBuddy 项目的 Principal Engineer，同时承担桌面架构、安全、测试、发布工程和产品落地责任。你的任务不是做 Demo，也不是只增加几个 UI 按钮，而是把现有项目逐步升级为可安装、可恢复、可更新、可诊断、可安全交付的跨平台桌面 Agent 产品。

### 任务参数

- `TARGET_MILESTONE = M0-M1`
- `PRIMARY_PLATFORM = Windows 11 x64`
- `SECONDARY_PLATFORMS = macOS arm64/x64, Ubuntu x64`
- `PRODUCT_MODE = 面向普通用户的个人 Agent / AI 办公助手；开发者能力放入高级模式`
- `AUDIT_DOCUMENT = docs/PiBuddy-desktop-agent-source-audit-2026-08-02.md`
- `DO_NOT_MIGRATE_FRAMEWORK = true`

如果仓库中的实际文件名、workspace 布局或包版本与上述不同，以源码和 lockfile 为准，并在实施报告中记录差异。不要因为路径不同就跳过需求。

### 产品与技术约束

1. 保持现有 Electron + Vue 3 + Pinia + Naive UI + electron-vite + electron-builder 方案，不迁移到 Tauri、React 或另一个 UI 框架。
2. 保留现有简洁聊天体验、真实图片多模态、streaming、thinking、tool card、steer/abort、语音和 Extension UI，不以“重构”为名推倒重写。
3. Pi 是可替换的 Agent runtime。默认使用随应用发布并经过回归测试的 bundled Pi；高级设置允许选择 external Pi。外部 Pi 绝不能破坏 bundled Pi 的可用性。
4. Electron 主进程掌握进程、权限、密钥、文件、Git、终端、更新和持久化；renderer 只获得窄、可验证、可撤销的业务能力。
5. Windows 为首发平台，但所有共享代码不得写死 Windows 路径或 shell 语义；macOS/Linux 必须有 CI、打包检查和明确的能力降级。
6. 默认产品界面面向非开发者：聊天、文件/产物、历史、任务、设置。PTY、Git 高级操作、worktree 和调试日志放在“开发者/高级模式”。
7. 不复制 BSL、Elastic、AGPL 或许可证不明确仓库的源码。只能参考产品行为和架构思想；新增代码必须保持本项目许可证合规并记录第三方依赖。
8. 不添加 mock、空按钮、永远成功的占位实现或只写 TODO 的产品入口。功能没有形成 main/preload/renderer/persistence/test 闭环，就不能标记完成。

### 开工前必须读取

开始修改前，完整检查：

- 项目根目录说明、`AGENTS.md`/贡献规则、根 package、workspace、lockfile、tsconfig。
- Electron main、preload、renderer、Pinia store、`@pibuddy/pi-sdk`、electron-builder 配置、现有测试与 CI。
- `AUDIT_DOCUMENT`，重点核对其中已经确认的三个阻断和 P0/P1/P2。
- 当前 git 状态。保留用户未提交修改，不覆盖无关代码，不执行破坏性 reset/checkout。

先运行并记录现有 baseline：依赖安装、typecheck、unit test、build。若某项不存在或失败，要区分“仓库原有失败”和“本次引入失败”。不要为了让 CI 变绿而删除测试或放宽类型/安全规则。

### 实施纪律

1. 只实施 `TARGET_MILESTONE`。可以为后续预留清晰接口，但不得顺手铺开所有功能。
2. 先给出当前实现证据和设计，再改代码。若审计文档与当前 HEAD 冲突，以当前源码为准并说明。
3. 一个里程碑内部按可运行的垂直切片推进：contract/schema → main service → preload → renderer store/UI → persistence/migration → tests → docs。
4. 每个高权限功能必须先定义 threat model、权限边界和失败语义，再暴露 UI。
5. 每个异步流程必须定义状态机、超时、取消、重试上限、幂等或去重、应用退出行为、renderer reload 恢复行为。
6. 每个持久化结构必须有 schema version、migration、原子写/事务、损坏恢复和敏感字段策略。
7. 所有 IPC 请求与事件使用共享运行时 schema；TypeScript interface 不能替代运行时校验。拒绝未知字段、超长字符串、非法枚举、越界路径和非主 frame 调用。
8. 所有子进程使用参数数组，内部命令默认 `shell:false`；只有用户明确打开的真实终端允许 shell 语法。
9. 任何“完成”都必须给出可复现命令与测试证据。只通过 typecheck 不等于运行时完成，只 build 成功不等于安装包可用。
10. 不擅自提交、推送、发布或写入真实生产更新源；如仓库已有明确授权工作流则按其规则执行。

### 必须维护的产品文档

若不存在，创建并在每个里程碑更新：

- `docs/product/requirements.md`：带 ID 的功能与非功能需求。
- `docs/product/architecture.md`：进程、数据、信任边界和模块关系。
- `docs/product/threat-model.md`：资产、攻击面、信任假设和缓解措施。
- `docs/product/traceability.md`：需求 ID → 代码 → 测试 → 状态。
- `docs/product/release-checklist.md`：打包、签名、更新、安装/升级/回滚验收。
- `docs/adr/`：bundled Pi、session storage、permission、update provider 等关键决策。

需求至少使用以下前缀：

- `RUN-*` Pi runtime/SDK
- `SES-*` 会话
- `SEC-*` IPC/权限/密钥/导航
- `EXT-*` Extension UI/Pi 资源
- `PROV-*` Provider/model/auth
- `FS-*` 文件与附件
- `ART-*` Office/artifact/preview
- `PTY-*` 终端
- `GIT-*` Git/worktree/checkpoint
- `UPD-*` 应用/Pi 更新
- `AGT-*` 后台/child Agent
- `AUT-*` 自动化
- `MEM-*` 记忆
- `REM-*` 远程与设备
- `OBS-*` 日志/诊断/崩溃
- `QA-*` 测试/CI/发布

### 通用 Definition of Done

一个需求只有同时满足以下条件才可标记完成：

- 用户从 UI 能进入、操作、取消并看到成功/失败/恢复状态。
- main/preload/renderer 边界完整，IPC 有 runtime schema 和 sender 校验。
- 关键状态在窗口 reload、Agent crash 或应用重启后按需求恢复或明确清理。
- 错误不泄露 key、完整环境变量、敏感路径或任意 stderr；同时保留可导出的脱敏诊断。
- 有正常、取消、超时、异常退出、重复调用和至少一个平台差异测试。
- 类型检查、单测、集成测试、renderer E2E 和生产 build 通过。
- 涉及安装/更新/runtime 的功能必须在 packaged app 上验证，不能只用 dev server。
- 文档、设置说明、迁移、可访问性和必要的 i18n 文案已经同步。
- `traceability.md` 中能从需求追踪到实现与测试。

### 本次输出格式

开始时输出：

1. 当前仓库/依赖/构建基线；
2. 本里程碑需求 ID 与已有/缺失状态；
3. 计划修改文件和关键设计；
4. 风险、兼容与回滚方案。

完成时输出：

1. 已完成需求 ID；
2. 实际修改文件与行为变化；
3. 执行过的命令和结果；
4. 尚未验证的平台/场景；
5. 新发现但不属于本里程碑的问题；
6. 是否达到该里程碑出口门禁。未达到必须明确写“未完成”，不能用“基本完成”。

现在读取源码和审计文档，从 `TARGET_MILESTONE` 开始实施。

---

## 里程碑详细规格

| 里程碑 | 目标 | 主要依赖 | 发布含义 |
|---|---|---|---|
| M0 | 基线、契约、测试骨架 | 无 | 不发布 |
| M1 | bundled Pi、session resolver、runtime supervisor | M0 | 内测 |
| M2 | Electron/IPC/权限/密钥安全 | M1 | 内测 |
| M3 | 会话、Provider、Extension/Pi 资源与日常 UX | M2 | 功能公测 |
| M4 | 更新、签名、CI/CD、诊断 | M2，建议 M3 后 | 可分发公测基线 |
| M5 | Workspace、Office/PDF、artifact | M2-M3 | 办公产品 v1 核心 |
| M6 | PTY、Git/Review、checkpoint/worktree | M2、M5 | 开发者高级模式 |
| M7 | 后台会话池、child Agent 编排 | M3、M6 | Agent 平台 Beta |
| M8 | durable tasks、长期记忆 | M3、M5、M7 | 个人 Agent OS Beta |
| M9 | Remote/PWA/IM、浏览器与插件平台 | M2、M7-M8 | 高风险能力，独立 Beta |
| M10 | GA 性能、可访问性、隐私与支持 | 实际发布范围全部前置里程碑 | GA |

不得跳过 M1-M2。M3 与 M4 可由不同分支并行但合并前必须共同跑 packaged E2E；M7 不得早于 worktree 和权限中心；M9 不得早于统一认证、设备 scope 和审计。

### M0：基线、需求追踪与架构护栏

目标：先建立可度量基线，避免在一个 40 文件 MVP 上直接堆功能。

#### 必做

- 确认 workspace 根 package、包管理器、lockfile、Node/Electron 版本和 `@earendil-works/pi-coding-agent` 实际解析版本。
- 建立 shared contract 包或目录，main/preload/renderer/SDK 共用类型与 runtime schema。
- 定义统一事件 envelope：`protocolVersion`、`workspaceId`、`sessionId`、`runtimeId`、`generation`、单调递增 `sequence`、`occurredAt` 和 typed payload；所有跨进程事件都用 runtime schema 校验，未知协议版本 fail closed，不能靠 TypeScript 类型假定运行时输入可信。
- 拆出最小服务边界，但不做无收益大重构：`PiRuntimeSupervisor`、`SessionRepository`、`SettingsStore`、`PermissionEngine`、`UpdateService` 先定义接口和依赖方向。
- 把当前 Pinia 单 store 规划为按 `sessionId` 归一化状态；M0 只迁移会被 M1 修改的 runtime/lifecycle 状态。
- 加入结构化、脱敏、本地轮转日志基础设施，日志默认不记录 prompt 正文、API key、Authorization、完整环境变量。
- 建立 fake Pi RPC process/fixture，能够模拟正常响应、畸形 JSON、超时、stderr、主动退出、crash、extension UI、旧 generation 延迟事件。
- 建立最小 CI：install、typecheck、unit、build。CI 不包含真实凭证。

#### 出口门禁

- 现有功能行为没有回归。
- baseline 命令、架构、威胁模型和 traceability 文件已落地。
- 后续 M1 可以使用 fake process 测试而不依赖真实 Provider。

### M1：修复三个确定性阻断并重建 Pi runtime/SDK 生命周期

目标：没有全局 Pi 的普通用户也能启动；会话跨平台正确；旧进程不能污染新会话。

#### RUN-001：可靠 bundled Pi

- 不再使用当前会触发 `ERR_PACKAGE_PATH_NOT_EXPORTED` 的 `createRequire().resolve(package-root)`。
- 开发态可用 ESM `import.meta.resolve()` + `fileURLToPath()` 解析公开入口；生产态不得依赖碰巧存在的 workspace `node_modules`。
- 增加构建期 `prepare-pi-runtime`：把锁定版本及完整生产依赖/动态资源准备为自包含 runtime 目录，生成 `runtime-manifest.json`，至少含版本、入口、构建时间、协议能力和内容校验信息。
- electron-builder 使用 `extraResources` 或经过验证的最小 `asarUnpack` 放置 runtime；应用主代码恢复 `asar:true`，不得因为 Pi 动态资源而把整个应用裸放。
- packaged mode 只从 `process.resourcesPath` 下的 manifest 定位 bundled Pi；路径必须存在、是普通文件且属于 runtime 根。
- external Pi 是高级设置：显式路径优先于 PATH，显示版本与能力；外部启动失败自动提供“切回内置版本”，但不能静默改变用户设置。
- 启动时进行 version/protocol/capability handshake。记录 `bundledVersion`、`selectedRuntime`、`protocolVersion`，不兼容时拒绝启动并提供恢复动作。
- 所有启动参数使用 argv 与 `shell:false`。Windows `.cmd` fallback 必须经过受控 launcher 或明确的命令解析，不能把 renderer 输入拼进 shell。
- 子进程环境变量采用 allowlist/显式构造；默认剔除或受控处理 `NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`、调试端口、动态库注入和其它可改变 Node/Electron 启动语义的变量。Provider 所需变量从主进程安全存储按 scope 注入，不把整份父进程环境或 renderer 输入原样透传。

#### SES-001：统一会话解析

- 删除自写的 POSIX cwd 编码复制逻辑，优先通过 Pi 公开导出的 `SessionManager.list(cwd, sessionDir)` 或同一 resolver 获取会话。
- 正确支持 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、Pi settings `sessionDir` 和 `path.resolve(cwd)`。
- 会话列表 API 返回稳定 session ID、文件路径、cwd、name、首条用户消息、消息数、mtime、当前 runtime 版本和解析错误状态。
- 解析在 worker/utility process 或异步 I/O 中进行，不能同步全量读取阻塞 Electron main。
- 单个损坏/超大 JSONL 不影响其它会话；记录脱敏错误并允许用户导出诊断。

#### RUN-002：generation 与生命周期状态机

- 每次 runtime start 生成不可复用的 `runtimeId`/generation。所有 Agent event、UI request、response、stderr、exit 都携带 `runtimeId + sessionId + sequence`。
- 主进程只转发当前 generation；renderer 再次丢弃旧 generation 或 sequence 倒退事件。
- dispose 必须取消 batch timer、清空队列、移除 listeners、拒绝 pending、区分 `expected-stop` 与 `crash`。
- 初始化任一 RPC 失败时，立即停止子进程、删除 map、清理 listener，并向 UI 返回结构化错误与最近脱敏 stderr。
- 状态机至少包含 `idle/starting/running/stopping/stopped/crashed/recovering`；非法转换在开发态抛错并有单测。

#### RUN-003：SDK 请求可靠性

- 每条请求有自动生成且不可碰撞的 ID、默认 timeout、可覆写 timeout、`AbortSignal`；timeout/abort 后必须从 pending map 删除。
- 监听 child `error/exit/close`、stdin `error` 和 write callback；处理 backpressure/`drain`。
- JSONL reader 设置单行和累计 buffer 上限；malformed line、orphan response、重复 response、未知 event 进入有界诊断，不静默吞掉关键协议错误。
- spawn `ENOENT` 后对象必须进入 crashed/stopped，而不是 `running=true`；同一对象若允许 restart，旧 child callback 不得清空新 child。
- stop 顺序：停止接收新命令 → graceful abort/关闭 stdin → 等待 → terminate → kill process tree/Windows Job Object；每层都有超时与测试。

#### SES-002：现有交互一致性

- `new_session`、`switch_session` 检查 `success` 与 `data.cancelled`；extension veto 时保持旧会话和消息，不显示假空白。
- 发送失败保留文本、图片和文件；只有 RPC 已接受后才清空 composer。
- session switch 已成功但 messages 加载失败时，显示明确错误和可重试，不把旧消息冒充新会话。
- runtime/session 更换时清理或按 scope 恢复 queue、Extension UI request、status、live assistant、tool run。
- 不用全局 settings 无条件覆盖历史会话记录的 model/thinking；只在新会话或用户明确选择时应用默认值。

#### M1 测试矩阵

- 没有全局 `pi` 的 packaged Windows 安装包仍能启动 bundled Pi。
- macOS `/Users/...`、Linux `/home/...`、Windows `C:\...` 会话列表正确。
- 自定义 agent/session dir 正确。
- 快速连续换 workspace/session，旧 exit/update/UI request 不影响新 generation。
- spawn ENOENT、启动后立即 crash、RPC timeout、畸形 JSON、超大无换行输出、stdin EPIPE、强制 kill 均可恢复。
- extension veto new/switch、发送失败、历史加载失败不丢用户状态。

#### M1 出口门禁

- 在 clean VM/runner 上用 packaged app 完成 bundled Pi 启动 smoke。
- 三个平台路径单测通过；至少 Windows packaged E2E 通过。
- 已确认没有旧 generation 污染和永久 pending。

### M2：Electron 安全边界、权限中心与敏感数据

目标：renderer 被 XSS 或扩展内容影响时，也不能直接获得任意 shell、文件、密钥和 Pi RPC 权限。

#### SEC-001：安全窗口与导航

- `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`，并评估 `app.enableSandbox()`。
- 使用本地自定义协议替代宽松 `file://` 时，协议必须注册为 secure/standard 且只服务应用资源。
- CSP 默认至少 `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`；图片默认只允许 `self data: blob:`。远程图片需显式同意或经安全代理。
- `will-navigate` 拒绝非应用 origin；`setWindowOpenHandler` 默认 deny。外链只允许规范化后的 `https/http/mailto`，并在传给 `shell.openExternal` 前阻断本地文件、控制字符和危险 scheme。
- 对权限请求（麦克风等）设置 `session.setPermissionRequestHandler`，只允许主窗口、可见用户动作和所需权限。

#### SEC-002：窄 IPC 与 schema

- 删除 renderer 通用 `pi.command({type,...})`。按产品动作暴露 `prompt/steer/followUp/abort/newSession/switchSession/setModel/...` 等窄方法。
- 所有 handler 校验 `event.senderFrame === event.sender.mainFrame`、可信 origin/webContents、payload schema、字符串/数组/二进制大小和 rate limit。
- preload 不暴露任意 channel 名、任意绝对路径、任意 URL、环境变量、raw Electron API。
- 事件订阅返回 unsubscribe；窗口销毁时清理 listener，防止重复订阅和内存泄漏。

#### SEC-003：Workspace capability

- 用户选择目录后，main 注册 canonical realpath，renderer 只持有不透明 `workspaceId` 和 relative path。
- 每次文件操作重新做 root containment、symlink/traversal、文件类型和大小校验；禁止只用字符串 `startsWith()`。
- 文件选择器返回短期 attachment capability/token，而不是让 renderer 把任意绝对路径传回读取 API。
- Pi 已知工具层与桌面文件 API 使用同一个 `PermissionEngine`：通过 Pi 公开 hook/内建 guardian extension 或 SDK tool wrapper 拦截 read/write/edit/bash/network/MCP；至少支持 deny、allow once、allow session、allow workspace，并有审计与撤销。对每个支持的 Pi 版本做 contract test，不能只在 renderer 显示确认框而实际未阻断工具。
- Pi project trust 单独显示，它只决定项目 `.pi` resources 是否加载，不得冒充工具 sandbox。
- 产品文案必须把这一层称为“工具审批/策略”，不能承诺 OS 级沙箱。任意受信第三方 extension 本身仍可能通过 Node API 绕过 tool hook；只有实现并验证 Windows AppContainer/受限 token + Job、macOS sandbox profile、Linux bubblewrap/container 等进程隔离后，才能宣传强隔离。

#### SEC-004：密钥、STT 与网络

- STT/API key 存入 OS 安全存储或主进程加密 vault；renderer 只能看到“已配置/尾四位”，不能取回明文。
- Provider/STT 请求由主进程根据保存的 endpoint ID 发起，renderer 不同时提交任意 base URL 与 key。
- 自定义 endpoint 保存前做 URL 标准化、HTTPS 要求、DNS/IP 私网/loopback/link-local/metadata 阻断策略；若产品允许本地模型，必须让用户显式授予 local-network scope，不能默认放开。
- SSRF 测试至少覆盖 `localhost`、IPv4 `127/8`、`0.0.0.0`、整数/八进制/十六进制 IP 表示、IPv6 `::1`、IPv4-mapped IPv6、RFC1918、CGNAT、link-local、云 metadata 地址、DNS rebinding 和跳转到私网；每次 redirect 都要重新解析并校验目标。允许本地网络时也应绑定用户确认的 host/port，而不是放开整个内网。
- fetch 有 connect/overall timeout、AbortSignal、response size、content-type 和错误脱敏。
- settings 原子写（temporary + fsync + rename）、schema version、migration、备份；损坏时恢复而不是静默清空所有配置。

#### SEC-005：附件与 Markdown

- 图片/音频/文件设置数量、单文件、单次总量和尺寸上限；用 magic bytes/MIME 嗅探，不只看扩展名。
- 大文件通过临时文件/capability/stream 传递，避免 base64 多次复制；临时文件有权限、TTL 和退出清理。
- Markdown 保持 `html:false`，链接与图片 scheme 白名单；代码高亮和超长 tool output 有字节上限。
- macOS 增加明确的 `NSMicrophoneUsageDescription`，签名包实测权限拒绝、允许和撤销。

#### M2 出口门禁

- 安全测试证明 renderer 无法调用任意 bash、读取任意图片路径、拿到 STT key、通过 STT 访问未授权内网或打开任意 scheme。
- Electron 官方安全检查项逐条记录到 threat model；CSP/sandbox/navigation/IPC sender 均有自动化回归。

### M3：会话、Provider、Pi 生态与完整桌面交互

目标：吃完 Pi/SDK 已经提供的低成本能力，把“能聊天”升级为可长期使用的日常产品。

#### SES-101：会话中心

- 使用 SQLite 增量索引 session metadata，保存 source path、cwd、session ID、offset/mtime/hash、name、preview、message count、token/cost、状态和 schema version；JSONL 仍为真相源，不改写不理解的 entry。
- 提供搜索、rename、pin、archive/restore、delete（进回收站或可恢复区）、按 workspace/date/model/status 筛选、未读和后台运行标识。
- 接入 `set_session_name`、`compact`、`fork`、`clone`、`get_entries`、`get_tree`、`get_fork_messages`、`export_html`；每个能力先核对当前 Pi 版本的真实 RPC response 和 cancelled 语义。
- 会话树能定位当前 leaf、分支点、compaction 和模型变化；rewind/fork 不能静默删除原分支。
- 删除、批量移动、导出等操作显示精确对象并支持取消/失败恢复。

#### SES-102：输入、队列与长对话

- 明确区分 prompt、steer、follow-up；用户可选择“立即插话”或“下一轮处理”，并编辑/删除未发送队列项。
- 草稿、附件和队列按 session 持久化；崩溃、切会话和窗口 reload 后恢复。
- streaming 使用 `assistantMessageEvent.delta` 按 animation frame 合并；完成消息才进入 Markdown cache。避免不断传输/解析完整前缀造成 O(n²)。
- 消息列表使用真正虚拟滚动或分段数据源，保留锚点、跳到底部、未读分界和历史加载失败重试。
- 复制、重新发送、从消息分叉、停止、错误详情和 tool output 展开符合键盘/屏幕阅读器语义。

#### PROV-101：Provider 与模型中心

- 复用 Pi 的 auth/model registry，不再让用户必须去终端 `/login`。
- 支持 API key、OAuth（上游确实提供时）、自定义 OpenAI-compatible endpoint、模型发现、连通性/最小请求测试、模型输入能力和 context/cost 展示。
- key 始终留在 main/vault；renderer 只拿 provider 状态、模型 metadata 和脱敏错误。
- 区分全局默认、workspace 默认、session 当前模型。打开历史 session 不得无提示覆盖它记录的 model/thinking。
- 图片发送前检查模型 input capabilities；不支持图片时阻止或让用户切换模型。
- 提供用量页：按日/workspace/model/provider 汇总 token、cost、context、失败率；本地优先，导出 CSV/JSON。

#### EXT-101：完整 Extension UI

- 覆盖 select/confirm/input/editor/notify/setStatus/setWidget/setTitle/set editor text，以及当前 Pi 版本公开的全部 RPC UI method。
- dialog 支持 timeout、AbortSignal、runtime generation、多个请求排队、窗口 reload 恢复/取消；上游超时后本地 modal 立即失效。
- Widget 有稳定 key、placement、更新/删除和高度限制；Title 经过产品前缀与长度限制。
- 任何 extension request 都不能直接获得 Electron API；UI 内容按纯文本或受限 renderer 渲染。
- 显示 Pi project trust：来源、将加载的 project resources、allow/deny/remember；明确说明 trust 不等于工具权限。

#### EXT-102：Pi 资源中心

- 枚举 user/project/package 来源的 packages、extensions、skills、prompts、themes、MCP；显示路径、版本、来源、启用状态、冲突和诊断。
- 支持安装、卸载、启停、刷新、打开目录、版本锁；project 资源需先通过 trust。
- 安装来源必须规范化并显示将执行/访问的权限；禁止 renderer 直接执行任意 package manager command。
- MCP 支持 CRUD、启停、连接测试、OAuth 状态、tool 列表和错误诊断；凭证留在 main。
- Pi 原生资源与未来 PiBuddy UI 插件使用不同的 manifest、权限和运行宿主，不能混为一层。

#### UX-101：桌面产品状态

- 首次启动向导覆盖 workspace、bundled/external Pi、Provider、project trust、通知和可选语音，不要求用户先打开终端。
- 全局错误分为可恢复/需设置/需重启/需导出诊断；避免只有 toast。
- 顶栏或状态中心显示 runtime、session、网络/Provider、context、后台任务和 update 状态。
- 空状态、loading、offline、permission pending、crashed、no-model、no-session 均有明确动作。
- 键盘导航、焦点回归、对话框 aria、缩放、高对比度和 reduced motion 有基础回归。

#### M3 出口门禁

- 普通用户无需终端即可完成首次启动、Provider 登录/配置、新建任务、恢复/搜索/重命名/分叉/导出会话和安装一个受信 Pi skill。
- Extension UI 全方法 contract tests 通过；长会话测试不出现明显 O(n²) 增长或主线程长时间冻结。

### M4：升级检测、签名发布、安装器与可诊断性

目标：形成从版本、构建、签名、发布、检测、下载、安装、重启到升级后健康检查的完整闭环。仅仅“打开 GitHub Releases”不算自动更新。

#### UPD-001：更新服务边界

- 审计日 2026-08-02 的 registry 版本为 electron-builder 26.15.3、electron-updater 6.8.9、electron-log 5.4.4。先与项目 lockfile/运行环境验证，再把相互兼容的精确版本写入唯一 lockfile；不要继续用浮动 `^` 作为发布可复现性，也不要混用 Electron 内置 `autoUpdater` 的不同事件语义。
- 建立 main-only `UpdateService`。renderer 不接触 feed URL、token、文件路径或 raw updater，只通过窄 API 获取状态、请求检查/下载/安装和修改允许的偏好。
- 版本真相来自 `app.getVersion()`/packaged metadata，不信任 renderer 或手写常量；使用严格 semver，默认拒绝 downgrade。
- dev/test 模式返回明确 `unsupported-in-dev` 或注入 fake provider，不访问生产更新源。
- 更新源用 ADR 决定 GitHub Releases、S3/对象存储或 generic HTTPS。私有 GitHub token/API key 绝不能打进客户端；需要私有发布时使用受控下载授权或公开无密钥制品源。
- 当前 `mac.target` 只有 DMG，必须增加 ZIP；macOS updater 依赖 ZIP payload 与 `latest-mac.yml`。当前也没有 `publish`、updater dependency、签名、CI 和更新 UI，这些都属于本里程碑，不可只改一处配置。
- 推荐目录：`src/main/update/{update-types,update-service,update-ipc,update-errors,release-integrity}.ts`、`src/main/lifecycle/graceful-shutdown.ts`、`src/renderer/src/stores/update.ts` 和独立 update components；不要继续堆进现有 `ipc.ts/index.ts`。

#### UPD-002：状态机和 API

共享、可序列化的状态至少包含：

- `unsupported`
- `idle`
- `checking`
- `available`
- `not-available`
- `downloading`
- `downloaded`
- `waiting-for-agent`
- `installing`
- `error`

状态字段至少包含 current version、candidate version、channel、check source、last checked、release date/notes、download bytes/percent/speed、error code、retryable 和 dismissed version。事件带 monotonic sequence，renderer reload 后先取 snapshot 再订阅。

对 renderer 暴露的动作：

- `getUpdateState()`
- `checkForUpdates({source:'manual'})`
- `downloadUpdate()`
- `installAndRestart()`
- `setUpdateChannel('stable'|'beta')`
- `setAutoCheck(boolean)`
- `setAutoDownload(boolean)`
- `dismissVersion(version)`

如果当前 updater 版本支持真正的 CancellationToken，可提供 cancel download；否则不要放一个无效的“取消”按钮。

初始化规则必须集中在 `UpdateService` 并有单测：

- 产品层 `stable` 明确映射到 updater feed/channel 的 `latest`，`beta` 映射到 `beta`；配置、持久化和 UI 只使用产品层枚举，适配器内部才转换，避免 `stable/latest` 混用造成收不到更新或误入预发布通道。
- `autoDownload = false`
- `autoInstallOnAppQuit = false`
- `allowPrerelease = channel === 'beta'`
- 设置 channel 后最后再次明确 `allowDowngrade = false`；当前 electron-updater 的 channel/prerelease setter 可能联动 downgrade，不能只在前面设置一次。
- 注册且只注册一组 updater listeners 后才允许 check；所有 check/download/install 有 single-flight guard。
- 默认保留差分下载；只有出现可复现的上游缺陷且有全量 fallback 回归时才关闭。
- updater error 映射为 network/disk/permission/signature/metadata/unsupported/unknown，UI 不直接显示堆栈和服务端原始正文。

#### UPD-003：检测策略

- packaged app 主窗口可交互约 30 秒后首次检查；此后约每 4 小时检查，加入 10%–20% jitter，避免启动关键路径被网络阻塞和所有客户端同时请求。timer `unref()`，不阻止退出。
- 网络失败可按 15 分钟、1 小时、4 小时退避，成功后重置。manual check 不受后台静默提示节流，但要防并发/按钮连点。
- 同一时间只允许一个 check/download/install；重复调用返回当前 operation，而不是新建竞态。
- 默认 `autoDownload:false`：先展示版本、发布时间、经过纯文本/白名单净化的 release notes 和预计大小；用户同意后下载。
- 下载完成展示“立即重启安装/稍后”。只有用户已经同意下载后，才可选择退出时安装；绝不在用户有未保存草稿、录音、运行中 Agent 或 pending permission 时强行重启。
- stable 默认不接收 prerelease；beta 可接收 beta 且能回 stable。channel 切换显示影响并重新检查，不自动降级。
- staged rollout 只有在发布元数据、监控和撤回流程都存在后启用；不能只设置 percentage 而没有事故处置。
- 同一 candidate 在本进程只主动提示一次；“稍后”默认 24 小时内不重复弹窗，但 Settings 始终可见。
- macOS 在 `update-available` 后下载必须沿用同一次检查上下文；不要为“确认最新”再次 check 后才 download，避免 Squirrel.Mac 生命周期竞态。

#### UPD-004：更新 UI

- Settings 中有“关于与更新”：当前版本、runtime 版本、channel、自动检查/下载、上次检查、手动检查、更新错误与诊断复制。
- 全局 banner 只在 available/downloaded/需要用户动作的 error 显示；普通 no-update 不打扰，只在手动检查后反馈。
- 下载进度显示百分比、已传输/总量、速度和可重试状态；窗口关闭/reload 后从 main snapshot 恢复。
- 安装前检查 active Agent、未保存文件/草稿、录音、PTY、后台任务；提供“停止并安装”“稍后”，不静默丢任务。
- Active Agent 时提供“等待任务结束后安装”“停止任务并安装”“取消”。等待模式订阅真实 idle 事件而非轮询；停止模式先 abort，再在超时后安全 kill process tree。
- release notes 当作不可信内容处理，不在主 renderer 直接执行 HTML/远程脚本。

#### UPD-005：三平台产物

- Windows：以 per-user NSIS 为首发自动更新目标，生成 installer、`latest.yml` 和 blockmap；对 app exe、helper 和 installer 统一签名。保留安装目录/单实例/appId/协议关联兼容，不能因升级改变 appId 或用户数据目录。
- macOS：面向用户发布 DMG，同时生成 updater 所需 ZIP 与 `latest-mac.yml`；使用 Developer ID Application、Hardened Runtime、entitlements、notarization 和 stapling。加入麦克风用途说明；arm64/x64 或 universal 策略写 ADR 并分别验收。
- Linux：AppImage 作为首个 updater 目标并生成 `latest-linux.yml`；DEB/RPM 若无法可靠自更新，UI 明确降级为下载新包/打开受信发布页，不伪装自动安装。
- 每个平台发布 metadata、artifact、blockmap/checksum 必须原子可见：先上传 artifact，最后发布 manifest，避免客户端读到半次发布。
- 正式发布 CI 不默认使用当前开发配置中的第三方 Electron mirror；release 使用官方或经过供应链审批、校验的来源。国内镜像只能由开发环境显式启用。

#### UPD-006：签名、完整性与回滚

- production release 缺少签名/公证条件时必须失败，不能静默产出“正式版未签名包”。PR/nightly 可产生明确标注的 unsigned artifact，但不得进入 stable feed。
- macOS 必须签名并公证；Windows 使用可信 OV/EV 或 Azure Trusted Signing。证书、Apple 凭证、发布 token 只存在 CI secret，不写仓库、日志或 artifact。
- 客户端必须依赖平台签名与 updater 完整性验证；manifest/下载错误、签名不匹配、hash 不匹配全部中止安装并给出脱敏错误。
- 保留前一稳定版本及下载入口。v1 不得虚假声称自动二进制回滚；至少实现更新后 health marker、safe mode/诊断入口、分阶段放量与快速撤回 feed。若要自动回滚，另写 ADR 和跨平台 crash-loop 测试。
- 放量建议先 beta/internal，再 stable 5% → 25% → 50% → 100%，每步观察 check/download/install/healthy-launch；事故时停止新增下载并发布更高版本 hotfix，不能覆盖同版本资产或把 stable 指向低版本。
- 更新不能迁移或删除用户会话、settings、vault、索引和草稿；数据库 migration 必须向前兼容、可备份，失败时应用进入恢复模式而非循环崩溃。

#### UPD-007：应用更新与 Pi 更新分层

- bundled Pi 版本默认跟随应用版本，由应用 release 统一签名和回归，不在用户机器里直接 `npm update`。
- external Pi 只检测当前路径、版本、兼容范围和可用升级，不擅自执行全局 npm 修改；提供切回 bundled。
- 如果未来支持独立 runtime 更新，必须使用单独签名 manifest、原子目录切换、兼容矩阵、上一 runtime 保留和 rollback；不得复用应用 updater 的 feed 假装完成。

#### OBS-101：日志、诊断与崩溃

- 主进程、Pi runtime、updater、session index、permission 采用结构化日志，带 correlation/runtime/session ID；默认脱敏 prompt、key、Authorization、完整 home 路径和环境变量。
- 日志按大小/天轮转并有总量上限；提供一键 support bundle，用户可预览将导出的文件。
- 收集 crash dump 前取得明确隐私选择；无论是否接第三方崩溃平台，本地 crash marker 和启动恢复都必须工作。
- 更新后第一次启动执行轻量 health check：数据库 migration、renderer ready、bundled Pi handshake；成功后标记 healthy，失败进入 safe mode 并保留诊断。
- 更新 handoff 前写 `pending-update` marker；成功健康启动后写 `last-known-good` 并清 marker。新版本连续无法 healthy 时进入 safe mode：禁用第三方插件/自动任务，不自动降级二进制，显示诊断和上一稳定版受信下载入口。

#### QA-401：更新专项测试

- 使用本地/临时 HTTPS update server 和两个签名测试版本验证 N → N+1；不把生产 feed 用作测试。
- Windows clean VM：安装旧版、创建会话/设置/草稿、检测、下载、重启安装、验证版本与数据、卸载保留/删除数据选择。
- macOS：签名、公证、staple 验证，DMG 首装，ZIP 更新到新版本，麦克风权限仍正常。
- Linux：AppImage 检测/下载/替换；不可写目录、非 AppImage 安装和 DEB 场景显示正确降级。
- 错误矩阵：offline、代理、DNS、TLS、404、损坏 manifest、错误 semver、artifact 缺失、签名/hash 不匹配、下载中断、磁盘满、权限拒绝、重复检查、应用退出、active Agent 阻止重启。
- CI 校验 release 目录含平台所需 yml、artifact、blockmap/checksum，artifact version 与 tag/package 一致；stable feed 不允许 prerelease/unsigned。
- Release workflow 在原生 Windows/macOS/Linux runner 分别 `--publish never` 构建/签名/验证，再集中生成 SHA256SUMS、SBOM、third-party notices 和 provenance；先发布不可变 artifact，最后原子发布 channel metadata。第三方 Actions 固定 commit SHA，签名 secret 仅 release environment 可见。

#### M4 出口门禁

- 至少 Windows signed NSIS 在干净 VM 完成真实 N → N+1 更新闭环；macOS/Linux 若尚未获得证书/runner，必须保持功能关闭或 beta 状态，并明确列为未验证，不能宣称三平台完成。
- 用户可看到检测、下载、失败、重试、稍后安装和重启结果；数据与运行中任务不会被静默丢弃。
- release checklist、签名证据、artifact inventory 和更新 E2E 报告齐全。

以下真实值必须由产品所有者配置，Coding Agent 不得编造：正式 GitHub owner/repo 或 CDN/bucket/public URL、Windows signing identity/Publisher、Apple Team/Developer ID/notarization credential、Linux 独立 manifest 签名私钥、正式下载与反馈域名。缺失时可以完成 adapter、fake feed 和 unsigned CI artifact，但 release job 必须失败关闭，验收状态写 `not-tested/blocked-by-credential`，不能用自签名包冒充正式完成。另建 `docs/product/RELEASE_SETUP.md` 说明 secret 名称、申请、轮换、过期演练、发布暂停和 hotfix 流程，文档不得包含 secret 本身。

### M5：Workspace、Office/PDF 与 artifact 工作台

目标：让“AI 办公小助手”真正理解、展示和交付文件，而不是只把绝对路径拼进 prompt。

#### FS-101：Workspace 与文件服务

- 用户选择目录后创建 workspace record：ID、canonical root、display name、trust、created/last opened、ignore policy、默认模型和权限规则。
- 文件树 lazy load、watch、刷新、ignore、超大目录/符号链接保护；main 不向 renderer 返回工作区外绝对路径。
- 文件名和内容搜索可取消、分页、有结果上限，返回 relative path、行号和受限预览；重活放 worker/utility process。
- CodeMirror 文本编辑支持 encoding/newline 检测、dirty 状态、autosave 可选、显式保存、mtime + content hash 冲突和 compare/reload/overwrite。
- 新建/重命名/移动/复制/回收站/恢复都经过 PermissionEngine 和 root containment；破坏性动作显示精确范围。
- 附件变为结构化引用：attachment ID、capability、relative/source name、MIME、size、hash、expiry；不再把任意绝对路径当成可信输入。

#### FS-102：Agent changeset 与 diff

- Agent 对文件的写/edit/delete 形成 changeset，记录 session/turn/tool、before hash、after hash、路径、状态和时间。
- UI 支持 file/hunk diff、接受/拒绝、批量处理、在编辑器定位；大文件/二进制有明确降级。
- 接受/拒绝必须处理文件被外部修改的冲突，不能用过期 before 内容覆盖；必要时三方比较。
- changeset 状态可恢复且有撤销/备份策略；同一变更不能重复应用。

#### ART-101：安全预览与 Office 转换

- 第一版支持 Markdown、纯文本/代码、JSON、CSV、图片、音频/视频 metadata、PDF、Word、Excel、PPT 预览。
- Office/PDF 转换在受限 utility process/sidecar 中运行，限定 CPU、内存、执行时间、输入/输出目录和文件大小；默认禁用宏、脚本、远程模板、外部链接和自动数据连接。
- HTML/文档预览使用独立 sandbox/origin，无 Node、无主 preload、无主 session；CSP 阻断脚本和任意网络。
- 损坏、密码保护、超大、不支持文件返回可行动错误，可选择系统打开但不自动执行。

#### ART-102：Artifact Repository

- artifact 有稳定 ID、类型、来源 session/turn/tool、workspace、版本、hash、created/updated、preview、原始/导出路径和删除状态。
- artifact 库支持搜索/筛选、版本比较、rename、duplicate、export、show in folder、回收站/恢复。
- 聊天消息链接 artifact 的确定版本，而不是易失路径；session rename/archive 不破坏来源关系。
- Agent 生成产物有 generating/ready/failed/conflicted 状态；转换失败不丢原文件。

#### M5 测试与出口门禁

- 路径含中文/空格、symlink/junction、深目录、超多文件、外部修改、磁盘满和只读目录均有测试。
- 两个编辑器/外部程序并发修改时不静默覆盖。
- 典型 Word/Excel/PPT/PDF/CSV/图片能在 packaged app 安全预览；恶意文档不能执行宏/脚本、访问主 renderer 或任意网络。
- 用户可把文件交给 Agent、审阅 changeset、接受/拒绝并在 artifact 库追踪最终产物。

### M6：PTY、Git/Review、checkpoint 与 worktree

目标：为高级用户和 coding task 建立完整但默认收起的开发闭环。

#### PTY-101：真实持久终端

- `PtyManager` 位于 main/utility process，使用项目选定且跨平台验证的 PTY 实现；renderer 不能 spawn。
- 支持多 tab、workspace cwd、shell profile、resize、复制/粘贴、搜索、clear、退出码、restart、rename 和显式 kill。
- 输出用有界 ring buffer、chunk sequence 和背压；renderer reload/窗口切换后可重连并取 snapshot。
- 内部 Git/Pi 命令 API 不复用用户终端的 shell 字符串能力。打开终端和 Agent shell 都经过各自 permission scope。
- 正常退出、应用崩溃、更新安装、系统 sleep/wake 的保留/终止语义可配置且有测试；不能留下孤儿进程。

#### GIT-101：本地 Git 与 Review

- 先实现 repository detect、status、file/hunk diff、stage/unstage、safe revert、commit、branch create/switch。
- 再实现 fetch/pull/push、stash、history、conflict resolution；remote/branch 清楚显示，force push/reset/worktree remove 单独高风险审批。
- Git 进程只传 argv；路径、repo root、环境和 credential helper 受控；不在日志记录 token。
- Workspace changeset 与 Git diff 共用 review primitives，避免两套冲突状态。

#### GIT-102：Checkpoint 与 worktree

- checkpoint 记录 repo HEAD/index/worktree/untracked 策略、session/turn、时间和说明。不能假设所有 workspace 都是 Git repo。
- rewind 前展示将改变的文件、未跟踪文件和冲突；优先创建可恢复点，失败时不留下半恢复状态。
- worktree 支持 create/list/open/rename/compare、关联 session/Agent、merge/cherry-pick、archive 和 safe remove。
- 删除前检查 dirty、untracked、unmerged 和 branch reachability；默认不 force。

#### M6 出口门禁

- PTY 在 renderer reload 后继续且不丢已确认的尾部输出；高吞吐不冻结 renderer。
- Git UI 结果与 CLI fixture 一致，覆盖 Unicode、detached HEAD、submodule、conflict、无 Git workspace。
- checkpoint/rewind/worktree remove 的破坏性场景有精确预览、确认、恢复点和 E2E。

### M7：后台多会话、child Agent 与 worktree 编排

目标：从单活动聊天升级为可监督的并行 Agent，而不是简单增加多个 tab。

#### AGT-101：后台会话池

- 每 session 有独立 runtime/utility process，状态至少 `focused/background/warm/stopped/crashed`；配置全局/workspace 并发、内存和成本上限。
- pool 负责公平排队、idle 回收、crash budget、恢复和 shutdown；窗口关闭不等于任务停止，应用真正退出/更新时要让用户选择。
- 任意窗口用 snapshot + sequence 订阅 session；未读、running、waiting_permission、failed、done 有列表状态和系统通知。
- 后台 permission 进入统一 inbox；无人响应默认等待/超时拒绝，绝不自动允许。

#### AGT-102：Child Agent

- 父 Agent 创建 child 时必须给出目标、输入、workspace/worktree、模型/预算、权限继承、超时和预期交付物。
- UI 展示父子拓扑、状态、成本、最近活动、阻塞、证据、patch/commit 和 final result。
- cancel 向子节点传播；child 可以结构化发 progress/question/evidence/result，不能只靠解析自然语言日志。
- coding child 默认独立 worktree；合并前展示 diff、测试和冲突，支持 cherry-pick/选择文件/放弃。
- supervisor 实现重复任务检测、超时、有限重试、Provider 限流协调和结果收敛；非幂等工具不得因断线自动重放。

#### M7 出口门禁

- 至少 5 个并发后台会话在切换、reload、crash/recover 时不串消息、工具、permission 和成本。
- child 拓扑、取消传播、预算、worktree 隔离、失败可见和结果合并有 E2E。
- 用户始终能回答：哪个 Agent 做了什么、改了哪些文件、花了多少、测试是否通过、结果是否已合并。

### M8：Durable Tasks 与可治理长期记忆

目标：形成个人 Agent OS 的“持续执行”和“长期上下文”，同时保证可审阅、可停止、可删除。

#### AUT-101：持久任务

- 支持 once/daily/weekly/cron/event；保存时显示时区、下一次运行、workspace、Agent、Provider、权限、预算、超时和失败策略。
- scheduler 位于 main 或 headless helper，不依赖 Vue 页面；使用 lease、idempotency key、misfire policy、并发策略和 crash recovery。
- run 有独立 ID、输入 snapshot、状态、session/artifact、费用、日志、attempt；支持 pause/run now/cancel/retry/duplicate。
- App 关闭、系统 sleep/wake、DST、时钟回拨和 missed run 按用户选择 skip/run-once/catch-up；不能重复执行非幂等 action。
- 定时任务不能继承交互会话的 allow-once；危险动作需要预授权最小规则或等待 owner。

#### MEM-101：记忆

- 第一版先做 session/workspace FTS 和用户显式保存的 memory；每条记录 content/type/scope/source session/turn/file/created/updated/confidence/expiry/sensitivity。
- 用户可以查看原始证据、edit、merge、exclude、delete、export、关闭 workspace/all memory。
- embeddings/semantic search 是第二阶段；模型推断事实必须保留来源和置信度，不能把总结当不可更正真相。
- prompt 注入前记录命中项，调试/隐私界面可查看；secret、被排除文件和敏感路径默认不进入 memory。
- 删除覆盖正文、embedding、FTS、cache 和同步副本；验证删除后不再检索/注入。

#### M8 出口门禁

- scheduler 多实例争抢、sleep/DST/clock rollback/crash、任务重复和权限等待测试通过。
- memory 命中可追溯、可纠正、可精确删除；关闭后不再写入或注入。

### M9：Remote/PWA/IM、浏览器与安全插件平台

目标：高风险能力分三个独立 feature flag 发布。任何一个子模块没有完成其安全门禁，都不能借其它模块已完成而上线。

#### REM-101：Remote 与设备

- 默认只监听 loopback；用户主动开启 LAN/remote，显示监听范围和一键关闭。
- QR pairing 使用随机、短期、单次 challenge；长期 token 只存 hash，设备有 ID/name/created/last used/scopes，可逐台撤销/轮换。
- scopes 至少拆为 conversation.read、prompt.send、artifact.read、permission.approve、terminal、workspace.write、admin；后四项默认不授予。
- HTTP/WS/SSE/raw file/upload 全部经过同一 auth、origin/CSRF、rate limit、大小限制和审计；不能只保护 WebSocket。
- PWA 第一版只做会话、实时消息、发送/停止、后台状态、通知和 permission inbox；离线缓存不含 secret。
- IM connector 按 workspace/Agent/群聊白名单隔离，做去重、防回环、速率/附件限制和审计。

#### BROWSER-101：隔离浏览器/预览

- 使用独立 WebContentsView/partition，无主 preload、无 Node、sandbox、严格 navigation/download/permission policy。
- Agent 浏览器工具按 domain/session scope 申请导航、截图、DOM/action；cookie/login state 隔离且可一键清除。
- 下载进入受控 quarantine，经用户确认和 WorkspaceFs 后才移动到 workspace。

#### PLG-101：PiBuddy 插件

- manifest 声明 ID/version/source/compatibility/entry/contributions/capabilities/update metadata。
- 第三方代码不得在主 renderer 同 realm 动态 import；使用 utility process/worker/sandboxed iframe，默认无文件/网络/shell/secret。
- 插件 crash/timeout 独立隔离；安装/升级使用版本目录、签名/hash、权限 diff、原子切换和旧版本 rollback。
- v1 只允许 built-in/官方签名源。公开 marketplace、支付和评分延期。

#### M9 出口门禁

- 未配对设备访问任意 API/raw file/WS 均失败；关闭 remote 后连接和 token scope 立即失效。
- 浏览器内容不能访问主 renderer/preload/session；恶意下载不能越过 quarantine。
- 恶意或崩溃插件不能读取 key、越界文件、执行 shell或拖垮 App；新增权限升级必须重新批准。

### M10：GA 产品化门禁

目标：只对实际纳入 GA 的功能做承诺；未完成的高阶模块保持 feature flag 关闭并从公开文案移除。

#### 必做

- 完整 onboarding：安装 → Provider → workspace trust → 首次任务 → 权限 → 文件/artifact 结果 → 更新说明。
- 中英文覆盖用户可见文案；时间、货币、路径、快捷键按平台本地化。
- 键盘导航、焦点、screen reader label、颜色对比、动态字体、缩放和 reduced motion 回归。
- 隐私设置、数据 export/delete、遥测 consent、support bundle、反馈和卸载数据策略。
- 性能预算以 M0 基线为准写入夜间/GA gate；至少覆盖冷启动、长 stream、10k sessions、大 workspace、多后台 Agent 和 artifact preview。
- 产出 signed installers、checksums、SBOM、third-party notices、release notes、migration/rollback runbook、测试报告和 known issues。

#### 建议初始性能预算

- 4 核/8GB/SSD 参考机，冷启动到可交互 P95 ≤ 4 秒，不含 Provider 首 token。
- 已索引 10,000 sessions 的搜索 P95 ≤ 250ms；启动不读取全部 JSONL 正文。
- 50,000 历史消息只渲染可视窗口；滚动 P95 ≥ 50fps。
- Agent delta 到 UI 的额外延迟 P95 ≤ 100ms，事件队列有界。
- App main + renderer idle RSS 目标 ≤ 350MB；Pi/PTY/preview sidecar 单独统计。
- 默认 support bundle 30 秒内生成且不含会话正文。

最终阈值必须由 M0 的真实基线、目标硬件和产品取舍确认，不能为了过门禁伪造测量或删除场景。

#### GA 出口门禁

- 支持平台的 clean install、首次启动、核心任务、权限、crash recovery、数据 migration、N → N+1 更新和卸载 E2E 全绿。
- 发布 blocker 和高危安全问题为 0；接受的中风险有 owner、期限与缓解。
- 用户文档覆盖安装、Provider、workspace/权限、会话、文件/artifact、更新、备份恢复、隐私、诊断和卸载。

## 跨里程碑质量门禁

| 测试层 | 必须覆盖 | 执行频率 |
|---|---|---|
| Unit | JSONL、schema、state machine、path、permission、index、scheduler、memory、semver/channel | PR |
| Contract | fake Pi RPC、支持的 Pi 版本、Extension UI、MCP、Provider、update manifest | PR |
| Main integration | utility process、SQLite migration、safe storage、WorkspaceFs、PTY、Git、supervisor | PR/夜间 |
| Renderer component | loading/empty/error/cancel、keyboard/a11y、large list、permission/update UI | PR |
| Electron E2E | onboarding、chat、recover、session、Provider、files、update | PR 核心/夜间全量 |
| Packaged smoke | 无全局 Pi、resourcesPath、asar/native、签名、协议、升级 | 每平台 release |
| Security | XSS/navigation、IPC fuzz、path traversal/symlink、SSRF、secret leak、remote/plugin | 相关里程碑/夜间 |
| Reliability | crash/kill/restart、disk full、offline、sleep/wake、duplicate event、update interrupt | 夜间/release |
| Performance | long stream、10k sessions、50k messages、大 workspace、多 PTY/Agent | 夜间趋势/GA |

最低平台矩阵：Windows 11 x64；macOS 当前与前一主版本 arm64，若发布 x64 则增加 x64；Ubuntu LTS x64。只有产品明确支持 Windows 10 时才加入其持续门禁。

## 明确延期与不做

- M0-M4 不做公开插件市场、云账号计费、匿名分享、公网 relay 和浏览器自动化。
- Provider 第一版不做自动套利式路由；先完成登录、健康、模型能力和可解释选择。fallback 不能重放非幂等 tool turn。
- Office 第一版做安全预览、artifact 版本和受控导出，不承诺完整在线 Office 编辑器。
- Git 第一版先本地 status/diff/stage/commit/worktree，不复制完整 GitHub/GitLab PR 平台。
- 没有进程/realm 隔离时只允许 built-in 插件，不能靠 manifest 自称安全。
- 没有父子拓扑、预算、取消传播、隔离和结果收敛时，多个 tab 不能宣传为 multi-agent orchestration。
- 记忆先显式保存、来源和删除，不默认把所有对话自动写入长期记忆。
- Remote 默认关闭；低权限设备不能 shell、写文件或授予永久权限。

## 相关竞品只作为行为参考

| 领域 | 优先查看 | 只借鉴什么 |
|---|---|---|
| Runtime/pool | Picot、justhil/pi-app、AJSubrizi/Pi-App | bundled runtime、generation、focused/background/warm |
| Permission | AJSubrizi/Pi-App、OpenCode、Nimbalyst | once/session/workspace、审计、capability |
| Session | pi-gui、Pi Session Manager | tree/fork、增量索引、FTS/分析 |
| Files/Office | OpenPi、Picot、AionUI | CodeMirror、mtime、Office/PDF、安全预览 |
| Git/worktree | OpenPi、AJSubrizi/Pi-App、Superset | review、checkpoint、worktree 生命周期 |
| Child Agent | pi-gui、CodePilot、AionUI | 父子拓扑、监督、证据/结果收敛 |
| Updates | OpenCode、Picot、AionUI | 签名 updater、channel、产品状态 |
| Provider/MCP | CC Switch、Claude Code Router | health、fallback、统一资源控制台 |
| Tasks/memory | CodePilot、AionCore、Nimbalyst | durable run、来源治理、可删除记忆 |
| Remote | Picot、VibeAround、AionCore | pairing、handover、统一 auth |

## 里程碑续作提示词模板

当一个里程碑完成、切换到新会话或上下文压缩后，使用下面的短提示词，不要重新让 Agent 猜项目状态：

“继续 PiBuddy 产品级改造，`TARGET_MILESTONE = Mx`。先读取 `docs/product/requirements.md`、`architecture.md`、`threat-model.md`、`traceability.md`、相关 ADR、上一个里程碑验收报告和当前 git diff。验证上一个出口门禁仍然通过，只实施 Mx，不重做已完成工作。先给出 Mx 的需求 ID、当前证据、修改文件、migration、security 和 test plan，然后完成一个可运行的垂直切片。所有完成项必须区分 implemented、tested、packaged-tested、not-tested。”

## 独立验收提示词模板

实现者完成一个里程碑后，交给另一个 Agent 使用：

“你是独立 Release/Security Reviewer。不要先相信实现者总结，也不要扩大功能范围。读取 Mx 的 requirements、ADR、traceability、git diff、测试和打包产物，逐条核对 Definition of Done。重点寻找 renderer 越权、路径/SSRF、旧 generation、永久 pending、数据丢失、更新签名/manifest、跨平台和只在 dev 有效的问题。亲自运行可行测试。输出 PASS/FAIL/NOT TESTED 证据表、阻断项和最小修复建议；没有 packaged 证据的条目不得判 PASS。”

## 实施时使用的官方依据

- [Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [electron-builder Auto Update](https://www.electron.build/docs/features/auto-update/)
- [electron-builder Code Signing](https://www.electron.build/docs/features/code-signing/)
- [electron-builder macOS Signing/Notarization](https://www.electron.build/docs/mac/)
- [electron-builder Target Selection](https://www.electron.build/docs/targets/)

实际实施时应重新核对当前锁定版本的 API 和官方文档；本提示词中的版本号和行为结论以 2026-08-02 审计时点为基准。
