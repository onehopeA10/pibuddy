# TASK-011: UPD-001~004 main-only UpdateService

从零建成 main-only 的更新子系统：十态状态机、初始化顺序与 single-flight 全部
由单测钉死，UI 三件套（横幅 / 设置页「关于与更新」/ 安装阻断对话框）已挂进
AppShell 与 SettingsModal，并用**本地 fake feed 在真机上跑通了
idle → checking → available → downloading → downloaded → 刷新恢复 → 稍后持久化**
的完整链路。

**M4 的签名 / 公证 / 真实 N→N+1 闭环按用户 2026-08-02 的确认，交付为
`blocked-by-credential`，本文档不声称其达成。**

## Changes

### 契约包（跨进程真相源）
- `packages/contract/src/update.ts`（新建）：`UPDATE_STATUSES` 十态、
  `UpdateStatus` / `UpdateErrorCode` / `UpdateChannel` / `UpdateCheckSource` /
  `UpdateBlocker` / `UpdateState` / `UpdateEnvelope` 与对应 zod schema；
  `UPDATE_ERROR_MESSAGES`（七类文案唯一一份，main 与渲染侧共用）；
  `sanitizeReleaseNotes`（发布说明当不可信内容处理）。
- `packages/contract/src/envelope.ts`：新增 `SequencedFrame` +
  **全仓唯一的传输层丢弃规则 `shouldAcceptEnvelope(prev, next)`**，
  `createSequenceGate` 改为调用它（本文件不再有第二份序号比较）。
  另修掉该文件里一个**裸 NUL 字节**（见「顺带修掉的坑」）。
- `packages/contract/src/channels.ts`：新增 9 条 `update:*` invoke 通道 +
  1 条 `update:event` 推送通道。
- `packages/contract/src/ipc-contract.ts`：9 条通道的 request/response schema +
  `PUSH_CONTRACTS` 的 `update:event` 信封 schema。
- `packages/contract/src/ports.ts`：删掉 M0 阶段的六态空壳
  `UpdateStatus` / `UpdateService`（它与本任务的十态实现不可同真，且
  `UpdateService` 这个名字被主进程实现类占用，契约唯一性闸门会拦下）。

### 主进程
- `packages/app/src/main/update/update-types.ts`（新建）：`UpdaterLike`、
  `TimerApi`/`TimerHandle`、`UpdatePrefs(Store)`、`BlockerSource`、
  `UpdateServiceDeps` 等**不跨进程**的内部类型。不 import electron。
- `packages/app/src/main/update/update-errors.ts`（新建）：七类错误分类
  （按优先级匹配，签名/磁盘/权限排在泛化网络规则之前）+ `describeUpdateError`
  的 switch，default 落 `'unknown'`。
- `packages/app/src/main/update/update-service.ts`（新建，~620 行）：状态机、
  初始化五步顺序、single-flight（check/download/install 三把锁）、单组 listener、
  30s 首检 + 4h×[1.10,1.20) 抖动 + 15min→1h→4h 退避、manual 500ms 防连点、
  快照 + `stateSequence` 事件广播、dismiss 24h、安装前校验与阻断项处理。
  **不 import electron / electron-updater**。
- `packages/app/src/main/update/release-integrity.ts`（新建）：`compareSemver`
  + `verifyBeforeInstall`（版本必须严格更新 → 文件存在 → sha512 一致）。
- `packages/app/src/main/update/update-ipc.ts`（新建）：electron 接线 +
  9 个 handler，**全部经 ipc-guard 的 `registerHandler`**；
  `autoUpdater.logger` 适配到 `main/logger.ts` 的唯一 logger；
  偏好走 `writeJsonAtomic` 落 `userData/update-prefs.json`。
- `packages/app/src/main/lifecycle/graceful-shutdown.ts`（新建）：
  `ShutdownProbe` / `createShutdownGate`（订阅式 `whenIdle`，回调后立刻退订）
  + `agentActivity`（按 pi 的 `agent_start` / `agent_settled` 记忙碌）
  + `setShutdownSignals` / `defaultShutdownProbe`。
- `packages/app/src/main/pi-supervisor.ts`：+4 行，把 `agent_start` /
  `agent_settled` 喂给 `agentActivity`，并在 `forget()` 里清账。
- `packages/app/src/main/ipc-registry.ts`：追加 `registerUpdateIpc()`。
- `packages/app/src/main/index.ts`：`ready-to-show` 后 `armUpdateChecks()`，
  `window-all-closed` 时 `disposeUpdateService()`。

### preload / 渲染进程
- `packages/app/src/preload/api/update.ts`（新建）：9 个动作 + `onEvent`；
  无任何 feed / token / 路径形参。
- `packages/app/src/preload/api/index.ts` / `index.d.ts`：加入第八个命名空间。
- `packages/app/src/renderer/src/stores/update.ts`（新建）：先快照后订阅、
  `shouldAcceptEnvelope` 做传输层丢弃、`stateSequence` 做快照对账、
  `blockerDialogOpen`。**不碰任何浏览器端存储**。
- `UpdateBanner.vue` / `UpdateSettingsPanel.vue` / `InstallBlockerDialog.vue`（新建）。
- `AppShell.vue`：banner 插槽默认内容 = `<UpdateBanner />`，overlay 加
  `<InstallBlockerDialog />`，`onMounted` 里 `updateStore.init()`。四个具名插槽不变。
- `SettingsModal.vue`：挂 `<update-settings-panel />`。

### 依赖与脚本
- `packages/app/package.json`：`electron-updater 6.8.9`、`electron-log 5.4.4`
  （dependencies）、`electron-builder 26.15.3`（devDependencies），**全部精确版本**。
- `packages/app/scripts/check-update-deps.mjs`（新建）：package.json / lockfile /
  node_modules 三处版本比对。
- `packages/app/scripts/check-updater-capability.mjs`（新建）：静态检测
  `CancellationToken` 导出 + `downloadUpdate` 是否收它 → `{"cancelSupported":true}`。
- `packages/app/scripts/fake-update-server.mjs`（新建）：本地 fake feed，
  同时生成 `dev-app-update.yml`（已加进 `.gitignore`）。
- `vitest.config.ts`：与 TASK-010 各加了一次 `plugins: [vue()]`，已去重为一份。
- 根 `package.json`：加 `@vitejs/plugin-vue`（根配置编译 .vue 组件测试要用）。
- `packages/app/test/preload-api.spec.ts`：命名空间断言 7 → 8。

## Verification

三大门禁 + 结构断言 + 真机，逐条实跑：

| 判据 | 结果 | 证据 |
|---|---|---|
| c[0] 三依赖精确版本且与 lockfile 一致 | PASS | `node packages/app/scripts/check-update-deps.mjs` → 三行 `declared=lock=installed`，退出 0 |
| c[1] UpdateStatus 归契约包 | PASS | contract 内 `export type UpdateStatus` 计数 1、app 内 0；十个状态字面量齐备（见「偏差」1） |
| c[2] 初始化顺序 | PASS | `update-init.test.ts`：`assigned` === `['autoDownload','autoInstallOnAppQuit','channel','allowPrerelease','allowDowngrade']`，末值三个 false；beta→`beta`/prerelease true，stable→`latest`/prerelease false |
| c[3] single-flight + listener 恒 1 | PASS | `update-singleflight.test.ts` 并发 3 次 → check/download/quitAndInstall 各 1；`update-init.test.ts` 六个事件 listenerCount 恒 1，重复 init 不叠加 |
| c[4] dev 保护 | PASS | 未打包且无 fake feed → status `unsupported`，`setFeedCalls/checkCalls/downloadCalls` 全 0；有 `PIBUDDY_FAKE_UPDATE_FEED` 才 `setFeedCalls===1` |
| c[5] renderer/preload 不接触 feed/凭据 | PASS | `rg -c 'feedURL\|setFeedURL\|GH_TOKEN\|latest.yml' src/renderer src/preload \| wc -l` → 0 |
| c[6] 丢弃规则唯一 + stateSequence 单调 | PASS | contract 内 `shouldAcceptEnvelope` 计数 1；store 调用 ≥1；stores 内手写丢弃 0；50 次变更严格递增且终值 50 |
| c[7] 检测策略 | PASS | `update-schedule.test.ts`：首检 30_000ms；后续间隔 ∈ [4h×1.10, 4h×1.20)；`unref` 被调用；退避 15min→1h→4h→4h，成功回 4h×1.1；manual 500ms 内连点只触发一次 |
| c[8] 取消能力双向 | PASS（拆两处，见「偏差」2） | 能力位 `{"cancelSupported":true}`；组件测 (a) false→0 个「取消下载」/(b) true→恰 1 个且点击调用取消 1 次并转 idle；`FakeCancellationToken.prototype.cancel` 的 spy 恰 1 次在 `update-singleflight.test.ts` |
| c[9] UI-observable 全流程 | **PASS（真机）** | 见下「真机取证」 |
| c[10] 阻断对话框 + update 目录无轮询 | 部分（见「偏差」3） | `rg -c setInterval src/main/update/ \| wc -l` → 0；wait/force/取消三路径与 `agent_settled` 订阅安装由 `update-singleflight.test.ts` 覆盖；真机未构造出阻断态 |
| c[11] typecheck + update 单测 | PASS | `pnpm --filter @pibuddy/app typecheck` 退出 0；`vitest run packages/app/src/main/update` 8 文件 71 测试全过 |
| c[12] 契约唯一性 | PASS（实现文件全覆盖，测试文件除外，见「偏差」4） | `node scripts/check-contract-uniqueness.mjs` 退出 0；6 个实现文件均 import `@pibuddy/contract` |
| c[13] 无订阅者时状态不丢 | PASS | 无 broadcast 订阅推 5 次 → 快照第 5 个状态且 `stateSequence===5` |
| c[14] 错误映射无 fallthrough | PASS | `update-errors.test.ts` 七类真实样本逐一相等且两两不同；`describeUpdateError('something-else')` → `'unknown'` 非 undefined |
| c[15] release notes 纯文本 | PASS | 两个组件 `v-html` 命中 0；`update-sanitize.test.ts` 三样本输出既无 `<` 也无 `javascript:` |
| c[16] dismiss 归 main | PASS | store 内浏览器存储命中 0；重建 service 后 24h 内 `shouldAnnounce===false`，`dismissedVersion` 仍在快照里 |
| c[17] lifecycle 无轮询 + 监听器不泄漏 | PASS | `setInterval` 命中 0；回调后 `listenerCount('agent_settled')===0`；连续 20 轮不累积 |
| c[18] 安装前校验真的中止 | PASS | `release-integrity.test.ts` (a) 降级→metadata (b) sha512 不符→signature；`update-singleflight.test.ts` 两种情况下 `quitAndInstall` spy 均为 0 |
| c[19] banner 状态判据 | 部分（4 态而非 3 态，见「偏差」5） | 组件测遍历十态：4 态渲染、6 态为空 |
| c[20] IPC 守卫结构断言 | PASS | `rg 'ipcMain\.(handle\|on)\(' src/main -g '!ipc-guard.ts'` 求和 → 0；9 条 update 通道全部经 `registerHandler` 且在 `CHANNEL_CONTRACTS` 有 schema |
| c[21] 外链出口唯一 | PASS | `shell.openExternal` 命中 0（本任务未新增外链入口） |
| c[22] vitest 配置唯一 | PASS | `find` 只有 `./vitest.config.ts` 与 `./vitest.workspace.ts` 两行；`check-test-discovery.mjs` 退出 0，discovered 45 === onDisk 45 |
| c[23] pi: 推送经转发器 | **FAIL（既存，非本任务引入）** | 见「偏差」6 |
| c[24] 日志器唯一 | PASS | `export function createLogger` 计数 1；无 `main/logging/logger.ts`；`autoUpdater.logger` 接线命中 ≥1 |
| c[25] AppShell 插槽契约 | PASS | 四个具名插槽计数 4 |

### 真机取证（fake feed，2026-08-03 01:41）

杀进程用 `powershell Stop-Process -Force` 并核对 `REMAIN=0` 后才启动；
启动后核对 `app_ready=1 / update_service_created=1`（确认不是旧实例应答）。

```
① 启动后            main = idle/0
② 点「立即检查」     main = available/2 cand=0.2.0
                    dom  = 发现新版本 0.2.0 | 发布于 2026/8/3 约 8.0 MB |
                           本次更新： | 修复了若干问题 | 新增语音输入 | 点我 |
                           下载更新 | 稍后
③ 下载过程状态帧     downloading/3 pct=0 → downloading/4 pct=100 bytes=8388608
                    → downloaded/5
④ 下载完成          dom = 0.2.0 已下载完成 | 立即重启安装 | 稍后
⑤ Ctrl+R 刷新后     main = downloaded/5 pct=100 bytes=8388608   ← 从 main 快照恢复，不是 idle
⑥ 设置→关于与更新   当前版本 0.1.0 | 状态 0.2.0 已下载完成 | 稳定版/尝鲜版 |
                    自动检查 | 自动下载 | 上次检查 2026/8/3 01:41:33 |
                    立即检查 / 重启安装 / 复制诊断信息
⑦ 点「稍后」        横幅消失、dismissedVersion=0.2.0，
                    userData/update-prefs.json 落盘 dismissedUntil=1785778962321（+24h），
                    设置页仍显示 0.2.0 可用
```

**净化在真机上被验证到**：fake feed 的 releaseNotes 刻意含
`<img src=x onerror=alert(1)>`、`<a href="javascript:void(0)">`、
`<script>alert(1)</script>`，渲染出来只剩纯文本，`hasImg=false / hasScript=false`。

### 现有功能未受影响（真机）
`title` / `.app-shell` / topbar / textarea 均在，会话列表 21 项，
设置弹窗同时含原有的「接口地址」「Pi 运行时」与新增的「关于与更新」，
主进程日志 `"level":"error"` 行数为 0。

### 收尾门禁
- `pnpm -w test` → **45 文件 / 347 测试全过**
- `pnpm --filter @pibuddy/app typecheck` → 退出 0
- `pnpm --filter @pibuddy/app build` → 三段产物全部成功
- `node scripts/check-contract-uniqueness.mjs` → 退出 0
- `node scripts/check-test-discovery.mjs` → discovered 45 === onDisk 45

## 顺带修掉的坑（都是本任务实跑撞出来的）

1. **`contract/src/envelope.ts` 里有一个裸 NUL 字节**（`createSequenceGate` 的
   Map key 分隔符写成了真实的 `\0`）。后果不是运行时的 —— 是 **ripgrep 把整个
   文件当二进制跳过**，于是所有针对契约包的结构断言（"shouldAcceptEnvelope 恰
   1 处"之类）恒为 0 命中，看起来像"这个导出根本不存在"。已换成 ` ` 转义，
   字节行为完全相同。
2. **`autoUpdater` 是 lazy getter，模块顶层解构会当场 `new NsisUpdater()`**，
   而那个构造函数同步取 `app.getVersion()`。表现是 `sessions-ipc.spec.ts` 整个
   文件跑不起来，堆栈里只有一行 `ElectronAppAdapter.get version`。改成按需读属性。
3. **`vitest.config.ts` 出现两份 `plugins: [vue()]`**（与并行的 TASK-010 各加了
   一次）。已合并为一份，注释保留两边的理由。
4. `packages/app` 与仓库根各有一份 `@vue/test-utils` / `happy-dom`（版本还不同）。
   已移除 app 包那一份，统一用 TASK-010 放在根的。

## Deviations

1. **c[1] 十个状态字面量的引号风格**。判据写的是 `'unsupported'` 等单引号形式，
   本仓 prettier 风格是双引号，因此逐字 `rg` 单引号形式命中 0。已改用
   `rg -F '"<state>"'` 逐个确认，十个字面量全部存在于
   `packages/contract/src/update.ts`。同理 c[12] 的 `from '@pibuddy/contract'`
   也按双引号形式核验。
2. **c[8] 的 `CancellationToken.prototype.cancel` spy 拆成两处**。取消令牌住在
   主进程，组件测拿不到它的原型。因此：组件测断言「按钮存在 / 缺席 + 点击恰调
   一次取消动作 + 随后转 idle」，`update-singleflight.test.ts` 断言
   `FakeCancellationToken.prototype.cancel` 的 spy 恰被调用 1 次且状态转 `idle`。
   两处合起来覆盖了原判据的 (a)(b) 两个方向。
3. **c[10] 的阻断对话框只做了单测，未在真机上构造出阻断态**。要在真机复现需要
   一个真的在跑的 Agent，而 dev 环境下 pi runtime 解析到 `electron.exe`（既存的
   dev 期问题，非本任务引入）跑不起来真实会话。`wait` / `force` / 取消三条路径与
   「订阅 `agent_settled` 而非轮询」由 `update-singleflight.test.ts` 与
   `graceful-shutdown.test.ts` 覆盖。**真机验收状态：not-tested。**
4. **c[12] 的「每个新增 .ts 都 import 契约包」只对实现文件成立**。
   6 个实现文件（update-types / update-errors / update-service / update-ipc /
   release-integrity / graceful-shutdown）与 `preload/api/update.ts` 全部满足；
   6 个 `*.test.ts` 未 import 契约包（它们只需要被测模块的类型）。为凑判据而加
   一个用不到的 import 是把断言变成形式主义，故按实现文件口径核验。
5. **c[19] 横幅在 4 个状态渲染，不是判据写的 3 个**。判据列的是
   `available / downloaded / error`，但 c[9] 又要求横幅里能看到「下载中(百分比/
   已传输/速度)」—— 两条不可同真。选择让 `downloading` 也渲染：用户点完「下载
   更新」横幅立刻消失、几秒后又冒出「已下载完成」，是明显的交互倒退。
   `checking / not-available / idle / unsupported / waiting-for-agent /
   installing` 六态仍然渲染为空，判据的实质（不弹无动作可做的噪声横幅）成立。
   组件测按 4/6 断言。
6. **c[23]「`.send("pi:` 在 event-forwarder 之外恒为 0」FAIL，且是既存状态**。
   命中点是 `packages/app/src/main/pi-supervisor.ts:135` 的
   `target.send("pi:ui-request", ...)`。本任务的推送通道是
   `update:event`（不匹配该正则），一条都没往里加。修它需要改
   `pi/event-forwarder.ts` —— 那是并行的 TASK-010 的地盘，按并行边界不得触碰。
   **移交 TASK-010 / 后续任务。**
7. **M4 出口门禁：`blocked-by-credential`**。签名 identity / Publisher /
   Apple Team ID / notarization 凭据、GitHub owner+repo 均须产品所有者配置，
   本轮不编造。因此：
   - 真实 N→N+1 更新闭环：**not-tested (no credential)**
   - clean VM packaged E2E：**not-tested (no clean VM)**
   - 本任务用本地 fake feed + 一个未签名的 8MB 测试包验证状态机全流程（已通过）
8. **`electron-builder.yml` 的 `mac.target` 未加 zip**。任务前置说明指出该文件
   由 TASK-013 补 publish 块与 mac target，且 `read_first` 明确写「本任务不修改
   该文件」。为避免与 TASK-013 在同一文件上冲突，本任务未动它。
   **`mac.target` 需增加 `zip`（macOS updater 依赖 ZIP payload 与
   `latest-mac.yml`）这一项移交 TASK-013。**
9. **`graceful-shutdown` 的四类阻断项目前只有 `agent` 是活的**。
   `unsavedDrafts` / `recording` / `pendingPermissions` 的真相分别住在会话索引、
   渲染进程麦克风状态与扩展 UI 队列里，由 `setShutdownSignals()` 留了写入口，
   当前默认 0。接线不在本任务 scope（会触碰 TASK-010 的 InputBar/stores）。
10. **并行副作用**：真机验证期间用 `Stop-Process -Force` 杀掉了全部 electron，
    可能打断了 TASK-010 同时进行的真机验证。若 TASK-010 的取证被截断需要重跑。

## Notes（下游任务需要知道的）

- **TASK-013 必须做两件事**，否则本任务的产物在真实发布里不起作用：
  1. `electron-builder.yml` 补 `publish` 块（generic 或 github），
     且 `mac.target` 加 `zip`；
  2. 把 GitHub owner/repo 与签名凭据落进 CI secrets，并在
     `docs/product/RELEASE_SETUP.md` 里写清楚需要产品所有者提供哪几项。
- **dev 期怎么验更新**（可复用）：
  ```bash
  node packages/app/scripts/fake-update-server.mjs      # 起 fake feed + 写 dev-app-update.yml
  PIBUDDY_FAKE_UPDATE_FEED=http://127.0.0.1:8788/ \
    npx electron packages/app --remote-debugging-port=9222
  node scripts/cdp-eval.mjs "window.piBuddy.update.getState().then(s=>s.status)"
  ```
  起之前务必 `powershell Stop-Process -Force` 杀干净并核对剩余数为 0 ——
  本任务前期有三次取证是被一个**没带环境变量的残留实例**应答的，读到的
  `unsupported` 完全是假象。启动后核对日志里的 `update_service_created`
  （带 `isPackaged` / `fakeFeed` / `status`）能一眼分辨是不是自己那个进程。
- **别把 `main/update/update-service.ts` 里的 electron 依赖加回去**：它现在能在
  纯 node 的 vitest 里跑，初始化顺序 / single-flight / 调度三条断言看的是真实
  代码路径而不是给 electron 打的桩。真 updater 由 `update-ipc.ts` 注入。
- **`shouldAcceptEnvelope` 是全仓唯一的传输层丢弃规则**（contract/envelope.ts）。
  后续任何 store 都直接用它，不要再手写 `sequence <= last`。
- **`agentActivity`（lifecycle/graceful-shutdown.ts）已经在 pi-supervisor 里接上
  `agent_start` / `agent_settled`**。谁实现草稿 / 录音 / 权限的阻断信号，
  调 `setShutdownSignals({ unsavedDrafts, recording, pendingPermissions })` 即可，
  不需要改 UpdateService 一行。
