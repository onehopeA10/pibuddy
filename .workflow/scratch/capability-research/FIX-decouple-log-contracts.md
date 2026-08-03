# FIX：能力包架构第一阶段的前置解耦

依据 `docs/product/ADR-0002-capability-architecture.md`「实施顺序」里卡住所有后续
工作的两条。本轮**只做这两条**，不碰能力包拆分、registry、feature gate、Profile、
UI 插槽与权限引擎。

---

## 1. `log()` 从 pi 域搬到 kernel

### 改前

`log()` 定义在 `pi/pi-ipc.ts:57`，三个内核模块反向取用：

| 取用方 | 后果 |
|---|---|
| `ipc.ts:14` | ipc-guard 的拒绝日志（`setGuardLogger`）出口在 pi 域 |
| `misc-ipc.ts:28` | settings / dialog / file / shell / stt 五类 handler 的日志出口在 pi 域 |
| `update/update-ipc.ts:36` | **更新子系统的日志出口在 pi 域** —— 与「pi runtime 不可用时更新仍须工作」直接冲突 |

另外 `index.ts` 自己还有一个 `mainLogger()`：同一个日志目录被两个 Logger 实例
各自算着 `written` 字节数，轮转判定各算各的。

### 改后

新增 `packages/app/src/main/log.ts`（内核设施，唯一一处解析 `userData/logs`
并调 `configureLogging`）。方向倒过来：

- `ipc.ts` / `misc-ipc.ts` / `update/update-ipc.ts` / `index.ts` → `./log.js`
- `pi/pi-ipc.ts` 不再导出 `log`，改为 `import { log } from "../log.js"` —— pi 域
  和其它域一样是**消费方**
- `index.ts` 的 `mainLogger()` 删除，合并进 `log()`：进程内只剩一个 Logger 实例

`logger.ts` 一个字没动。它刻意不 import electron（那样才能在纯 node 的 vitest 里
被直接驱动），`log.ts` 就是「解析目录」与「日志实现」之间那道薄接缝。
**全仓仍然只有一个日志器实现**。

### 新增结构性断言

`packages/app/test/kernel-boundary.spec.ts`（6 条），手法与 `ipc-guard.ts:14`
的「守卫外 ipcMain 命中数恒为 0」同源：

1. main 下没有任何模块从 pi 域取 `log`
2. `pi-ipc.ts` 不再 `export function log`，且确实 import 了 `../log.js`
3. `getPath("userData"), "logs")` 在 main 下恰好一处，且在 `log.ts`
4. `export function createLogger` 在 `packages/app/src` 下恰好一处，且在 `main/logger.ts`
5. **内核模块不得 import pi 域**，除登记在案的三处
6. 登记表只减不增，不留死条目

登记表（逐条附理由，只减不增）：

| 文件 | 取的什么 | 理由 |
|---|---|---|
| `ipc-registry.ts` | `registerPiIpc` | 宿主装配点，能力包架构里注册表本就该知道每个能力入口 |
| `ipc.ts` | `disposeClientFor` | ADR-0002「其余四条」之一，随 pi 包拆分迁走 |
| `sessions/sessions-ipc.ts` | `tryClientFor` | ADR-0002「其余四条」之一，随 pi 包拆分迁走 |

写断言时抓到一个原先没料到的事实：`pi-supervisor.ts` import 了
`pi/event-forwarder.js`。它不是内核违规 —— `pi-supervisor.ts` / `pi-launcher.ts` /
`pi-runtime-manifest.ts` 本身就是 pi runtime 的组成部分，只是摆放位置是历史遗留。
断言里把它们标成 pi 域成员（域内依赖不计入判据），而不是塞进允许表 —— 塞进允许
表会把「域内依赖」和「内核对 pi 的硬依赖」两件不同的事混成一件。

---

## 2. `CHANNEL_CONTRACTS` 从穷举 Record 改为可分片合并

### 改前

`ipc-contract.ts:477` 是 `Record<InvokeChannel, ChannelContract>` 的**单个对象
字面量**。类型的穷举性保证「每条通道都有 schema」，代价是所有 100 条通道必须写在
同一个对象里 —— 能力包无法各自声明再合并。

### 改后

新增 `packages/contract/src/channel-contract.ts`：

```
ChannelContract          一条通道的 request / response
ContractShard            { id, contracts: Partial<Record<InvokeChannel, ChannelContract>> }
defineContractShard()    声明一个分片
mergeChannelContracts()  合并；重复通道抛错、重名分片抛错，绝不覆盖
sealChannelContracts()   合并 + 核对 CHANNELS 全表（缺/多都抛错）+ freeze
```

100 条通道拆成 **13 个具名分片**：

| 分片 id | 条数 | 位置 |
|---|---|---|
| pi-runtime | 24 | ipc-contract.ts |
| sessions | 9 | ipc-contract.ts |
| settings | 5 | ipc-contract.ts |
| attachments | 8 | ipc-contract.ts |
| **workspace-files** | 9 | **workspace.ts** |
| **workspace-review** | 4 | **workspace.ts** |
| **preview** | 3 | **preview.ts** |
| **artifacts** | 8 | **artifacts.ts** |
| stt | 1 | ipc-contract.ts |
| pi-resources | 7 | ipc-contract.ts |
| update | 9 | ipc-contract.ts |
| providers | 10 | ipc-contract.ts |
| diagnostics | 3 | ipc-contract.ts |

加粗那四片**已经住进各自的域文件**，用来证明「分片跨文件声明 + 宿主合并」这条路
真的通，而不是同一个文件里换了个写法。`channel-contract.ts` 刻意只依赖 zod 类型与
`channels.ts`，否则域文件一旦自带分片就会与 `ipc-contract.ts` 成环。剩下九片仍留在
`ipc-contract.ts`，因为它们的 request schema 也还定义在那里，随各自能力包拆分时
一并搬走。

### 「四道闸对每条通道都生效」怎么接住

原先靠 `Record<InvokeChannel, …>` 的穷举性：少一条编译不过。分片之后这条保证换成
**装配期封口**（`sealChannelContracts`），两个方向都查：

- **缺**：`CHANNELS` 里有、没有任何分片声明 → 抛 `CHANNEL_CONTRACT_MISSING`。
  该通道若活到运行期，`isKnownChannel` 会把它判成未知通道，guard 的第一道闸对它
  形同虚设。
- **多**：分片声明了 `CHANNELS` 里不存在的通道 → 抛 `CHANNEL_CONTRACT_UNKNOWN`。

封口发生在**模块加载期**，因此一旦不成立，`import "@pibuddy/contract"` 这件事本身
就失败：全部单测与应用启动一起红，不存在「只在某条冷路径上才发现」的可能。见下面
对拍 A 的实测输出。

编译期也没有完全放弃：分片的 `contracts` 类型仍是
`Partial<Record<InvokeChannel, ChannelContract>>`，**拼错通道名依然是编译错误**。
换掉的只有「少一条」那半边。

### 重复 key 必须抛错

依据 ADR-0002 D4 规则 6 与 `source/CodePilot` `registry.ts:13-28` 的 seal 模式。
反面教材是 pi 的裸 `Map.set` 静默覆盖：同名 Tool 冲突让 RPC 直接启动失败，而现场
没有任何一句话指向「有两个同名的东西」，宿主被迫用三条硬编码关键词猜冲突并删磁盘
文件（`ExtensionManager.ts:586-590`）。

重名分片本身也抛错 —— 否则重复通道的报错会退化成「分片 x 与分片 x 冲突」，等于没报。

---

## 对拍验证（把修复拆掉，确认测试真的变红）

本项目多次抓到恒真断言，所以每条断言都拆开跑过一遍。

### 对拍 1：把 `update-ipc.ts` 的 log 接回 pi 域

拆法：`update-ipc.ts` 改回 `import { log } from "../pi/pi-ipc.js"`，
`pi-ipc.ts` 补回 `export function log()`。

```
× ADR-0002：日志是内核设施，不是 pi 域的导出 > main 下没有任何模块从 pi 域取 log
  → expected [ Array(1) ] to deeply equal []
  +   "update/update-ipc.ts → ../pi/pi-ipc.js"
× ADR-0002：日志是内核设施，不是 pi 域的导出 > pi 域自己也只是 log() 的消费方：pi-ipc.ts 不再导出 log
  → expected '/**\n * pi 运行时相关的 IPC handler（从 ipc.t…' not to match /export\s+function\s+log\b/
× ADR-0002：内核模块不得 import pi 域 > 除登记在案的三处外，没有内核模块依赖 pi 域
  +   "update/update-ipc.ts → ../pi/pi-ipc.js"
× ADR-0002：内核模块不得 import pi 域 > 登记表里的每一条都还真的存在（表只减不增，不留死条目）
  +   "update/update-ipc.ts"
Tests  4 failed | 2 passed (6)
```

恢复后：`Test Files 1 passed (1) / Tests 6 passed (6)`

### 对拍 2A：分片里删掉一条通道（缺）

拆法：从 `artifacts.ts` 的分片里删掉 `[CHANNELS.artifactsQuery]`。

```
FAIL  packages/contract/test/channel-contract.spec.ts [ packages/contract/test/channel-contract.spec.ts ]
Error: CHANNEL_CONTRACT_MISSING: 以下通道没有任何分片声明契约：artifacts:query
Tests  no tests
```

`no tests` 正是想要的形态：封口在模块加载期就炸，测试文件根本收集不起来 ——
任何 import 契约包的文件都会一起红。

### 对拍 2B：两个分片抢同一条通道（重复）

拆法：往 `artifacts` 分片里塞一条 `[CHANNELS.previewOpen]`。

```
FAIL  packages/contract/test/channel-contract.spec.ts
Error: CHANNEL_CONTRACT_DUPLICATE: 通道 preview:open 同时由分片 "preview" 与 "artifacts" 声明
Tests  no tests
```

报错点名了**是哪两个分片**在抢 —— 这正是 pi 的裸 `Map.set` 给不出来的信息。

### 对拍 2C：把 merge 的抛错换成静默覆盖（模拟裸 `Map.set`）

拆法：删掉 `mergeChannelContracts` 里的重复检查与 throw。

```
× 重复声明必须抛错，不得静默覆盖 > 两个分片抢同一条通道时抛错，并指出是哪两个分片
× 重复声明必须抛错，不得静默覆盖 > 后注册者不会覆盖先注册者（裸 Map.set 的反面）
Tests  2 failed | 6 passed (8)
```

恢复后：`Test Files 1 passed (1) / Tests 8 passed (8)`

---

## 硬约束复核（全部实跑）

```
$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0

$ rg --no-filename -c '\bfetch\(' packages/app/src/main -g '*.ts' -g '!**/outbound-guard.ts' | awk '{s+=$1} END{print s+0}'
0

$ rg '^import \{' packages/app/src/preload/api/*.ts packages/app/src/preload/*.ts | grep '@pibuddy/contract"'
无（preload 的运行时值一律来自 @pibuddy/contract/channels 子入口，主入口全是 import type）
```

- 未向 preload 增加任何无约束入口，preload 接口面一字未动
- `fs-atomic.ts` / `path.relative` 收容口径均未触碰
- `source/` 未修改

## 门禁

```
$ pnpm typecheck
packages/pi-sdk typecheck: Done
packages/contract typecheck: Done
packages/app typecheck: Done

$ pnpm -w test
Test Files  97 passed (97)
     Tests  870 passed (870)          # 基线 95 文件 856 测试 → 新增 2 文件 14 测试

$ node scripts/check-test-discovery.mjs
discovered 97 / onDisk 97 / OK

$ node scripts/check-contract-uniqueness.mjs
contract exports 307
OK: 契约名字唯一、无第二套契约包、无跨层 preload/index.d 引用

$ node scripts/check-workflow-pins.mjs
OK（2 个 workflow，全部 action 已 SHA 固定）

$ node packages/app/scripts/check-pure-js-deps.mjs
OK（扫描 83 个包，无原生扩展；npmRebuild: false 成立）

$ node scripts/check-respond-ui-guard.mjs
respondUi 调用点 1 处，未在其后 5 行内检查返回值的 0 处 / OK

$ pnpm build
✓ built in 11.59s

$ pnpm --filter @pibuddy/app dist
building block map  blockMapFile=release\PiBuddy-Setup-0.1.0.exe.blockmap

$ node packages/app/scripts/verify-packaged-app.mjs
✓ [win-unpacked] pi-runtime 依赖 18486 个文件，与源一致
✓ [win-unpacked] convert-worker 与 11 个 chunk 已外置且无 external 解析库
```

## 真机启动验证

跑的是 `release/win-unpacked/PiBuddy.exe`（--remote-debugging-port=9222）。

**preload 桥完好、界面非白屏**（沙箱化 preload 失败的典型表现）：

```
bridge: "object"
ns: "artifacts,diagnostics,dialog,file,pi,piResources,preview,providers,
     sessions,settings,shell,stt,update,workspace"   # 14 个命名空间齐全
root: true                                            # #app 有子节点
body: "更新失败…π PiBuddy AI 办公小助手 ＋ 开始新任务 … 只回答两个字：收到 今天 14:11 · 6 条消息"
```

（「更新失败/连不上更新服务器」是本机无 feed 的预期结果，恰好说明更新子系统跑到了
网络那一步 —— 而它的日志出口正是本轮搬走的那条。）

**日志：三个来源落进同一个文件、同一个实例**（本次启动 `app_ready` 之后的 14 行）：

```
$ grep -o '"event":"[^"]*"' <本次启动的日志> | sort | uniq -c | sort -rn
      3 "event":"ipc_rejected"          ← ipc-guard，经 ipc.ts 的 setGuardLogger
      2 "event":"update_error"          ← update-ipc（原先挂在 pi 域）
      1 "event":"window_ready"          ← index.ts
      1 "event":"updater"               ← update-ipc
      1 "event":"update_service_created"← update-ipc
      1 "event":"startup_health"        ← index.ts
      1 "event":"pi_stderr"             ← pi 域（现在是消费方）
      1 "event":"pi_runtime_resolved"   ← pi 域
      1 "event":"pi_runtime_launched"   ← pi 域
      1 "event":"pi_runtime_handshake_ok" ← pi 域
      1 "event":"app_ready"             ← index.ts
```

那三条 `ipc_rejected` 就是下面故意打的三个坏载荷，说明 guard 的拒绝留痕这条路
（`ipc.ts:14` 那条依赖）在真机上是活的：

```
main sessions:query     [{"expected":"string","code":"invalid_type",…}]
main artifacts:query    [{"expected":"string","code":"invalid_type",…}]
main settings:set-secret[{"code":"invalid_value","values":["stt"],…}]
```

**13 个分片的通道逐个实调**（合并后的表在真机上可用）：

```
settings:get            → schemaVersion/workspace/sessionDir/provider     ✔ settings
pi:get-state            → {"id":"d67200db-…:7","type":"response",…}       ✔ pi-runtime
workspace:current       → workspaceId 9b749749…                           ✔ attachments
sessions:query          → array:3                                          ✔ sessions
workspace:tree-list     → relativePath/entries/truncated                   ✔ workspace-files
changeset:query         → entries/diffs                                    ✔ workspace-review
artifacts:query         → items/total                                      ✔ artifacts
preview:convert         → ENOENT（handler 内的文件不存在，非 schema 拒绝）  ✔ preview
stt:transcribe          → ENDPOINT_NOT_FOUND（handler 内判定）              ✔ stt
pi-resources:scan       → resources/trust/mcp                              ✔ pi-resources
trust:describe          → workspaceId/hasProjectResources/resources        ✔ pi-resources
update:get-state        → status/stateSequence/currentVersion/…            ✔ update
providers:list          → providers/permissionEnforced                     ✔ providers
usage:query             → array:4                                          ✔ providers
diagnostics:preview-bundle → entries/totalBytes/crashDumpConsent           ✔ diagnostics
```

**gate 2（zod）仍然咬得住**：`settings.setSecret({kind:'nope'})` 被
`secretKindSchema` 挡下（上面 `ipc_rejected` 第三条）。

**退出**：`powershell Stop-Process -Name PiBuddy -Force` 后
`(Get-Process PiBuddy).Count` = **0**。

---

## CI

提交 `9d89f04` 的 CI 四个 job 全绿（run 30802927421）：

```
package (ubuntu-latest): success
verify  (ubuntu-latest): success
package (windows-latest): success
verify  (windows-latest): success
```

## 偏差与遗留

1. **`index.ts` 的 `mainLogger()` 被删除**，合并进 `log()`。这超出了「只改
   三处 import」的最小改动面，理由是它与新的 `log.ts` 在做完全同一件事
   （解析 `userData/logs` + `configureLogging` + 惰性建实例），留着就是第二个
   实例在同一个目录上各算各的轮转字节数。`mainLogger` 全仓只有 `index.ts` 自己用。

2. **`sealChannelContracts` 的封口在运行期而不是编译期**。分片之后
   `Record<InvokeChannel, …>` 的编译期穷举性无法保留（这也是 ADR 里写明的）。
   试过用泛型推断把各分片的 key 联合起来做编译期断言，判断是**不做**：
   一旦推断退化成 `InvokeChannel`，断言就变成恒真，而那正是本项目反复踩过的坑。
   现在是「拼错名字 = 编译错误，少一条 = 加载期抛错」，后者由对拍 2A 证明会红。

3. **`ipc-guard.registerHandler` 的 schema 仍然是各 handler 自己传的**，不是从
   `CHANNEL_CONTRACTS` 查的 —— 也就是说契约表与 gate 2 实际用的 schema 之间没有
   强制一致性（只有 `pi-runtime-approval.spec` / `preview-ipc.test` 各钉了一条）。
   这是改前就有的状况，本轮未扩大也未收窄。要收窄的话应该让 `registerHandler`
   直接查表，那是独立的一次改动。

4. **ADR 里其余四条跨层依赖未动**（`index.ts:4` 的 kernel→common、
   `sessions-ipc.ts:27` → pi-ipc、`tool-watch.ts:25` → artifact-tracker、
   `stores/app.ts` 被 23 处直接 import），按 ADR 随各自能力包拆分时处理。
   其中两条已登记进 `kernel-boundary.spec.ts` 的允许表，新增第三条会立刻红。

5. **未提交的他人文件**：`doc/regression/TASK-010-perf.json`（进本轮之前就是
   modified）、`docs/product/ADR-0002-capability-architecture.md`、
   `.workflow/explore/`、`.workflow/scratch/capability-research/` 下的探查产物。
   一律未纳入本次提交（逐个 `git add` 具体路径，无 `-A` / `.`）。
