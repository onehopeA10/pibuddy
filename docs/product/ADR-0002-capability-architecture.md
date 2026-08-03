# ADR-0002：能力包架构（Capability Architecture）

- 状态：已采纳
- 日期：2026-08-03
- 相关：ADR-0001（更新源）、`doc/architecture.md`、`doc/threat-model.md`

## 背景

PiBuddy 的产品目标是**通用 Agent**，而非编码专用工具。若把编码、财务、教育各自的工具与 UI 都堆进主应用，会得到三个后果：主应用无限膨胀；同一能力（文件、表格、结构化提问）在每个垂直领域重写一遍；用户无法按需组合。

产品模型确定为：

```
通用 Agent = 平台内核 + 通用能力 + 可选垂直能力包 + 可选连接器
```

「编码模式」「财务模式」是**一组能力的 Profile**，不是互相隔离的独立应用。用户可以组合出「通用文档 + 财务分析 + 飞书连接器」。

## 四层边界

| 层级 | 包含内容 | 可关闭 |
|---|---|---|
| 平台内核 | Agent runtime、会话、模型与 Provider、流式事件、权限、IPC、安全、能力注册、日志、更新 | 否 |
| 通用能力 | 文件与附件、Artifact、文档预览、任务/计划、结构化提问、知识库、通知 | 是 |
| 垂直能力包 | 编码、财务、教育、法务、研究等领域工具与 UI | 是 |
| 连接器 | 飞书、Slack、邮件、云盘、远程控制、外部数据源 | 是 |

## 从两个参考实现中学到的

调研了 `source/CodePilot` 与 `source/PiDeck`（含 pi 扩展机制），证据见
`.workflow/scratch/capability-research/explore-plugin-arch.json`。

**两者都没有本 ADR 所需的契约**：manifest 里 permissions / compatibility /
data schema version / runtime requirements 四项全部缺失；**插件权限申请机制两边都不存在**；
能力级拆卸两边都没有（pi 的 40 个扩展 API 里只有 1 个反注册，禁用只能杀进程）；
签名与兼容区间校验两边都没有。

真正值得借鉴的是两条：

1. **宿主自声明的能力契约 + drift test**（CodePilot `capability-contract.ts:178-217`）。
   每条能力钉住其暴露点的模块路径与符号名，用 grep 写成可执行断言。这与本仓一贯的
   结构性断言（「守卫外 `ipcMain` 命中数恒为 0」）是同一手法。
2. **重复 id 抛错 + seal**（CodePilot `registry.ts:13-28`）。对照 pi 的裸 `Map.set`
   静默覆盖：后者导致同名 Tool 冲突让 RPC 直接启动失败，宿主被迫用三条硬编码关键词
   猜冲突并删磁盘文件（`ExtensionManager.ts:586-590`）。

**贯穿性观察（本 ADR 的核心依据）**：进程边界是这两套设计里唯一真正生效的隔离手段，
其余（前缀约定、关键词黑名单、文件停放）都是补丁。凡有「声明 → 校验 → 投影」三段
结构的地方，冲突能静态发现；凡「运行期注册」的地方，冲突只能在崩溃时发现。

## 决策

### D1：三阶段推进，第一阶段不碰动态加载

1. **内置模块化**：capability manifest、registry、feature gate、Profile。所有能力仍随
   应用构建，只按用户配置启用与懒加载。
2. **第一方能力包**：拆成独立 workspace package，验证启用/禁用/升级/权限/数据迁移。
3. **第三方可下载**：签名、hash、版本兼容、权限预览、供应链治理。

理由见上文贯穿性观察：第一阶段全部内置且声明式，冲突静态可查，规避动态加载、第三方
代码执行、native 模块分发三块复杂度。终端的 node-pty、浏览器 guest、财务连接器尤其
不适合在第一阶段动态安装。

### D2：能力包可以携带自己的重依赖

编码包获准单独引入 `monaco-editor`（纯 JS，依赖仅 marked + dompurify，可过
`check-pure-js-deps` 闸门）。由此确立通则：**能力包可携带独立 bundle**。

三条连带约束：

- 必须懒加载。manifest 的 `runtime` 段声明资产为独立 chunk，未启用不得进包。
- 每包 bundle 预算，做成可断言闸门。允许重依赖不等于允许无上界。
- `check-pure-js-deps` 从全仓闸门收紧为**按包检查**：编码包过、某些连接器包可能不过。

**LSP 暂不纳入编码包 v1**：`monaco-languageclient` 会拖进整套
`@codingame/monaco-vscode-*`（把 VSCode 服务层搬过来），体积与耦合度远超 Monaco 本身。
待编码包边界跑通后单独评估。

### D3：能力只能申请权限，不能自行授予

权限枚举（初始集）：

```
workspace.read      workspace.write     process.git
process.shell       network:<domain>    secret:<slot>
external.open
```

核心 PermissionEngine 按 workspace / agent / profile 授权。**即使能力被启用，renderer 被
攻陷后也不能直接执行 Git、Shell 或任意文件操作。**

现成接缝：`workspace-store.ts:57` 的 `permissionRules: PermissionRule[]` 已落盘
（DDL 见 `:69`），但 `ipc-guard.ts` 一行都没读——数据通路已通，只差决策层消费。

**拦截点必须实测验证，不得靠架构图推断。** 依据：CodePilot 核实 SDK 源码后发现
`canUseTool` 在 `permissionMode:'auto'` 的分类器批准路径上根本不会被调用
（`permission/profile.ts:196-228`），「统一 invoke 入口 = 统一拦截点」在该 SDK 上不成立。

### D4：硬规则

1. 不向 preload 增加 `invoke(channel: string, args: any)` 这类无约束入口。
2. 每个 capability action 都有运行时 schema、尺寸、频率与权限检查。
3. 数据按 `capabilityId + workspaceId + agentId` 分区。
4. 禁用能力时清理 worker、listener、watcher 与子进程，**保留用户数据**。
5. 卸载与删除数据是两个动作。
6. 工具名、UI slot、配置 key 必须有命名空间。
7. 第三方包不得 import `app/main` 内部模块，只依赖 contract / capability SDK。

规则 6 的代价是实测过的：pi 的裸 `Map.set` 无命名空间，后注册静默覆盖，同名 Tool 冲突
直接让 RPC 启动失败。

### D5：UI 贡献只开放固定插槽

侧栏 section、右侧抽屉 tab、Composer action/建议/附件类型、Message renderer /
Extension widget、Settings section、Command / Tool / Workflow template。

现状是 4 个具名 slot 全在 `AppShell.vue:185/187/222/264`，且为**整块替换语义、无法追加**；
`filesOpen` 一个 ref 同时控制 FileTreePanel + FileEditorPane + PreviewPane，横跨
workspace-files 与 documents 两个能力域。演进为 registry 驱动时这一个开关须拆开。

## 实施顺序（由依赖决定，非偏好）

现有代码有 6 条跨层依赖挡在前面，其中两条卡住所有后续工作，必须先动：

1. **`log()` 从 pi 域搬到 kernel**——更新子系统的日志出口现在挂在 pi runtime 上
   （`ipc.ts:14`、`misc-ipc.ts:28`、`update/update-ipc.ts:36` 反向取用）。
2. **`CHANNEL_CONTRACTS` 从穷举 Record 改为可分片合并**（`ipc-contract.ts:477` 的
   `Record<InvokeChannel, ChannelContract>` 穷举性使通道无法按包声明）。

其余四条随各自能力包拆分时处理：`main/index.ts:4` 的 kernel→common 反向 import；
`sessions-ipc.ts:27` → `pi/pi-ipc.js` 及其被写死成的注册顺序；
`changeset/tool-watch.ts:25` → `artifacts/artifact-tracker.js`（两个 common 包被同一条
工具事件流缝死）；`stores/app.ts` 被 23 处直接 import（其中 6 处属 common）。

## 后果

**正面**：垂直领域沿同一套边界扩展，文件/表格/结构化提问跨领域复用；能力可关闭意味着
攻击面可收缩；声明式契约让冲突在构建期而非崩溃时暴露。

**代价**：短期内所有能力仍随应用构建，安装包不会因此变小（第二阶段才有收益）；
每个能力包都要维护 manifest 与 drift test；跨包协作（如 changeset 与 artifacts）需要
显式的事件契约而非直接 import。

**已知未决**：`workspace-review` 的行级 hunk 概念是否属于通用层。当前判断是通用层只承诺
「文件级接受/拒绝 + 可插拔 diff 渲染器」，hunk / stage / 三方合并留在编码包——否则财务、
教育包会被迫绕开一层只有代码才用得上的抽象。待第二阶段拆包时定案。
