# 架构总览

> 本文描述**约束**，不描述实现细节；实现细节属于各模块源码注释。

## 包边界

| 包 | 角色 | 消费方式 |
| --- | --- | --- |
| `@pibuddy/contract` | main / preload / renderer / pi-sdk 四方共用的类型与**运行时 schema** 唯一真相源 | 源码形式（`main` 指向 `src/index.ts`，不产出 dist） |
| `@pibuddy/pi-sdk` | pi RPC 协议（JSONL over stdio）的客户端与类型 | 源码形式 |
| `@pibuddy/app` | Electron 应用：main / preload / renderer 三进程 | electron-vite 打包 |

`tsconfig.base.json` 的 `noEmit: true` 决定了 workspace 包一律以**源码**被消费：app 直接 include contract 与 pi-sdk 的 `src/**/*.ts`，没有 project references，也没有中间产物。

> 新建 workspace 包时必须同时改三处，漏一处就会在运行时炸：
> 1. `packages/app/electron.vite.config.ts` 的 `externalizeDepsPlugin({ exclude: [...] })`——漏加会构建通过但运行时报"无法解析的 external"。
> 2. `tsconfig.node.json` / `tsconfig.web.json` 的 `include`。
> 3. `tsconfig.web.json` 的 `paths` 与 `electron.vite.config.ts` 的 renderer `alias`。

## 依赖方向（硬规则）

```
renderer  →  preload  →  main  →  pi-sdk  →  pi 子进程
                 ↘         ↓        ↙
                  @pibuddy/contract
```

- **禁止反向**：main 不得 import renderer 的任何东西；pi-sdk 不得感知 Electron。
- **contract 只被依赖**：它不依赖任何 workspace 包。因此 `StartResult` 用泛型槽位（`StartResult<TState, TModel, TMessage>`）而不是直接引用 pi-sdk 的类型——否则 contract → pi-sdk 的边会把 renderer 侧的类型检查被迫拉进 `node:child_process`。
- **禁止跨层硬编码路径**：渲染进程一律通过 `@contract` 拿类型，`scripts/check-contract-uniqueness.mjs` 把这条规则跑成 CI 断言。

## 端口接口

`contract/src/ports.ts` 只定型，不实现。按里程碑落地：

| 端口 | 落地里程碑 |
| --- | --- |
| `PiRuntimeSupervisor` | M1 |
| `SessionRepository` | M1 |
| `PermissionEngine` | M2（`ipc-guard.ts implements PermissionEngine`） |
| `SettingsStore` | M3 |
| `UpdateService` | M4/M5 |

## 单点实现（不得各写一份）

| 能力 | 唯一实现 | 复用方 |
| --- | --- | --- |
| 结构化脱敏日志 | `app/src/main/logger.ts` | 全主进程 |
| 脱敏规则 | `app/src/main/logger-redact.ts` | logger、support-bundle、connectivity |
| 原子写 | `app/src/main/fs-atomic.ts` | workspace 记录、settings.json、auth.json、health marker |
| 测试配置 | 仓库根 `vitest.config.ts` | 全仓 |

`scripts/check-contract-uniqueness.mjs` 与 `scripts/check-test-discovery.mjs` 在 CI 里把"唯一性"从文档条款变成可执行断言。

## 继续阅读

- [事件流与信封](/architecture/event-flow)：跨进程事件如何分帧、归一、批处理并落到 Vue 组件。
- [pi 运行时生命周期](/runtime/)：generation、状态机与 SDK 请求可靠性。
- [SQLite 分区与备份](/data/)：12 个独立库的一致性口径与两段式恢复。
