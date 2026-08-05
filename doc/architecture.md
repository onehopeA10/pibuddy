# PiBuddy 架构与依赖方向

> 立于 TASK-002（M0 架构护栏）。本文描述**约束**，不描述实现细节；
> 实现细节属于各模块源码注释。

## 1. 包边界

| 包 | 角色 | 消费方式 |
|---|---|---|
| `@pibuddy/contract` | main / preload / renderer / pi-sdk 四方共用的类型与**运行时 schema** 唯一真相源 | 源码形式（`main` 指向 `src/index.ts`，不产出 dist） |
| `@pibuddy/pi-sdk` | pi RPC 协议（JSONL over stdio）的客户端与类型 | 源码形式 |
| `@pibuddy/app` | Electron 应用：main / preload / renderer 三进程 | electron-vite 打包 |

`tsconfig.base.json` 的 `noEmit: true` 决定了 workspace 包一律以**源码**被消费：
app 的 `tsconfig.node.json` / `tsconfig.web.json` 直接 include `../contract/src/**/*.ts`
与 `../pi-sdk/src/**/*.ts`，没有 project references，也没有中间产物。

> 新建 workspace 包时必须同时改三处，漏一处就会在运行时炸：
> 1. `packages/app/electron.vite.config.ts` 的 `externalizeDepsPlugin({ exclude: [...] })`
>    —— 漏加会构建通过但运行时报「无法解析的 external」
> 2. `tsconfig.node.json` / `tsconfig.web.json` 的 `include`
> 3. `tsconfig.web.json` 的 `paths` 与 `electron.vite.config.ts` 的 renderer `alias`

## 2. 依赖方向（硬规则）

```
renderer  →  preload  →  main  →  pi-sdk  →  pi 子进程
                 ↘         ↓        ↙
                  @pibuddy/contract
```

- **禁止反向**：main 不得 import renderer 的任何东西；pi-sdk 不得感知 Electron。
- **contract 只被依赖**：它不依赖任何 workspace 包。因此 `StartResult` 用泛型槽位
  （`StartResult<TState, TModel, TMessage>`）而不是直接引用 pi-sdk 的 `AgentState` ——
  否则 contract → pi-sdk 的边会让 renderer 侧的类型检查被迫拉进 `node:child_process`。
- **禁止跨层硬编码路径**：渲染进程曾用 `'../../../preload/index.d'` 拿类型，
  现已全部改为 `@contract`。`scripts/check-contract-uniqueness.mjs` 会把这条规则跑成 CI 断言。

## 3. 事件流（5 跳）

```
[1] pi 子进程 stdout
      │  JSONL，一行一个事件
      ▼
[2] pi-sdk/jsonl.ts 分帧
      │  StringDecoder + LF 切分，坏行跳过不中断
      ▼
[3] pi-sdk/client.ts 分派  ── toAgentEvent() 归一
      │  response(带 id) → pending promise
      │  extension_ui_request → "ui_request"
      │  其余 → "event"（未建模的类型归一为 { type:"unknown", raw }）
      ▼
[4] app/main/ipc.ts 33ms 批处理
      │  折叠连续的累积型事件（message_update / 同 toolCallId 的
      │  tool_execution_update 都携带到目前为止的全量内容，只留最后一条）
      ▼
[5] preload → renderer store reducer
      │  stores/app.ts handleEvent() switch(e.type)
      ▼
   Vue 组件
```

第 4 跳的折叠判据读的是事件的 `type` 与 `toolCallId`。信封化之后（见 §4）
判据读 `envelope.payload.type` —— 这正是 `payload` 必须是信封**正式字段**、
而不是随手挂上去的属性的原因。

## 4. 事件信封 `PiEnvelope<T>`

八个字段，缺一不可：

| 字段 | 作用 |
|---|---|
| `protocolVersion` | 版本闸门。`parseEnvelope` 第一步就比对，不等直接拒绝 |
| `workspaceId` | 工作区标识（M1 起为稳定 ID） |
| `sessionId` | pi 会话 ID |
| `runtimeId` | 一次 pi 子进程实例 |
| `generation` | 代际。每次 start / restart +1，用于丢弃上一代迟到事件 |
| `sequence` | 同一 `(sessionId, generation)` 内单调递增 |
| `occurredAt` | 主进程观测到的 Unix ms |
| `payload` | 承载的事件本体 |

**未知协议版本 fail closed**：宁可整条链路停摆，也不要一个新版本的字段被旧版本
渲染进程当成 `undefined` 静默吞掉。版本比对刻意排在结构校验**之前** —— 反过来的话，
一个 v2 信封会先因「结构不符」被报成 malformed，运维看到的是误导性的错误分类。

## 5. 端口接口（`contract/src/ports.ts`）

只定型，不实现。落地节奏：

| 端口 | 落地里程碑 |
|---|---|
| `PiRuntimeSupervisor` | M1（TASK-005） |
| `SessionRepository` | M1（TASK-006） |
| `PermissionEngine` | M2（TASK-007，`ipc-guard.ts implements PermissionEngine`） |
| `SettingsStore` | M3（TASK-008） |
| `UpdateService` | M4/M5（TASK-011） |

## 6. 单点实现（不得各写一份）

| 能力 | 唯一实现 | 复用方 |
|---|---|---|
| 结构化脱敏日志 | `app/src/main/logger.ts` | 全主进程 |
| 脱敏规则 | `app/src/main/logger-redact.ts` | logger、support-bundle(TASK-013)、connectivity(TASK-014) |
| 原子写 | `app/src/main/fs-atomic.ts` | workspace 记录(TASK-007)、settings.json(TASK-008)、auth.json(TASK-014)、health marker(TASK-013) |
| 测试配置 | 仓库根 `vitest.config.ts` | 全仓 |

`scripts/check-contract-uniqueness.mjs` 与 `scripts/check-test-discovery.mjs`
在 CI 里把「唯一性」从文档条款变成可执行断言。

## 7. SQLite 备份与恢复（BKP-101）

持久状态按能力域分区在 **12 个独立 sqlite 库**里（全仓 `FOREIGN KEY` /
`REFERENCES` / `ATTACH DATABASE` 命中数为 0：库之间既无外键也无跨库事务）。

| 文件 | 代际来源 | 内容 |
|---|---|---|
| `artifacts.db` (1) | `PRAGMA user_version` | 产物版本链与状态 |
| `changesets.db` (2) | `PRAGMA user_version` | 工作区改动评审 |
| `connectors.db` (1) | `PRAGMA user_version` | 外部渠道连接器 |
| `home-assistant.db` (1) | `PRAGMA user_version` | 家居实体注册表 |
| `home-automation.db` (1) | `PRAGMA user_version` | 家居自动化规则 |
| `memory.db` (2) | `PRAGMA user_version` | 记忆 / 知识库 / 向量 |
| `remote.db` (1) | `PRAGMA user_version` | 远程设备与审计 |
| `session-index.db` (1) | `PRAGMA user_version` | 会话索引 |
| `tasks.db` (1) | `PRAGMA user_version` | 定时任务与运行 |
| `usage.db` (2) | `usage_meta` 表的一行 | 用量与花费 |
| `workflows.db` (1) | `PRAGMA user_version` | 工作流定义与运行 |
| `workspaces.db` (2) | `PRAGMA user_version` | 工作区偏好 |

**一致性口径：逐库快照，不是原子快照。** 备份逐个调用 `node:sqlite` 的在线
`backup()`：每个库**自身**完整一致，跨库一致性是 best-effort（第 1 个与第 12 个
库的快照点之间隔着几十到几百毫秒）。这是分区架构的直接后果，不是缺陷 ——
因为库之间没有任何跨库不变量要维护。这句话必须原样出现在设置页上。

**范围**：12 个库 + `workspaces.json`（工作区注册表，库里的 `workspace_id` 列靠
它才有含义）。**不含** `settings.json`、账号凭据（`auth.json` / secret-store）、
日志、以及产物文件本体（那是用户工作区里的普通文件）。

**恢复是两段式**：`backup:restore` 只把校验通过的副本落到
`userData/pending-restore/`；真正的套用由 `applyPendingRestoreOnStartup()` 在
下次启动、任何 store 被打开之前完成（`main/index.ts` 的 `whenReady` 首行）。
当场替换做不到 —— 12 个句柄正开着，Windows 上 rename 覆盖会 EPERM。
暂存区在全部 rename 成功之后才删，因此中途崩溃会在下次启动继续收敛。

| 能力 | 唯一实现 |
|---|---|
| 备份纯逻辑（库登记表 / 清单编解码 / 路径收容 / 盘点比较） | `app/src/main/backup/backup-manifest.ts` |
| 备份 IO（快照 / fsync / 校验 / 暂存 / 套用） | `app/src/main/backup/backup-service.ts` |
| 四条通道接线（含目录选择框与确认框） | `app/src/main/backup/backup-ipc.ts` |
