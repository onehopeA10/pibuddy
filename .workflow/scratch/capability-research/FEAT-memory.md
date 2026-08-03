# FEAT-memory：长期记忆 v1 通用能力包（common.memory / MEM-101 第一版）

依据：`docs/product/ADR-0002-capability-architecture.md`（D1~D5）、
`.workflow/scratch/capability-research/FIX-capability-core.md`（第一阶段落地形态）。

范围：用户**显式保存**的 memory + workspace/session FTS 检索 + 注入前记录命中项。
embeddings / 语义检索 / 自动抽取属第二阶段，本轮**不做**（如实入 deferred，见 §6）。

---

## 1. 交付物（按路径）

**新增（全部为本能力独占）**

```
packages/contract/src/memory.ts                              契约 + memoryContractShard（9 通道）
packages/app/src/main/memory/memory-store.ts                 SQLite + FTS5(trigram) + 注入开关 meta
packages/app/src/main/memory/memory-secret.ts                secret 拦截 / 敏感路径标记
packages/app/src/main/memory/memory-inject.ts                注入钩子 + 命中 cache（零成本门）
packages/app/src/main/memory/memory-evidence.ts              读会话原文（本能力唯一的 workspace.read）
packages/app/src/main/memory/memory-ipc.ts                   9 条通道 registerHandler + dispose
packages/app/src/main/capability/manifests/memory.manifest.ts  能力清单（独立文件）
packages/app/src/preload/api/memory.ts                       window.piBuddy.memory（9 方法）
packages/app/src/renderer/src/stores/memory.ts               渲染侧状态
packages/app/src/renderer/src/components/MemoryPanel.vue      保存/查看/编辑/合并/排除/删除/导出/证据/命中/开关注入
packages/app/test/memory-store.spec.ts                       15 用例
packages/app/test/memory-inject.spec.ts                       5 用例（含完整注入时序）
```

**修改（与另两个并行 agent 共用的协调点，逐条列出本轮追加的 hunk）**

```
packages/contract/src/channels.ts        + memory:* 9 条通道常量块
packages/contract/src/ipc-contract.ts    + import memoryContractShard；CHANNEL_CONTRACT_SHARDS 追加一项
packages/contract/src/index.ts           + export * from "./memory.js"
packages/app/src/main/capability/capability-manifests.ts  + import memoryCapability；BUILT_IN 追加；general/coding profile 追加 "common.memory"
packages/app/src/main/capability/capability-catalog.ts    + register(memoryCapability, registerMemoryIpc, disposeMemoryResources)
packages/app/src/main/pi/pi-ipc.ts        + 注入钩子（唯一内核接触点，见 §3）
packages/app/src/preload/api/index.ts     + memory 命名空间
packages/app/src/renderer/src/components/AppShell.vue  + 🧠 记忆 工具条按钮 + MemoryPanel 挂载（均经 isEnabled("common.memory") 门控）
```

**未新增任何运行时依赖**（node:sqlite 已在用；FTS5 trigram 在 Node 24 内置可用，已实测）。

**未触碰**（硬边界）：`components/SessionTree*.vue`、`stores/session-tree.ts`、`main/mcp/**`、`stores/piResources.ts`。

---

## 2. 数据模型与关键决策

**记忆记录**：`content / type(fact|preference|instruction|context) / scope(workspace|global) /
origin(user|inferred，本版恒 user) / confidence / sensitivity(normal|sensitive) / excluded /
sourceSessionId / sourceTurnId / created / updated / expiry`。

- **分区**（ADR D4 规则 3）：`workspace_id` 列即分区键，随记录保存；`scope` 单独控制注入资格。
  workspace_id 是已有的 `sha256(canonical realpath)`（不透明，不外发；record 视图里丢掉它）。
- **FTS**：`memories_fts` 用 `tokenize='trigram'` —— unicode61 会把整段中文当一个 token，搜「财务」命不中
  「给财务团队」；trigram 做子串匹配、中英一致。<3 字查询回落 LIKE。
- **注入开关**存在 db 的 `memory_meta` 表（不是独立 prefs 文件）：既避免多一处 fs 写标记，也让
  「关闭 workspace/all memory」与记忆数据同分区。缺省即启用。
- **模型推断的事实保留来源与置信度**：`origin` + `confidence` + `sourceSessionId/TurnId` + `memory:evidence`
  读回原文，用户能核对、能改、能删——本版只做用户显式保存（origin 恒 user），自动抽取留给后续。

**secret / 敏感 默认不进 memory**（`memory-secret.ts`）：
- secret（API key 前缀 / 私钥 PEM 头 / `password=` 赋值 / 高熵长串）→ **保存入口直接拒绝**，不落库；
  编辑成 secret 同样拒绝（不从编辑旁路进来）。
- 敏感路径（`.ssh/`、`id_rsa`、`.env`、`credentials`…）→ 落库但标 `sensitive`，**默认不注入、
  不进命中记录、不进日志**。

**删除覆盖 正文 + FTS + cache**：`store.delete/merge` 同时清 `memories` 与 `memories_fts`；
命中 cache（memory-inject 内存）由 IPC 层在 delete/merge 时 `clearHitsForMemory` 一并清。

---

## 3. 注入钩子怎么接的（唯一内核接触点）

现有 `main/pi/pi-ipc.ts` 的 `pi:prompt` handler 是干净的注入位：message 在此已拼好、`client.send` 之前。
追加一段**最小、可选、feature-gate 零成本**的注入：

```ts
if (isCapabilityEnabled(MEMORY_CAPABILITY_ID)) {
  const memoryRoot = loadSettings().workspace;
  if (memoryRoot) message = injectMemory(message, workspaceIdFor(memoryRoot));
}
```

- **零成本**：`isCapabilityEnabled` 是一次内存 Set 命中。未启用时立即为假，连 `loadSettings` 都不跑
  （loadSettings 每次读盘，不能放在门前）。`injectMemory` 内部再判一次门（纵深）+ 注入总开关 +
  抽词检索 + 落命中记录。未启用 = 这段等于不存在。
- 不重构 pi 流：只加这一处，未改 pi 的任何既有分支（附件拼接、streamingBehavior、images 原样保留）。
- 依赖方向代价：pi 域（非 kernel）新增了对 `capability-state` 与 `memory/` 的 import。pi 不是 kernel，
  不触发 `kernel-boundary.spec` 的「内核不得 import pi 域」判据（该判据当前的 2 条红是 session-tree agent
  的 `session-tree-ipc.ts → pi-ipc.js`，与本轮无关，见 §7）。

---

## 4. 可证伪测试 + 对拍验证（临时拆机制确认变红）

基线（本轮 4 个 spec 全绿）：`memory-store 15 + memory-inject 5 + capability-drift 17 + capability-gate 8 = 45 passed`。

**核心不是「delete 被调用过」，是一条完整时序**（`memory-inject.spec` 的「完整时序」用例）：
保存 → 命中注入（message 真被改写、命中记录真落下）→ 删除 → 再注入原样返回 → 命中记录里也没有它 → 检索零命中。

对拍（逐条拆源码 → 跑 spec → 还原，两次输出）：

| # | 拆掉的机制 | 结果 |
|---|---|---|
| M-A | `deleteInternal` 去掉 `DELETE FROM memories_fts` | RED：memory-store「删除后主表与 FTS 都零命中」失败（FTS 仍有行、再检索仍命中）。还原后 15 passed |
| M-B | `injectMemory` 去掉首行 `isCapabilityEnabled` 门 | RED：memory-inject「零成本门：能力未启用时原样返回」失败（关着也注入）。还原后 5 passed |
| M-C | `clearHitsForMemory` 改空操作 | RED：memory-inject「完整时序」失败（删除后命中记录仍含该 id）。还原后 5 passed |

三处均确认 RED 后还原，还原后复跑全绿（无对拍残留；`memory-inject.ts:9` 的「对拍」字样是文档注释）。

其它可证伪判据：secret 拒绝用「total 恒 0」（不是「标了敏感」）；敏感/排除/过期不进注入候选逐条验证；
global 作用域从别的工作区命中、workspace 作用域不命中（对照组）。

---

## 5. 真机启动验证（packaged，CDP 取证）

`pnpm build`（3129 modules ✓）→ `pnpm --filter @pibuddy/app dist`（DIST_EXIT=0）→
`packages/app/release/win-unpacked/PiBuddy.exe --remote-debugging-port=9222`。

```
window.piBuddy 命名空间含 "memory"；memory 方法 9 个：
  [delete, evidence, export, hits, merge, query, save, setInjection, update]

一整轮 IPC（workspaceId='cdp-mem-test'）：
  {"memEnabled":true,        ← common.memory 在 general profile 下真机启用
   "saveOk":true,
   "found":1,                ← FTS 检索在 packaged sqlite 里命中
   "injOn":true,
   "secretRejected":true,    ← sk- 前缀在真机被拒（total 未增）
   "delOk":true,
   "afterDelete":0}          ← 删除覆盖 FTS，再检索零命中

memory.db 落在 %APPDATA%\@pibuddy\app\memory.db（4096B）
  ← 打包后 userData 路径正确（session-index 曾因此类路径问题只在 packaged 红）

进程清理：Stop-Process -Name PiBuddy -Force → count=0
```

**真机抓到「单测绿但真机不同」的边界**：无——本轮的 packaged 专属风险面（sqlite 句柄、FTS5 可用性、
db 落盘路径、契约 seal、能力门在 packaged 下的启用集合）全部经上面这轮真机跑实。

**未能真机跑通的一环（如实记录）**：注入钩子的端到端触发需要一个**已配置模型的 live pi:prompt**，
本验证环境无可用模型，未能走一条真实 prompt。已用等价手段覆盖其 packaged 专属风险：
`memEnabled:true` 证明门在 packaged 下放行、`save/query` 证明 memoryStore 在 packaged 下可开可查，
注入逻辑本身由 §4 的完整时序单测 + 对拍钉死。端到端 prompt→注入待有模型的环境补跑。

---

## 6. 契约与能力包（ADR D4/D5）合规

- manifest：id `common.memory`（命名空间）、tier `common`、compatibility contract 1~1、
  permissions `["workspace.read"]`、9 channels、uiContribution `drawer.tab / MemoryPanel.vue / AppShell.vue`、
  dataSchemaVersion 1（表有代际 + `PRAGMA user_version` migrate）、teardown `["listener"]` + dispose、exposure 三段。
- **权限只申请不授予**：manifest 全链 `.strict()` + 授予黑名单扫描（继承既有机制）。
  只申请 `workspace.read`，其唯一实现是 `memory-evidence.ts` 的 `createReadStream`（读会话原文当证据）；
  导出只回文本、不经主进程写盘，故**不申请 workspace.write**（申请了没有对应写调用，drift-3 会红）。
- **drift test 自动纳入**：`capability-drift.spec`（17）已被并行 agent 泛化为「核心数据面 + 逐能力对账」，
  本轮 memory 被 BUILT_IN 自动带入并通过全部 5 组对账（register 导出 / 通道三方对账 / UI 模块存在且被门控 /
  权限双向 / teardown→dispose / catalog 逐条 register+seal / ipc-registry 无写死注册）。
- **feature gate**：未启用时 `registerMemoryIpc` 一次不调用（`capability-gate.spec` 的 lite profile 对照组），
  UI 不渲染（AppShell 门控），注入钩子零成本（§3 + 对拍 M-B）。
- deferred（如实）：embeddings / 语义检索、自动抽取（推断记忆）、注入命中的持久化历史（当前是内存 cache）。

---

## 7. 收尾门禁与提交状态（重要，含偏差）

**本能力的门禁**：
- 本轮 4 个 spec：45 passed。
- `pnpm build`：3129 modules ✓（esbuild，不受 vue-tsc 类型错影响）。
- `pnpm --filter @pibuddy/app dist`：exit 0；真机跑通（§5）。
- 本能力所有源码 tsc 干净（node 侧 tsc 在 session-tree 的 `.test.ts` 处中断，本能力文件在其之前无一报错；
  web 侧 vue-tsc 报错全部落在 `SessionTreeNode.vue / SessionTreePanel.vue`，无一条指向 memory）。

**全仓门禁当前非全绿——3 条红全部属另两个并行 agent，均在本能力硬边界之外，本轮不得触碰**：
1. `kernel-boundary.spec` ×2：`session-tree/session-tree-ipc.ts → ../pi/pi-ipc.js`（session-tree agent 的
   内核→pi 违规 + 其登记表未更新）。
2. `preload-api.spec` ×1：`preload/api/permission.ts` 有文件无对应 api key（permission 相关 agent 的接线未完成）。
3. `pnpm typecheck`：`session-tree-graph.test.ts` + `SessionTree*.vue` 的类型错（session-tree agent）。

**提交/推送状态（偏差，需上层裁决）**：本轮在**共享工作树**里与另两个 agent 同时改动。协调点文件
（`channels.ts / ipc-contract.ts / capability-manifests.ts / capability-catalog.ts / AppShell.vue /
preload/api/index.ts` 等）已同时承载三方 hunk，且 `AppShell.vue` 现已 import 兄弟 agent 的
`SessionTreePanel.vue`、`capability-catalog.ts` 现已 import `mcp-ipc / session-tree-ipc`。因此：

- 「只提交本能力文件」会得到一个**引用未提交兄弟文件、无法独立编译**的 commit；
- 「提交共享文件」会把兄弟 agent 的 hunk 卷进本次 commit（违反「严禁 -A/. 扫入他人改动」），且其中
  session-tree 侧代码当前门禁未过。

`git add -p` 交互式分块在本环境不可用，无法从共享文件里只挑本轮 hunk。因此**本轮不擅自 commit/push**：
一个自洽、可编译、门禁全绿的集成提交，必须等三方 agent 均完成、`git pull --rebase` 汇合、
session-tree 的 typecheck/kernel-boundary 修好之后再做。本能力的全部改动已就位于工作树、逐条列于 §1，
届时按路径提交即可干净落地。
