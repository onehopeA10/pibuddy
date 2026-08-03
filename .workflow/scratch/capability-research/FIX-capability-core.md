# 能力包架构第一阶段主体：CapabilityManifest + CapabilityRegistry + AgentProfile + feature gate

依据：`docs/product/ADR-0002-capability-architecture.md`（D1~D5 与实施顺序）。
调研：`explore-plugin-arch.json`（CodePilot / PiDeck 两个参考实现）、`explore-current-inventory.json`（现有能力盘点）。

范围与上一次收敛（`FIX-decouple-log-contracts.md`：log 搬到 kernel + 契约分片）严格接续：
本轮**只做机制，不拆包**。四个 common 域仍在原地运行，只是各自多了一份 manifest 并接进注册表。

---

## 1. 交付物

### 1.1 `CapabilityManifest` 契约 —— `packages/contract/src/capability.ts`（新增，480 行）

字段全集（`capabilityManifestSchema`，全链路 `.strict()`）：

| 字段 | 说明 |
|---|---|
| `manifestVersion` | manifest 结构自身的代际 |
| `id` | `<namespace>.<name>`，正则强制 |
| `version` | `x.y.z` |
| `tier` | `common` / `vertical` / `connector` —— **没有 kernel**（内核不可关闭，见 §4.1） |
| `compatibility` | `{appMin, appBelow?, contractMin, contractMax}` |
| `dependencies` | capabilityId 数组 |
| `permissions` | ADR D3 枚举，**只有申请** |
| `channels` / `pushChannels` | 该能力注册的通道 |
| `tools` | `{name, description, permissions}`，name 强制 capabilityId 前缀 |
| `uiContributions` | `{slot, id, title, module, host}`，slot 是 D5 十个固定插槽的枚举 |
| `settingsSchema` | `{key, type, description, options?}`，key 强制前缀 |
| `dataSchemaVersion` | 该能力自有数据的代际 |
| `runtime` | `{loading, entry?, bundleBudgetKb?, heavyDependencies, teardown}` |
| `exposure` | `{module, register, dispose?}` —— drift test 的 grep 目标 |

**`runtime` 段如何落地 D2**（能力包可携带重依赖，前提是懒加载 + 有预算）：
`validateCapabilityManifest` 强制三条，不靠人自觉——

- `heavyDependencies` 非空 ⇒ `loading` 必须是 `lazy`（未启用不得进包）
- `heavyDependencies` 非空 ⇒ `bundleBudgetKb` 必填（允许重依赖 ≠ 允许无上界）
- `loading: "lazy"` ⇒ `entry` 必填；`loading: "inline"` ⇒ `entry` 必须缺席

编码包日后引入 monaco-editor 时长什么样，已经用合成 manifest 钉在
`capability-registry.spec.ts`「lazy + entry + 预算 → 通过」那条用例里。

**`permissions` 用 ADR D3 枚举**，且 manifest 里**没有任何形式的「已授予」**。
两道结构性手段：

1. `capabilityManifestSchema` 全链路 `.strict()` —— 多一个键直接抛错；
2. `CAPABILITY_GRANT_FORBIDDEN_KEYS`（granted / grants / grant / grantedPermissions /
   autoGrant / permissionsGranted / approved / authorized）**递归扫描整份 manifest**。

第 2 条不是第 1 条的冗余：strict 只能挡住已知形状上的多余键，日后给 `runtime` 加一段
`runtime.grants` 会在 schema 演进时被顺手放行。对拍 M12 证实了这一点（见 §3）。

权限参数形态也收紧：`network:*` 这种通配**不接受**——一条通配等于「任意出站」，
而 main 侧唯一出站原语 `net/outbound-guard.ts` 的全部意义就是不存在这种东西。

### 1.2 `CapabilityRegistry` —— `packages/app/src/main/capability/capability-registry.ts`（新增）

- **重复 id 抛错 + seal**（依据 CodePilot `registry.ts:13-28`）。对拍 M10 验证：把抛错改回
  静默覆盖，`capability-registry.spec.ts` 立刻红两条（其中一条专门断言「表里留下的是第一个」）。
- **通道所有权**：两个能力抢同一条通道也抛错，并报出是哪两个。契约分片那层
  （`mergeChannelContracts`）已经守了一条路，能力 manifest 是第二条路，两条必须同样地拒绝。
- **依赖解析**（`resolve()`）四类拒绝，每类给可读原因，**不静默降级**：
  1. 请求了没注册的 id；2. 兼容区间不符；3. 依赖未被请求 / 依赖自己也被拒；4. 依赖成环。
  第 3 类**迭代到不动点**：A 依赖 B、B 因版本不符被拒，A 也必须被拒——少了这一轮的
  表现是 A 被启用、跑到某个用得着 B 的路径上才炸，那正是静默降级的典型形态。
- **命名空间强制**在 `register()` 里（装配期），不合法的 manifest 进不了表。
- 本文件**不 import electron**：gate 会被 `tool-watch.ts` 这种热路径模块引用，拖进 electron
  等于让每个引用它的单测都必须打桩，而需要打桩才能跑的判据最后都会变成没人跑的判据。

### 1.3 `AgentProfile` —— `capability-manifests.ts`

三条：`general`（通用办公，四个全开，默认）/ `coding`（编码）/ `lite`（精简，一个都不开）。

**现阶段 coding 与 general 的能力集相同**，因为垂直包一个都还不存在（D1 第一阶段只做机制）。
没有把它们合并成一条：合并之后「切 Profile」在第一阶段就没有任何可验证的行为，而它正是
这次要立起来的机制。`lite` 是让机制可证伪的那条——「未启用 = 通道不注册」因此有了对照组。

用户可在 Profile 之上逐个开关（`overrides`）。两者分开存：换 Profile 不该抹掉用户对某个
能力的明确意见，合并成一个集合存的话，换一次 Profile 就把那些意见全丢了。

### 1.4 feature gate —— 四处闸门

| 闸门 | 位置 | 未启用时的效果 |
|---|---|---|
| 通道 | `ipc-registry.ts` 下半段按 `resolution.enabled` 调 `activate()` | `registerHandler` 一次都不调用 → `registeredChannels()` 里没有它的通道 |
| UI | `AppShell.vue` 四个 `computed(() => capabilities.isEnabled(...))` | 面板与开关按钮不渲染 |
| listener（审阅） | `tool-watch.ts` 的 `pending.set` 前 | 不抓 before 快照（那是按文件大小增长的内存） |
| listener（产物） | `artifact-tracker.ts` 的 `trackToolStart` 首行 | 不插 generating 记录；`trackToolEnd` 因 inflight 为空自然空转 |

**已有数据保留**（D4 规则 4 / 5）：四个 `dispose*` 只收「还在跑 / 还占着内存」的东西——
watcher、搜索子进程、预览窗口、在途快照表、sqlite 句柄。`changesets.db` / `artifacts.db` /
磁盘上的产物文件**一个字节都不动**。真机验证见 §4.3。

新增 3 条内核通道 `capabilities:describe` / `set-profile` / `set-enabled`，
preload 新增 `window.piBuddy.capabilities` 命名空间（第 15 个）。三条恒注册、不受能力开关
影响——否则「把能力全关掉」会连带关掉那个用来把它们重新打开的入口。

三条通道的入参里**没有 manifest**：能力集合由注册表在装配期封口，渲染进程只能在一张
已经定死的表上挑一个 id。这也是 D4 规则 1 的落地：三个方法各自对应一条窄通道，没有
`invoke(channel, args)` 那种无约束入口（全仓命中数 0，见 §4.1）。

### 1.5 drift test —— `packages/app/test/capability-drift.spec.ts`（17 条）

仿 CodePilot `capability-contract.ts:178-217`：每条能力钉住暴露点的模块路径与符号名，
断言用 grep 写。五组对账：

| 组 | 对账内容 | 抓什么 |
|---|---|---|
| 前置 | 清单集合非空、每份都有通道/权限/UI 贡献、合起来恰 24 条通道 | **防止数据集为空导致后面全部空洞通过** |
| drift 1 | manifest.channels ↔ `registerHandler(CHANNELS.x)` 实际注册 ↔ 契约分片键集合 | 声明的通道与实际注册的不一致 |
| drift 2 | uiContribution.module/host 存在 + host 里真的引用了它 + 至少一个 host 对该能力做了门控 | 声明的 UI slot 与实际贡献的不一致 |
| drift 3 | 权限 ↔ 源码标记，**双向** | 声明的权限与实际请求的不一致（两个方向） |
| drift 4 | teardown ↔ 子进程/worker/watcher 标记；teardown 非空 ⇒ dispose 是真实导出 | 声明拆卸却没有拆卸入口 |
| drift 5 | catalog 逐条 register 且 seal；ipc-registry 里**没有**任何写死的能力注册调用 | 给 gate 开后门 |

权限标记表每条都带 `\(`：要的是**一次调用**，不是一次提及。源码在扫描前先去注释——
不去的话，一句「本域没有 shell.openPath(」的注释会被判成一次调用，对账就变成了
「注释里有没有提到过它」，比没有还糟。

---

## 2. 改了什么（按路径）

**新增**

```
packages/contract/src/capability.ts                       契约 + 3 条通道的分片
packages/app/src/main/capability/capability-registry.ts   注册表（纯，不 import electron）
packages/app/src/main/capability/capability-state.ts      装配结果的运行期读取面（纯）
packages/app/src/main/capability/capability-prefs.ts      capability-prefs.json 落盘
packages/app/src/main/capability/capability-manifests.ts  清单聚合 + Profile（纯）
packages/app/src/main/capability/capability-catalog.ts    装配（manifest ↔ register/dispose）+ seal
packages/app/src/main/capability/capability-ipc.ts        3 条内核通道
packages/app/src/main/workspace/workspace-files.capability.ts
packages/app/src/main/changeset/workspace-review.capability.ts
packages/app/src/main/preview/preview.capability.ts
packages/app/src/main/artifacts/artifacts.capability.ts
packages/app/src/preload/api/capabilities.ts
packages/app/src/renderer/src/stores/capabilities.ts
packages/app/test/capability-drift.spec.ts        17 条
packages/app/test/capability-registry.spec.ts     26 条
packages/app/test/capability-gate.spec.ts          8 条
packages/app/test/capability-profile.spec.ts      10 条
```

**修改**

```
packages/contract/src/channels.ts        + capabilities:* 3 条
packages/contract/src/ipc-contract.ts    + capabilitiesContractShard（第 14 个分片）；导出 CHANNEL_CONTRACT_SHARDS
packages/contract/src/index.ts           + export capability.js
packages/app/src/main/ipc-registry.ts    拆成「内核写死 / 能力按启用集合装」两段
packages/app/src/main/changeset/tool-watch.ts        + 快照门控 + disposeToolWatch
packages/app/src/main/changeset/changeset-ipc.ts     + disposeChangesetResources
packages/app/src/main/artifacts/artifact-tracker.ts  + 跟踪门控 + disposeArtifactTracking
packages/app/src/main/artifacts/artifact-ipc.ts      + disposeArtifactResources
packages/app/src/main/preview/preview-ipc.ts         + disposePreviewResources
packages/app/src/preload/api/index.ts    + capabilities 命名空间
packages/app/src/renderer/src/components/AppShell.vue  4 个能力门控（四个具名 slot 一个没动）
packages/app/test/preload-api.spec.ts    命名空间集合 14 → 15
```

**未新增任何运行时依赖。**

---

## 3. 对拍验证（临时拆掉机制，确认变红）

本项目多次抓到恒真断言，因此每条判据都做了对拍。脚本逐条改源码 → 跑对应 spec → 还原。

**基线**（三个 spec 全绿，0 失败）：

```
packages/app/test/capability-drift.spec.ts:    exit=0 失败用例=0
packages/app/test/capability-gate.spec.ts:     exit=0 失败用例=0
packages/app/test/capability-registry.spec.ts: exit=0 失败用例=0
```

**对拍结果**（15 条，全部变红）：

| # | 拆掉的机制 | 结果 | 变红的用例 |
|---|---|---|---|
| M1 | 删掉 manifest 里一条通道声明 | RED exit=1，3 条 | 24 条覆盖 / registerHandler 对账 / 契约分片对账 |
| M2 | 删掉一个真实的 `registerHandler` 注册（契约分片不动） | RED exit=1，**1 条** | 只有 registerHandler 对账 —— 证明两条轴独立，不是同一个判据抄了两遍 |
| M3 | UI 贡献指向不存在的组件 | RED exit=1，2 条 | 模块存在 / 宿主引用 |
| M4 | 拿掉 AppShell 里对产物库的门控 | RED exit=1，1 条 | 「至少一个宿主做了门控」 |
| M5 | 多申请一条实际没用到的权限 | RED exit=1，1 条 | 权限对账·正向 |
| M6 | 代码里偷加一次 `shell.openPath(` 而不申报 | RED exit=1，1 条 | 权限对账·反向（安全判据的那一半） |
| M7 | 拿掉 teardown 里的 `watcher` 声明 | RED exit=1，1 条 | 拆卸项对账 |
| M8 | 在 ipc-registry 里给能力开后门（写死注册） | RED exit=1，1 条 | 「没有写死注册调用」 |
| M9 | 拆掉 feature gate：不管启用集合全部 activate | RED exit=1，2 条 | 24 条通道不在注册表 / ipcMain 侧也没被绑过 |
| M10 | 重复 id 的抛错改回静默覆盖 | RED exit=1，2 条 | 抛错 / 「留下的是第一个」 |
| M11 | 校验不再强制命名空间前缀 | RED exit=1，1 条 | 工具名缺前缀 |
| M12 | 去掉授予语义的黑名单扫描 | RED exit=1，1 条 | 嵌套里的授予字段被点名 |
| M13 | describe 改回读装配期缓存（重现 §4.2 的真机缺陷） | RED exit=1，4 条 | Profile 回读 / restartRequired / 单个开关回读 |
| M14 | 依赖不满足时静默放行 | RED exit=1，1 条 | 依赖被拒的传导 |
| M15 | 换 Profile 时不清 overrides | RED exit=1，1 条 | overrides 清空 |

M2 是这一批里最要紧的一条：它只让**一条**用例红，说明「registerHandler 实际注册」与
「契约分片声明」是两条真正独立的轴，而不是同一份数据被读了两遍。

### drift test 自身的恒真风险

数据驱动断言最容易失效的方式是数据集为空。第一组用例专门钉这个：
清单恰四条、每条都有通道/权限/UI 贡献、合起来恰 24 条通道。M1 会同时打到这一组。

---

## 4. 逐条验证记录

### 4.1 硬约束（命令与真实输出）

```
$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0

$ rg -n '\bfetch\(' packages/app/src/main -g '*.ts'
packages/app/src/main/net/outbound-guard.ts:6    （注释）
packages/app/src/main/net/outbound-guard.ts:89
packages/app/src/main/net/outbound-guard.ts:98
→ 守卫外命中数 0；HEAD 基线同样是这 3 条（全在守卫内），未变

$ rg -c 'invoke\(\s*channel\s*:\s*string' packages/app/src/preload | awk -F: '{s+=$2} END{print s+0}'
0        # 未向 preload 增加无约束入口（D4 规则 1）

$ grep -n zod packages/contract/src/channels.ts
2: * IPC 通道名常量 —— **本文件刻意不 import zod**。
8: * zod 打进 preload …
→ 两处都是注释，channels.ts 仍是不依赖 zod 的子入口
```

其余硬约束：
- **D4 规则 2**（每个 action 有 schema / 尺寸 / 频率 / 权限检查）：3 条新通道全部经
  `registerHandler` 注册，四道闸写死在 `ipc-guard.ts` 里，没有第二条路。
- **D4 规则 3**（数据按 capabilityId 分区）：能力偏好落 `capability-prefs.json` 独立文件，
  不塞进 `AppSettings`（理由见 `capability-prefs.ts` 文件头：塞进去会自动落进
  `settings:set` 的可写集合，与 SEC-005 把 `piRuntimeMode` 移出可写集合同构）。
- **D4 规则 6**（命名空间）：`validateCapabilityManifest` 装配期强制，对拍 M11。

### 4.2 门禁（收尾一次全跑）

```
$ pnpm typecheck
packages/pi-sdk typecheck: Done
packages/contract typecheck: Done
packages/app typecheck: Done

$ pnpm -w test
 Test Files  101 passed (101)
      Tests  931 passed (931)
   Duration  24.51s
（基线 97 文件 / 870 测试 → +4 文件 / +61 测试，无一条既有用例被改判）

$ pnpm build
✓ 3110 modules transformed. ✓ built in 11.15s

$ pnpm --filter @pibuddy/app dist
• building target=nsis file=release\PiBuddy-Setup-0.1.0.exe archs=x64
• building block map

$ node scripts/check-test-discovery.mjs
onDisk 101 / OK: 磁盘上的全部 spec 都在 vitest 的发现范围内

$ node scripts/check-contract-uniqueness.mjs
contract exports 352 / OK: 契约名字唯一、无第二套契约包、无跨层 preload/index.d 引用

$ node packages/app/scripts/check-pure-js-deps.mjs
OK（扫描 83 个包，无原生扩展；npmRebuild: false 成立）

$ node scripts/check-workflow-pins.mjs
OK（2 个 workflow，全部 action 已 SHA 固定）

$ node scripts/check-respond-ui-guard.mjs
respondUi 调用点 1 处，未在其后 5 行内检查返回值的 0 处 / OK

$ node packages/app/scripts/verify-packaged-app.mjs
✓ [win-unpacked] pi-runtime 依赖 18486 个文件，与源一致
✓ [win-unpacked] convert-worker 与 11 个 chunk 已外置且无 external 解析库
verify-packaged-app: OK（校验 1 个产物目录）
```

### 4.3 真机启动验证（`release/win-unpacked/PiBuddy.exe`，CDP 取证）

**第一轮（默认 general）**

```
window.piBuddy 的命名空间（15 个）：
["artifacts","capabilities","diagnostics","dialog","file","pi","piResources",
 "preview","providers","sessions","settings","shell","stt","update","workspace"]

capabilities.describe()：
{"profile":"general","restart":false,"profiles":["general","coding","lite"],
 "caps":[["common.workspace-files",true,"workspace.read|workspace.write"],
         ["common.workspace-review",true,"workspace.read|workspace.write"],
         ["common.preview",true,"workspace.read|workspace.write"],
         ["common.artifacts",true,"workspace.read|workspace.write|external.open"]]}

工具条按钮：["📁 文件","🔀 改动","📦 产物"]
```

**这一轮抓到一条单测没抓到的缺陷。** `setProfile('lite')` → `location.reload()` 之后，
界面上三个按钮**照旧全在**，`describe()` 也仍然回「general、四个全开」。

根因：`describeCapabilities()` 回落到装配期缓存的那份 prefs
（`assembledPrefs ?? loadCapabilityPrefs(...)`）。当时的单测只看 `setProfile` 的**返回值**，
而那条路径是直接拿着新 prefs 去 `describe` 的——恒对。判据因此改钉在「**换一个 describe
的入口再读一次**」上，见 `capability-profile.spec.ts`，对拍 M13。

修复：`describeCapabilities()` 一律读磁盘上当前的偏好；`assembledPrefs` 整个删掉，
`restartRequired` 的比对基准只保留 `lastResolution`（它记的是这个进程实际装成了什么样）。

**第二轮（重新 dist，磁盘上的偏好是 lite）**

```
capabilities.describe()：
{"profile":"lite","restart":false,
 "caps":[["common.workspace-files",false],["common.workspace-review",false],
         ["common.preview",false],["common.artifacts",false]]}

工具条按钮：[]                                    ← UI 贡献不出现

window.piBuddy.artifacts.query({workspaceId:'x'})：
Error invoking remote method 'artifacts:query':
  Error: No handler registered for 'artifacts:query'   ← 通道确实没注册
```

**第三轮（切回 general，不重启）**

```
setProfile('general') → {"profile":"general","restart":true, 四个 true}
location.reload() → 工具条按钮 ["📁 文件","🔀 改动","📦 产物"]（UI 立刻恢复）
describe() → {"profile":"general","restart":true}      ← 如实告知主进程侧要重启
```

**第四轮（重启进程）**

```
describe() → {"profile":"general","restart":false, 四个 true}
artifacts.query(...) → "artifacts:query OK total=0"     ← 通道回来了
DOM → {"toggles":["📁 文件","🔀 改动","📦 产物"],"composer":true,"topbar":true}
```

**数据保留**（D4 规则 4/5）——走完一整轮「全部禁用 → 重新启用」之后：

```
$ ls %APPDATA%\@pibuddy\app\*.db
artifacts.db 12288 / changesets.db 4096 / session-index.db 4096 / usage.db 4096 / workspaces.db 4096
```

一个都没被删、没被清空。

**启动日志**（`%APPDATA%\@pibuddy\app\logs\pibuddy-20260803.log` 末尾）：
`app_ready` → `update_service_created` → `window_ready` → `startup_health(safeMode:false)` →
`pi_runtime_resolved(bundled 0.83.0)` → `pi_runtime_handshake_ok` → `pi_runtime_launched(generation:1)`。
无 `ipc_rejected`，无能力相关错误。唯一的 warn 是 `update_error: net::ERR_CONNECTION_CLOSED`
——`PIBUDDY_UPDATE_FEED_URL` 未配置时的占位地址，build-config 已在打包时明确警告过，与本次改动无关。

**进程清理**：`powershell Stop-Process -Name PiBuddy -Force` 之后
`PiBuddy count=0` / `electron count=0`，三轮各核对一次。

---

## 5. `workspace-store.ts:57` 的 `permissionRules`：明确记录为什么本轮不接

`workspace-store.ts:57` 落盘的 `permissionRules: PermissionRule[]`（DDL 见 `:69`）确实已经
落盘且无人读。但**它和 ADR D3 的能力权限不是同一个轴**：

- `PermissionRule`（`ipc-contract.ts:97`）是**单条 IPC 通道的准入配额**：
  `{channel, maxBytes, windowMs, maxPerWindow}`。`ipc-guard` 的 `CHANNEL_MAX_BYTES` 与
  `RateLimiter` 就是它的运行时投影。它回答的是「这条通道一次能收多大、10 秒能来几次」。
- `CapabilityPermission` 回答的是「这个能力被允许做哪一类事」（`workspace.write` /
  `process.shell` / `network:<domain>`）。

两边**连键都对不上**：一个按 channel 索引，一个按 capabilityId 索引。把前者当成后者的
决策数据源来读，只能靠一层猜测性的映射——那正是 ADR D3 里点名批评过的做法
（「拦截点必须实测验证，不得靠架构图推断」）。

因此本轮**不接**，并把这段判断写进 `capability.ts` 的 `CapabilityPermission` 文档注释，
免得下一个人重新纠结一遍。正确的接法记在同一处：PermissionEngine 落地时给
`WorkspaceProfile` 加一张**按 capabilityId 索引的授权表**，与现有 `permissionRules` 并列
而不是复用它。那属于「权限引擎的实际决策逻辑」，本轮明确不做（只做声明与校验）。

---

## 6. 本轮发现、但**没有**修的问题（留给第二阶段）

1. **`common.workspace-review` 的 listener 挂在 kernel 上**。
   `pi-supervisor.ts:42` 直接 `import { observeToolEvent } from "./changeset/tool-watch.js"` ——
   内核持有一个 common 能力的函数引用。本轮的做法是在 `tool-watch` 内部门控（快照不抓、
   跟踪不插），而不是把这条 import 拆掉：拆它需要一套「能力订阅内核事件流」的机制，
   属 ADR 实施顺序「其余四条」里 `changeset/tool-watch.ts:25` 那一条。
   现状是**成本被门控掉了，依赖方向还没扶正**。

2. **D5 的 slot registry 化没做**。AppShell 的四个具名 slot 一个没动，本轮只加了可见性
   门控。`filesOpen` 一个 ref 同时控制 FileTreePanel + FileEditorPane + PreviewPane 这个问题，
   只在 PreviewPane 上按「文件树给它输入 + 预览能力给它转换」拆成了两个判据，
   ref 本身仍然是一个。

3. **`listener` 类 teardown 没有反向源码判据**。drift 4 能从源码反查 `utilityProcess.fork` /
   `new Worker` / `fs.watch`，但「这里挂了一个事件监听」在源码上没有稳定特征，因此
   `teardown: ["listener"]` 只有正向（声明了就必须有 dispose 导出）。这一条已写进
   drift test 的注释里，不是遗漏。

4. **`appMin` 对内置能力是恒真的**，四份 manifest 都填 `0.0.0` 并注明理由：内置能力不可能
   比宿主更老。对内置真正生效的是 `contractMin/contractMax`（`CAPABILITY_HOST_CONTRACT_VERSION`
   一旦 +1，每份没跟着改的 manifest 当场被拒）。`appMin/appBelow` 的行为由
   `capability-registry.spec.ts` 用合成 manifest 钉住，不是没有判据。
