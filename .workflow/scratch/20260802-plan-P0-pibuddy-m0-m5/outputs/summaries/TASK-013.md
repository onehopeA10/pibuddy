# TASK-013: UPD-005~007 + OBS-101 三平台产物与签名 CI、结构化日志诊断、更新后 health check 与 safe mode

## Changes

### 打包与发布
- `packages/app/electron-builder.yml`：mac.target 补 `zip`（macOS updater 的硬缺口）+ `hardenedRuntime`/`gatekeeperAssess`/`entitlements`/`entitlementsInherit`/`notarize`/`NSMicrophoneUsageDescription`；linux.target 补 `deb`；新增 `publish: {provider: generic, url: ${env.PIBUDDY_UPDATE_FEED_URL}}`；**移除硬编码 npmmirror**；`directories.buildResources: build`。`asar: true`、`npmRebuild: false`、`extraResources`、`afterPack: scripts/after-pack.cjs` 全部保留未动。
- `packages/app/build/entitlements.mac.plist`（新）：6 条例外，每条写明理由。
- `packages/app/scripts/build-config.mjs`（新）：镜像改由 `PIBUDDY_USE_CN_MIRROR` 注入 `ELECTRON_MIRROR`；未配 feed 时用显式占位地址 + 告警。支持 `--exec` 包装子命令。
- `packages/app/scripts/verify-release-artifacts.mjs`（新）：按平台断言必需文件集合（win: latest.yml+exe+blockmap / mac: latest-mac.yml+dmg+zip / linux: latest-linux.yml+AppImage）、版本一致性、stable 禁 prerelease、清单引用的文件必须真实存在。
- `packages/app/scripts/check-pure-js-deps.mjs`（新）：遍历 runtime 依赖闭包，命中 binding.gyp / gypfile / node-gyp 类 install 脚本 / `.node` 即 exit 1。不硬编码包名，空集合返回 0。
- `.github/workflows/release.yml`（新）：`preflight`（缺凭据 exit 1，**任何构建之前**）→ `upload-artifacts`（三平台原生 runner，`--publish never`，先传不可变产物再暂存清单）→ `publish-manifest`（`needs: upload-artifacts`，先发安装包，**最后一个 step** 才发 latest*.yml）。全部 action SHA 固定；不含任何镜像开关字符串。
- `.github/workflows/ci.yml`（**modify**，TASK-001 三道闸原样保留）：追加 `check-workflow-pins.mjs` 与 `check-pure-js-deps.mjs`。
- `scripts/check-workflow-pins.mjs`（新）：正则 `^\s*-?\s*uses:`（同时匹配紧凑写法），未以 40 位 hex 结尾即 exit 1 报 file:line。
- `packages/app/package.json`：`dist` 改走 `build-config.mjs --exec`；新增 `verify:artifacts` / `check-pure-js-deps`。

### 日志与脱敏（裁定4：仍是唯一那一份）
- `packages/app/src/main/logger.ts`（modify）：`MAX_LOG_FILES` 5→7；新增 `configureLogging()` / `logDir()` / `createLogger(scope)` 重载 / `logFiles()`；每行恒含 `correlationId`（缺省自动生成）/`runtimeId`/`sessionId`/`scope`；**redactSecrets 移进唯一写盘函数 `writeLine`**，因此连 `event` 名本身都会被脱敏（改前 event 明文落盘）。
- `packages/app/src/main/logger-redact.ts`（modify）：新增 `redactText()`（字符串入口，不截断）；`SECRET_KEY_RE` 加 `^key$`/`^api_key$` 精确匹配；新增内嵌 JSON `"key":"..."` 规则（保留键名）、通用 Windows/POSIX 家目录归一、`process.env` 里名字像密钥的值；`Bearer` 正则改为不吞引号（否则诊断包里的 JSON 会被脱敏毁成语法错误）。

### 健康检查、安全模式、marker
- `packages/app/src/main/health/health-check.ts`（新）：`runStartupHealthCheck(probes)`，三项并发、各 5s 超时，永不 reject。
- `packages/app/src/main/health/safe-mode.ts`（新）：连续 2 次失败进安全模式；**一次成功即计数归零并退出**；被禁用能力逐条列出。
- `packages/app/src/main/health/update-markers.ts`（新）：pending-update / last-known-good / health 三个 marker，一律经 `fs-atomic.ts` 的 `writeJsonAtomic`；读坏当不存在。
- `packages/app/src/main/health/startup-health.ts`（新）：electron 侧三个真实探针 + 「只在更新后第一次启动才跑」的判据。
- `packages/app/src/main/update/update-service.ts`（modify）：`quitAndInstall` **之前**写 pending-update marker（经新增的可选 `deps.markers`），写失败留痕但不阻断安装。
- `packages/app/src/main/update/update-types.ts`（modify）：新增 `UpdateMarkerSink`。
- `packages/app/src/main/update/update-ipc.ts`（modify）：注入 markers。
- `packages/app/src/main/update/runtime-version-policy.ts`（新，UPD-007）：`assertNoRuntimeNpmUpdate()`、external pi 兼容范围判定（只检测不改用户环境）。

### 诊断包
- `packages/app/src/main/diagnostics/support-bundle.ts`（新）：`previewBundle()` 只出清单不写盘；`exportBundle(targetPath, sources)` 文本条目全部过 `redactText`；crash dump 仅在 `crashDumpConsent === "allow"` 时收且清单里明标 `redacted:false`；内置最小 ZIP 写入器用 **STORE 不压缩**（无第三方依赖，且单测能在字节流里直接搜密钥）。
- `packages/app/src/main/diagnostics/diagnostics-ipc.ts`（新）：3 条通道经 `ipc-guard.registerHandler` 注册，均**不接受路径形参**，导出位置由主进程保存对话框决定。
- `packages/app/src/main/ipc-registry.ts`（modify）：追加 `registerDiagnosticsIpc()`。

### 契约与 UI
- `packages/contract/src/diagnostics.ts`（新）+ `channels.ts`/`ipc-contract.ts`/`index.ts`（append-only）：3 条通道 + schema。
- `packages/contract/src/settings.ts`：新增 `crashDumpConsent`（默认 `unset` —— 没问过就当没同意）。
- `packages/app/src/preload/api/diagnostics.ts`（新）+ `api/index.ts`（append-only）。
- `DiagnosticsPanel.vue`（新）、`SafeModeBanner.vue`（新）、`SettingsModal.vue` / `AppShell.vue`（append-only 挂载）。
- `packages/app/src/main/index.ts`：`configureLogging()`；窗口就绪触发改为 `ready-to-show` 与 `did-finish-load` **先到者生效**（见「真机发现的回归」）。

### 文档
- `docs/product/RELEASE_SETUP.md`（新）、`docs/product/ADR-0001-update-feed.md`（新）。

### 测试（新增 5 个 spec / 42 条）
`test/logger-redact.spec.ts`、`test/logger.spec.ts`（追加轮转/上下文键/出口脱敏）、`src/main/health/health-check.test.ts`、`src/main/diagnostics/support-bundle.test.ts`、`test/release-workflow.spec.ts`、`test/runtime-version-policy.spec.ts`、`test/diagnostics-ipc.spec.ts`。

---

## 真机发现的回归（本 task 最重要的产出）

**`win.once("ready-to-show", ...)` 从来没有触发过。**

打包版实测：`app_ready` 之后再没有任何来自该回调的日志。这意味着 TASK-011 交付的
`armUpdateChecks()`（30 秒后首次更新检查 + 后续 4h 调度）**在真实启动里一次都没跑过** ——
`update_service_created` 之所以出现在日志里，是渲染进程 mount 时调 `update:get-state`
懒构造出来的，与调度无关。三大门禁全绿、508 个测试全过，而自动更新检查是死的。

修复：`ready-to-show` 与 `webContents.did-finish-load` 两个事件都挂，先到者生效并去重，
并加一行 `window_ready` 日志让这件事以后可被观测。

同一轮真机验证还抓到两个探针 bug（两者都会让更新后健康检查**必然误判失败**）：
1. `rendererReady` 只挂 `once("did-finish-load")`，而探针恰恰是被 did-finish-load 调起的 ——
   事件不会再发第二次，Promise 永远不 resolve，实测每次恰好卡满 5000ms 超时。已改为
   事件 + 100ms 轮询双保险。
2. `piHandshake` 在未打包环境读 `process.resourcesPath/pi-runtime`，dev 下那里恒不存在。
   已改为 `!app.isPackaged` 时放行。
3. `startup-health.ts` / `diagnostics-ipc.ts` 的 logger 建在模块顶层，而模块 import 早于
   `configureLogging()`，日志会落在 `%TEMP%` 而不是 userData/logs。已改为惰性构造。

---

## Verification

### 机器判据（逐条实跑）

| # | 条件 | 命令 / 结果 |
|---|---|---|
| c0 | yml 无 npmmirror；mac 有 dmg+zip+hardenedRuntime+entitlements+麦克风说明 | `rg -c npmmirror … \| wc -l` = **0**；release-workflow.spec 断言全过 |
| c1 | win 三件套 + verify 脚本 | `pnpm dist -- --win nsis --publish never` → `latest.yml` / `PiBuddy-Setup-0.1.0.exe` / `.exe.blockmap` 全在；`verify-release-artifacts.mjs win` **exit 0**；反向：`mac` **exit 1**（缺 3 项）、不存在目录 **exit 1** |
| c2 | 失败关闭 + 两 job + needs + 清单最后发 | `rg -c 'needs: upload-artifacts'` = **1**；`if [ -z "${WIN_CSC_LINK}" ] … exit 1` 存在；release-workflow.spec 按 step 下标断言最后一步是 `Publish channel manifests last` |
| c3 | action SHA 固定 | `check-workflow-pins.mjs` **exit 0**；rg 等价式两文件均输出 **0**。**非恒真复验**：临时样本（3 行 uses，1 行未固定）→ rg 匹配 3 行 / 未固定 1 行，脚本 **exit 1** 并报 `sample.yml:8` |
| c4 | 四类样本脱敏 + `export redactSecrets` 计数 | `logger-redact.spec.ts` 8 条全过；计数 = **1** |
| c5 | 轮转参数 + 8 文件 + 丢最旧 + 无第二个 logger | 两个 `rg -c` 均 = **1**；轮转单测断言目录恰 8 文件且残留最旧 mtime > 已丢弃项；`test ! -e src/main/logging/logger.ts` OK；`export function createLogger` 计数 = **1** |
| c6 | support bundle 预览 + zip 内无假 key | `support-bundle.test.ts` 4 条全过（zip 原始字节 `includes(FAKE_KEY)` = false，magic `504b0304`） |
| c7 | health check + marker | `health-check.test.ts` 8 条全过 |
| c8 | UI-observable | 见下「真机 UI 验证」 |
| c9 | RELEASE_SETUP.md | 存在；secret 字面量命中 **15**（≥6）；`sk-\|BEGIN…` 命中 **0**；含「轮换」×6、「hotfix」×4 |
| c10 | ADR 六个字符串 + yml 无 `asar: false` | 六串全部命中；`rg -c 'asar: false' … \| wc -l` = **0** |
| c11 | 契约唯一性 + 新文件 import contract | `check-contract-uniqueness.mjs` **exit 0**；10 个新 .ts 逐个 `from "@pibuddy/contract"` ≥ 1 |
| c12 | 脱敏在写出函数体内 | 脚本判定：`writeLine`（含 `fs.appendFileSync`）覆盖 177–205 行，唯一 `redactSecrets` 调用在 **178** 行 → 在函数体内。单测 `createLogger('main').info('sk-ant-0123456789abcdef')` 落盘不含该串 |
| c13 | 脱敏不误伤 | 三样本 `index.ts` / `session-abc123` / `runtimeId=7f3a` 逐字符相等 |
| c14 | 必填上下文键 | 每行 JSON 含三键；未提供 correlationId 时自动生成非空串 |
| c15 | health check 有超时 | fake timers：4999ms 未 settle，5001ms settle 且该项在 failed 内，其余项不受影响 |
| c16/c21 | marker 原子写 | `writeJsonAtomic` 在 health/ 命中 **5**（≥2）；`fsyncSync\|renameSync` 命中 **0**；单测断言抛错时原文件字节相等且无残留 `.tmp` |
| c17 | safe mode 有出口 | fail→fail→`active=true`→success→`consecutiveFailures=0` 且 `active=false` |
| c18 | 镜像正负成对 | `PIBUDDY_USE_CN_MIRROR=` → 输出 npmmirror **0**；`=1` → **3**；yml **0**；release.yml 三关键词 **0** |
| c19 | IPC 守卫结构 | 全仓 `ipcMain.(handle\|on)` 除 ipc-guard 外 = **0**；`diagnostics-ipc.spec.ts` 断言 3 条通道进注册表、契约里有 schema、表长 ≥3 |
| c20 | 外链出口唯一 | `shell.openExternal` 命中 **0**（导出后定位用 `shell.showItemInFolder`，非 openExternal） |
| c22 | 唯一 vitest 配置 | `git ls-files` 命中恰 `vitest.config.ts` + `vitest.workspace.ts` 两行；`check-test-discovery.mjs` **exit 0**，discovered 62 = onDisk 62（详见 Deviations） |
| c23 | ci.yml 只 modify | 四项 contains 全过（含新增 check-workflow-pins.mjs） |
| — | UPD-007 | `rg 'npm (update\|i -g\|install -g)' packages/app/src` 除策略文件本身外 **0 行** |

### 真机验证（打包版 + preview 版）

杀进程一律 `powershell Stop-Process -Force` 并核对计数归 0 与 StartTime。

1. **打包版启动 + pi runtime 完好**：`release/win-unpacked/PiBuddy.exe` 启动，5 个进程存活，
   日志 `pi_runtime_handshake_ok {bundledVersion:"0.83.0"}` —— asar + extraResources + afterPack
   的 node_modules 补齐链路未被破坏。
2. **新日志格式落地**：真实日志每行含 `scope` / `correlationId` / `runtimeId` / `sessionId`。
3. **无 pending marker**：`startup_health {ran:false}`，写出 `last-known-good.json`，不跑三项检查。
4. **有 pending marker（打包版）**：植入 `pending-update.json` 后启动 →
   `post_update_health_check_start` → `post_update_health_check_ok
   {durations:{db-migration:5, renderer-ready:125, pi-handshake:1}}` → `startup_health {ran:true, ok:true}`
   → `last-known-good.json` 更新、`pending-update.json` 已清除。
5. **失败路径（preview 版，探针修复前）**：`post_update_health_check_failed
   {failed:["renderer-ready","pi-handshake"], consecutiveFailures:1}`，`health.json` 落盘，
   pending marker **保留**。这一次实跑正是上面两个探针 bug 的来源。
6. **safe mode 横幅（CDP 取证）**：植入 `consecutiveFailures:2, safeMode:true` 后启动，
   页面文本实测为「已进入安全模式 / 上次更新之后启动检查连续失败 2 次（内置 Pi 运行时）/
   三条被禁用能力 / 上一个正常启动过的版本是 0.1.0 / 查看诊断 / 下载上一稳定版本（0.1.0）」。
7. **诊断面板（CDP 取证）**：设置弹窗内点「生成诊断包」→ 实测渲染
   「共 5 个文件，约 43.5 KB」+ 逐条清单（路径 · 大小 —— 说明）+ 「已脱敏」分组 +
   崩溃转储三选一单选组。
8. **诊断 IPC 端到端**：`window.piBuddy.diagnostics.previewBundle()` /
   `.getHealthReport()` 经四道闸真实往返，返回结构与契约一致。

## Tests

- `pnpm typecheck` — **PASS**
- `pnpm -w test` — **PASS，63 文件 / 508 用例全绿**（本 task 新增 42 条）
- `pnpm build` — **PASS**
- `pnpm --filter @pibuddy/app dist -- --win nsis --publish never` — **PASS**
- `node packages/app/scripts/verify-release-artifacts.mjs win` — **exit 0**
- `node scripts/check-workflow-pins.mjs` — **exit 0**
- `node scripts/check-contract-uniqueness.mjs` / `check-test-discovery.mjs` / `check-pure-js-deps.mjs` — 全 **exit 0**

## Deviations

1. **M4 出口门禁：`blocked-by-credential` / `not-tested (no clean VM)`**（用户 2026-08-02 已确认接受）。
   本 task **未产出任何已签名的正式包**，**未执行**真实 N→N+1 闭环。Windows/macOS/Linux 签名与
   公证、正式下载域名、GitHub owner/repo 的真实值均未编造，release job 保持失败关闭。
   状态表写在 `docs/product/RELEASE_SETUP.md` §0。
2. **c19 的「registerAllIpc() 之后遍历注册表」改为 `registerDiagnosticsIpc()` 之后遍历。**
   理由：`registerAllIpc()` 会 import TASK-012 正在改写中的 `pi-resources-ipc.ts`，让本断言的
   通过与否取决于并行任务的瞬时状态。断言内容（3 条通道在表内、每条在 `CHANNEL_CONTRACTS`
   里有 schema、表长 ≥3、确实落到 ipcMain）一条未减，且不引用任何 handler 文件路径。
3. **c22 的 `find` 输出为 4 行而非 2 行**，多出的两条是
   `packages/app/resources/pi-runtime/node_modules/@mistralai/…/vitest.config.ts` 与
   `packages/app/release/win-unpacked/…` 同一文件的副本。两者都在 `.gitignore` 内
   （`release/`、`packages/app/resources/pi-runtime/`），`git ls-files` 命中恰为
   `vitest.config.ts` + `vitest.workspace.ts` 两行。**本 task 未新建任何 vitest 配置**，
   该现象是 TASK-003 投递 pi-runtime 时带进来的第三方文件，判据本身的 find 排除项没覆盖到。
4. **`packages/app/src/renderer/src/stores/app.ts` 被改了一行**（占位设置对象补
   `crashDumpConsent: "unset"`）。该文件是 TASK-012 的领地，但契约新增带默认值的字段后
   typecheck 必然在此处红。属「只增不改他人条目」，未触碰 uiRequests 分支。
5. **`packages/app/src/main/update/update-types.ts` 被改了**（新增可选 `markers` 与
   `UpdateMarkerSink`）。files[] 只列了 `update-service.ts`，但 marker 注入点的类型必须落在
   deps 接口上；设为可选，TASK-011 既有单测零改动。
6. **`assertNoRuntimeNpmUpdate()` 放在 `main/update/runtime-version-policy.ts`
   而不是「pi-launcher 旁」**：`main/pi-launcher.ts` 是 TASK-012 的并行边界，硬约束禁止触碰。
7. **`redactSecrets` 未改成 `(input: string): string`**：c4 的机器判据要求
   `export (function|const) redactSecrets` 全仓计数恰为 1，加重载签名会让计数变成 3。
   改为保留原 `(input: unknown)` 签名并新增 `redactText(input: string): string` 作为字符串入口。
8. **发布落点用 GitHub Release + generic feed 两段式**：`publish-manifest` 用
   `gh release upload` 把产物与清单分两步传到本仓库的 Release，由产品所有者的 CDN 把
   Release 同步到 `PIBUDDY_UPDATE_FEED_URL`。客户端只认 generic feed，二进制里没有任何 token。
9. **首次全量 `pnpm -w test` 时 `session-index.bench.test.ts` 超时一次**（20s 门限）。
   单独重跑 3.0s 通过，二次全量重跑 508/508 全绿。原因是 TASK-012 新增的
   `resource-scanner.test.ts`（单文件 13~19s）与之并发抢 CPU，非本 task 引入的回归。
10. **提交范围包含了 TASK-012 的在途文件。** 二者共用
    `packages/contract/src/{channels,ipc-contract,index}.ts` 与
    `packages/app/src/main/ipc-registry.ts`、`preload/api/index.ts`：只提交我的改动会让
    这些共享文件引用到未提交的文件，产出一个编译不过的树。提交时全仓 typecheck +
    508 测试 + build + dist + 真机启动均已验证通过。

## Notes

- **`ready-to-show` 那条修复对后续任何任务都重要**：只要有人再往窗口就绪回调里加逻辑，
  在没有这条修复的分支上都会静默不执行。
- `redactText` 是脱敏的**字符串入口**（不截断长度），`redactSecrets` 是结构化入口
  （对字符串会截到 512 字符）。收整份文本文件时必须用前者。
- `build-config.mjs` 的 `--exec` 形态是 `dist` 脚本的唯一入口；直接调 `electron-builder`
  会绕过镜像/feed 注入。
- 诊断包的 zip 刻意用 STORE 不压缩，日志按尾部 1MB × 最多 4 个文件收集
  （`MAX_LOG_TAIL_BYTES` / `MAX_LOG_FILES_IN_BUNDLE`）。要换成 deflate 的话，
  `support-bundle.test.ts` 里那条「zip 字节流里搜不到假密钥」的断言会退化成恒真。
- `SafeModeBanner.vue` 里「下载上一稳定版本」指向本仓库 releases 页；正式下载域名确定后
  需替换（`RELEASE_SETUP.md` §1 第 6 项）。
