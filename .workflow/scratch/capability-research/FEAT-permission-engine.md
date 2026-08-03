# FEAT-permission-engine：PermissionEngine 决策逻辑（ADR-0002 D3 / SEC-003）

解锁 Git 编码包 / 连接器 / 后台池 / durable tasks 四块的总闸。本轮**只做
engine + 决策 + 审计 + 撤销 + 接线**，不接具体垂直能力——用已有的通道形态
（一条声明 `process.git` 的探针）验证 engine 真的能拦，并为将来的 `process.git`
预留清晰入口。

依据：`docs/product/ADR-0002-capability-architecture.md` D3/D4；
`FIX-capability-core.md` §5/§6（能力权限与 `permissionRules` 不是同一个轴，
必须给 `WorkspaceProfile` 加一张按 capabilityId 索引的**并列**授权表）。

---

## 1. 决策模型

- **拦截点在主进程**：`ipc-guard` 的**第五道闸**。renderer 被攻陷后也只能
  发 IPC，发到需求表里的通道就会被 engine 挡下——不是渲染层弹框就算数。
- **决策次序（默认拒绝）**：① 上界（请求的权限必须在该能力 manifest 的声明
  集合里，越不过去）→ ② once → ③ session → ④ workspace → ⑤ 拒绝。
- **四档**（SEC-003 原文）：deny / allow-once / allow-session / allow-workspace。
  只有 allow-workspace 落盘（跨重启）；once/session 活在主进程内存，重启即收回。
- **危险权限**（`process.git` / `process.shell` / `network:` / `secret:`）的持久化
  授权必须过一次**主进程原生确认框**（渲染进程伪造不了、绕不开），与
  `settings:set-pi-runtime` 同一口径。
- **审计 + 撤销**：每次授予/拒绝/撤销/拦截都经 `logger`（脱敏）落盘 + 环形缓冲；
  session 与 workspace 授权各可撤销。

### 为什么不接 `permissionRules`

`workspace-store.ts:57` 的 `permissionRules` 按 **channel** 索引（IPC 准入配额，
maxBytes/windowMs/maxPerWindow），能力权限按 **capabilityId** 索引，两边连键都
对不上（FIX-capability-core §5 的结论）。因此本轮给 `WorkspaceProfile` **新增
一张 `capabilityGrants` 表**，与 `permissionRules` **并列**，不复用它。

---

## 2. 改了什么（按路径）

**新增**

```
packages/contract/src/permission.ts                        决策契约 + 4 条通道分片
packages/app/src/main/permission/permission-engine.ts      纯决策引擎（不 import electron）
packages/app/src/main/permission/permission-store.ts       接线：磁盘 / 审计 / 原生框 / 需求表 / 第五道闸
packages/app/src/main/permission/permission-ipc.ts         4 条内核通道 + setPermissionGate
packages/app/src/preload/api/permission.ts                 window.piBuddy.permission（第 18 个命名空间）
packages/app/src/renderer/src/stores/permission.ts         渲染侧状态
packages/app/src/renderer/src/components/PermissionPrompt.vue   裁决弹窗（deny/once/session/workspace）
packages/app/src/renderer/src/components/PermissionCenter.vue   授权中心（列表 + 撤销 + 审计）
packages/app/test/permission-engine.spec.ts                9 条（纯引擎 + 互斥对拍）
packages/app/test/permission-gate.spec.ts                  7 条（真流水线 + 对拍 + 上界 + 原生框 + 向后兼容）
```

**修改（我的独占文件）**

```
packages/app/src/main/ipc-guard.ts        + 第五道闸（PermissionGate 注入点，1 行接入流水线）
packages/app/src/main/ipc-registry.ts     + registerPermissionIpc()（内核段，恒注册）
packages/app/src/main/workspace/workspace-store.ts  + capability_grants 列，schema v1→v2（ALTER 补列，不动既有数据）
packages/app/src/renderer/src/App.vue     + 挂 PermissionPrompt / PermissionCenter（避开 AppShell 四个具名 slot）
```

**修改（与三个并行 agent 共用的分片文件，各自追加，无覆盖）**

```
packages/contract/src/channels.ts         + permission:* 4 条
packages/contract/src/ipc-contract.ts     + permissionContractShard（分片数组追加一条）
packages/contract/src/index.ts            + export permission.js
packages/app/src/preload/api/index.ts     + permission 命名空间
```

**未新增任何运行时依赖。**

### 第五道闸的向后兼容（铁律）

`CHANNEL_PERMISSION_REQUIREMENTS` **本轮只有探针一条**：任何现有通道都不在表里，
因此第五道闸对它们一律「无适用规则 → 放行」，现有全部通道行为**一字不变**。
前四道闸（主 frame → zod → 尺寸 → 限流）的签名与既有逻辑一行未动，第五道闸是
`rateLimiter.check` 之后追加的一行 `permissionGate?.(channel, payload)`，默认不装
（`setPermissionGate` 由 permission-ipc 在装配期调用）。

---

## 3. 对拍验证（临时拆掉决策逻辑，确认变红）

### 3.1 单测对拍（`permission-gate.spec.ts` 内置）

`permission-gate.spec.ts` 把探针通道**穿过 registerHandler 的完整五道闸**跑：

| 场景 | 结果 |
|---|---|
| 未授权 → probe | **抛 IPC_PERMISSION_DENIED**（第五道闸挡在 handler 之外） |
| **对拍：`setPermissionGate(null)` 后同一次未授权调用** | **变为放行 `{ok:true}`** —— 证明这道闸是真门槛，不是走过场 |
| 装回闸 → 同一调用 | 又变回拒绝 |
| allow-session 后 → probe | 放行；撤销后 → 又拒绝（互斥） |
| 越过 manifest 上界的 allow-session | 不产生任何授权 + 审计记 denied |
| 危险权限 allow-workspace，原生框取消 | 不落盘 |
| 危险权限 allow-workspace，原生框通过 | 落盘 + 该 workspace 上下文的探针放行 |
| 现有通道（settings:get / workspace:file-save / pi:prompt） | gateForChannel 一律不抛（无适用规则） |

`permission-engine.spec.ts` 的核心是**互斥对拍**：同一条 query，无授权**必拒**、
有授权**必放行**；上界那条也做了双向（未声明 → 给了授权也拒；补上声明 → 同一
授权立刻生效）——两个方向缺一个，另一个就可能恒真。

实跑：

```
$ npx vitest run packages/app/test/permission-engine.spec.ts packages/app/test/permission-gate.spec.ts
 Test Files  2 passed (2)
      Tests  16 passed (16)
```

### 3.2 全量门禁

```
$ pnpm typecheck
packages/contract typecheck: Done
packages/pi-sdk  typecheck: Done
packages/app     typecheck: 仅 session-tree/*（并行 agent 的在途改动，非本轮）报错；
                            本轮 permission 相关文件零报错

$ pnpm -w test
 Test Files  1 failed | 109 passed (110)      ← 唯一失败是 session-tree-graph.test.ts（并行 agent 在途，非本轮）
      Tests  6 failed | 999 passed (1005)       ← 我的 16 条全绿；perf 门禁在另一次运行里通过（墙钟抖动）

$ pnpm build
✓ built（out/main + out/preload 38.60kB + 3134 renderer modules，含 permission 全链路）
```

> 说明：`session-tree/*` 的 6 条失败与 8 条 TS 报错来自并行的会话树 agent 改了
> `buildSessionTreeGraph` 签名而其 test/ipc 还在用旧调用形态——属其在途工作，
> 硬边界内不得触碰。我的改动全绿。

---

## 4. 真机取证（`release/win-unpacked/PiBuddy.exe` + CDP，拒绝/放行互斥）

打包产物已含本轮代码（CDP 实测 `typeof window.piBuddy.permission.probe === "function"`）。
逐条 `scripts/cdp-eval-main.mjs`（连主窗口 target）：

```
A. 未授权 → probe
   "DENIED: permission:probe 无适用授权：kernel.git-probe / process.git"

B. decide allow-session(kernel.git-probe/process.git) → probe
   "ALLOWED:{"ok":true}"

C. revoke session → probe
   "DENIED_AGAIN"                                  ← 互斥闭环

D. describe().audit（末 4 条）
   [["blocked",null,"无适用授权：kern"],
    ["granted","allow-session",null],
    ["revoked",null,"session ×1"],
    ["blocked",null,"无适用授权：kern"]]

向后兼容：window.piBuddy.settings.get() → "settings:get OK (object)"   ← 现有通道未被第五道闸影响
命名空间（18 个）：artifacts,capabilities,diagnostics,dialog,file,mcp,memory,
   permission,pi,piResources,preview,providers,sessions,settings,shell,stt,update,workspace
```

A / B / C 就是那对**「拒绝 → 授权 → 放行 → 撤销 → 再拒绝」的真机互斥证据**，
且不是靠架构图推断——探针穿过真实 `ipcMain.handle` → 五道闸 → handler 的全链路，
第五道闸在 handler 之前就把未授权调用抛掉了。

**进程清理**：`Stop-Process -Name PiBuddy -Force` 后 `Get-Process PiBuddy,electron`
返回 0（`pkill -f electron` 本机无效，已按铁律用 powershell）。

> 取证时机：win-unpacked 由并行 agent 在 23:09 打包（其 electron-vite build 从
> 含本轮改动的 out/ 出，故含 permission 全链路）。首轮取证到 A/B/C 前三步时并行
> agent 关掉了它的实例；随后我自行重启同一 win-unpacked（确认无其它 PiBuddy 在跑）
> 补齐了 C/D 与向后兼容，全程未 kill 他人进程。

---

## 5. 硬约束核对

```
$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0        # 唯一 ipcMain.handle 出口仍是 ipc-guard；permission 的 4 条通道全经 registerHandler
```

- **前四道闸未改**：第五道闸是 `rateLimiter.check` 后追加的一行调用 + 一个注入点；
  默认不装时行为与从前一字不差。
- **contract 分层**：`channels.ts` 不依赖 zod（permission 通道名是纯字符串常量）；
  preload 的 `api/permission.ts` 只从 `@pibuddy/contract/channels` 引通道名。
- **原子写 / logger 唯一**：workspace 授权走 `workspace-store` 的 sqlite（既有原子路径）；
  审计走 `createLogger("permission")`（脱敏）。
- **不向 preload 加 `invoke(channel,args)` 无约束入口**：permission 四个方法各对一条窄通道。
- **数据保留（D4 规则 4/5）**：schema v1→v2 用 ALTER ADD COLUMN 补 `capability_grants`，
  既有 workspaces.db 一个字节不动。

---

## 6. 将来接 process.git 的入口

需求表 `CHANNEL_PERMISSION_REQUIREMENTS`（permission-store.ts）现在只映射探针一条。
Git 包落地时：给它的通道在这张表里加一行 `{capabilityId, permission}`，能力 manifest
声明 `process.git`，engine 的上界校验与第五道闸的拦截**自动生效**，无需再动 ipc-guard。
探针用的保留 id `kernel.git-probe` 到时可退役（或保留作回归探针）。

---

## 7. 本轮发现、未修（留给后续）

1. **once/session 授权由渲染进程经 `permission:decide` 记录**：这是「渲染进程收集
   用户选择」的口径，与 `changeset:accept` 同构（渲染可触发、主进程按 id/上界收口）。
   真正 compromise-proof 的两条是**拦截在主进程**（第五道闸）+ **上界卡在 manifest**
   （越不过已启用能力声明的权限）。危险权限的**持久化**已加原生确认框；once/session
   的危险权限确认待 Git 包落地时按需收紧（届时有真实副作用可依）。
2. **探针通道随包出厂**：它是本轮唯一「可穿过五道闸的真实 gated 通道」，是拦截点
   可证伪的代价。handler 只返回 `{ok:true}`，无任何真实副作用。
3. **UI 为最小可用版**：弹窗 + 授权中心 + 撤销 + 审计流水，未做完整权限中心
   （按能力分组、批量、搜索）。
