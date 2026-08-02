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
