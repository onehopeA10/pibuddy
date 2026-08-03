# FEAT-agent-pool：后台多会话池（AGT-101 第一批）

内核基建，让 PiBuddy 从「单活动聊天」升级为「可监督的并行 Agent」。child Agent 编排的
前置——本批**只做池子**，为 child 编排预留清晰接口（`PoolRuntimeHost` 接缝 +
`requestSession(origin)`），不实现任何 parent/child 逻辑。

依据：`docs/product/ADR-0002-capability-architecture.md`（会话/runtime 属四层边界表第一行
「平台内核」，不可关闭）；`FEAT-permission-engine.md`（第五道闸 / 权限引擎，本批只调用不改）；
`FIX-capability-core.md`（契约分片、drift、结构性断言手法）。

在**独立 worktree**（`worktree-agent-aac7928986237fd20`）里工作，提交到自己的分支，不 push origin/main。

---

## 1. 交付了什么

- **纯内核状态机** `agent-pool/pool-core.ts`：每会话进程态
  `focused/background/warm/stopped/crashed` + 列表任务态
  `idle/running/waiting_permission/failed/done` + 未读；全局/每 workspace 并发、内存、成本
  四道资源上界与**公平 FIFO 准入队列**；空闲回收 `background→warm→stopped`；崩溃预算
  （窗口内超预算才放弃自动恢复）；统一权限 inbox（**超时拒绝，绝不自动允许**）；**按会话
  隔离的事件序号闸门**（不串台的落点）；单调快照序号。
- **snapshot + sequence 订阅**：快照推送复用现有 `PiEnvelope`（generation 全局判、sequence
  按通道单调判），任一窗口拿一份快照即对齐，晚到的旧快照被序号闸门丢弃。
- **窗口关闭 ≠ 停止**：`hasLiveSessions()` 供应用退出/更新时让用户选择；`shutdownAll()` 才真停。
- **接线层** `agent-pool/pool.ts`：把内核接到广播（推全部窗口）、维护节拍、`PoolRuntimeHost`
  占位（后台派生的接缝）。**不 import pi 域**——观测者形状定义在内核侧，由 pi 域挂上。
- **4 条内核通道** + **1 条推送**（恒注册）：`agent-pool:describe/focus/stop/set-caps` +
  `agent-pool:event`。preload 第 19 个命名空间 `window.piBuddy.agentPool`。
- **渲染侧**：`stores/agent-pool.ts`（snapshot+sequence 订阅，与 app store 并列、只读）+
  `components/AgentPool.vue`（会话列表 / 资源占用 / 统一权限 inbox）。

**child 编排本批不做**：`PoolRuntimeHost.launch/stop` 与 `requestSession({origin:"child"})`
是预留接缝，已在 core 用例里钉住准入/回收/崩溃预算对 launch 路径生效，但 host 的真实后台
进程派生本批留空（记账占位）。

---

## 2. 改了什么（按路径）

**新增**

```
packages/contract/src/agent-pool.ts                       契约 + 4 通道分片 + 快照/inbox/caps schema
packages/app/src/main/agent-pool/pool-core.ts             纯状态机（不 import electron / 不碰进程）
packages/app/src/main/agent-pool/pool.ts                  接线：广播 / 维护节拍 / host 占位 / 观测者
packages/app/src/main/agent-pool/agent-pool-ipc.ts        4 条内核通道 + 起维护节拍
packages/app/src/preload/api/agentPool.ts                 window.piBuddy.agentPool（第 19 个命名空间）
packages/app/src/renderer/src/stores/agent-pool.ts        渲染侧 snapshot+sequence 订阅
packages/app/src/renderer/src/components/AgentPool.vue     会话池监督面
packages/app/test/agent-pool-core.spec.ts                 17 条（纯状态机 + 真交错并发 + 对拍）
packages/app/src/renderer/src/stores/agent-pool-store.test.ts  3 条（快照序号闸门）
```

**修改（我的独占文件）**

```
packages/app/src/main/pi-supervisor.ts   + PoolObserver 挂钩（与 uiHook 同手法，默认 null → 零回归）
packages/app/src/main/pi/pi-ipc.ts       + registerPiIpc 里挂 setPoolObserver（依赖方向 pi → kernel）
packages/app/src/main/ipc-registry.ts    + 内核段 registerAgentPoolIpc（恒注册）
packages/app/src/preload/api/index.ts    + agentPool 命名空间
```

**修改（与并行 agent 共用的分片/中央文件，各自追加，无覆盖）**

```
packages/contract/src/channels.ts        + agent-pool:* 4 条 + agent-pool:event 推送（追加在末尾）
packages/contract/src/ipc-contract.ts    + agentPoolContractShard（分片数组末尾）+ PUSH_CONTRACTS 一行
packages/contract/src/index.ts           + export agent-pool.js
packages/app/test/preload-api.spec.ts    命名空间集合 + "agentPool"（18 → 19）
```

**未新增任何运行时依赖。** **不得改**的 `main/git/**`、`main/scheduler/**`、`main/tasks/**`、
`main/permission/**` 既有逻辑——一行未动（permission 只调用形态，本批甚至未接 inbox 到引擎，
见 §6）。

### 单会话零回归的两处落点

1. **supervisor 观测者默认 null**：`setPoolObserver` 不装时，`onEvent/onAdopt/onExit`
   三个回调点都是 `?.`，行为与从前逐字节相同。装上后：事件信封**只生成一次**
   （`const env = this.nextEnvelope(...)` 先喂观测者再转发），序号单调自增一次，
   33ms 合批 / 折叠 / 按通道序号判 / 代际全局判全部不变。
2. **池是并列的一层**：前台会话的流式渲染、steer 插话、abort、切换本地优先渲染仍走 app
   store 那条老路；池 store 只读不写会话内容，不碰 composer/draft。

---

## 3. 对拍验证（临时拆掉确认变红，两次输出）

本项目铁律：多会话并发判据必须**真的制造并发**，不能只断言 `pool.size==N`。核心用例
`agent-pool-core.spec.ts`「N 个并发会话不串消息/成本/权限」交错投喂两个会话的真实事件流 /
成本 / 权限：A 先把序号推到 5，再交错投 B 的序号 0→2（**恒小于 A 当前序号**），断言 B 到达
`done`、`droppedEnvelopes==0`、成本各归各、未读各归各。

**对拍**：把 `observeEnvelope` 里 per (sessionId,generation) 的闸门退化成一个全局单帧
（`shouldAcceptEnvelope(this.__global, env)`）：

```
基线（per-session 闸门）：Test Files 1 passed / Tests 17 passed
对拍（全局单帧）      ：× 两个活跃会话交错事件流 → AssertionError: expected 'idle' to be 'done'
                        （B 的序号 0/1/2 全被 A 的 5 判成「倒退」丢弃，B 停在 idle）
```

全局闸门下 B 的三条事件全被误判为序号倒退而丢，B 永远到不了 done——证明按会话隔离的闸门
是真门槛，不是恒真断言。还原后 17 条全绿。

其余可证伪判据（每条都做了「拆掉即红」的方向）：
- 资源上界：`liveCount` 少了 `!r.queued` 半句时，排队会话被算成在跑，三个会话全部准入
  （实测红：expected 2 to be 3）；
- 崩溃预算：预算内自动 launch / 超预算置 crashed 不再 launch，两个方向都断言；
- 空闲回收：`background→warm→stopped` 逐级 + running 永不回收；
- 权限 inbox：超时返回待拒办 + 从 inbox 移除 + 恢复列表态，**核心根本没有 allow 路径**
  （结构性保证「绝不自动允许」）；
- 渲染侧快照：序号回退的旧快照被丢弃、`droppedSnapshots` 计数、状态不回退。

---

## 4. 真机取证（`release/win-unpacked/PiBuddy.exe` + CDP）

`pnpm build` + `pnpm --filter @pibuddy/app dist` 后跑 win-unpacked，`--remote-debugging-port=9222`，
`scripts/cdp-eval.mjs`：

```
命名空间（19 个）：agentPool,artifacts,capabilities,diagnostics,dialog,file,mcp,memory,
   permission,pi,piResources,preview,providers,sessions,settings,shell,stt,update,workspace
agentPool 方法面：describe,focus,onSnapshot,setCaps,stop

describe() 初始快照：{seq:3, caps:{4/3/1600/20}, active:1, queued:0, sessions:1, inbox:0}
   → 池在真机上**纳入了当前正在跑的会话**（active:1）——supervisor 观测者接线生效
纳入会话视图：{active:1, runState:"focused", listState:"idle"}
setCaps 走通全五道闸并回读：{maxConcurrent:6,maxPerWorkspace:4,memoryCeilingMb:2000,costCeilingUsd:30}
订阅推送：focus(null) 触发 {protocolVersion:1, generation:1, sequence:5, hasCaps:true}
   → snapshot+sequence 订阅在真机上跑通（复用 PiEnvelope，generation 固定、sequence 单调）

向后兼容：settings.get() → "settings:get OK object"；pi.prompt / pi.events.onEvent 均为 function
```

**真机抓到并修掉一条单测没覆盖的边界**：首轮取证时纳入的会话被读成 `runState:"warm"`。
根因是刚握手、还没产生任何事件的会话 `lastActivityAt=0`，第一次维护 tick 就因「自纪元以来
一直空闲」把它回收成 warm。修复：`adoptRunning` 接一个 `now` 参数，空闲计时从**进程就绪
的这一刻**起（观测者传 `Date.now()`）。补了对拍用例「刚纳入的会话不会被第一次 tick 立即
回收」。重新 dist 后复核：`{active:1, runState:"focused", listState:"idle"}`——稳定为 focused。

**进程清理**：`powershell Stop-Process -Name PiBuddy,electron -Force` 后
`PiBuddy=0 / electron=0`（每轮各核对一次）。

**未在真机覆盖的**：2-3 个真实并发**后台**会话进程的非串台，因本批是单窗口单活跃会话模型、
后台进程派生是预留接缝（child 编排本批不做，ADR 明确边界）。多会话非串台在内核**单元级**
用真交错事件/成本/权限流 + 对拍严格证伪（§3）——那正是串台 bug 真正藏身的路由层。

---

## 5. 硬约束核对（命令与真实输出）

```
$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0        # 唯一 ipcMain.handle 出口仍是 ipc-guard；池的 4 条通道全经 registerHandler（走满五道闸）

$ rg -c 'invoke\(\s*channel\s*:\s*string' packages/app/src/preload | awk -F: '{s+=$2} END{print s+0}'
0        # 未向 preload 加无约束入口；agentPool 五个方法各对一条窄通道

$ rg -n 'zod' packages/contract/src/channels.ts        # 仅两处注释，channels.ts 仍不依赖 zod
$ node scripts/check-test-discovery.mjs                 # onDisk 112 / OK
$ node scripts/check-contract-uniqueness.mjs            # contract exports 489 / OK
$ node packages/app/scripts/check-pure-js-deps.mjs      # OK（83 包，无原生扩展）
$ node scripts/check-respond-ui-guard.mjs               # OK
$ node scripts/check-workflow-pins.mjs                  # OK
$ node packages/app/scripts/verify-packaged-app.mjs     # OK（pi-runtime 18486 文件一致）
```

- **序号单调性按通道判、代际全局判**：池快照走 `agent-pool:event` 自己的通道 + 固定
  generation=1，渲染侧用与 app store 同源的 `shouldAcceptEnvelope`；`droppedEnvelopes`
  在正常多会话转发下恒 0（对拍证明只有真陈旧帧才被计数）。
- **kernel 不 import pi 域**：`kernel-boundary.spec` 的 PI_IMPORT_ALLOWLIST **只减不增**——
  首版 `pool.ts` 误 import 了 `pi/pi-ipc`，被该判据当场抓红；改为依赖方向 pi → kernel
  （观测者形状在内核侧，pi-ipc 挂上），允许表一条未加。
- **logger 唯一 / 原子写**：池审计走 `log()`（kernel logger）；无落盘，资源上界活在内存。
- **每 session 资源上界**：`maxConcurrent/maxPerWorkspace/memoryCeilingMb/costCeilingUsd`
  四道，超界排队而非拒绝，防止一个用户开 100 个会话打爆机器。

---

## 6. 门禁总账

```
$ pnpm typecheck                       # contract / pi-sdk / app 三包全 Done
$ pnpm -w test                         # Test Files 112 passed / Tests 1026 passed
                                       #   基线 110 文件 1006 测试 → +2 文件（agent-pool-core / agent-pool-store）+20 测试
                                       #   无一条既有用例被改判（preload-api 仍 4 条，命名空间集合从 18 改 19）
$ pnpm build                           # ✓ 3135 modules transformed
$ pnpm --filter @pibuddy/app dist      # ✓ nsis PiBuddy-Setup-0.1.0.exe + win-unpacked
```

---

## 7. 本批发现、未做（留给后续）

1. **后台进程真实派生**：`PoolRuntimeHost.launch/stop` 是记账占位。supervisor 现按
   webContents/runtimeId 索引、单窗口单活跃 runtime；真派生 N 个后台 pi 进程需要 supervisor
   支持按 sessionId 独立起进程（与内存/成本实测挂钩）。内核的准入/回收/崩溃预算已就绪，
   host 补齐即可，无需再改 core。这是 child 编排落地时的第一步。
2. **权限 inbox 到引擎的闭环**：本批 inbox 只排队 + 超时**记审计**（`agent_pool_permission_
   timeout_denied`），未把超时/裁决接到 `decidePermission`。真实副作用（Git 包/连接器）落地
   时，超时经 `decidePermission(deny)` 收口，后台会话的权限请求由 supervisor 的 `ui_request`
   在非前台时路由进 inbox。核心已保证「绝不自动允许」（无 allow 路径）。
3. **AppShell 挂载点**：`AgentPool.vue` 是可用组件，但未挂进 AppShell 的具名 slot（避免碰
   `filesOpen` 那类横跨能力域的开关）。挂载留给 UI 集成批。
4. **stopSession 真停**：`agent-pool:stop` 记账 + 内核置 stopped；真正终止进程同 §1，随
   后台派生一起落地。
