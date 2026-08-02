# PiBuddy 与桌面 Agent 竞品源码审计

审计日期：2026-08-02  
审计对象：18 个 GitHub 仓库（17 个产品/子系统）以及用户提供的 PiBuddy Electron + Vue 应用、`@pibuddy/pi-sdk` 和根 `tsconfig.base.json`。

## 一、结论先行

PiBuddy 的 Vue 对话层不是静态 Demo：流式对话、thinking、工具卡、图片多模态、steer/abort、模型与思考等级、费用/上下文、语音转写和一部分 Pi Extension UI 都有实际代码闭环；应用与 SDK 的 TypeScript 检查、应用生产构建也都通过。

但它目前还不能算“可交付给普通用户的完整桌面 Agent”，原因不是功能按钮少，而是有三个确定性的运行阻断：

1. 内置 Pi 0.83.0 的入口解析方式不兼容其 ESM `exports`，代码实际总会回退全局 `pi`；未全局安装 Pi 的用户启动失败。
2. macOS/Linux 的 Pi 会话目录编码多一个 `-`，历史列表通常恒为空；自定义 agent/session 目录也未处理。
3. 新旧 Pi client 没有 generation/run ID，旧进程延迟退出或残留的 33ms 事件队列可以污染新会话。

修完这三项后，PiBuddy 才进入真正的桌面 MVP 阶段。与成熟项目相比，主要缺口依次是：安全权限与可靠发布、完整会话管理、文件/变更工作台、PTY/Git/worktree、Pi 资源管理、后台并发 Agent、远程/自动化/记忆。

最适合借鉴的组合不是照搬某一个仓库：

- 运行时与后台会话：`justhil/pi-app`、Picot、AJSubrizi/Pi-App。
- 权限与安全边界：AJSubrizi/Pi-App、OpenCode、Nimbalyst。
- 文件/Git/Review：OpenPi、AJSubrizi/Pi-App、Superset。
- child Agent + worktree + 监督：`pi-gui`。
- 远程手机端：Picot、VibeAround、AionUI/AionCore。
- 历史索引与分析：Pi Session Manager。
- 定时任务与长期记忆：CodePilot、Nimbalyst、AionUI/AionCore。
- Provider/MCP/Skills 管理：CC Switch；可靠路由与 fallback：Claude Code Router。

## 二、审计方法与边界

- 对每个仓库固定到 2026-08-02 本地浅克隆 HEAD，检查 package/Cargo 清单、桌面主进程、preload/IPC、renderer、Agent/RPC 生命周期、数据库/schema、文件/Git/PTY、扩展、测试和发布配置。
- “已实现”表示能从 UI/API 追踪到服务、进程或数据层调用链；README/ROADMAP 中只有规划而无调用链的项目不计为完成。
- 这是源码级静态审计，不宣称逐项启动了所有竞品。外部账号、云端、移动端、签名发布和真实 Provider 登录没有逐一运行验收。
- PiBuddy 在临时重建的 npm workspace 中完成 `@pibuddy/pi-sdk`、`@pibuddy/app` 类型检查和 `electron-vite build`。安装使用 `--ignore-scripts`；原始根 `package.json`、lockfile、签名/发布流水线未提供，因此安装包和真实 Pi RPC 未完成端到端验收。

标记：✅ 有实际实现闭环；◐ 部分实现、依赖外部 CLI/云/另一个仓库或存在确定性缺陷；— 本次源码未发现。

## 三、PiBuddy 当前源码能力

| 能力域 | 当前结论 | 源码核验结果 |
|---|---|---|
| Pi 启动 | ◐ 阻断 | 设计为 Electron 内置 Node 启动 bundled Pi，再回退全局 `pi`；0.83.0 下 `require.resolve()` 恒失败，实际只剩全局 Pi 路径。 |
| RPC SDK | ◐ | JSONL、request ID、prompt/steer/follow-up/abort、session/model/thinking/stats/compact/commands wrapper 已有；缺 timeout、AbortSignal、stdin 背压、完整 spawn/stop/crash 状态机。 |
| 流式聊天 | ✅ | text/thinking/tool call/result、错误/中止、自动重试与压缩状态；主进程约 33ms 合并累计事件。 |
| 长对话 | ◐ | UI 默认挂载最近 60 条，可继续展开；仍是窗口截断而非真正虚拟列表，流式完整快照与全量 Markdown 重解析接近 O(n²)。 |
| 运行中控制 | ✅/◐ | steer、队列显示、abort 已接；follow-up wrapper 已有但 UI 没有明确入口。 |
| 会话 | ◐ 阻断 | 新建、打开、恢复消息和 JSONL 元数据解析已写；POSIX 目录错误，自定义 sessionDir 不支持，也无 rename/search/archive/delete/fork/tree/export UI。 |
| 模型/统计 | ✅ | 模型、thinking level、费用、context percent；无应用内 Provider 登录、API key/OAuth、模型健康检查和聚合 usage dashboard。 |
| 图片 | ✅ | 粘贴、拖入、选择图片，base64 走 Pi `images` 真多模态；这是当前实现的强项。 |
| 普通文件/视频 | ◐ | 只把绝对路径写进 prompt，没有结构化附件、工作区 capability、预览/编辑、Office/PDF artifact。 |
| 语音 | ◐ | MediaRecorder + OpenAI-compatible STT 已实现；key 明文存储并进入 renderer，base URL 可形成 SSRF，缺 timeout、大小限制和 macOS 麦克风发布配置。 |
| Extension UI | ◐ | select/confirm/input/editor、notify、setStatus、set editor text；缺 setWidget/setTitle、dialog timeout 清理，项目 trust 状态未接。 |
| 文件工作台 | — | 无文件树、搜索、编辑器、mtime 冲突、变更 diff/接受/拒绝。 |
| 终端 | — | 无持久 PTY、tab、resize、进程管理。 |
| Git/worktree | — | 无 status/diff/stage/commit/branch/worktree/checkpoint/review。 |
| 工具权限 | — | 无 read/write/bash/network/MCP 的 once/session/workspace 策略、审计与撤销；Pi project trust 仅控制项目资源加载，不是工具 sandbox。 |
| Pi 生态管理 | — | 只能被动承接部分扩展 UI；无 packages/skills/extensions/themes/MCP 的发现、安装、启停、版本和权限管理。 |
| 并行 Agent | — | 一个窗口对应一个 Pi client；无后台会话池、child-agent 拓扑、结果收敛或 worktree 隔离。 |
| 远程/自动化/记忆 | — | 无 Web/PWA/mobile/IM、durable scheduler、长期记忆与跨会话检索。 |
| 桌面发布 | ◐ | 有 NSIS/DMG/AppImage 配置；无签名、公证、自动更新、fuses、CI、安装/升级 smoke、support bundle，且 `asar:false`。 |

### 已通过的构建检查

- `@pibuddy/pi-sdk`：`tsc --noEmit` 通过。
- `@pibuddy/app`：`vue-tsc --noEmit` 通过。
- `@pibuddy/app`：`electron-vite build` 通过，main、preload、renderer 均产出。
- 上述结果只能证明类型与 bundling；内置 Pi 解析 bug 正说明生产 build 不能替代 packaged runtime smoke test。

## 四、18 个仓库的角色、功能与相对领先点

### 4.1 完整桌面 Agent / 工作台

| 仓库与快照 | 源码中已实现的主要功能 | 相对 PiBuddy 的主要领先点 |
|---|---|---|
| [CodePilot](https://github.com/op7418/CodePilot) `73a7f88` | native/Claude SDK/Codex 三运行时；会话搜索、压缩、checkpoint/rewind；权限审计；文件/多格式预览/PTY；完整 Git/worktree；subagent cockpit；MCP/Skills/Plugins/CLI 市场；多 Provider/OAuth/usage；Telegram/飞书/Discord/QQ/微信；定时任务、workspace index、memory、图片生成和 Generative UI；updater/Sentry/E2E。 | 产品宽度、权限、并行 Agent、渠道、任务、记忆、发布链几乎全线领先。 |
| [AionUI](https://github.com/iOfficeAI/AionUi) `2bca547` + [AionCore](https://github.com/iOfficeAI/AionCore) `274f325` | Electron UI + Rust sidecar；AionRS/ACP/自定义/远程 Agent，Pi 经 `pi-acp`；会话、审批、团队 Agent/mailbox/task board/恢复；文件、Git snapshot、Word/Excel/PPT/PDF 预览转换；MCP OAuth、Skills、Extension Hub、自定义 assistant；Cron；认证 WebUI、Telegram/飞书/钉钉/微信、远程 Agent、流式 STT；updater 与大量测试。 | 团队编排、Office 工作台、扩展平台、远程/渠道、Cron 和 sidecar 可靠性。 |
| [VibeAround](https://github.com/jazzenchen/VibeAround) `bfd814e` | 发现/启动多种 Agent；OpenAI/Anthropic/Gemini 协议桥和 Agent-as-API；ACP Web Hub、丰富内容渲染、Web Terminal；handover、tunnel、IM 插件生命周期；dev server/Markdown/HTML preview；最多 8 个 parallel subagent 自动建 branch/worktree；桌面/CLI/TUI。 | 多 Agent 接入基础设施、远程接力、Web Terminal、API bridge 和 worktree 并行。 |
| [Superset](https://github.com/superset-sh/superset) `d1ea13e` | 管理 14 种终端 Agent并有原生 Chat；pane 工作台、CodeMirror、持久 PTY daemon；完整 Git/worktree/PR/check/review；内置 Browser WebView；relay/host-service、原生移动端；云端 RRULE 调度；高密度测试。 | 多 CLI 工作台、终端持久化、Git/PR、浏览器、远程移动端。 |
| [Nimbalyst](https://github.com/nimbalyst/nimbalyst) `1e2c058` | API/SDK/CLI/ACP/OpenCode 多运行时；Monaco/Lexical/Ghostty；最深 Git/worktree/PR；workstream、MetaAgent、Blitz/SuperLoop；隔离浏览器自动化；MCP OAuth、权限化扩展与市场；Markdown automation；SQLite/BM25/vector memory；原生 iOS/Android 和协作同步。 | 能力密度最高：编辑器、编排、浏览器、自动化、记忆、插件和移动端均完整。 |
| [CloudCLI / ClaudeCodeUI](https://github.com/siteboon/claudecodeui) `59472c0` | Express/WS + React PWA + Electron 壳；Claude/Codex/Cursor/OpenCode；会话/文件/CodeMirror/node-pty；完整 Git/worktree；MCP/Skills、URL 插件；browser-use；Web/PWA 远程与认证。 | Web/PWA 可达性、四 CLI 统一 UI、Git/worktree 和本地 server 架构。 |
| [OpenCode](https://github.com/anomalyco/opencode) `32f278b` | 第一方 Agent core/server/desktop；session/tool/permission/subagent 一体；文件搜索/diff/review、PTY；实验 worktree；MCP OAuth、Skills、Plugins、commands/agents；远程 server/WSL；强 Electron sandbox、updater 与测试。 | 最值得参考的 Agent 内核、permission/subagent 模型和 Electron 安全基线。 |

### 4.2 Pi 专用桌面客户端

| 仓库与快照 | 源码中已实现的主要功能 | 相对 PiBuddy 的主要领先点 |
|---|---|---|
| [pi-gui](https://github.com/minghinmatthewlam/pi-gui) `eb9a738` | main 内 Pi SDK + SessionSupervisor；重命名/归档/置顶/树/fork/多窗口/外部同步；可编辑 steer/follow-up 队列；真实图片附件；Provider OAuth/API key；完整 Extension UI；受控预览、node-pty、基础 Git diff/stage、原生 worktree；child thread 工具、消息、监督循环和证据汇总；资源启停。 | child-agent + worktree + supervision 是 Pi 客户端中最强；会话、后台生命周期、PTY 也明显领先。 |
| [OpenPi](https://github.com/heyhuynhgiabuu/openpi) `29137ff` | Pi SDK sidecar 与崩溃重启；会话搜索/树/fork/compact/worktree；CodeMirror 文件树/搜索/编辑；PTY；hunk stage/revert、commit/push/pull/branch/stash/history/conflict、Keep/Revert、逐行评论；Provider auth；包管理；SQLite usage dashboard。 | 文件编辑与 Git/Review 最完整。 |
| [justhil/pi-app](https://github.com/justhil/pi-app) `1cb6397` | 每会话 utility process，focused/background/idle worker pool；会话树/fork/clone/rewind/compact/sandbox；后台队列；Codex ASR；Provider/model JSON 与 Pi SDK 版本切换；文件预览；Git hunk/commit；resources/packages/skills/extensions、revision 与大量 adapter；强测试/SBOM。 | 后台多会话进程池、语音、SDK 切换、兼容层和工程测试。 |
| [pi-desktop](https://github.com/gustavonline/pi-desktop) `5d69843` | 外部 Pi RPC，多 workspace/instance 与 generation；会话树/fork/compact/export；模型/provider 状态；Extension UI；基础文件树/textarea 自动保存；xterm 外观；基础 Git/外部工具；`pi list/install/remove/update`、skills/themes。 | 即使是轻量项目，也比 PiBuddy 多文件、终端入口、会话 fork/export 和 Pi 包管理；但其终端并非通用持久 PTY，安全/测试弱。 |
| [Picot](https://github.com/shixin-guo/picot) `8f36a96` | 固定版本 Pi sidecar；workspace 主进程 + 最多 5 个 side chat + quick chat；成熟会话搜索/收藏/归档/Focus；图片/队列/Extension UI；CodeMirror、mtime 冲突、Office/PDF/图片；portable-pty；包/Skills/配置 bridge；LAN QR 配对、PWA/mobile、Telegram Agent Inbox；usage 趋势与签名更新。 | 自包含 Pi、多进程/side chat、原生 PTY、Office 预览、手机遥控和开箱即用。 |
| [AJSubrizi/Pi-App](https://github.com/AJSubrizi/Pi-App) `27b5079` | focused/background/warm Pi 进程池；本地/SSH/WSS；完整 stream/plan/ask/permission；会话搜索/归档/恢复；可编辑 ResourceViewer、mtime 冲突、Rust PTY、child Webview；Git status/diff/stage/commit/push/PR/worktree、checkpoint/rewind；packages/Skills/MCP/plugins/hooks/persona/marketplace；日/周/单次自动化、PR sweep、usage。 | 六个 Pi 客户端中唯一形成 once/session + 持久规则 + 路径/下载风险判断的权限系统，也是 IDE/Git/worktree/checkpoint/自动化最全的一款。 |

### 4.3 配置、历史、网关与早期管理器

这些产品很有参考价值，但不能把它们的功能数量直接当作主聊天客户端基线。

| 仓库与快照 | 实际定位与主要功能 | 可拆出的参考子系统 |
|---|---|---|
| [Pi Session Manager](https://github.com/Dwsy/pi-session-manager) `9d0e1dd` | 主产品不托管 Pi RPC；把九类 Agent JSONL 导入 SQLite/FTS，提供标签/收藏/树/分支图、统计、摘要、经验提取；portable-pty；Pi 资源编辑；大型插件平台；headless server、REST/WS、PWA/mobile。实时控制依赖另装 bridge，权限链和若干 RPC 仍不完整。 | SessionRepository、跨 Agent 导入、FTS/分析、headless remote；插件同 realm 动态 import 的做法不应照搬。 |
| [CC Switch](https://github.com/farion1231/cc-switch) `ebbf141` | 不执行聊天 turn；管理八类 Agent 工具的 Provider、协议代理、价格/用量；failover/circuit breaker；MCP/Prompts/Skills 跨工具同步、deep link；session 浏览；S3/WebDAV 备份；updater/tray。 | Provider 控制台、统一 MCP/Skills、同步备份。 |
| [Claude Code Router](https://github.com/musistudio/claude-code-router) `4a152d9` | 网关而非聊天客户端；OpenAI/Anthropic/Gemini 等多协议 provider、route/rewrite/retry/fallback、凭证池、API key/limit、usage/trace；Pi profile；ToolHub、浏览器自动化、插件市场、bot gateway；Desktop/CLI/Web/Docker。 | ProviderGateway、fallback/circuit breaker、用量与可观测性。 |
| [Opcode](https://github.com/winfunc/opcode) `70c16d8` | 早期 Claude CLI 管理器；会话/history/resume、checkpoint、MCP、自定义 Agent、usage 已有；无完整编辑器/PTY/Git/worktree，多处 Web/mobile/preview 为 mock/TODO，最后提交停在 2025-10。 | 只适合参考早期会话/checkpoint 交互，不应作为 2026 年成熟基线。 |

## 五、PiBuddy 相对竞品还缺什么

### P0：先把现有产品变成可靠、可安全发布的桌面端

1. **修复 bundled Pi。** 用 ESM `import.meta.resolve()`/显式 sidecar 定位 0.83.0，启动前做 version/protocol/capability handshake；保留 tested bundled 与 advanced external 两种模式。CI 必须在没有全局 Pi 的打包产物上启动 RPC。
2. **统一会话解析。** 复用 Pi 的 SessionManager/resolver，不再复制 cwd 编码；支持 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、settings `sessionDir`，并逐步改成 offset/mtime 增量索引。
3. **建立 PiRuntimeSupervisor。** generation/run ID、`starting/running/stopping/stopped/crashed` 状态机、每 RPC timeout/AbortSignal、stdin error/backpressure、bounded JSONL、graceful abort → terminate → process-tree kill、stderr/support log、受限自动重启。
4. **收窄 preload/IPC。** 删除 renderer 任意 `pi.command()` 与未使用的任意 `shell.openPath`，改成窄 typed methods；校验 sender main frame/origin、schema、长度、频率、canonical workspace root 和 capability token。
5. **补安全边界。** 开启 renderer sandbox；CSP 限制 script/img/connect；拒绝新窗口与导航，白名单外链交给系统浏览器；STT key 用 OS 安全存储且不返回 renderer，base URL 做 allowlist/私网阻断；附件限 MIME/大小/数量。
6. **修数据一致性。** 处理 `new_session`/`switch_session` 的 `data.cancelled`；发送失败保留草稿与附件；切换失败不混用旧消息；runtime 更换清理 queue/UI request/status；设置原子写、备份和 migration。
7. **建最小测试与发布链。** SDK 单测、RPC fake-process contract、Electron E2E、Windows/macOS/Linux packaged smoke、升级回归；代码签名/公证、自动更新、fuses、崩溃/诊断导出。`asar:false` 改成最小 `asarUnpack`/extraResources。

### P1-A：先接入上游已经有、成本最低的能力

| Pi/SDK 已有 | PiBuddy 需要补的 UI/状态 |
|---|---|
| `set_session_name` | 会话重命名。 |
| `get_commands` | Skills/prompts/extensions 命令面板与 slash autocomplete；同步更新落后的 `CommandInfo.sourceInfo` 类型。 |
| `compact` | 手动压缩、自定义指令和自动压缩开关。 |
| `fork`、`clone`、`get_entries`、`get_tree`、`get_fork_messages` | 会话树、分支、clone/rewind 基础。 |
| `export_html` | 会话导出。 |
| steering/follow-up mode | 明确的“立即插话/下一轮排队”选择和队列编辑。 |
| auto compaction/retry/abort retry | 自动策略设置与取消重试。 |
| `setWidget`、`setTitle`、dialog timeout | 完整 Extension UI 兼容。 |
| `bash_execution_update` / `BashExecutionMessage` | 直接 bash 的增量输出与最终状态。 |

### P1-B：达到成熟桌面 Agent 基线

1. **会话中心：** 搜索、rename、archive/delete/pin、fork/tree/rewind、import/export、未读与后台状态；SQLite/FTS 增量索引而不是主线程全量读 JSONL。
2. **Provider 中心：** Pi auth/OAuth/API key、自定义 OpenAI-compatible endpoint、模型发现/健康检查、账号/额度/usage；密钥留在主进程。
3. **Workspace 工作台：** 注册 canonical root；文件树、全文搜索、CodeMirror、预览、mtime/hash 冲突、变更 diff、接受/拒绝。若继续定位“办公助手”，Office/PDF/表格/图片的结构化预览和 artifact 库应先于复杂 PR 管理。
4. **真实 PTY：** node-pty 多 tab、resize、shell profile、输出环形缓冲、窗口重载重连、显式清理。
5. **Git/review：** status/diff、file/hunk stage/revert、commit/branch；再扩展 push/pull/stash/history/worktree/checkpoint。危险操作显示精确范围并保留恢复点。
6. **权限中心：** read/write/edit/bash/network/MCP 分级，allow once/session/workspace、deny、规则撤销和审计。Agent 自身工具与桌面 IPC 权限要用同一个主进程决策层。
7. **Pi 生态中心：** packages/extensions/skills/themes/MCP 的发现、安装、启停、配置、版本锁、来源与权限清单；Pi 原生资源和 PiBuddy 自有插件必须分层。
8. **后台多会话：** 每 session utility process/worker、focused/background/warm 状态、并发上限、通知、窗口重载后重订阅。

### P2：形成“个人 Agent OS”差异化

1. **child Agent + worktree + supervision：** 以 `pi-gui` 为产品参考，加入父子任务、取消传播、隔离分支、跨线程消息、证据和结果收敛；不要把“多 tab”误当编排。
2. **durable automation：** daily/weekly/once/event、lease/idempotency、missed-run、重试、日志和通知；调度器放主进程或 headless helper，不依赖 Vue 页面存活。
3. **remote/mobile/IM：** 默认 loopback，用户主动开启 LAN；短期单次 QR pairing、长期 token hash、按设备撤销、所有 HTTP/WS/raw-file 统一鉴权；远程终端、写文件、批准权限需要 owner 能力。
4. **长期记忆：** workspace index、跨会话 FTS/语义检索、事实来源/置信度/过期/合并/精确删除；先做可审阅记忆，再做自动注入。
5. **Office 与 artifacts：** Word/Excel/PPT/PDF/图片/网页的结构化预览、版本与产物库，Generative UI/可交互 artifact；这比单纯复制另一个 coding IDE 更符合当前“AI 办公小助手”定位。
6. **浏览器/预览：** 隔离 WebContentsView、无 preload、独立 partition、导航/截图/DOM 工具、dev-server preview；与主 renderer 和登录态隔离。
7. **安全插件市场：** manifest、capability、受限 worker/utility process/iframe、签名来源、版本锁、升级回滚。市场目录不是安全模型。

## 六、推荐的 Electron + Vue 模块边界

| 主进程模块 | 核心职责 | 首选参考 |
|---|---|---|
| `PiRuntimeSupervisor` | bundled/external Pi、handshake、generation、RPC timeout、进程树、后台 session | Picot、justhil/pi-app、AJSubrizi/Pi-App |
| `SessionRepository` | JSONL 增量索引、SQLite/FTS、树/标签/搜索/统计 | Pi Session Manager、pi-gui |
| `PermissionEngine` | 工具/路径/网络决策、once/session/workspace、审计 | AJSubrizi/Pi-App、OpenCode、Nimbalyst |
| `WorkspaceFs` | rootId + relativePath、realpath/symlink containment、watch、mtime/hash | Picot、OpenPi |
| `PtyManager` | node-pty、多 tab、resize、流控、重连、清理 | Superset、Picot |
| `GitService` | diff/stage/commit/worktree/checkpoint/review | OpenPi、AJSubrizi/Pi-App、Superset |
| `ResourceManager` | Pi packages/skills/extensions/themes/MCP | Pi-App、pi-desktop、CC Switch |
| `ExtensionHost` | Pi Extension UI 与 PiBuddy 插件分层、能力 token、隔离 | Nimbalyst、AionUI/AionCore；避免 PSM 同 realm import |
| `Scheduler` | 持久任务、lease、重试、missed-run、通知 | CodePilot、AionCore；增强 AJSubrizi/Pi-App |
| `RemoteGateway` | loopback/LAN、pairing、auth、设备权限、PWA/IM | Picot、VibeAround、AionCore |
| `MemoryService` | 索引、检索、来源治理、编辑/删除 | Nimbalyst、CodePilot、PSM |
| `UpdateService` | App/Pi 分离更新、签名、channel、rollback | OpenCode、Picot、AionUI |

Vue 状态不应继续全部塞在一个全局聊天 store。至少以 `sessionId` 为一级键拆分 runtime、stream、queue、permission、extension UI、files、terminal；事件携带 generation + monotonic sequence，renderer 检测丢包后请求 snapshot。流式文本用 delta 按帧拼接，完成后再做 Markdown 缓存。



## 七、最终产品判断

PiBuddy 当前最有价值的已完成部分是：简洁的 Vue 对话体验、真实图片多模态、Pi 流式/tool 展示、steer/abort、语音和基础 Extension UI。不要为了追赶功能数量推翻这层。

接下来的正确顺序是：

1. 修复 runtime、session、generation 三个确定性阻断；
2. 做权限/IPC/发布安全与测试；
3. 吃完 Pi/SDK 已有的低成本会话和扩展能力；
4. 增加文件/变更/PTY/Git 形成桌面工作闭环；
5. 用后台会话 + child-agent/worktree 建立并行能力；
6. 选择“Office artifacts + durable tasks + memory + remote”作为个人 Agent OS 差异化。

这样做的结果不是另一个功能堆叠的 Pi GUI，而是一套可靠的 Electron + Vue Agent 平台：Pi 是可替换运行时，主进程掌握权限、进程和数据，Vue 只负责可恢复、可验证的交互状态。
