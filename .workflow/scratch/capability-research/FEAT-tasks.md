# FEAT-tasks：持久定时任务（Durable Tasks，AUT-101 第一批，能力包 `common.tasks`）

让 Agent 能按计划持续执行。依据：`docs/product/ADR-0002-capability-architecture.md`（能力包机制、四层边界、D3 权限只申请不授予）、`FEAT-permission-engine.md`（预授权靠权限引擎的 workspace 授权表）、`FIX-capability-core.md`（manifest / registry / feature gate / drift test）。

tier 选 **common**（通用能力，可关闭），id `common.tasks`。scheduler 位于**主进程、headless**，不依赖任何 Vue / BrowserWindow——用户关掉窗口任务照跑。

---

## 1. 交付物（按路径）

**新增**

```
packages/contract/src/tasks.ts                         契约：计划(once/daily/weekly/cron/event) + 策略 + task/run 形态 + 11 条通道分片
packages/app/src/main/tasks/clock.ts                   可注入时钟（Clock / systemClock / ManualClock）——可测试性地基
packages/app/src/main/tasks/cron.ts                    极简 5 字段 cron 解析（通配/步长/区间/列表 + 日周 OR 语义）
packages/app/src/main/tasks/schedule.ts                时区/DST 换算 + computeNextRun（once/daily/weekly/cron）
packages/app/src/main/tasks/misfire.ts                 错过运行策略 skip/run-once/catch-up（纯函数）
packages/app/src/main/tasks/task-store.ts              node:sqlite 两表（tasks/runs），schema v1+migration，按 workspaceId 分区，idempotency UNIQUE
packages/app/src/main/tasks/task-permission.ts         **关键安全点**：定时 run 只认 workspace 预授权，纯函数
packages/app/src/main/tasks/task-trigger.ts            「触发 Agent run」的接线点（可注入，默认如实标注的 stub）
packages/app/src/main/tasks/scheduler.ts               调度核心：tick/lease/idempotency/misfire/并发/crash recovery/runNow/cancel/retry
packages/app/src/main/tasks/tasks-ipc.ts               11 条通道 handler + disposeTasksResources + 启动调度器
packages/app/src/main/capability/manifests/tasks.manifest.ts   能力清单（纯数据）
packages/app/src/preload/api/tasks.ts                  window.piBuddy.tasks（第 18 个命名空间）
packages/app/src/renderer/src/stores/tasks.ts          渲染侧状态
packages/app/src/renderer/src/components/TasksPanel.vue 面板（建任务 + 列表 + run 记录 + 全部操作）
packages/app/test/tasks-schedule.spec.ts               23 条：DST/时区/cron/misfire/回拨
packages/app/test/tasks-scheduler.spec.ts              12 条：lease/idempotency/并发/崩溃恢复/pause-runNow-cancel-retry
packages/app/test/tasks-permission.spec.ts             6 条：定时 run 不继承 once/session（对照真实交互引擎）
packages/app/test/tasks-store.spec.ts                  2 条：workspace 分区 + schema 版本
```

**修改（共享中央文件，各自末尾追加，无覆盖）**

```
packages/contract/src/channels.ts        + tasks:* 11 条
packages/contract/src/ipc-contract.ts    + tasksContractShard（分片数组追加一条）
packages/contract/src/index.ts           + export tasks.js
packages/app/src/main/capability/capability-manifests.ts  + tasksCapability 进 BUILT_IN + 进 general/coding 两个 Profile
packages/app/src/main/capability/capability-catalog.ts    + register(tasksCapability, registerTasksIpc, disposeTasksResources)
packages/app/src/main/logger.ts          + LogScope 追加 "tasks"（headless 调度器的日志域）
packages/app/src/preload/api/index.ts    + tasks 命名空间
packages/app/src/renderer/src/components/AppShell.vue  + tasksEnabled 门控 + ⏰定时 按钮 + 挂 TasksPanel（四个具名 slot 一个没动）
packages/app/test/preload-api.spec.ts    命名空间集合追加 "tasks"（精确匹配断言，必须同步）
```

**`ipc-registry.ts` 一行未动**：tasks 是能力，经 `resolution.enabled` 循环自动注册，drift-5 明令禁止在 ipc-registry 里写死能力注册。
**未新增任何运行时依赖**（cron 自己实现，时区走 Intl full-ICU）。

---

## 2. 时间/时钟——这块的核心难点，全部可注入、可证伪

所有已知坑（DST、时钟回拨、missed run、sleep/wake、App 关闭）都在时间处理。落地方式：

- **可注入时钟**：scheduler 从不 `Date.now()`，一律 `clock.now()`。单测注入 `ManualClock` 把时间捏成任意形状（包括往回拨）。
- **墙钟 + 时区，不冻 epoch**：`daily/weekly/cron` 存 `HH:MM`/表达式 + IANA 时区，绝对时刻每次调度用 `computeNextRun` 按时区重解。
- **DST 两种病态显式处理**（`wallToEpoch`）：
  - gap（春季前跳，2:30 不存在）→ 滚到 gap 之后（3:30），不静默丢弃；
  - overlap（秋季回拨，1:30 出现两次）→ 取较早一次，且只算一次。
- **时钟回拨天然安全**：`planMisfire` 枚举 `(sinceMs, now]` 的槽位，回拨时 `now < sinceMs` ⇒ 集合为空 ⇒ 一个 run 都产生不出来。不是靠 if 挡，是枚举定义本身排除了它。
- **idempotency**：每个墙钟槽位一个 key（`taskId#scheduledFor`），`runs` 表 UNIQUE(idempotency_key) 在**数据库层**保证非幂等 action 不被重复执行；回拨/双触发/catch-up 对同一槽位的第二次尝试 createRun 直接返回 null。
- **misfire policy**：skip（只跑准点的）/ run-once（最多补一次）/ catch-up（逐个补，各带独立 key）。

DST 断言用 America/New_York 真实切换日（2026 春 3/8 02:00→03:00、秋 11/1 02:00→01:00），断言具体 epoch / 本地时分，不是「函数被调用」。

---

## 3. 关键安全点：定时任务不继承交互会话的 allow-once（ADR D3）

无人值守的定时 run 触发时用户可能在睡觉。若它能拿到交互会话的 allow-once/session，就等于绕开人工确认。落地：

- `task-permission.evaluateScheduledPermissions(required, workspaceId, workspaceGrants)` **只读 workspace（allow-workspace、落盘）授权**。它在结构上够不到交互引擎的 once/session 列表——**入参里根本没有那两个列表**，不是「记得别读」。
- 每个任务在 `requiredPermissions` 声明它触发的 run 可能需要的能力权限（与 tasks 能力自己 manifest 的 `permissions:[]` 是两个轴）。
- 缺预授权时的动作是**等待 owner**：run 被登记为 failed 且 error「等待 owner 授权：当前工作区尚未预授权 X」，不执行、不静默失败。列表里以 `missingPermissions` 摊开，用户去权限中心补 allow-workspace（危险权限会走既有的主进程原生确认框）。**只调用权限引擎，`main/permission/**` 既有逻辑一行没改。**

危险动作（`process.git` 等）在本批因此默认**等待 owner**——把危险的自动执行接线点留清晰，而不是先放行。

---

## 4. 触发 Agent run = 清晰的待接线点（不依赖后台池新接口）

触发机制归后台池 agent 在改（`main/agent-pool/**` / `pi-supervisor` / `event-forwarder`，均在硬边界外，本批不碰）。做法：

- `AgentRunTrigger` 窄接口，scheduler 只依赖它；默认注入 `noopAgentRunTrigger`，如实走完 run 生命周期但**不驱动真实 Agent**，日志明写「Agent 触发为待接线点（后台池接口尚未接入）」。
- **将来接后台池**：实现一个 `AgentRunTrigger`，拿 `ctx.input`（冻结的 provider/model/prompt）向后台池申请无人值守会话，回填 sessionId / 费用 / 产物；超时预算由 ctx 传入。`setAgentRunTrigger()` 一处替换即可，scheduler 一行不动。**在此之前绝不用交互会话的 pi:prompt 驱动**（会把无人值守任务塞进用户正在看的会话）。

run 有独立 id、输入 snapshot、状态、attempt、session/artifact/费用、日志；支持 pause / run now / cancel / retry / duplicate。lease（LEASE_TTL 5min）+ crash recovery：进程崩溃留下的孤儿 run（running/pending 且 lease 过期）在 `recover()` 里判死 failed，**不盲目重跑**（避免重复副作用），用户可显式重试（走新 key）。

---

## 5. 对拍验证（临时拆掉机制，确认变红，两次输出）

本项目反复抓到恒真断言，故对时序类判据做对拍。

### 对拍 A：DST gap 方向（`schedule.ts` `Math.max`→`Math.min`）

```
$ npx vitest run --project unit packages/app/test/tasks-schedule.spec.ts
 ❯ tasks-schedule.spec.ts (23 tests | 1 failed)
   × DST 春季前跳（gap）… daily 02:30 在 3/8 那天不存在，滚到 03:30 EDT
 Test Files  1 failed (1)
```

还原后：

```
 Test Files  1 passed (1)
      Tests  23 passed (23)
```

改错方向后 02:30 会解成 gap **之前**的 01:30 EST（早于用户意图、且落在被跳过的时刻），是一个真实 DST bug——测试变红，证明它不是恒真。

### 对拍 B：时钟回拨下界（`misfire.ts` `let cursor = sinceMs`→`Math.min(sinceMs, 0)`）

```
$ npx vitest run --project unit packages/app/test/tasks-schedule.spec.ts
 ❯ tasks-schedule.spec.ts (23 tests | 5 failed)
   × 回拨当天不会把同一墙钟槽位跑两遍（catch-up 也只列一次）
   × 时钟回拨：now 早于 sinceMs → 一个槽位都不产生（不重复触发）
   …
 Test Files  1 failed (1)
```

还原后 4 个 tasks spec 全绿：

```
 Test Files  4 passed (4)
      Tests  43 passed (43)
```

从 0 起枚举后，回拨会翻出海量历史槽位重复触发——测试变红，证明 `sinceMs` 下界是「回拨不重复触发」真正的承重点，而不是走过场。

### 内嵌对拍

- idempotency：`createRun` 同 key 第二次返回 `null`（拆掉 UNIQUE/预检就会重复执行）。
- 权限不继承 session：用**真实**交互引擎 `CapabilityPermissionEngine` 加一条 session 授权 → `engine.evaluate` 放行；同一条权限 `evaluateScheduledPermissions(…, workspaceGrants=[])` → 拒绝。交互放行 vs 定时拒绝的对照即「不继承 session」的证据。

---

## 6. 门禁（收尾全跑）

```
$ pnpm typecheck            # tsc node + vue-tsc web，全绿（tasks 全链路零报错）
$ npx vitest run --project unit
 Test Files  111 passed (111)
      Tests  1037 passed (1037)     # 基线 +4 文件 / +43 测试，无一条既有用例被改判
$ npx vitest run --project perf
 Test Files  3 passed (3) / Tests 12 passed (12)
$ pnpm build                # out/main + preload(40.90kB) + 3139 renderer modules，含 tasks 全链路
$ pnpm dist                 # release/win-unpacked/PiBuddy.exe（含本批代码）
```

硬约束核对：

```
$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0                                   # 唯一 ipcMain.handle 出口仍是 ipc-guard；11 条 tasks 通道全经 registerHandler
$ node scripts/check-test-discovery.mjs        → onDisk 114 / OK
$ node scripts/check-contract-uniqueness.mjs   → exports 503 / OK
$ node packages/app/scripts/check-pure-js-deps.mjs → OK（无原生扩展）
channels.ts 无真实 zod import（只有注释）；preload 只引 @pibuddy/contract/channels
```

- 数据按 workspaceId 分区（`runs`/`tasks` 的 `workspace_id` 列，值即 `sha256(realpath)` 派生的 workspaceId，规范化在 workspace-registry 用 `realpathSync.native` 做过）。
- SQLite 用 `node:sqlite`，schema v1 + migration（改 DDL 必须 +1 补分支，绝不重建）。
- `capability-gate.spec` 的「lite 下只有 capability-prefs.json」不破：能力禁用时 `registerTasksIpc` 不被调用，tasks.db 与调度器都不创建（store 惰性、调度器 start 在 activate 内、且测试进程 VITEST 置位时不起真实 interval）。

---

## 7. 真机取证（`release/win-unpacked/PiBuddy.exe` + CDP，`scripts/cdp-eval.mjs`）

打包产物含本批代码。CDP 连渲染进程：

```
命名空间：window.piBuddy.tasks 存在，11 个方法 list,get,create,update,delete,pause,resume,runNow,cancelRun,retryRun,duplicate

A. 建任务 + 列表 + run now + pause（一次性 flow）：
{"created_id":"5bd7b731","tz":"Asia/Shanghai",
 "nextRunAt":"2026-08-04T01:00:00.000Z",         ← 每天 09:00 上海 = 01:00 UTC，时区解析正确
 "budget":2,"timeout":60000,"failPolicy":false,
 "listed":1,
 "run_status":"succeeded","run_attempt":1,
 "run_note":"开始执行|Agent 触发为待接线点（后台池接口尚未接入）…",  ← 如实标注 stub，不谎称跑过真实 Agent
 "paused_status":"paused","paused_next":null}     ← pause 生效，nextRunAt 清空

B. 关键安全点（危险任务无预授权 → 等待 owner）+ cancel：
{"missingPerms":["process.git"],                  ← 列表摊开「等待授权」
 "run_status":"failed",
 "run_error":"等待 owner 授权：当前工作区尚未预授权 process.git",  ← 不继承任何 session，直接挡下
 "cancel_of_terminal":"failed"}                   ← cancelRun 对已终结 run 优雅无操作，不崩
```

保存时界面显示了：时区、下一次运行、workspace（入参）、Agent/Provider、权限、预算、超时、失败策略——需求逐项对齐。

**进程清理**：`Stop-Process -Name PiBuddy -Force` 后 `PiBuddy count=0` / `electron count=0`（按铁律用 powershell）。

---

## 8. 本批发现 / 未做（留给后续）

1. **触发 Agent run 未接后台池**：本批是 stub（如实标注），接线点 `AgentRunTrigger` 已就绪，后台池落地时一处替换。
2. **无 push 通道**：后台调度器触发的 run 状态更新靠渲染侧刷新/轮询（各动作返回权威快照，与 providers/update 同构）。加 `tasks:event` push 需要 main→renderer 的 sender，涉及 event-forwarder（硬边界外），留待后台池接线时一并做。
3. **失败重试的 backoff 不真实 sleep**：自动重试在同一 tick 内递增 attempt 连续尝试（backoff 记入日志不阻塞调度线程）。真实退避定时器留给后台池接线（那时有真实副作用与时长可依）。
4. **`event` 计划**：数据面已就位（`{kind:"event",event}`，`computeNextRun` 恒返回 null），等外部事件投递机制——同属待接线点。
5. **危险权限的 once/session 确认**：本批危险任务默认等待 owner（只认 allow-workspace）。交互侧危险权限的 workspace 持久化已有原生确认框（permission 引擎既有），tasks 直接复用其落盘授权表。
