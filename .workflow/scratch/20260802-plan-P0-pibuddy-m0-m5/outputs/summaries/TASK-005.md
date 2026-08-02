# TASK-005: RUN-002 + RUN-003 运行时代际状态机与 SDK 可靠性垂直切片

状态：**completed**（全部 20 条 convergence.criteria 实跑通过，含 2 条 UI-observable 人工项）

## Changes

### pi-sdk

- `packages/pi-sdk/src/errors.ts`（新建）：`RpcTimeoutError` / `RpcAbortedError` /
  `JsonlOverflowError` 三个具名错误。请求级失败与链路级失败要让调用方能分开处置。
- `packages/pi-sdk/src/jsonl.ts`：新增 `MAX_LINE_BYTES = 8MB` / `MAX_BUFFER_BYTES = 16MB`
  与 `onError` 回调；越界后清空 buffer 并进入「丢弃直到下一个 `\n`」状态
  （否则超长行的后续分片会不断重复触发同一个错误）。返回 `JsonlReaderHandle`
  （`bufferLength()` / `detach()`）。仅按 `\n` 分帧、剥尾部 `\r` 的原语义不变。
- `packages/pi-sdk/src/client.ts`：
  - `readonly runtimeId = randomUUID()` + `readonly generation`；
  - `RuntimePhase` 七相位 + `ALLOWED_TRANSITIONS` 表，非法转换在
    `NODE_ENV !== "production"` 抛错、生产环境记诊断；
  - `send(command, { timeoutMs, signal })`，`DEFAULT_RPC_TIMEOUT_MS = 30_000`，
    超时/abort/成功/写失败四条结束路径统一 `pending.delete(id)` + `dispose()`；
  - 请求 id 改为 `${runtimeId}:${++seq}`（跨代际重启后旧 response 不会被新 pending 认领）；
  - 注册 `proc.on("close")` 与 `proc.stdin.on("error")`；`error/exit/close` 三路
    汇入 `settleTermination()`，靠 `terminated` 保证 `exit` **恰好** emit 一次
    （ENOENT 实测只走 error → close，没有 exit）；
  - 写路径改为串行泵 + 背压：`stdin.write` 返回 false 时 `await once(proc.stdin, "drain")`，
    写队列上限 1000；
  - `stop()` 四级阶梯：abort RPC(1500ms) → `stdin.end()`(1000ms) → SIGTERM(3000ms)
    → Windows `taskkill /pid <pid> /T /F`、其它平台 `process.kill(-pid,"SIGKILL")`，
    每级独立超时且进程提前退出即收敛；永不 reject；
  - `exit` 事件带 `PiExitMeta{reason:"expected-stop"|"crash", runtimeId, generation, error?}`；
  - `assertUsable()` 抛出携带 `lastSpawnError` / stderr 尾巴的真因（替代泛化文案）；
  - 有界诊断环 `diagnostics`（上限 200）收 malformed / orphan / jsonl-overflow /
    stdin-error / illegal-transition / write-overflow。
- `packages/pi-sdk/src/index.ts`：导出 `RuntimePhase`、三个错误类、
  `ALLOWED_TRANSITIONS`、`DEFAULT_RPC_TIMEOUT_MS`、`PiExitMeta` 等。

### 主进程

- `packages/app/src/main/pi/event-forwarder.ts`（新建，全计划唯一转发器）：
  `BATCH_INTERVAL_MS = 33`、
  `collapseEnvelopes(input: PiEnvelope<AgentEvent>[]): PiEnvelope<AgentEvent>[]`
  （本任务为「按 sequence 保序 + 累积快照折叠」版，TASK-010 升级为 delta 累加）、
  `createForwarder()` 返回 `{push, flush, dispose}`；`dispose` 同时
  `clearTimeout` / `queue = []` / `source.removeAllListeners()`。
  折叠判据读 `env.payload.type` / `env.payload.toolCallId` —— 类型层面锁死
  「折叠只吃信封」，避免加了信封后判据恒 undefined、折叠静默退化成透传。
- `packages/app/src/main/pi-supervisor.ts`（新建）：`implements PiRuntimeSupervisor`。
  每次 `launch()` 分配 `randomUUID()` 与 `++generationCounter`（永不复用），
  维护 per-runtime 单调 `sequence`，三条 push 通道全部经 `wrapEnvelope()` 包成
  `PiEnvelope` 并填满 7 个字段；只转发当前代际（`isCurrent`），旧代际的 exit
  记 `pi_stale_exit_dropped` 后直接丢弃；`forget()` 先摘索引再 dispose forwarder。
  33ms 合批**不在**本文件（结构断言输出 0）。
- `packages/app/src/main/ipc.ts`：`makeEventForwarder` 整体迁走；`pi:start` 委托
  supervisor，`clients.set(wc.id, client)` 位于**任何 await 之前**（第 107 行，
  第一个 await 在第 110 行）；握手失败进 catch：停子进程、删索引、摘监听，
  抛出带真因 + 脱敏 stderr 的结构化错误；`clientFor` 改调 `client.assertUsable()`，
  文件内已无「智能体尚未启动」。
- `packages/app/src/preload/index.ts`：不再剥壳，完整 `PiEnvelope` 透传；
  所有监听器登记进 `active`，`pagehide` 时统一摘除。
- `packages/app/src/preload/index.d.ts`：三个 `on*` 回调签名改为
  `PiEnvelope<AgentEvent>` / `PiEnvelope<ExtensionUiRequest>` / `PiEnvelope<PiExitPayload>`。

### 契约 / 渲染进程

- `packages/contract/src/ipc-contract.ts`：新增 `piExitPayloadSchema` /
  `PiExitPayload`（`code` + `reason` + 可选 `error`），`PUSH_CONTRACTS[piExit]` 随之收紧。
- `packages/app/src/renderer/src/stores/app.ts`：新增
  `currentRuntimeId` / `currentGeneration` / `lastSequence` / `droppedEnvelopes`；
  `acceptEnvelope(raw, channel)` 做 parseEnvelope → 代际比对 → **按通道**的序号单调判定；
  `handleEventEnvelope` / `handleUiRequestEnvelope` / `handleExitEnvelope` 三个入口
  先解包再进原有 switch reducer（未逐 case 改写）；`onExit` 按 `reason` 区分
  「主动停止」与「崩溃」，崩溃时把真因带进提示；三个 `on*` 的 unsubscribe 全部
  存入 `unsubscribes` 数组并由新增的 `dispose()` 释放。
- `vitest.config.ts`：补 `@sdk` / `@contract` 的 resolve.alias（store 现在会运行时
  import `parseEnvelope`，没有别名任何 import store 的测试会在解析期就失败）。
  未新建第二个 vitest 配置。

### 测试

- `packages/pi-sdk/test/lifecycle.spec.ts`（新建，11 例）
- `packages/app/test/generation.spec.ts`（新建，7 例）
- `packages/app/test/event-forwarder.spec.ts`（新建，7 例）
- `packages/pi-sdk/test/client.spec.ts`（改）：请求 id 断言随格式更新为
  `` `${client.runtimeId}:1` ``；`afterEach` 改为 `await stop()`。
- `doc/regression/TASK-005-runtime.md`（新建）：人工回归记录。

## Verification（逐条实跑）

命令与真实输出：

```
$ pnpm -w test
 Test Files  10 passed (10)
      Tests  70 passed (70)

$ pnpm typecheck
packages/pi-sdk typecheck: Done
packages/contract typecheck: Done
packages/app typecheck: Done      (tsc -p tsconfig.node.json && vue-tsc -p tsconfig.web.json)

$ pnpm build
✓ built in 19.55s   (out/main 193.14 kB, out/preload/index.cjs 1.82 kB, renderer 全部产出)
```

字符串级判据（node 读文件断言，避开 MSYS 对 `/T` `/F` 的参数路径改写）：

| # | 判据 | 结果 |
|---|------|------|
| c[0] | client.ts `DEFAULT_RPC_TIMEOUT_MS = 30_000` / `signal?: AbortSignal` | PASS |
| c[1] | client.ts `ALLOWED_TRANSITIONS` + 7 个相位字面量 | PASS（7/7） |
| c[2] | client.ts `proc.on("close"` / `proc.stdin.on("error"` / `once(proc.stdin, "drain")` | PASS |
| c[3] | client.ts `taskkill` / `/T` / `/F` | PASS（`taskkill:true /T:true /F:true`） |
| c[4] | client.ts `randomUUID()` / `readonly runtimeId` | PASS |
| c[5] | jsonl.ts `MAX_LINE_BYTES` / `MAX_BUFFER_BYTES` | PASS |
| c[6] | supervisor `implements PiRuntimeSupervisor`/`generation`/`sequence`/`PROTOCOL_VERSION`/`wrapEnvelope(` | PASS |
| c[6] | 结构断言 supervisor 内 `setTimeout(.*33\|BATCH_INTERVAL_MS` 计数 | **0** PASS |
| c[7] | event-forwarder `collapseEnvelopes` 单行签名 / `createForwarder(` / `BATCH_INTERVAL_MS = 33` | PASS |
| c[7] | dispose 函数体同时含 `clearTimeout` / `removeAllListeners` / `queue = []` | PASS |
| c[9] | 含 `pi:start` 的文件恰为 1 个（`packages\app\src\main\ipc.ts`，不硬编码路径） | PASS |
| c[9] | 该文件内 `clients.set(` 行号(107) < 回调体第一个 `await ` 行号(110) | PASS |
| c[9] | ipc.ts 中「智能体尚未启动」出现次数 | **0** PASS |
| c[15] | store 中 `activityTick.value++` 出现次数 | **1** PASS |
| c[16] | store `unsubscribes` 存在，且 3 个 `on*` 返回值全部入数组 | PASS（count=3） |

行为级判据（`pnpm -w test` 内实跑）：

| # | 判据 | 结果 |
|---|------|------|
| c[10] | ENOENT 后 2000ms 内 `phase === "crashed"`，`exit` 恰好 emit 一次 | PASS（329ms） |
| c[9]  | `assertUsable()` 抛出的 message contains `ENOENT`、not contains 泛化文案 | PASS |
| c[11] | `--scenario timeout` 下 `timeoutMs:200` 超时 reject，`pending.size === 0` | PASS |
| —     | AbortSignal 触发后 reject，`pending.size === 0` | PASS |
| c[12] | 单行超限抛可捕获错误且 `bufferLength() === 0`；`--scenario oversized-line` 记 `jsonl-overflow` 且链路不死 | PASS |
| c[13] | 非法转换 `stopped → running` 在非 production 抛错，且相位不被半推进 | PASS |
| c[14] | gen:2 后投 gen:1 → `started` 仍 true、旧 payload 不进 items；sequence 倒退被丢 | PASS |
| —     | stop 后 `exit` 的 reason 为 `expected-stop`；stopping 之后拒绝新命令 | PASS |
| —     | forwarder dispose 后再投递，`target.send` 调用次数为 **0** | PASS |

UI-observable（真机 CDP 驱动 Electron 渲染进程，非模拟；记录见
`doc/regression/TASK-005-runtime.md`）：

| # | 判据 | 结果 |
|---|------|------|
| c[18] | 流式中连点两次「开始新任务」不弹「智能体进程意外退出」，输入框保持可用并能立即发下一条 | PASS |
| c[18] | 流式文本增量 / thinking 折叠 / 花费与会话列表刷新 / 「⏹ 停止」按钮 | PASS |
| c[18] | steer 插话：提示「已插话…」+「（已排队 1 条插话）」，模型实际改为只数到 10 | PASS |
| c[19] | external 指向不存在命令，文案 contains `ENOENT` 与缺失命令名，not contains 泛化文案 | PASS |
| —     | 改回 bundled 重启：`generation` 1→2、`droppedEnvelopes === 0`、无崩溃提示 | PASS |

## Deviations

1. **`clients` 映射保留在 ipc.ts**。c[9] 要求 handler 体内出现 `clients.set(`，
   因此 supervisor 持有代际/序号/转发的完整记录，ipc.ts 另留一份极薄的
   `Map<number, PiRpcClient>` 仅供 `clientFor` 同步查找。两处都由
   `disposeClientFor` 一起清，不会各自漂移。
2. **`PiSupervisor.start()` 需要 `bindTarget` + `spawn`**。端口签名
   `start(options: PiRuntimeStartOptions)` 不带转发目标，而 Electron 路径必须
   同步拿到 client 才能满足「await 之前登记」，因此实际入口是同步的 `launch()`，
   `start()` 作为端口兼容壳存在。
3. **请求 id 格式变更**（`c1` → `${runtimeId}:1`），已同步更新
   `packages/pi-sdk/test/client.spec.ts` 中两处断言。这是「每请求不可碰撞 ID」
   的直接后果，非绕过。
4. **`collapseEnvelopes` 超出「纯直通」**：criteria 写的是「保序直通版本」，
   但 risks 明确要求不得丢失累积型折叠（否则流式文本闪烁 / tool 卡片不更新）。
   本实现是「保序 + 累积快照折叠」，两者都满足；TASK-010 仍在同一文件升级。
5. **`vitest.config.ts` 增加了 resolve.alias**（未新建第二份配置）。
6. **`contract` 包新增 `piExitPayloadSchema`**：`files[]` 未列 contract，
   但 `PUSH_CONTRACTS[piExit]` 原为 `z.number().nullable()`，与新的
   `{code, reason, error?}` 载荷不符，不改就是留一个已知错误的契约。
7. **stderr 未新开 IPC 通道**：按「所有外发消息带代际上下文」的要求，
   stderr 带 `runtimeId`/`generation` 进结构化日志（OBS-001），
   未向渲染进程新增 push 通道以免扩大改动面。
8. **非 Windows 下 spawn 加了 `detached: true`**：`process.kill(-pid)` 杀进程组
   需要子进程自成进程组。Windows（本项目目标平台）不受影响。

## Notes（下游任务需要知道的）

- **序号单调性必须按通道判定，不能全局判**。三条 push 通道共用一个计数器，
  但 `pi:event` 走 33ms 合批、`pi:ui-request` / `pi:exit` 立即发出，ui-request
  会带着更大的 sequence 先到。本任务实测踩到：`agent_start` 被误丢 →
  `streaming` 恒 false → 插话退化成普通 prompt 被 pi 拒绝
  （`Agent is already processing`）。**这条 bug 单测全绿、流式文本照常渲染**，
  只有真机跑一次插话才暴露。回归测试见
  `packages/app/test/generation.spec.ts`「ui-request 抢先到达…」。
  TASK-010 若改动合批时机，必须重跑这条。
- **TASK-010 在 `packages/app/src/main/pi/event-forwarder.ts` 上继续升级折叠**。
  `collapseEnvelopes` 的入参类型已锁死为 `PiEnvelope<AgentEvent>[]`，
  fixture 无法投喂裸事件；升级 delta 累加时判据仍须读 `env.payload`。
- **TASK-007/009 迁移 `pi:start` handler 时**：c[9] 的校验脚本按
  「`packages/app/src/main` 下含 `pi:start` 的文件恰为 1 个」定位，
  迁移后请保证仍只有一个文件含该字面量，且 `clients.set(` 仍在第一个 `await` 之前。
- `client.stop()` 现在是 `Promise<void>` 且永不 reject；旧的同步调用点
  （`disposeClientFor` / 测试 afterEach）无需改动，但需要等进程真死的地方要 await。
- `client.transition()` 是公开方法，仅供 supervisor 与状态机单测驱动，
  业务代码不应直接调用。
- 渲染进程 store 新增了 `dispose()`，窗口销毁路径可调用它释放三个订阅。
