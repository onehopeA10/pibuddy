# FEAT-session-tree：会话树 / 分叉可视化通用能力包（common.session-tree）

依据：`docs/product/ADR-0002-capability-architecture.md`（D1~D5）、
`.workflow/scratch/capability-research/FIX-capability-core.md`（registry / manifest / Profile / feature gate 的落地形态）。

补齐 M3 出口门禁 doc:329 明列却被裁剪的「分叉」能力——数据面（fork / clone /
get_tree / get_fork_messages / get_entries 的 pi RPC 与 IPC 通道）在 TASK-009 已
完整接入，本轮只补**可视化 UI + 能力包封装**。

---

## 1. 架构决策（关键，几经推翻）

### 1.1 树的数据源：会话 JSONL，而非 pi 的 get_tree

最初把 `session-tree:graph` 的 handler 写成「取 pi client → send get_tree → 归一化」，
`kernel-boundary.spec.ts` 当场变红 **2 条**：

```
× 除登记在案的三处外，没有内核模块依赖 pi 域
  → session-tree/session-tree-ipc.ts → ../pi/pi-ipc.js
× 登记表里的每一条都还真的存在（表只减不增）
```

那张 `PI_IMPORT_ALLOWLIST` **只减不增**（注释原文：「新增一条就等于新增一处内核对
pi runtime 的硬依赖，而 ADR-0002 的前提正是 pi runtime 必须可替换」）。一个 common
能力去 import pi 域是架构回退，不能加白名单。

改为**从持久化的会话 JSONL 重建树**：source/pi 明说会话是「append-only tree of
entries with stable ids」（rpc.md:694 起），每条 entry 的 `parentId` 就是树的边。
据 (workspaceId, sessionId) 反查 sourcePath、读文件、按 parentId 重建。由此：

- 不碰 pi 域 → kernel-boundary 干净（改后该 spec 6 条全绿）。
- 只用 `workspace.read`（读 JSONL）。
- 天然按 **workspaceId + sessionId 分区**（数据分区铁律，任务明确强调）。
- 当前叶子 = 文件里最后一条带 id 的 entry（append-only，末端恒在活动分支）。

### 1.2 为什么 session-tree 拥有一条真实通道，而非纯 UI

manifest schema **强制** `exposure {module, register}`，drift test 又据它对账
「register 注册的通道 == manifest.channels == 契约分片键」。纯 UI（channels 为空）
会退化成一个「注册了零条通道」的空壳 register + 空分片，是死代码。给它一条读 JSONL
的真通道，既满足模型，又让「能力未启用时通道不注册」这条 feature gate 有真实可测的
行为（对照 capability-gate.spec）。

### 1.3 fork / clone 走内核，不重复封装

fork / clone / get_fork_messages 是 pi runtime 的**内核动作**
（`window.piBuddy.pi.fork/clone/getForkMessages`，恒可用、可被扩展否决）。本能力
只画树，不重复内核已有的动作面。分叉是导航不是删除：pi 的树是 append-only，fork
只在某条历史 user 消息上新长一条分支，原分支一字节不动（get_tree 连废弃分支一起
返回），成功后只 `refresh()` 把两条分支都重画。

---

## 2. 交付物

**新增**

```
packages/contract/src/session-tree.ts                         SessionTreeGraph 类型 + 请求 schema + 契约分片
packages/app/src/main/session-tree/session-tree-graph.ts      纯归一化（JSONL 扁平 entry → 类型化树，带性能截断）
packages/app/src/main/session-tree/session-tree-graph.test.ts 8 条
packages/app/src/main/session-tree/session-tree-ipc.ts        session-tree:graph handler（读 JSONL，不碰 pi 域）
packages/app/src/main/capability/manifests/session-tree.manifest.ts  能力清单（独立文件）
packages/app/src/renderer/src/components/SessionTreePanel.vue 面板：SVG 树 + 布局 + 分叉/克隆控制
packages/app/src/renderer/src/components/SessionTreeNode.vue  单节点呈现（分类着色 / 分支点环 / 当前叶子 / 可分叉标记）
packages/app/src/renderer/src/stores/session-tree.ts          store：refresh / fork / clone / select
packages/app/src/renderer/src/stores/session-tree.test.ts     8 条
```

**修改（仅追加我这一份的行）**

```
packages/contract/src/channels.ts        + sessionTreeGraph 通道
packages/contract/src/index.ts           + export session-tree.js
packages/contract/src/ipc-contract.ts    + sessionTreeContractShard（import + 装入 CHANNEL_CONTRACT_SHARDS）
packages/app/src/main/capability/capability-catalog.ts   + 注册 sessionTreeCapability（activate=registerSessionTreeIpc，无 deactivate）
packages/app/src/main/capability/capability-manifests.ts + BUILT_IN 追加 + general/coding Profile 追加 session-tree（lite 不加）
packages/app/src/preload/api/sessions.ts + tree(workspaceId, sessionId)
packages/app/src/renderer/src/components/AppShell.vue    + 独立 sessionTreeOpen ref + 🌳 开关 + 面板挂载（不动 filesOpen/changesOpen）
packages/app/test/capability-drift.spec.ts    id 列表/通道数改为「派生 + 下界」以容纳并行追加的能力
packages/app/test/capability-gate.spec.ts     24 → `>= 24` 下界
packages/app/test/capability-profile.spec.ts  默认启用集改为「等于 general profile 声明」派生断言
packages/app/test/preload-api.spec.ts         sessions 覆盖测试补 tree() → sessionTreeGraph
```

**未新增任何运行时依赖。** 面板是纯 SVG + Vue。

---

## 3. 能力契约（ADR D4/D5）

| 字段 | 值 |
|---|---|
| id | `common.session-tree`（命名空间强制，装配期校验） |
| tier | `common` |
| permissions | `["workspace.read"]`（读 JSONL；不写、不开外部程序、不出站、不碰密钥） |
| channels | `[session-tree:graph]`（唯一一条；fork/clone 是内核通道，不在此声明，避免抢通道所有权） |
| uiContributions | `drawer.tab` / `common.session-tree.panel` → SessionTreePanel.vue，host=AppShell.vue |
| runtime | inline，无重依赖，teardown 空（不开 watcher/worker/子进程） |
| exposure | module=`main/session-tree/session-tree-ipc.ts`，register=`registerSessionTreeIpc`（无 dispose） |
| dataSchemaVersion | 0（无自有持久化数据） |

Profile：general / coding 各 +session-tree（默认开），lite 不加（feature gate 的可证伪对照组）。

---

## 4. 功能要求逐条落地

- **定位当前 leaf / 分支点 / compaction / 模型变化**：归一化把 entry 分成
  user/assistant/compaction/model-change/session/other；子节点 >1 标 `branchPoint`；
  末条 entry 标 `current`。
- **从任一历史 user message 分叉**：面板点选节点，若在 `get_fork_messages` 的权威
  可分叉集合里则亮「从此消息分叉」→ `pi.fork(entryId)`。
- **克隆当前分支**：头部「克隆当前分支」→ `pi.clone()`。
- **rewind/fork 不静默删原分支**：fork/clone 成功后仅 refresh，两条分支一起重画；
  归一化保留废弃分支（get_tree/JSONL 都含它们）。
- **走 pi RPC，检查 success 与 data.cancelled**：store 的 fork/clone 都**两层检查**
  （先 success 再 cancelled；扩展否决时 success 仍为 true）。
- **节点点击 = 导航到该 entry**：点选即在树里高亮（pi 无「跳到 entry」的 RPC，也不
  该有——非破坏性切分支的唯一手段是 fork）。
- **大树性能保护**：归一化在**数据出口**截断（`SESSION_TREE_NODE_CAP = 400`），且
  **保证活动分支（根→当前叶子）完整**，其余分支填到预算为止；`truncated`/`totalNodes`
  告知界面「还有多少未显示」。渲染侧节点数因此恒 ≤ 上限。

---

## 5. 可证伪测试 + 对拍验证（临时拆功能确认变红）

本项目反复抓到恒真断言，两条非平凡机制各做一次对拍。

### 对拍 A：性能截断的「活动分支必须完整」保证

测试特意把旁支写在主干节点**之前**（append order），使先序遍历先把预算花在旁支上，
主干深处只能靠「活动分支无视预算恒发」进来——否则该断言恒真。

拆掉保护（`if (!onActive && emitted >= CAP)` → `if (emitted >= CAP)`）后：

```
× 总数超上限时截断，且活动主干（根 → 当前叶子）完整保留
  → expected [ 'spine-7', false ] to deeply equal [ 'spine-7', true ]
Test Files 1 failed | Tests 1 failed | 7 passed
```

还原后 8/8 绿。证明该保证由 `onActive` 那一支承载，非恒真。

### 对拍 B：fork 的 `data.cancelled` 两层检查

拆掉 cancelled 分支后：

```
× 被扩展取消（success=true, cancelled=true）时不重拉、不报错，只给提示
  → expected '已从该消息分叉' to match /取消/
Test Files 1 failed | Tests 1 failed | 7 passed
```

还原后 8/8 绿。证明「扩展否决 ≠ 分叉成功」这条判据真的挡在路上。

---

## 6. 门禁实跑（我这一份）

```
$ pnpm typecheck
packages/pi-sdk typecheck: Done
packages/contract typecheck: Done
packages/app typecheck: Done                       ← 全绿

$ npx vitest run --project unit \
    session-tree-graph.test.ts session-tree.test.ts \
    capability-drift/gate/profile.spec.ts preload-api.spec.ts kernel-boundary.spec.ts
 Test Files  7 passed (7)
      Tests  61 passed (61)                         ← 含 kernel-boundary 6 条（pi 域 import 已移除）
```

硬约束核对：

```
$ rg -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0                                                   ← 守卫外命中数恒为 0

session-tree main 源码里的权限/拆卸 marker：只有 readFile(（对应 workspace.read），
  无 spawn/simpleGit/shell.openPath/safeFetch/readSecret/fs.watch/Worker/child_process
channels.ts：仍不 import zod（唯一命中是文件头注释）
```

---

## 7. 未完成 / 阻塞（并行多 agent 的共享资源冲突）

**提交与真机验证被并行 agent 阻塞，未完成。** 现象与依据：

1. **权限引擎 agent 在我工作期间提交了 `d89456a`**，其提交把我对 `channels.ts` /
   `index.ts` / `ipc-contract.ts` 的追加**一并扫进了它的提交**（`git show d89456a --
   channels.ts | grep sessionTreeGraph` = 1）。同一提交的 `ipc-contract.ts` 还
   import 了尚未提交的 `./memory.js` / `./mcp.js` / `./session-tree.js`——**HEAD 当前
   不自洽**（引用未入库文件），这是 memory/mcp/我三方的 contract 文件还没入库所致。

2. **git 索引（staging area）是被并行 agent 实时操作的共享资源**：某次 `git add` 我
   自己 10 个文件后，`git diff --cached --name-only` 里混进了权限 agent 已暂存的 19 个
   文件（permission-engine.ts / PermissionCenter.vue / App.vue / channels.ts …）。
   在共享索引 + 并发 `git add` 下，任何 `git commit` 都会把别人的在途工作卷进来——正是
   「编得过跑不过」的灾难。已 `git reset HEAD <我的文件>` 把我的文件退回未暂存，
   **未污染权限 agent 的暂存**，并**未提交**。

3. 因此**未跑全量 `pnpm -w test` / `build` / `dist` / 真机启动**：当前工作树混着三个
   agent 的在途改动、HEAD 不自洽，全量门禁测的不是我这一份；真机 `pnpm dist` 更会与
   其他 agent 的 dist 互删 `pi-runtime`（任务点 5 已警告）。

**我这一份的代码全部在磁盘上、typecheck 与 61 条单测 + 两条对拍已绿。** 待并行 agent
收敛、索引可独占后，按路径逐个 `git add`（禁 `-A`）即可入库；共享文件里
`capability-catalog.ts` / `capability-manifests.ts` 的追加与 memory/mcp 的行**逐行相邻**
（如 BUILT_IN 数组 `sessionTreeCapability, memoryCapability, mcpCapability` 三行连续），
`git add -p` 的 y/n/s 无法安全切分，需协调者串行化提交或做集成时逐行合并。

### 待集成时需并入共享文件的**我的行**（供协调者对账）

- `capability-catalog.ts`：`import { registerSessionTreeIpc } from "../session-tree/session-tree-ipc.js"`、
  `import { sessionTreeCapability } from "./manifests/session-tree.manifest.js"`，以及
  `capabilityRegistry.register({ manifest: sessionTreeCapability, activate: registerSessionTreeIpc })`（seal 之前，无 deactivate）。
- `capability-manifests.ts`：`import { sessionTreeCapability } ...`、BUILT_IN 追加
  `sessionTreeCapability`、general/coding 两个 Profile 的 capabilityIds 追加 `"common.session-tree"`。
- `channels.ts` / `index.ts` / `ipc-contract.ts`：我的行已随 d89456a 入库（见上）。
- `sessions.ts` / `AppShell.vue` / 4 个 capability spec：改动见 §2。
