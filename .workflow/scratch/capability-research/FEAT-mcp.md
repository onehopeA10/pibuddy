# FEAT-mcp：MCP 管理能力包（common.mcp）

依据：`docs/product/ADR-0002-capability-architecture.md`（D1~D5）、
`.workflow/scratch/capability-research/FIX-capability-core.md`（第一阶段 registry /
manifest / Profile / feature gate 落地形态）。补 TASK-012 里标为「本轮尚未实现」的 MCP。

三个并行 agent 之一（另两个：会话树可视化 `common.session-tree`、长期记忆
`common.memory`；实施期间还并入了第四个 `permission`）。全程共享同一棵工作树，
本文只记 MCP 这一片；对共享装配文件（channels / ipc-contract / capability 清单等）
只做**追加**，与其它包的追加并存。

---

## 0. 关键前置发现：pi 没有原生 MCP

落地前先核实 pi 侧真实形态（要求「不臆测」）：

```
$ grep -il mcp  <pi docs>/*.md            → 只有 usage.md 提到（无关）
$ grep -rn mcp <pi>/dist  --exclude node_modules → 无 MCP 配置概念
settings.md：settings.json 没有 mcpServers 键；extensions.md 不经 MCP
```

`resource-scanner.ts:832` 那句 `mcp:{implemented:false}` 说的就是这件事——**不存在
「pi 的 MCP 配置格式」可读**。因此 PiBuddy 显式采用 **MCP 生态事实标准形状**
（Claude Desktop / Cursor / VS Code 一致的 `{ "mcpServers": { name: {...} } }`），
落在与 pi 资源同层的两个文件，并在契约文件头写明这是 PiBuddy 自己的约定、不是猜
pi 的格式：

- user：`~/.pi/agent/mcp.json`
- project：`<workspace>/.pi/mcp.json`

## 1. 本轮范围（明确的边界，诚实标注未做的部分）

| 能力 | stdio | http / 远程 |
|---|---|---|
| 枚举（user+project、脱敏、活进程状态） | ✅ | ✅ |
| CRUD（save upsert / remove，先读再合并） | ✅ | ✅ |
| 连接测试（**真的连一次**：spawn + JSON-RPC 握手 + tools/list） | ✅ | ❌ 未实现，记入 risks |
| 启停（start 保活 + stop kill + teardown） | ✅ | ❌（http 无本地进程） |
| tool 列表 | ✅（握手时取回） | ❌ |
| OAuth 状态 | N/A | ⚠️ 仅从配置读「是否需要」并展示，**未驱动授权流程** |
| 错误诊断 | ✅（stderr / 超时 / 退出码，脱敏后回传） | ✅（回「未实现」诊断） |

stdio 是本地 MCP 的主流传输，且**不涉及任何网络请求**（换行分隔的 JSON-RPC 跑在
子进程管道上），因此天然满足「main 侧无出站 HTTP 调用」，也不需要 safeFetch。

## 2. 交付物（按路径）

**新增（MCP 独有，本 agent 完全拥有）**

```
packages/contract/src/mcp.ts                          契约 + 6 条通道的分片(id="mcp")
packages/app/src/main/mcp/mcp-config.ts               读写 mcp.json、脱敏、id 派生
packages/app/src/main/mcp/mcp-client.ts               stdio JSON-RPC 握手客户端（spawn）
packages/app/src/main/mcp/mcp-service.ts              编排 + 活进程登记 + teardown
packages/app/src/main/mcp/mcp-ipc.ts                  6 条通道 registerHandler + dispose
packages/app/src/main/capability/manifests/mcp.manifest.ts   能力清单
packages/app/src/preload/api/mcp.ts                   window.piBuddy.mcp（6 方法）
packages/app/src/renderer/src/stores/mcp.ts           渲染侧 store
packages/app/src/renderer/src/components/McpPanel.vue UI 面板
packages/app/test/mcp-client.spec.ts                  7 条（真机握手 + 可证伪）
packages/app/test/mcp-config.spec.ts                  10 条（解析 / 脱敏 / 合并）
packages/app/test/mcp-service.spec.ts                 6 条（生命周期 / teardown）
```

**追加（共享装配文件，只加不改既有行）**

```
packages/contract/src/channels.ts        + mcp:* 6 条
packages/contract/src/ipc-contract.ts    + mcpContractShard 进 CHANNEL_CONTRACT_SHARDS
packages/contract/src/index.ts           + export mcp.js
packages/app/src/main/capability/capability-manifests.ts  + mcpCapability 进 BUILT_IN + 两个 Profile
packages/app/src/main/capability/capability-catalog.ts    + register(mcpCapability, registerMcpIpc, disposeMcpResources)
packages/app/src/preload/api/index.ts    + mcp 命名空间
packages/app/src/renderer/src/components/PiResourcesPanel.vue  MCP「未实现」提示 → McpPanel（门控 isEnabled("common.mcp")）
packages/app/test/preload-api.spec.ts    命名空间集合 + mcp（同时补 memory / permission，见 §6）
```

**未新增任何运行时依赖。**

## 3. 能力契约要点（ADR D3/D4/D5）

- **id / tier**：`common.mcp`，tier=`common`。理由写在 manifest 头：MCP 是 Agent 的
  通用基础设施（一套把外部工具接进对话的协议），不绑定垂直领域、也不是单一服务的
  连接器，故归 common，与文件 / 预览 / 产物库并列。
- **permissions**：`["workspace.read","workspace.write","process.shell"]`。
  - read/write：读写 mcp.json 配置文件（drift 权限对账是双向的：源码里出现
    `readFile(` / `writeJsonAtomic(` 就必须申请，反之亦然）。
  - process.shell：stdio 连接测试 / 启动要 `spawn`。
  - **没有 `network:<domain>`**：本轮 stdio 不发网络请求，源码里一处 `safeFetch(`
    都没有；声明了却不用会撞上正向对账。见 §5 risks。
- **channels**：`mcp:list / save / remove / test / start / stop`（恰 6 条）。
- **uiContributions**：`settings.section` 槽，host=PiResourcesPanel.vue，
  module=McpPanel.vue（drift 2 的 grep 目标）。
- **runtime.teardown**：`["child-process"]`——start 后 main 持有活着的 stdio 子进程，
  disposeMcpResources 逐个 kill（D4 规则 4）；配置文件一个字节不动（规则 5）。
- **exposure**：module=`main/mcp/mcp-ipc.ts`，register=`registerMcpIpc`，
  dispose=`disposeMcpResources`（dispose 在 exposure.module 里落一个具名导出，不是
  re-export——re-export 不带 `export function` 特征，drift 4 扫不到）。
- **feature gate**：接进已建 CapabilityRegistry；未启用时 `registerMcpIpc` 一次都不调用
  → 通道不注册、UI 不渲染。lite Profile 是对照组（capability-gate.spec 覆盖）。

## 4. 逐条验证记录（命令 + 真实输出）

### 4.1 单元 / 集成测试（可证伪 + 对拍）

本项目反复抓到恒真断言，故连接测试用**真实子进程**而非打桩 spawn。

```
$ npx vitest run packages/app/test/mcp-client.spec.ts   → 7 passed
$ npx vitest run packages/app/test/mcp-config.spec.ts   → 10 passed
$ npx vitest run packages/app/test/mcp-service.spec.ts  → 6 passed
```

**「真的连一次」怎么真**：`mcp-client.spec` / `mcp-service.spec` 用
`process.execPath`（node 自己）跑一个真实的 stub MCP 服务器脚本，走完整
`initialize → notifications/initialized → tools/list` JSON-RPC 握手，断言拿到
serverInfo(`svc-stub 1.0.0` / `stub-mcp 9.9.9`)、protocolVersion(`2024-11-05`)、
真实工具列表。

**可证伪对照组**（拆掉「连上」这件事，确认变红→再确认判据非恒真）：

| 对照 | 结果 |
|---|---|
| 不应答的 stub（silent） | `probe.ok=false`，诊断含「超时」——证明「连接成功」不是恒真 |
| 启动即崩溃（exit 3） | `probe.ok=false`，诊断含退出码 |
| 命令为空 / 不存在的二进制 | `probe.ok=false`，不抛异常 |
| http 服务器 test | `ok=false` + 「http…未实现」诊断，不伪装成已连接 |
| **脱敏**：env 值 `super-secret` | `JSON.stringify(descriptor)` 里一个字都搜不到 |

start→list.running=true→stop→false→dispose 全部逐一断言（生命周期 + teardown）。

### 4.2 门禁（收尾全跑，共享树 4 agent 收敛后全绿）

```
$ pnpm typecheck
packages/pi-sdk typecheck: Done
packages/contract typecheck: Done
packages/app typecheck: Done

$ pnpm -w test
 Test Files  110 passed (110)            （含本片 3 文件 / 23 测试）

$ pnpm build         → ✓ main + preload + renderer 全部 built（3134 modules）
$ pnpm --filter @pibuddy/app dist
  • pi runtime deps copied files=18486
  • building target=nsis file=release\PiBuddy-Setup-0.1.0.exe archs=x64   ✓
```

drift / gate 共享 spec（被三个并行 agent 改成了「不锁总数、只锚核心 4 能力 + 无重复」
的容错形态）在本能力接入后仍全绿：

```
$ npx vitest run capability-drift.spec.ts   → 17 passed（drift 1-5 覆盖 common.mcp）
$ npx vitest run capability-gate.spec.ts    →  8 passed（lite 下 mcp 通道不注册）
```

### 4.3 硬约束（命令 + 真实输出）

```
$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0                                    # 全仓唯一注册点仍是 ipc-guard

$ rg --no-filename -c '\bfetch\(' packages/app/src/main -g '*.ts' -g '!**/net/outbound-guard.ts' | awk '{s+=$1} END{print s+0}'
0                                    # main 下守卫外 fetch( 恒 0（mcp 目录 0 命中）
                                     # 注：一度因注释里写了字面量 fetch( 命中 1，已改写注释

$ node scripts/check-contract-uniqueness.mjs → OK（460 exports，mcp.ts 无重名、无第二套契约）
$ node scripts/check-test-discovery.mjs      → OK（110 spec 全在发现范围）
```

- channels.ts 仍不依赖 zod（mcp 通道只是常量）；preload 只引 channels 子入口。
- 未向 preload 加 `invoke(channel,args)` 无约束入口：mcp 命名空间是 6 个具名窄方法，
  启停 / 测试收不透明服务器 id，spawn 只发生在主进程 mcp-client.ts。

### 4.4 真机启动验证（`release/win-unpacked/PiBuddy.exe`，CDP 取证）

```
$ ./PiBuddy.exe --remote-debugging-port=9222     → proc count=5，CDP up

CDP Runtime.evaluate(window.piBuddy)：
  namespaces 含 "mcp"（18 个命名空间，含并行的 memory / permission）
  window.piBuddy.mcp 方法：["list","remove","save","start","stop","test"]   ← 沙箱 .cjs preload 存活

  await window.piBuddy.mcp.list('__nope_ws__')：
    Error invoking remote method 'mcp:list': Error: WORKSPACE_UNKNOWN: __nope_ws__
  await window.piBuddy.mcp.test('__nope_ws__','deadbeef')：
    Error invoking remote method 'mcp:test': Error: WORKSPACE_UNKNOWN: __nope_ws__
```

**这就是「三门禁全绿但功能已死」那类回归的证伪点**：错误是
`WORKSPACE_UNKNOWN`（打到了真实的 mcp-service → mcp-config → requireWorkspaceRoot），
**不是** `No handler registered for 'mcp:list'`。证明打包后的
preload → ipc-guard → 已注册 handler → service 整条链在默认 general Profile 下真的
通了（feature gate 确实注册了这两条通道）。「实际 spawn 握手」那一段由 §4.1 的真实
子进程测试兜住——两处合起来覆盖了「连接测试真的连一次」的全链。

**进程清理**：`powershell Stop-Process -Name PiBuddy -Force` 后
`PiBuddy count=0` / `electron count=0`。

## 5. Risks（本轮明确未做的部分，如实记录，不伪装）

1. **http / 远程 MCP 的连接测试未实现**。根因是两条现实约束叠加：
   - `net/outbound-guard.ts` 的 safeFetch **仅放行 HTTPS 且阻断全部私网 / 环回**
     （SEC-004），而本地 MCP 常在 `http://localhost:PORT`——要支持须做**显式的
     local-network scope 放行**，那是对 SEC-004 安全策略的改动，超出本片干净边界，
     不应在此顺手放宽全局私网阻断。
   - 任意用户配置的远程主机**无法用 `network:<domain>` 表达**（`network:*` 通配被
     契约明令拒绝）。一个连接任意用户主机的能力，其网络权限声明需要 PermissionEngine
     落地后按 capabilityId 授权，那是 ADR D3 明确留给后续的部分。
   两条都落地后，再在 mcp-client 里加 http 传输 + 调 safeFetch，并同步给 manifest 补
   `network:<domain>` 权限（否则会撞正向对账）。当前 http 服务器可枚举、可编辑、
   连接测试回明确的「未实现」诊断。

2. **OAuth 授权流程未实现**。仅从配置读「是否需要 OAuth」并在列表 / 结果里展示，
   未发起任何授权。与 §5.1 同源（OAuth 是远程 HTTP MCP 的东西）。契约里有固定文案
   `MCP_OAUTH_NOT_IMPLEMENTED_NOTE`，界面照实写。

3. **Windows 上 `npx` / `.cmd` 类命令需要 shell 才能直接 spawn**。本实现坚持
   `spawn(shell:false)`（安全边界，挡 shell 注入），因此 `node` / 绝对路径命令可直接
   跑，而 `npx`（实为 `npx.cmd`）在 Windows 上 shell:false 找不到。彻底解决要么做
   `.cmd` 解析、要么等 PermissionEngine 的 process.shell 门就位后受控放开 shell——
   本轮不做。真机 / 测试用 `node <stub>` 验证。

4. **敏感 env 值目前明文存在用户自己的 mcp.json 里**（与 Claude Desktop / Cursor 的
   约定一致：env 直接写在配置文件）。PiBuddy 读它、spawn 时注入、**下发渲染进程时
   脱敏**（descriptor 只带键名）——但磁盘上仍是明文。把 env 值迁进 secret-store
   （加密落盘、按 slot 引用）是后续项；本轮明确不做，凭证「留 main」是通过「渲染进程
   拿不到值 + spawn 只在 main」实现的，不是通过加密存储。

5. **CRUD 的残余执行面**。save 由渲染进程给出 command/args（与 pi-resources 的 install
   同构），随后 start/test 会 spawn 它。`spawn(shell:false)` 挡住 shell 元字符注入，但
   「运行用户配置里的某个可执行文件」是 MCP stdio 的固有语义。彻底收口要靠
   PermissionEngine 的 `process.shell` 门（ADR D3 实测拦截点，本轮未做）。与
   pi-resources 跑 npm/git 是同一类残余面。

6. **project 作用域与 trust 未打通**。project mcp.json 的服务器目前不经 pi 的
   project-trust 判定就能被 start——pi-resources 那边 project 安装要先受信，MCP 这条
   本轮未接。后续应让 project 作用域的 start/test 也过一遍 `trust.effective==="allow"`。

## 6. 共享文件与并行 agent 的相互作用（提交前必读）

实施期间工作树被 4 个 agent 同时写（mcp / memory / session-tree / permission）。以下
共享文件里，本片的追加与其它 agent 的追加**并存于同一文件**：

```
channels.ts / ipc-contract.ts / index.ts（契约三件套）
capability-manifests.ts / capability-catalog.ts（能力装配）
preload/api/index.ts
preload-api.spec.ts（命名空间集合——本片补了 mcp，并顺带补了当时已在 api 里但 spec
                     还没列的 memory / permission，否则该 spec 会因别人的 in-flight 变红）
```

drift / gate / profile 三个 spec 被并行 agent 改成了「不锁总数」的容错形态，因此本片
新增能力**无需改动计数**，只要 manifest 合法 + 装配一致即可（已验证 17+8 全绿）。

**提交建议**：本片 MCP 独有文件（§2 第一块）可安全按路径 `git add`；共享文件（§2
第二块）因承载三方 in-flight 追加，需在四个 agent 都收敛后由协调方统一按路径提交，
避免把他人未完成工作并进本片 commit、或抢先固化他人本应自己提交的行。收尾时整棵树
已是 typecheck / test(110) / build / dist / 真机 全绿的一致状态。
