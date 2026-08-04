/**
 * IPC 通道名常量 —— **本文件刻意不 import zod**。
 *
 * 拆出来的唯一原因是 preload：它开着 sandbox:true，产物必须是自包含的 .cjs
 * （沙箱里的 require 只认 electron 与少数内建模块，解析不到 workspace 包时
 * 整个 preload 会静默失败、window.piBuddy 变成 undefined）。preload 需要的
 * 只是这几个通道名，把它们和 schema 放在同一个模块里，就意味着要把整个
 * zod 打进 preload —— 140KB 的运行时校验库躺在一个从不做校验的安全边界上。
 *
 * schema 与通道名的对应关系仍然唯一，见 ipc-contract.ts 的 CHANNEL_CONTRACTS：
 * 那里的键类型就是本文件的 InvokeChannel，少一条或多一条都过不了编译。
 */

/**
 * 渲染进程可发起的 invoke 通道。
 *
 * `pi:*` 产品动作通道与 pi-sdk 的命令封装一一对应，**没有**通用的
 * 转发通道 —— 新增一种 pi 能力必须在这里显式加一行，并因此过一遍威胁模型。
 */
export const CHANNELS = {
  // ---- 运行时生命周期（非产品动作，不在 window.piBuddy.pi 命名空间下） ----
  piStart: "pi:start",
  piStop: "pi:stop",
  piUiRespond: "pi:ui-respond",
  /**
   * 取扩展 UI 的当前快照（挂起弹窗 / 状态 / widget / 标题）。
   *
   * 窗口 reload 之后渲染进程的内存全没了，而挂起表在主进程里还在。没有这
   * 条通道的话，reload 只能表现为「所有正在等待回答的问题凭空消失，扩展
   * 那边继续阻塞」。
   */
  piUiPending: "pi:ui-pending",

  // ---- 15 个产品动作窄通道 ----
  piPrompt: "pi:prompt",
  piSteer: "pi:steer",
  piFollowUp: "pi:follow-up",
  piAbort: "pi:abort",
  piNewSession: "pi:new-session",
  piSwitchSession: "pi:switch-session",
  piSetModel: "pi:set-model",
  piSetThinkingLevel: "pi:set-thinking-level",
  piGetState: "pi:get-state",
  piGetMessages: "pi:get-messages",
  piGetSessionStats: "pi:get-session-stats",
  piGetAvailableModels: "pi:get-available-models",
  piGetAvailableThinkingLevels: "pi:get-available-thinking-levels",
  piCompact: "pi:compact",
  piSetSessionName: "pi:set-session-name",

  // ---- 会话树 / 分叉（数据面；可视化 UI 本轮不做，见 TASK-009 risks[1]） ----
  //
  // rpc.md:694 起的 get_entries 只有 `since`（strictly after）游标，**没有**
  // before / limit，因此「向更早翻页」在协议层根本不存在 —— 那条路由
  // main/sessions/session-history.ts 按 JSONL 字节 offset 本地实现，不走这里。
  piGetEntries: "pi:get-entries",
  piGetTree: "pi:get-tree",
  piGetForkMessages: "pi:get-fork-messages",
  piFork: "pi:fork",
  piClone: "pi:clone",

  // ---- 会话树可视化（common.session-tree，ADR-0002 能力包，恰 1 条） ----
  //
  // 上面那五条 pi:* 是**平台内核**（pi runtime）的数据面，恒注册；这一条是
  // 归属 `common.session-tree` 能力的**归一化视图**：pi:get-tree 回来的是
  // `{tree, leafId}` 的裸结构（RpcResponse<unknown>），本通道把它折成一份
  // 带节点分类（user / assistant / compaction / model-change）、分支点、
  // 当前叶子标记与性能截断的类型化图，供分叉可视化面板直接渲染。
  // 能力未启用时它一条都不注册（feature gate 的主进程侧），对照见
  // capability-gate.spec.ts。
  sessionTreeGraph: "session-tree:graph",

  // ---- 会话中心（SES-101，恰 9 条） ----
  //
  // 取代原先那条一次性全量枚举的 `sessions:list`：列表、搜索、整理、草稿、
  // 导出、向前翻页各有各的窄通道，渲染进程一律只持有不透明 sessionId。
  sessionsQuery: "sessions:query",
  sessionsRename: "sessions:rename",
  sessionsSetPinned: "sessions:set-pinned",
  sessionsSetStatus: "sessions:set-status",
  sessionsPurge: "sessions:purge",
  sessionsGetDraft: "sessions:get-draft",
  sessionsSaveDraft: "sessions:save-draft",
  sessionsExportHtml: "sessions:export-html",
  sessionsReadHistory: "sessions:read-history",

  // ---- 设置 ----
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  /**
   * 写入一把密钥（SEC-004）。**只进不出**：渲染进程可以覆盖，但没有任何
   * 通道能把明文取回来 —— 取回的能力一旦存在，safeStorage 加密就只是
   * 给磁盘上的字节换了个编码。
   */
  settingsSetSecret: "settings:set-secret",
  /** 查询某把密钥的配置态：{configured, last4}，不含明文 */
  settingsDescribeSecret: "settings:describe-secret",
  /**
   * 切换 Pi 运行时来源（SEC-005）。
   *
   * 入参**只有一个枚举** `{mode}`，没有、也不允许有任何路径或命令字段 ——
   * `piRuntimeMode` / `piExternalCommand` 最终会被交给 spawn，渲染进程一旦
   * 能写它们，一次 XSS 或一段恶意扩展内容就等价于「让主进程启动我指定的
   * 任意可执行文件」。因此这两个字段被整体移出 `settings:set` 的可写集合，
   * external 的可执行文件改由**主进程**弹原生文件选择框让用户当场挑，再用
   * 一次展示完整路径的确认框二次确认，确认之后才落盘（落的是解析后的绝对
   * 路径，不是渲染进程给的字符串）。
   *
   * 切回 bundled 是降权操作，不需要确认。
   */
  settingsSetPiRuntime: "settings:set-pi-runtime",

  // ---- workspace 与附件 capability ----
  workspaceCurrent: "workspace:current",
  dialogChooseFolder: "dialog:choose-folder",
  dialogChooseFiles: "dialog:choose-files",
  fileAttachDropped: "file:attach-dropped",
  fileReadAttachment: "file:read-attachment",
  shellOpenPath: "shell:open-path",
  shellShowInFolder: "shell:show-in-folder",
  attachmentRevokeAll: "attachment:revoke-all",

  // ---- Workspace 文件服务（FS-101，恰 9 条） ----
  //
  // 八条通道的入参与返回**只有 relativePath**：canonical root 与文件的
  // 真实位置只活在主进程，渲染进程拿到一个相对路径既推断不出磁盘布局，
  // 也表达不出「读工作区外面的东西」这个意图。收容判定由 main 侧的
  // resolveInWorkspace 唯一实现（CT-18）。
  workspaceTreeList: "workspace:tree-list",
  workspaceTreeWatch: "workspace:tree-watch",
  workspaceSearch: "workspace:search",
  workspaceSearchCancel: "workspace:search-cancel",
  workspaceFileRead: "workspace:file-read",
  workspaceFileSave: "workspace:file-save",
  workspaceFileMutate: "workspace:file-mutate",
  /** 工作区内的文件 → 结构化附件引用（八字段，标识恒为 token） */
  workspaceAttachmentCreate: "workspace:attachment-create",
  /**
   * 释放某个工作区在主进程侧占用的 watcher 与搜索子进程。
   *
   * 切换工作区时由渲染进程发一次。main 侧早就有释放函数，缺的一直是这条
   * 「谁来叫它」的通道 —— 泄漏在功能上完全无声，只有句柄数会一路往上走。
   */
  workspaceRelease: "workspace:release",

  // ---- Agent 变更集（FS-102，恰 4 条） ----
  //
  // 接受一条变更是**唯一**会由渲染进程触发的、对用户文件的写入。因此它
  // 只接受一个不透明的 changeset id：写什么内容、写到哪个文件，全部由
  // 主进程按 id 查出来，渲染进程一个字节都决定不了。
  changesetQuery: "changeset:query",
  changesetAccept: "changeset:accept",
  changesetReject: "changeset:reject",
  changesetAcceptBatch: "changeset:accept-batch",

  // ---- 安全预览（ART-101，恰 3 条） ----
  //
  // 入参只有 attachment token 或 workspaceId + relativePath（CT-17 / CT-18），
  // 一个绝对路径字段都没有。真正的解析发生在一个受限 utilityProcess 里，
  // 渲染进程既指定不了「用哪个解析器」，也指定不了「解析哪个磁盘位置」。
  previewOpen: "preview:open",
  previewConvert: "preview:convert",
  previewClose: "preview:close",

  // ---- Artifact 仓库（ART-102，恰 8 条） ----
  //
  // 全部以不透明 artifactId 为入参：产物的真实落盘位置只活在主进程，
  // 渲染进程连「这个文件在哪」都问不出来，自然也就无法用产物库当成
  // 一条读任意文件的旁路。
  artifactsQuery: "artifacts:query",
  artifactsRename: "artifacts:rename",
  artifactsDuplicate: "artifacts:duplicate",
  artifactsExport: "artifacts:export",
  artifactsShowInFolder: "artifacts:show-in-folder",
  artifactsTrash: "artifacts:trash",
  artifactsRestore: "artifacts:restore",
  artifactsCompareVersions: "artifacts:compare-versions",

  // ---- 语音 ----
  sttTranscribe: "stt:transcribe",

  // ---- Pi 资源中心与 project trust（EXT-102，恰 7 条） ----
  //
  // 全部以**不透明 id** 为入参：`piResourcesOpenDir` 收的是扫描结果里的
  // resource id 而不是路径，`piResourcesInstall` 收的是包规格字符串而不是
  // 命令行 —— 渲染进程在结构上就表达不出「执行这条命令」。真正的 execFile
  // 只发生在 main/pi-resources/package-install.ts，子命令白名单写死在那里。
  piResourcesScan: "pi-resources:scan",
  piResourcesSetEnabled: "pi-resources:set-enabled",
  piResourcesInstall: "pi-resources:install",
  piResourcesRemove: "pi-resources:remove",
  piResourcesOpenDir: "pi-resources:open-dir",
  /** 查询当前工作目录的 project trust 态（含将要加载的 project resources） */
  trustDescribe: "trust:describe",
  /** 记录用户的 allow / deny 决定；remember=true 时写 ~/.pi/agent/trust.json */
  trustDecide: "trust:decide",

  // ---- 应用自更新（UPD-001~004，恰 9 条） ----
  //
  // 渲染进程能表达的极限就是这九个意图。没有 setFeedURL、没有「装这个文件」、
  // 没有任何形式的 URL 或路径形参 —— 更新是唯一一个错了会砸掉用户数据的
  // 子系统，它的副作用必须整体收在主进程里。
  updateGetState: "update:get-state",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateCancelDownload: "update:cancel-download",
  updateInstall: "update:install",
  updateSetChannel: "update:set-channel",
  updateSetAutoCheck: "update:set-auto-check",
  updateSetAutoDownload: "update:set-auto-download",
  updateDismissVersion: "update:dismiss-version",

  // ---- Provider 与模型中心（PROV-101，恰 8 条） ----
  //
  // 让「配账号」这件事不必打开终端，是这一组通道存在的全部理由。它们仍然
  // 一个密钥字段都不外发：providers:list 回来的是 {configured, last4}，
  // providers:save-key 是**只进不出**（与 settings:set-secret 同一口径）。
  //
  // providers:test 与 providers:discover-models 会发真实出站请求，两条都
  // 经 net/outbound-guard.ts 的 safeFetch —— 主进程里没有第二条出站路径。
  providersList: "providers:list",
  providersSaveKey: "providers:save-key",
  providersRemove: "providers:remove",
  providersAddCustom: "providers:add-custom",
  providersTest: "providers:test",
  providersDiscoverModels: "providers:discover-models",
  /** 写全局或 workspace 层的默认模型；session 层归会话文件自己所有 */
  providersSetScopeDefault: "providers:set-scope-default",
  /** 按日 / workspace / provider / model 汇总的用量 */
  usageQuery: "usage:query",
  /** 导出 CSV / JSON，返回文本由渲染进程交给保存对话框 */
  usageExport: "usage:export",
  /** 一次 agent_settled 之后上报会话累计量，由主进程做差值入库 */
  usageRecord: "usage:record",
  /** 按 (sessionId, day) 的会话明细（R5.2），与日汇总同一套差值口径 */
  usageSessions: "usage:sessions",

  // ---- 能力包与 Profile（ADR-0002 第一阶段，恰 3 条） ----
  //
  // 三条都**不接受 manifest**：能力集合由主进程的 CapabilityRegistry 在装配期
  // 封口，渲染进程只能在已注册的集合里挑，既塞不进一个新能力，也改不了任何
  // 一条 manifest 的权限申请。set-profile 的入参是 profileId，set-enabled 的
  // 入参是已注册的 capabilityId + 一个布尔——两条路上都没有可供构造的结构。
  /** 当前 Profile、全部已注册能力及其启用态 */
  capabilitiesDescribe: "capabilities:describe",
  /** 切换 Profile（= 换一组启用集合，不是换一个应用） */
  capabilitiesSetProfile: "capabilities:set-profile",
  /** 在当前 Profile 之上单独开关一个能力 */
  capabilitiesSetEnabled: "capabilities:set-enabled",

  // ---- 权限决策（ADR-0002 D3 / SEC-003，恰 4 条） ----
  //
  // 权限是**平台内核**设施（四层边界表第一行，不可关闭），四条恒注册。授权
  // 决策在主进程 PermissionEngine 侧做，渲染进程只**收集用户选择**再交给主进程
  // 记录；grant 的合法性由主进程按 manifest 声明的上界二次校验，渲染进程越不过
  // 任何一份 manifest 的权限申请。
  /** 当前 workspace 的授权表 + session 授权 + 审计 */
  permissionDescribe: "permission:describe",
  /** 记录一次决策（deny / allow-once / allow-session / allow-workspace） */
  permissionDecide: "permission:decide",
  /** 撤销一条 session 或 workspace 授权 */
  permissionRevoke: "permission:revoke",
  /**
   * 权限探针：本轮的可证伪拦截点，也是将来 process.git 之类真实消费者的预留
   * 入口。它声明自己需要 process.git，未授权时被第五道闸挡在 handler 之外。
   */
  permissionProbe: "permission:probe",

  // ---- MCP 服务器管理（EXT-102 / 能力包 common.mcp，恰 6 条） ----
  //
  // 全部以**不透明服务器 id** 或结构化配置为入参：启停 / 连接测试收的是
  // 扫描结果里的 id，main 侧按 id 从磁盘配置查出 command/args 再 spawn
  // （shell:false）—— 渲染进程在结构上表达不出「执行这条命令」。save 由
  // 渲染进程给出配置（与 pi-resources 的 install 同构），main 侧再过一遍
  // 注入校验。env / header 的值单向下发时脱敏（只留键名）。
  mcpList: "mcp:list",
  mcpSave: "mcp:save",
  mcpRemove: "mcp:remove",
  mcpTest: "mcp:test",
  mcpStart: "mcp:start",
  mcpStop: "mcp:stop",

  // ---- 长期记忆（MEM-101 第一版，能力包 common.memory，恰 9 条） ----
  //
  // 九条都以不透明 workspaceId / memory id 为入参：记忆按 capabilityId +
  // workspaceId 分区（ADR-0002 D4 规则 3），渲染进程既指定不了别的工作区的
  // 记忆，也表达不出「注入一段任意上下文」——注入内容只来自用户显式保存过的
  // 记录。没有一条通道能塞进一份现成的注入文本。
  memoryQuery: "memory:query",
  memorySave: "memory:save",
  memoryUpdate: "memory:update",
  memoryMerge: "memory:merge",
  memoryDelete: "memory:delete",
  memoryExport: "memory:export",
  /** 取一条记忆的来源会话轮次原文（查看原始证据） */
  memoryEvidence: "memory:evidence",
  /** 注入命中记录（调试 / 隐私视图）：这一轮注入了哪些记忆 */
  memoryHits: "memory:hits",
  /** 开关注入（当前工作区 / 全局），不删任何记忆 */
  memorySetInjection: "memory:set-injection",

  // ---- 长期记忆 第二版：语义检索 + 知识库 + 有限抽取（MEM-101 v2，common.memory，9 条） ----
  //
  // 与第一版同一能力包、同一分区规则。语义检索（memory:search）在 FTS 之上叠加
  // 向量余弦做混合排序；知识库（memory:kb-*）是带来源引用的文档 / 片段；抽取
  // （memory:extract）从会话里抽候选事实、恒标 inferred + 低置信、保留证据链。
  /** 混合语义检索（FTS + 向量），按相关度排序，返回命中来源分解 */
  memorySearch: "memory:search",
  /** 嵌入状态：后端 / 模型 / 维度 / 已嵌入占比（供 UI 与「重嵌」判断） */
  memoryEmbedStatus: "memory:embed-status",
  /** 重嵌：为缺向量 / 换了 embedder 的记录（含 v1 迁移上来的）补算向量 */
  memoryReembed: "memory:reembed",
  /** 从一段会话里抽候选事实存入记忆（origin=inferred，保留证据链，可改可删） */
  memoryExtract: "memory:extract",
  /** 知识库：加入一条文档 / 片段（带来源引用） */
  memoryKnowledgeAdd: "memory:kb-add",
  /** 知识库：混合语义检索，命中带引用（来源文件 / 会话 / 轮次） */
  memoryKnowledgeSearch: "memory:kb-search",
  /** 知识库：列出某工作区的全部片段 */
  memoryKnowledgeList: "memory:kb-list",
  /** 知识库：取一条片段的全文与来源 */
  memoryKnowledgeGet: "memory:kb-get",
  /** 知识库：删除一条片段（同时清 FTS + 向量） */
  memoryKnowledgeDelete: "memory:kb-delete",

  // ---- 诊断与健康（OBS-101，恰 3 条） ----
  //
  // 三条都**不接受路径**：诊断包的落盘位置由主进程的保存对话框决定，
  // 渲染进程既指定不了「导出到哪」，也指定不了「收集哪些文件」——
  // 否则 support bundle 会变成一条「读任意文件」的通用旁路。
  /** 先出清单供用户预览（路径、大小、是否已脱敏），**不写任何文件** */
  diagnosticsPreviewBundle: "diagnostics:preview-bundle",
  /** 用户确认后导出。主进程弹保存对话框，写盘，可选「在文件夹中显示」 */
  diagnosticsExportBundle: "diagnostics:export-bundle",
  /** 启动健康检查结果 + safe mode 态 + 上一稳定版本 */
  diagnosticsGetReport: "diagnostics:get-report",

  // ---- 后台多会话池（AGT-101，平台内核，恰 4 条） ----
  //
  // 池是**平台内核**设施（四层边界表第一行「会话 / runtime」，不可关闭），四条
  // 恒注册。入参一律不透明 sessionId 或一份资源上界；渲染进程既表达不出「让某
  // 进程跑这条命令」，也塞不进一个新会话规格——新建会话仍走 `pi:start`，池只做
  // 观测与调度（聚焦 / 停止 / 上界）。
  /** 取整池快照（会话列表、进程态、列表态、资源占用、统一权限 inbox）。 */
  agentPoolDescribe: "agent-pool:describe",
  /** 聚焦到某个会话（= 把它置 focused，前一个 focused 降为 background）。 */
  agentPoolFocus: "agent-pool:focus",
  /** 用户主动停掉某个会话进程（窗口关闭不会走这里——窗口关闭 ≠ 停止）。 */
  agentPoolStop: "agent-pool:stop",
  /** 设置资源上界（全局/每 workspace 并发、内存、成本）。 */
  agentPoolSetCaps: "agent-pool:set-caps",
  // ---- Git 编码能力包（coding.git，ADR-0002 垂直能力包 / GIT-101，恰 9 条） ----
  //
  // 第一个 coding tier 垂直能力包。九条通道的入参只有不透明 workspaceId +
  // 相对路径 / 分支名 / 提交信息，**没有任何 argv 或命令行字段** —— 真正跑
  // `git` 的地方在 main/git（execFile + shell:false + 只传参数数组）。九条
  // 全部登记在 main/permission 的需求表里、需要 process.git，未授权时被
  // ipc-guard 第五道闸挡在 handler 之外（连只读的 status/diff 也要起 git 子
  // 进程，因此同样受管）。危险类（force push / reset --hard / branch -D）本批
  // 不做，见 FEAT-git.md 的 deferred。
  gitStatus: "git:status",
  gitDiff: "git:diff",
  gitStage: "git:stage",
  gitUnstage: "git:unstage",
  gitRevert: "git:revert",
  gitCommit: "git:commit",
  gitBranchList: "git:branch-list",
  gitBranchCreate: "git:branch-create",
  gitBranchSwitch: "git:branch-switch",
  // ---- Git 补完整（coding.git v2 / GIT-101·102 剩余，21 条） ----
  //
  // v1 刻意把网络类与危险类 deferred（见 FEAT-git.md §7）。本批补上，纪律不变：
  // 一切仍走 main/git 的 runGit（execFile + shell:false + 只传 argv），渲染进程
  // 拿到的仍只有不透明 workspaceId + 已校验的 ref / 相对路径 / 不透明 worktree id。
  //
  // 网络类（fetch/pull/push）：git 子进程自己经 credential helper / SSH 处理凭据，
  // GIT_TERMINAL_PROMPT=0 让缺凭据立刻失败而非挂起，token 既不进 argv 也不进日志。
  gitFetch: "git:fetch",
  gitPull: "git:pull",
  gitPush: "git:push",
  // 危险类（force push / reset --hard / branch -D）：会丢用户提交或历史，除
  // process.git 外，handler 内再走一次**主进程原生二次确认**，确认框逐字列出精确
  // 范围（哪个 remote/branch、丢到哪个 ref），参照 SEC-003 的 allow-once 语义
  // （每次现确认、用后即焚，不持久授权）。
  gitForcePush: "git:force-push",
  gitResetHard: "git:reset-hard",
  gitBranchDelete: "git:branch-delete",
  // stash：save/list/pop/drop。
  gitStashSave: "git:stash-save",
  gitStashList: "git:stash-list",
  gitStashPop: "git:stash-pop",
  gitStashDrop: "git:stash-drop",
  // history：log（提交列表 / 文件历史）+ show（单个提交详情 + 改动文件）。
  gitLog: "git:log",
  gitShow: "git:show",
  // worktree：create/list/open/rename/compare/remove。worktree 用不透明 id
  // （sha256(worktreePath)）标识，路径只活在主进程；remove 前检查 dirty /
  // untracked / unmerged，默认不 force。
  gitWorktreeCreate: "git:worktree-create",
  gitWorktreeList: "git:worktree-list",
  gitWorktreeOpen: "git:worktree-open",
  gitWorktreeRename: "git:worktree-rename",
  gitWorktreeCompare: "git:worktree-compare",
  gitWorktreeRemove: "git:worktree-remove",
  // hunk 级 stage：v1 是文件级 stage + hunk 级 diff view；这里补逐 hunk 暂存
  // （git apply --cached 造补丁）与其逆操作。
  gitDiffHunks: "git:diff-hunks",
  gitStageHunk: "git:stage-hunk",
  gitUnstageHunk: "git:unstage-hunk",
  // ---- 持久定时任务（Durable Tasks，能力包 common.tasks，恰 11 条） ----
  //
  // 全部以不透明 workspaceId + taskId / runId 为入参：任务按 workspaceId 分区
  // （数据分区键就是 sha256(realpath) 派生的 workspaceId），渲染进程既指定不了
  // 别的工作区的任务，也表达不出「触发一次任意 Agent run」——触发的是某条已
  // 落盘任务里冻结的配置，渲染进程一个字节都改不了。每个动作的返回都是权威
  // 快照（列表或任务详情），与 providers / update 同一口径。
  tasksList: "tasks:list",
  tasksGet: "tasks:get",
  tasksCreate: "tasks:create",
  tasksUpdate: "tasks:update",
  tasksDelete: "tasks:delete",
  tasksPause: "tasks:pause",
  tasksResume: "tasks:resume",
  /** 立即触发一次（不改计划，独立 run，带 run-now 的 idempotency key） */
  tasksRunNow: "tasks:run-now",
  tasksCancelRun: "tasks:cancel-run",
  tasksRetryRun: "tasks:retry-run",
  tasksDuplicate: "tasks:duplicate",

  // ---- child Agent 编排（AGT-102，能力包 common.child-agent，恰 5 条） ----
  //
  // 编排是**通用能力**（可关闭）：关掉它单会话对话照常，只是不能派生子 Agent。
  // 五条通道的入参一律不透明 nodeId + 结构化子规格 —— 渲染进程既塞不进一个运行
  // 时句柄，也表达不出「让某进程跑这条命令」。子 Agent 的真实进程派生走后台池
  // （origin:"child"），本组只表达编排意图：取拓扑 / 创建子 / 取消（向子树传播）/
  // 回答子的结构化提问 / 裁决子 worktree 改动的合并。
  /** 取整棵编排拓扑（父子关系、状态、成本、证据、结果、限流视图）。 */
  childAgentDescribe: "child-agent:describe",
  /** 父创建一个子 Agent（parentId=null 表示用户直接创建的顶层子）。 */
  childAgentCreate: "child-agent:create",
  /** 取消某节点：向它的整棵子树传播（子进程一并停）。 */
  childAgentCancel: "child-agent:cancel",
  /** 回答某子 Agent 的一条结构化提问。 */
  childAgentAnswer: "child-agent:answer",
  /** 裁决某子 Agent 的 worktree 改动合并（accept / reject）。 */
  childAgentResolveMerge: "child-agent:resolve-merge",
  // ---- 连接器 v1（Webhook，能力包 connector.webhook，恰 7 条） ----
  //
  // 四层边界里风险最高的一层：连接器是唯一会把消息**送出本机**的能力。七条
  // 通道的入参一律不透明 connectorId + workspaceId + 文本，**没有任何绝对
  // URL 出口**：完整 webhook URL 是密令，只活在主进程（经 secret-store 加密），
  // 渲染进程能看到的极限是 {domain, configured, last4}。出站目标域名限定在
  // manifest 声明的 network:<domain> 白名单内，且每个 workspace 要经权限引擎
  // 单独授权——未授权域名被拒、内网地址被出站守卫（safeFetch）挡下。
  connectorList: "connector:list",
  connectorCreate: "connector:create",
  /** 改名与 / 或轮换凭证（凭证管理）；url 省略时只改名，保留原密令 */
  connectorUpdate: "connector:update",
  connectorRemove: "connector:remove",
  connectorSetEnabled: "connector:set-enabled",
  /** 连接自检：向配置的 webhook 发一次最小请求，需该域名已被 workspace 授权 */
  connectorTest: "connector:test",
  /** Agent 主动推送一条文本到外部平台 */
  connectorSend: "connector:send",
  // ---- 真实渠道适配器（connector.feishu / connector.slack / connector.telegram） ----
  //
  // 三个渠道各自在通用 webhook 基座之上加一层平台适配：出站按平台文档拼消息体
  // （飞书 msg_type/content、Slack text、Telegram chat_id+text），入站按平台事件
  // 结构解析并**防回环**（飞书 sender_type、Slack bot_id、Telegram from.is_bot）。
  // 每个渠道恰两条窄通道：`<平台>:send`（真实出站，穿出站三关）与
  // `<平台>:receive`（把一条平台入站事件喂给共享入站守卫，做去重/防回环/限速/
  // 尺寸判定，或应答平台的 url_verification 握手）。管理（增删改启停）复用上面
  // 的 connector:* 七条通道（kind 决定用哪个适配器），不再各自重造一套 CRUD。
  feishuSend: "feishu:send",
  feishuReceive: "feishu:receive",
  slackSend: "slack:send",
  slackReceive: "slack:receive",
  telegramSend: "telegram:send",
  telegramReceive: "telegram:receive",

  // ---- 可视化工作流（能力包 common.workflow，恰 8 条） ----
  //
  // 可视化工作流是**通用能力**（可关闭）：关掉它单会话对话与其它能力照常，
  // 只是不能再编排 DAG 工作流。八条通道的入参一律带 workspaceId（数据按工作区
  // 分区）+ 不透明 definitionId / runId + 可移植 JSON 文本，塞不进任何运行时
  // 句柄。Agent 节点的真实进程派生走后台会话池（与 child 编排同一套触发机制），
  // 本组只表达编排意图：列出 / 保存 / 删除 / 导出 / 导入定义、运行 / 停止 / 取历史。
  /** 列出一个工作区的全部工作流定义。 */
  workflowList: "workflow:list",
  /** 新建或更新一个工作流定义（upsert）。 */
  workflowSave: "workflow:save",
  /** 删除一个工作流定义。 */
  workflowDelete: "workflow:delete",
  /** 导出一个定义为可移植 JSON 文本。 */
  workflowExport: "workflow:export",
  /** 从可移植 JSON 导入一个定义（校验后入库）。 */
  workflowImport: "workflow:import",
  /** 运行一个定义（再次调用即重跑）。 */
  workflowRun: "workflow:run",
  /** 停止一次运行。 */
  workflowStop: "workflow:stop",
  /** 取当前活跃运行 + 近期历史快照。 */
  workflowRuns: "workflow:runs",

  // ---- 终端能力包（coding.terminal，ADR-0002 垂直能力包 / PTY-101，恰 11 条） ----
  //
  // 第一个原生模块能力包（node-pty，方案 B）。十一条通道的入参只有不透明
  // workspaceId + 不透明 tabId + 用户键入的字节，**没有任何 cwd / shell 命令行 /
  // argv 字段** —— 真正 spawn PTY 的地方在 main/terminal（node-pty），cwd 是
  // workspace 的 canonical root（主进程解析），渲染进程表达不出「用这个目录跑
  // 这条命令」。十一条全部登记在 main/permission 的需求表里、需要 process.shell
  // （开终端就是开 shell，继 git 之后第二个真实的危险权限消费者），未授权时被
  // ipc-guard 第五道闸挡在 handler 之外——连只读的 list/profiles/snapshot 也不
  // 例外。PTY 输出走 terminal:event 推送信封 + 主进程有界 ring buffer，reload 后
  // 由 terminal:snapshot 重连取回。
  terminalList: "terminal:list",
  terminalProfiles: "terminal:profiles",
  terminalOpen: "terminal:open",
  terminalInput: "terminal:input",
  terminalResize: "terminal:resize",
  terminalSnapshot: "terminal:snapshot",
  terminalClear: "terminal:clear",
  terminalKill: "terminal:kill",
  terminalRestart: "terminal:restart",
  terminalRename: "terminal:rename",
  /**
   * WSL 发行版查询（R5.1，仅 Windows 有实义）。返回 wsl.exe 是否可用与已安装
   * 的发行版列表；非 Windows / 无 WSL 机器上恒返回 `{available:false, distros:[]}`
   * 而不抛错。枚举是懒的：只有这条通道（或 terminal:profiles）被调用时才 spawn
   * `wsl.exe -l -v`，不在启动路径上。
   */
  terminalWslDistros: "terminal:wsl-distros",

  // ---- Remote / PWA 远程访问（connector.remote / REM-101，恰 8 条） ----
  //
  // 四层边界里唯一会**开一个对外网络监听**的能力，因此也是唯一一个「安全设计
  // 的疏忽 = 真实远程攻击面」的能力。这八条通道是**主机侧管理面**（渲染进程 ↔
  // 主进程）：开关服务、看/改监听范围、配对（生成单次短时 challenge）、看设备、
  // 撤销 / 轮换设备、按设备授予危险 scope。**注意它们与远程 HTTP/WS 服务本身
  // 是两个完全不同的入口**：这八条走 ipc-guard 的四道闸（主 frame + 校验 + 尺寸
  // + 限流），只有本机主窗口能发；远程设备走的是另一套统一鉴权中间件
  // （main/remote/remote-auth.ts），token + origin/CSRF + 限速 + 尺寸 + 审计，
  // 二者无任何共享放行路径。
  //
  // 入参一律不含任何原始 token / 监听地址字符串：set-bind-scope 只收一个枚举
  // （loopback / lan），create-pairing 不收参数（challenge 由主进程随机生成、
  // 用一次即失效），设备操作只收不透明 deviceId。渲染进程既表达不出「监听某个
  // 我指定的地址」，也拿不回任何设备的长期 token（配对时 token 只发给设备本身、
  // 主进程只存 hash）。每个动作都回**权威快照** RemoteState（与 connector /
  // providers 同一口径）。
  /** 当前远程服务态：开关 / 监听范围 / 实际地址 / 设备列表 / 活跃配对 / 审计 */
  remoteDescribe: "remote:describe",
  /** 开 / 关远程服务（关 = 停监听 + 断开全部活跃连接，token 立即失效于连接层） */
  remoteSetEnabled: "remote:set-enabled",
  /** 切换监听范围：loopback（默认，对外零暴露）/ lan（主动开启，显示范围） */
  remoteSetBindScope: "remote:set-bind-scope",
  /** 生成一次配对：单次、短时的随机 challenge，用一次即失效（QR / 手动码承载） */
  remoteCreatePairing: "remote:create-pairing",
  /** 取消当前未消费的配对 challenge */
  remoteCancelPairing: "remote:cancel-pairing",
  /** 撤销一台设备：删其 token hash + 断开它的活跃连接（立即失效） */
  remoteRevokeDevice: "remote:revoke-device",
  /** 轮换一台设备的凭证：旧 token 立即失效，生成一次新配对供该设备重新取 token */
  remoteRotateDevice: "remote:rotate-device",
  /** 按设备授予 / 收回一个危险 scope（owner 在主机上显式操作，默认全关） */
  remoteSetDeviceScope: "remote:set-device-scope",
} as const;

/** 主进程单向推送通道（9 个）。 */
export const PUSH_CHANNELS = {
  piEvent: "pi:event",
  piUiRequest: "pi:ui-request",
  piExit: "pi:exit",
  /**
   * 某一条扩展弹窗已失效（上游带 timeout 的 dialog 已自行 auto-resolve）。
   *
   * rpc.md:1145 明确「若 dialog 带 timeout，agent 侧到期会自行 auto-resolve，
   * 客户端不需要跟踪超时」—— 这句话的另一面是：**到期之后本地那个 modal
   * 上的每一个按钮都已经没人接收了**。不推这条消息的话，用户看到的是一个
   * mask-closable:false、关不掉、点了也没反应的弹窗。
   */
  piUiExpire: "pi:ui-expire",
  /** 整代作废（runtime 重启 / 换会话）：渲染侧清空全部挂起弹窗 */
  piUiExpireAll: "pi:ui-expire-all",
  /** 更新状态变更；payload 是 UpdateEnvelope（不是 PiEnvelope，语义不同） */
  updateEvent: "update:event",
  /**
   * 某个目录的内容变了（FS-101）。
   *
   * 载荷只有 `{workspaceId, relativePath}`：告诉渲染进程「这一层脏了，
   * 你要的话再来 list 一次」，而不是把整层条目推过去 —— 推整层的话，
   * 一次 `npm install` 会在几秒内推出几万条消息。
   */
  workspaceTreeEvent: "workspace:tree-event",
  /**
   * 后台会话池快照变更（AGT-101）。
   *
   * 载荷是 `PiEnvelope<PoolSnapshot>`：复用与 `pi:event` 同一套信封，渲染侧
   * 因此能用现成的 sequence（按本通道单调判）+ generation（全局判）丢弃规则
   * 对齐快照，不必另写一份序号比较。快照是全量的，晚到的旧快照被序号闸门丢弃。
   */
  agentPoolEvent: "agent-pool:event",
  /**
   * child Agent 编排拓扑变更（AGT-102）。
   *
   * 载荷是 `PiEnvelope<ChildTopologySnapshot>`：与池快照同一套信封，渲染侧复用
   * 现成的 sequence（按本通道单调判）+ generation（全局判）丢弃规则对齐拓扑，
   * 不必另写一份序号比较。快照是全量的，晚到的旧快照被序号闸门丢弃。
   */
  childAgentEvent: "child-agent:event",
  /**
   * 工作流运行状态变更（common.workflow）。
   *
   * 载荷是 `PiEnvelope<WorkflowRunSnapshot>`：与池 / child 快照同一套信封，
   * 渲染侧复用现成的 sequence（按本通道单调判）+ generation（全局判）丢弃规则
   * 对齐运行状态，不必另写一份序号比较。快照是全量的，晚到的旧快照被序号闸门丢弃。
   */
  workflowEvent: "workflow:event",
  /**
   * 终端 PTY 输出 / 退出（coding.terminal）。
   *
   * 载荷是 `PiEnvelope<TerminalEventPayload>`：信封的 sessionId 填 tabId、
   * generation 填 tab 代际、sequence 填 chunk 序号，渲染侧因此能复用现成的
   * `shouldAcceptEnvelope`（代际优先 + 同代际序号严格递增）丢弃上一代 PTY 的
   * 迟到输出，不必另写一份序号比较。输出被主进程按帧合并成一段一段的 chunk
   * 下发，配合有界 ring buffer + terminal:snapshot 支持 reload 后重连。
   */
  terminalEvent: "terminal:event",
} as const;

export type InvokeChannel = (typeof CHANNELS)[keyof typeof CHANNELS];
export type PushChannel = (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS];
