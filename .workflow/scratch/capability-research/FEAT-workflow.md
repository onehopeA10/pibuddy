# FEAT-workflow：可视化工作流能力包（common.workflow）

对标 hermes-studio 的 Vue Flow 画布。**common tier，可关闭**。在**独立 worktree**
（`worktree-agent-a74b44ca487e54834`）里工作，提交到自己的分支，不 push origin/main。

依据：`docs/product/ADR-0002-capability-architecture.md`（四层边界 / D1~D5）、
`FIX-capability-core.md`（manifest / registry / drift / 结构性断言手法）、
`FEAT-agent-pool.md` + `child-orchestrator.ts`（Agent 节点触发 pi run 的既有机制）。

范围与既有收敛严格接续：**只加一个可关闭的 common 能力包，不改内核 / 池 / child-agent /
connector / git / memory / mcp / tasks / permission 的任何既有逻辑**。

---

## 1. 交付了什么

- **纯内核 DAG 执行器** `main/workflow/workflow-runner.ts`（不 import electron / pi）：
  Kahn 拓扑排序 + 成环检测；节点按依赖顺序执行；上游产出注入下游输入（节点间传数据）；
  条件分支按 true/false handle 路由（未命中分支跳过）；失败 / 跳过沿出边传播；运行中停止
  → 剩余节点跳过；单调快照序号。六种节点：start / end / input / output / agent / condition。
- **按 workspace 隔离持久化** `main/workflow/workflow-store.ts`：`node:sqlite` DatabaseSync，
  存 userData（不碰用户工作区），定义整份以 JSON 列存（可移植一等公民），行按 workspace_id
  分区，`PRAGMA user_version` schema 版本 + migrate()，运行历史按上界（20/工作区）裁剪。
- **IPC 接线层** `main/workflow/workflow-ipc.ts`：8 条通道 + 广播 + dispose。Agent 节点触发
  pi run 走 `poolAgentHost` —— 对后台会话池的**唯一调用点**，只用池 / host 的公开方法
  （`agentPool().requestSession/stopSession/snapshot`、`poolRuntimeHost().deliver`），
  **不改池 / child-agent 的任何文件**。
- **能力清单** `main/capability/manifests/workflow.manifest.ts`：`common.workflow`，8 通道 +
  1 推送，`permissions: []`（自身不碰 workspace 副作用，派生走内核池），teardown:["listener"]
  → `disposeWorkflowResources`（停活跃运行、摘广播、关 sqlite 句柄，**不删数据**）。
- **契约分片** `contract/src/workflow.ts`：节点 / 边 / 定义 / 运行快照 schema（全 `.strict()`），
  8 通道分片 + push payload。
- **preload** `preload/api/workflow.ts`：`window.piBuddy.workflow`（第 24 个命名空间）。
- **渲染侧**：`stores/workflow.ts`（snapshot+sequence 订阅，与 app store 并列、只读）+
  `components/WorkflowCanvas.vue`（Vue Flow 画布：加节点 / 连线 / 拖拽 / 选中编辑 / 运行态着色）+
  `components/WorkflowPanel.vue`（定义列表 / 保存 / 运行 / 停止 / 导出 / 导入 / 删除）。

### 新依赖

**`@vue-flow/core@^1.48.2`**（纯 JS 渲染库，`@vueuse/core` + d3-* 依赖，无原生扩展）。
过 `check-pure-js-deps`（89 包 OK）。只在 renderer 用，不进主进程。**lockfile 因此变更**
（`pnpm-lock.yaml` + `packages/app/package.json`，如实说明）。引前已 `check-pure-js-deps` 过闸。

---

## 2. 改了什么（按路径）

**新增**
```
packages/contract/src/workflow.ts                            契约 + 8 通道分片 + 运行快照 schema
packages/app/src/main/workflow/workflow-runner.ts            纯 DAG 执行内核（不 import electron / pi）
packages/app/src/main/workflow/workflow-store.ts             sqlite 落盘（按 workspace 分区 + schema 版本）
packages/app/src/main/workflow/workflow-ipc.ts               8 条通道 + 池调用点 + 广播 + dispose
packages/app/src/main/capability/manifests/workflow.manifest.ts
packages/app/src/preload/api/workflow.ts                     第 24 个命名空间
packages/app/src/renderer/src/stores/workflow.ts             渲染侧 snapshot+sequence 订阅
packages/app/src/renderer/src/components/WorkflowCanvas.vue  Vue Flow 画布
packages/app/src/renderer/src/components/WorkflowPanel.vue   工作流面板
packages/app/test/workflow-runner.spec.ts                   14 条（纯内核 + 对拍）
packages/app/test/workflow-store.spec.ts                     5 条（落盘 / 分区 / 上界）
```

**修改（我的独占 / 中央文件各自末尾追加，无覆盖）**
```
packages/contract/src/channels.ts        + workflow:* 8 条 + workflow:event 推送（追加在末尾）
packages/contract/src/ipc-contract.ts    + workflowContractShard（分片数组末尾）+ PUSH_CONTRACTS 一行
packages/contract/src/index.ts           + export workflow.js
packages/app/src/main/capability/capability-manifests.ts  + workflowCapability + 两个 Profile 各加一行
packages/app/src/main/capability/capability-catalog.ts    + register/dispose 一段
packages/app/src/preload/api/index.ts    + workflow 命名空间
packages/app/src/renderer/src/components/AppShell.vue     + 门控 / toggle / 挂载（四个具名 slot 一个没动）
packages/app/test/preload-api.spec.ts    命名空间集合 23 → 24
packages/app/package.json + pnpm-lock.yaml  + @vue-flow/core（lockfile 变更）
```

**未改**：`main/agent-pool/**`、`main/child-agent/**`、`main/connector|git|memory|mcp|tasks/**`、
`main/permission/**`、`main/ipc-registry.ts`（能力经 catalog 装配自动 activate，无写死注册）。

---

## 3. 对拍验证（临时拆掉机制确认变红，两次输出）

本项目铁律：DAG 判据必须**真的制造那个图**。核心用例 `workflow-runner.spec.ts` 交错投喂
真实菱形图（A→{B,C}→D）记录 host 调用顺序、真构造环、真跑条件分支。

**基线**：`workflow-runner.spec.ts` exit=0，14 passed。

| # | 拆掉的机制 | 结果 | 变红的用例 |
|---|---|---|---|
| M1 | `planWorkflow` 无条件返回 ok（拆成环检测） | RED，**3 条** | 成环被检测 / 自环 / 运行置 failed（`expected 'succeeded' to be 'failed'`） |
| M2 | 节点输入恒置空（拆节点间传数据） | RED，**3 条** | input→agent→output 产出传递 / 提示词模板收到上游产出 / 条件分支（依赖输入） |
| M3 | 条件节点所有出边都当活（拆分支路由） | RED，**2 条** | 命中→true 分支/false 跳过、未命中→false 分支/true 跳过 |

三次拆掉都精确打到对应判据，还原后 14 条全绿——证明这三条机制都是真门槛，不是恒真断言。

---

## 4. 真机取证（`release/win-unpacked/PiBuddy.exe` + CDP）

`pnpm --filter @pibuddy/app dist` 后跑 win-unpacked，`--remote-debugging-port`，`scripts/cdp-eval.mjs`：

```
命名空间（24 个）：…,tasks,update,workflow,workspace   ← workflow 就位
workflow 方法面：exportJson,importJson,list,onSnapshot,remove,run,runs,save,stop
capabilities.describe()：common.workflow enabled=true, permissions=[], profile=general, restart=false

两节点工作流（input"hello"→output，真机跑一次）：
{state:"succeeded", nodes:[{I:succeeded,out:"hello"},{O:succeeded,out:"hello"}]}
  → DAG 在打包应用里经 IPC 真跑通，节点间数据 hello 一路传到 output

成环（A→B→A）：{state:"failed", err:"工作流成环，无法执行：A → B → A"}   ← 真机成环检测
条件（input 非空 → non-empty）：{state:"succeeded", T:"succeeded", F:"skipped"}  ← 真机分支路由
导出→导入 roundtrip：importedNewId=true, importedNodes=4                       ← 可移植 JSON

持久化（按 workspace 隔离 sqlite）：4 个定义 + 3 条运行历史落 workflows.db；
  杀进程 → 重启 → list/runs 原样还在（定义 4、历史：条件 succeeded / 环 failed / 两节点 succeeded）
  → 跨重启durability 成立
```

**进程清理**：`powershell Stop-Process -Name PiBuddy,electron -Force` 后 `PiBuddy=0 / electron=0`
（两轮各核对一次）。

---

## 5. 硬约束核对（命令与真实输出）

```
$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0        # 8 条 workflow 通道全经 registerHandler（走满闸），唯一 ipcMain 出口仍是 ipc-guard
$ rg -c 'invoke\(\s*channel\s*:\s*string' packages/app/src/preload | awk -F: '{s+=$2} END{print s+0}'
0        # 未向 preload 加无约束入口；workflow 九个方法各对一条窄通道 / 一条推送
$ rg -n 'zod' packages/contract/src/channels.ts    # 仅两处注释，channels.ts 仍不依赖 zod
```

- **fs-atomic / logger 唯一**：本能力落盘走 sqlite（同 tasks / changeset / artifacts），未新增第二条
  原子写；审计走 `log()`（kernel logger）。
- **数据按 workspaceId 分区**：sqlite 行按 workspace_id 分区（realpathSync.native 防 8.3 短名的真实
  工作目录解析发生在 Agent 节点触发 pi run 时，复用池的 `requireWorkspaceRoot`，本能力不碰磁盘路径）。
- **permissions: []** 是**结构性**成立的：workflow 域源码不命中任何权限标记——sqlite 用 DatabaseSync
  （不是 fs），且刻意**不 mkdirSync**（userData 由 Electron 保证存在，与 tasks 同口径；建目录会命中
  workspace.write 标记而本能力根本不碰用户工作区）。drift-3 双向对账两个方向都过。
- **Agent 触发不重造**：`poolAgentHost` 用 `origin:"user"`（非 "child"）请求后台会话——child 的结构化
  事件 sink 只对 `origin:"child"` 触发且被 child 编排独占，用 "user" 与它彻底不相干，两条路互不串台。

---

## 6. 门禁总账

```
$ pnpm typecheck                       # contract / pi-sdk / app 三包全 Done
$ pnpm -w test                         # Test Files 127 passed / Tests 1151 passed
                                       #   基线 125 文件 1132 测试 → +2 文件（workflow-runner / workflow-store）
                                       #   +19 测试；无一条既有用例被改判（preload-api 命名空间集合 23 → 24）
$ pnpm --filter @pibuddy/app build     # ✓ 3165 modules transformed（含 vue-flow + d3）
$ pnpm --filter @pibuddy/app dist      # ✓ nsis PiBuddy-Setup-0.1.0.exe + win-unpacked
$ node scripts/check-test-discovery.mjs        # onDisk 127 / OK
$ node scripts/check-contract-uniqueness.mjs   # contract exports 707 / OK
$ node packages/app/scripts/check-pure-js-deps.mjs   # OK（89 包，含 @vue-flow/core，无原生扩展）
$ node scripts/check-workflow-pins.mjs         # OK
$ node scripts/check-respond-ui-guard.mjs      # OK
$ node packages/app/scripts/verify-packaged-app.mjs  # OK（pi-runtime 18462 文件一致）
```

capability-drift.spec（17 条）/ capability-registry / gate / profile / preload-api 全绿——
新能力逐条过 drift 五组对账（通道↔registerHandler↔契约分片、UI module/host 存在+引用+门控、
权限双向、teardown、catalog register+seal）。

---

## 7. 本批发现、未做（留给后续）

1. **Agent 节点产出的文本富化**。当前 `poolAgentHost` 通过轮询池快照的**列表态**（running→done/failed）
   判定 Agent 节点收口，池快照不暴露会话的**文本产出**，因此 Agent 节点的 output 目前为空占位。
   节点间传数据的机制在纯内核里已由 `workflow-runner.spec` 用真实产出证伪（input→agent→output 一路
   传通）；真机上 input/output/condition 节点的数据传递已跑通。Agent 节点产出富化需要一条「从后台
   会话取结构化产出」的接缝——与 child 编排的 `pibuddy_child_report` 结构化上报同构，但那条 sink 被
   child 独占（`origin:"child"`）。正确的接法是给池 host 加一个**按 origin 多播**的产出汇聚点（属池域
   改造，本批明确不碰池文件）。
2. **Agent 节点的就绪/完成靠轮询池快照**（250ms）。语义正确、公开方法、不改池；但不如事件驱动省。
   与 §1 同一条接缝一起升级即可。
3. **D5 的 slot registry 化未做**。WorkflowPanel 走 AppShell 现有的 toggle+面板模式（与 GitPanel /
   ChildAgentPanel 并列），四个具名 slot 一个没动——registry 驱动属第二阶段。
4. **画布布局不自动排布**。新增节点按简单偏移落位，用户手动拖拽；自动 layout（ELK 等）未纳入本批。
