# FIX-update-release —— 更新 / 发布四条缺陷

基线 HEAD `299301d`。四条全部先复核确认存在，再动手。

**M4 的签名 / 公证 / 真实 N→N+1 闭环仍是 `blocked-by-credential`**（RELEASE_SETUP.md
规定 GitHub owner/repo、Windows signing identity、Apple Team/Developer ID/notarization
credential 必须由产品所有者配置）。本次只修状态机正确性与配置一致性，**未触及签名闭环**。

---

## 1（P2）更新通道切换不会作废旧检查或下载

### 复核确认
`update-service.ts` 原 `setChannel` 只做三件事：`savePrefs` → `initAutoUpdater` →
`commit({channel, candidateVersion: null, status: "idle"})`。没有取消 `cancelToken`，
没有复位 `downloadInFlight`，事件处理器上没有任何代际判据。

关键发现：**`initAutoUpdater` 里的 `removeAllListeners` 解决不了这个问题**。它摘掉的是
旧的*监听器*，而旧请求的回调是在同一个 emitter 上发出的，落进的是**新挂上去的**监听器。
判据必须挂在「这次请求属于哪一代」上，而不是「这个监听器属于哪一代」。

### 修法：两道独立闸门
口径参照 `main/pi-supervisor.ts` 的 runtime generation。新增字段刻意与既有的
进程 `generation`、`state.stateSequence`、信封 `sequence` 三者区分开：

- `channelGeneration` —— 每次 `setChannel` +1
- `opGeneration` —— 最近一次启动的检查/下载所属代际

| 闸门 | 位置 | 拦住什么 |
|---|---|---|
| A 代际 `dropStale()` | 六个 updater 事件处理器 | 切换之后、新任务开始之前回来的全部旧事件 |
| B 通道 `matchesChannel()` | `onAvailable` / `onDownloaded` | 新任务已开始（代际追平）时，stable 通道仍拒绝带 prerelease 的候选 |

B 是必需的，不是冗余：用户切到 stable 后又点了一次「检查更新」，`opGeneration` 追平，
A 就失效了；此时旧 beta 响应回来只能靠 B 拦。反方向（stable→beta 收到正式版）刻意放行 ——
beta 通道按定义是 stable 的超集。

另外两处：`setChannel` 调 `abortInFlight()`（取消令牌 + 丢弃已下载产物 + 复位
single-flight 锁 + 退订 idle wait）；`checkForUpdates` / `downloadUpdate` 的 `finally`
加代际门禁 —— 否则被作废的旧任务收尾时会把**新任务**的 single-flight 锁解开。

### 回归测试 + 对拍
新增 `update-channel-switch.test.ts`（8 条）。四个机制**逐个**拆掉对拍：

| 对拍 | 拆掉什么 | 结果 |
|---|---|---|
| C | `dropStale` 恒返回 false | **3 failed / 5 passed** |
| D | `downloadUpdate` finally 的代际门禁 | **1 failed / 7 passed**（single-flight 那条） |
| E | `matchesChannel` 恒 true | **1 failed / 7 passed**（B 组那条） |
| G | `setChannel` 不再复位 `status` | **4 failed / 4 passed** |

还原后 `8 passed (8)`。

**修正了一条恒真断言。** 初版 A.1 写的是 beta→stable + beta 候选，对拍 C 下**依然是绿的** ——
它同时踩中通道闸门，测的根本不是代际。改成 stable→beta + 正式版候选 `2.0.0`（beta 通道
按定义接受正式版，只剩代际一条判据）后，对拍 C 由 2 failed 变 3 failed。

**另一条恒真断言留痕。** 对拍 F（拆掉 `abortInFlight` 里 `downloadedPath = null` /
`expectedSha512 = null` 两行）**全绿** —— 原 C 组标题声称验证「丢弃已下载产物」，实际
起作用的是 `status` 复位。已把标题与注释改成它真正验证的机制（对拍 G 证明可证伪），
并在注释里写明那两行是走公开 API 无法单独失效的第二层保险。代码保留，断言不撒谎。

---

## 2（P2）更新版本比较不符合 SemVer

### 复核确认
- 正则 `/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/` **无结尾锚** → `1.2.3junk` 前缀匹配成 `1.2.3`
- prerelease 按字符串比 → `"10" < "2"`，`beta.10` 被判成比 `beta.2` 旧

### 修法：不引依赖，手写严格实现

**这一条偏离了审计建议（"直接用成熟的 semver 实现"），理由如下：**

1. 需要的只是 `compareSemver` 一个函数，semver 包 ~1500 行解决 30 行的问题；
2. `externalizeDepsPlugin` 默认把 `dependencies` 留成 external，而本仓刚被
   「解析库留成 external → 装完之后 ERR_MODULE_NOT_FOUND」咬过一次，新增主进程运行时
   依赖正是那条历史雷区；
3. 加依赖要动 `pnpm-lock.yaml`，与并行 agent 撞车风险；
4. 本仓已有同样取舍的先例：`release-workflow.spec.ts` 明确写了「为断言四条结构规则
   引一个 yaml 依赖会立刻撞上 check-pure-js-deps 闸门」，因此用行扫描。

作为补偿，测试用 **semver.org §11 规范给出的优先级链**当预言机逐对断言，而不是自造样例。

改动（`release-integrity.ts`）：严格文法（结尾锚 `$`、数字段禁前导零、build metadata
解析后丢弃、保留 `v` 前缀）；prerelease 拆成点分标识符数组；`compareIdentifier` 纯数字
按**数值**比、数字标识符低于字母数字、全等则字段多的更大。新增导出 `isPrerelease()`
（畸形版本号一律当 prerelease —— 它绝不该进 stable 通道）供缺陷 1 的通道闸门使用。

### 回归测试 + 对拍
`release-integrity.test.ts` 17 条（新增 7 条）。用例用的正是审计点名的
`beta.2` vs `beta.10`、`1.2.3junk`：

| 对拍 | 拆掉什么 | 结果 |
|---|---|---|
| A | 去掉结尾锚 `$` | **3 failed / 14 passed** |
| B | prerelease 数字段改回按字符串比 | **3 failed / 14 passed** |

还原后 `17 passed`。

依赖闭包未变，`check-pure-js-deps` / `check-update-deps` 未受影响（`update-deps.test.ts` 仍绿）。

---

## 3（P2）发布文档与 workflow 的 environment 配置不匹配

### 复核确认
`RELEASE_SETUP.md:44` 要求把 secrets 放在 `release` environment；`release.yml` 的
`preflight` / `upload-artifacts` / `publish-manifest` **三个 job 全都没有 `environment:`**。
后果不是「拿不到密钥」这种明确报错，而是 `${{ secrets.X }}` 全为空串 → preflight 把每一项
判成 missing 然后 exit 1，用户对着一个配好的仓库排查。同时失去 environment 的审批门禁。

### 修法
三个消费 secrets 的 job 全部加 `environment: release`（保留审批门禁）。
文档补 §2.1：列出哪三个 job 声明了它、为什么、以及 required reviewers 时审批会在
三个阶段各请求一次（第一次批「允许开始构建」，最后一次批「允许把清单推给全网」）。

### 回归测试 + 对拍
`release-workflow.spec.ts` 新增断言：三个 job 都必须匹配 `environment: release`，
且文档侧必须出现同一个 environment 名（把文档与 workflow 钉在一起）。

对拍 H：从 `publish-manifest` 删掉 `environment: release` → **1 failed / 12 passed**。还原后全绿。

`check-workflow-pins.mjs` 仍 `OK（2 个 workflow，全部 action 已 SHA 固定）`。

---

## 4（P3）常规 CI 没有覆盖真正的安装包链路

### 复核确认
`ci.yml` 只有一个 `verify` job，跑到 `pnpm build`（= `electron-vite build`）为止。
`prepare-pi-runtime` / `afterPack` / `electron-builder` / packaged smoke **一个都没有**。

### 修法
新增 `packages/app/scripts/verify-packaged-app.mjs` + `ci.yml` 的 `package` job。

用 `--dir` 而不是全量打包：不产出安装包（省掉 NSIS/DMG 的大头），但
`prepare-pi-runtime` → `electron-vite build` → `electron-builder`（含 `afterPack`、
`asar`、`asarUnpack`、`extraResources`）一步不落地跑完。成本控制：PR 只跑 ubuntu，
push 到 main 补 windows（`fromJSON` 条件矩阵，表达式写成一行 —— `${{ }}` 里换行在
Actions 表达式解析器上不是稳定行为）。

`verify-packaged-app.mjs` 五项判据，直接对着本仓历史上那两个致命坑：
1. `pi-runtime/node_modules` 与源**逐文件**对账（extraResources 吞 node_modules：19371 → 885）
2. `app.asar.unpacked/out/main/convert-worker.js` 存在
3. `app.asar.unpacked/out/main/chunks/` 非空
4. worker 与 chunks 里六个解析库**没有**以 bare specifier 形式 import（留成 external）
5. `app.asar` 存在（asar 没被关掉）

同一个脚本也接进 `release.yml` 的 `upload-artifacts`（在 `verify-release-artifacts` 之前）。

### 对拍（对着真实产物做，不是构造的假目录）
| 对拍 | 模拟的历史缺陷 | 结果 |
|---|---|---|
| 移走 `pi-runtime/node_modules/@anthropic-ai` | extraResources 吞 node_modules | **FAIL** `源 18486 个文件，产物 17542 个`，exit 1 |
| 移走 `app.asar.unpacked/out/main/chunks` | chunks 未被 asarUnpack 外置 | **FAIL** `chunks/ 为空` |
| 往 convert-worker.js 追加 `import __probe from "mammoth"` | 解析库留成 external | **FAIL** `仍以 external 方式 import "mammoth"` |

三次还原后均 `OK（校验 1 个产物目录）`。

对拍 I：从 `ci.yml` 删掉 `Verify packaged artifacts` step → **2 failed / 11 passed**。还原后全绿。

### CI 真的触发了一次
见文末「CI 实跑（run 30793998863）」—— 两个平台的 package job 都在真实 runner 上跑通了。

---

## 收尾验证（真实输出）

```
pnpm typecheck   →  packages/pi-sdk Done / packages/contract Done / packages/app Done   exit 0
pnpm -w test     →  Test Files 94 passed | 1 failed (95)   Tests 855 passed | 1 failed (856)
                    ↑ 见下方「perf flake」
  --project unit →  Test Files 92 passed (92)   Tests 844 passed (844)
  --project perf →  Tests 12 passed (12)
pnpm build       →  ✓ built in 18.90s
electron-builder →  • pi runtime deps copied  files=18486
                    • building target=nsis file=release\PiBuddy-Setup-0.1.0.exe
verify-packaged-app.mjs    →  OK（校验 1 个产物目录）   exit 0
verify-release-artifacts.mjs win → OK  平台=win 版本=0.1.0
```

测试总数 817 → 856（新增 39 条：channel-switch 8、semver 7、verifyBeforeInstall 2、
isPrerelease 2、workflow 结构 4，其余为既有用例内的分组）。

### perf flake（非本次改动引入）
全量 `pnpm -w test` 期间偶发 1 条 perf 预算测试红，两次分别是
`chat-window.perf` 与 `resource-scanner` 的 `不阻塞事件循环`。
**单独跑 `--project perf` 12 条全绿**（已复跑确认）。原因是并行 agent 同时在跑
electron-builder，机器负载把耗时预算撑破。我的改动不触及这两条路径。

### 真机启动（`release/win-unpacked/PiBuddy.exe`）
两次启动，均 5 个进程、主窗口标题正常。

第一次（无 feed 配置）：
```
update_service_created  isPackaged=true fakeFeed=false status=idle cancelSupported=true
pi_runtime_resolved     runtimeSource=bundled bundledVersion=0.83.0 protocolVersion=1
pi_runtime_handshake_ok
update_error            code=network detail=net::ERR_CONNECTION_CLOSED   ← 占位 feed，失败关闭符合预期
```

第二次（`PIBUDDY_FAKE_UPDATE_FEED` + `scripts/fake-update-server.mjs` 驱动状态机）：
```
update_service_created  fakeFeed=true status=idle
updater  msg="Checking for update"
updater  msg="Found version 0.2.0 (url: PiBuddy-Setup-0.2.0.exe)"
[fake-feed] GET /latest.yml
```
**关键回归判据：`update_stale_event_dropped` / `update_off_channel_candidate_dropped`
命中数 = 0** —— 两道新闸门在合法路径上零误伤。update 错误数 0。

收尾进程核对：`Stop-Process -Force` 后 PiBuddy 进程数 **0**，fake-feed 端口 8788
`Test-NetConnection` 返回 False，`dev-app-update.yml`（gitignored）已清理。

---

## CI 实跑（run 30793998863，push b0fe003）

```
✓ package (ubuntu-latest)   1m25s     ← 新增
✓ package (windows-latest)  4m35s     ← 新增
✓ verify  (ubuntu-latest)   2m29s
X verify  (windows-latest)  3m15s     ← 见下「CI 既有红」
```

新 package job 在**真实 runner** 上的输出，两个平台都跑通了完整打包链路：

```
package (windows-latest)
  [prepare-pi-runtime] 已复制 126 个依赖包
  • packaging  platform=win32 arch=x64 electron=43.2.0 appOutDir=release\win-unpacked
  • pi runtime deps copied  files=18462
  ✓ [win-unpacked] pi-runtime 依赖 18462 个文件，与源一致
  ✓ [win-unpacked] convert-worker 与 11 个 chunk 已外置且无 external 解析库
  verify-packaged-app: OK（校验 1 个产物目录）

package (ubuntu-latest)
  • packaging  platform=linux arch=x64 electron=43.2.0 appOutDir=release/linux-unpacked
  • pi runtime deps copied  files=18450
  ✓ [linux-unpacked] pi-runtime 依赖 18450 个文件，与源一致
  ✓ [linux-unpacked] convert-worker 与 11 个 chunk 已外置且无 external 解析库
  verify-packaged-app: OK（校验 1 个产物目录）
```

`fromJSON` 条件矩阵按预期工作：push 事件下 ubuntu + windows 都跑到了。
afterPack 在两个平台上都真的执行了（文件数与源一致）。

### ⚠️ CI 既有红（非本次引入，需另行处理）
`verify (windows-latest)` 的 `Test` step 在**我提交之前就已经红了**，
上一次 run 30789633013（commit 299301d）同样是它：

```
× workspace_id 跨重启稳定（裁定3） > 重开索引 DB 后，同一目录仍能查回全部会话
  AssertionError: expected +0 to be 2
  packages/app/src/main/sessions/session-index.test.ts
× 大小与收容 > openAttachment / revealAttachment 只接受凭证，且是唯一触达 shell 的路径
  AssertionError: expected "spy" to be called with arguments: [ Array(1) ]
  packages/app/test/attachment-registry.spec.ts
Tests  2 failed | 815 passed (817)
```

两条都是 **Windows 专有**（ubuntu 全绿），落在 sessions / attachments，
不在我的地盘，本次未动。「817 全绿」这个基线只在本机 Windows 与 CI ubuntu 成立，
**CI windows 上从来没绿过**。建议单独派一条修复。

---

## 过程中的发现（未改，仅留痕）

1. **并行构建互相摧毁。** `pnpm dist` 连续两次 `ENOTEMPTY: packages/app/resources/pi-runtime`，
   一次 `复制后入口缺失`。查进程发现 PID 110440 是**另一个 agent** 正在跑
   `prepare-pi-runtime.mjs` —— 两个 agent 的 prepare 对同一个 `resources/pi-runtime`
   互删。我一度加了 `rmSync maxRetries/retryDelay` 并写了「杀毒软件持有句柄」的注释，
   诊断出真因后**已完整还原**（`git diff` 该文件为空）——不给一个没验证过的成因写修复。
   绕法：确认 pi-runtime 完好（18486 文件）后跳过 prepare，只跑 build + electron-builder。

2. **`packages/app/test/**` 不在任何 tsconfig 的 include 里**
   （`tsconfig.node.json` 只收 `src/main`、`src/preload`；`tsconfig.web.json` 只收
   `src/renderer/src`）。`release-workflow.spec.ts` 因此从不被 `tsc` 检查，vitest 也只
   transpile 不查类型。既有状况，未改（超出本次范围）。

3. `verify-packaged-app.mjs` 写第一版时块注释里的 `mac*/` 提前终止了注释、
   吞掉后面的反引号导致语法错误。已改成 `mac<arch>/`。

## 未触碰（并行边界）
`AppShell.vue`、`stores/piResources.ts`、`ProjectTrustDialog.vue`、`main/preview/**`、
`main/artifacts/**`、`main/diagnostics/**` 全部未动。提交按路径逐个 `git add`，
未使用 `-A` / `.`。
