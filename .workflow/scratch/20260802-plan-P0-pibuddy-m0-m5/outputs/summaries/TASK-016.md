# TASK-016: ART-101 + ART-102 受限沙箱预览、Office/PDF 转换与 Artifact 仓库

M5 收官，全计划最后一个 task。

## Changes

### 契约（唯一真相源）
- `packages/contract/src/preview.ts`（新）：`PreviewKind` 十类、`PreviewErrorCode` 六类、`PreviewCode`（ok + 六类）、`PreviewResult`（含 `notices`）、`PreviewTarget`（`token` / `workspaceId`+`relativePath`）、`PreviewHandle`。
- `packages/contract/src/artifacts.ts`（新）：`ArtifactKind`、`ArtifactStatus`（generating/ready/failed/conflicted/trashed）、`ArtifactRecord`、`ArtifactComparison`、`ArtifactLink`（只有 artifactId+version+name，**没有路径字段**）。
- `channels.ts` +11 条：`preview:open|convert|close`、`artifacts:query|rename|duplicate|export|show-in-folder|trash|restore|compare-versions`；`ipc-contract.ts` 逐条挂 schema；`index.ts` 导出两个新模块。

### 主进程
- `main/preview/preview-types.ts`：扩展名 → PreviewKind 分派表 + 宿主↔worker 的进程间消息形状。
- `main/preview/convert-worker.ts`：跑在受限 utilityProcess 里的解析器。`SUGGESTION: Record<PreviewErrorCode,string>`、`OFFICE_SAFETY` 四项 disabled、`BLOCKED_OOXML_PARTS` 解析前剔除宏/远程模板/外链/数据连接/OLE/customXml、`redactExternalTargets` 打码 http(s)、十类分派、PPTX 用 jszip+fast-xml-parser 自建最小实现、PDF 只走 `extractText`。
- `main/preview/convert-host.ts`：`CONVERT_LIMITS`（50MB/100MB/30s/512MB）、`resolveWorkerPath()` + `rewriteAsarPath()`、`sanitizedEnv()`（白名单 + 清 `PIBUDDY_*`/`*_API_KEY`/`NODE_OPTIONS`）、专属临时目录 + finally 清理、超时 kill、子进程崩记 oom、输出尺寸封顶。
- `main/preview/preview-window.ts`：`PREVIEW_PARTITION`、`PREVIEW_CSP`、`shouldCancelRequest()`、`applyPreviewSessionPolicy()`（拦截 + CSP 头 + 两个 permission handler 全拒）、`previewWebPreferences()`（sandbox/contextIsolation/nodeIntegration:false/javascript:false/无渲染侧桥）、`renderPreviewHtml()` 全转义、按 previewId 的落盘目录 + 白名单 + 关窗即清。
- `main/preview/preview-ipc.ts`：3 条通道，两个定位型 handler 各自显式调 `resolveInWorkspace`。
- `main/artifacts/artifact-store.ts`：`artifacts` 表（14 个必需字段 + size_bytes）、status CHECK 约束、`(workspace_id, logical_key)` 版本链 version+1、`resolveLink(id, version)`、`verify()` → conflicted、`setStatus('trashed')` 只写两列、query/rename/duplicate/compare。
- `main/artifacts/artifact-ipc.ts`：8 条通道。
- `main/artifacts/artifact-tracker.ts`：tool_execution_start → generating，end → ready/failed。
- `main/ipc-registry.ts`：追加两个 register。
- `main/changeset/tool-watch.ts`（**scope 外，见 Deviations**）：3 行接上 artifact-tracker。

### preload / 渲染
- `preload/api/preview.ts`、`preload/api/artifacts.ts`（新）+ `index.ts` 聚合 → 14 个命名空间。
- `renderer/src/stores/artifacts.ts`（新）：产物库状态 + 预览缓存 + `previewRelativePath`。
- `PreviewPane.vue` / `ArtifactLibrary.vue` / `ArtifactLink.vue`（新）；`MessageItem.vue` 加 `artifacts` prop 渲染 ArtifactLink；`AppShell.vue` 加「📦 产物」入口 + PreviewPane 容器；`FileTreePanel.vue` 单击文件即预览。

### 构建
- `package.json`：mammoth 1.12.0 / exceljs 4.4.0 / unpdf 1.8.0 / papaparse 5.5.4 / jszip 3.10.1 / fast-xml-parser 4.5.3（无 `^`/`~`）+ devDep `@types/papaparse`。
- `electron.vite.config.ts`：新增 `convert-worker` 与 `preview-window` 两个 input；六个解析库从 externalize 里 **exclude**（打进产物）。
- `electron-builder.yml`：`asarUnpack: [out/main/convert-worker.js, out/main/chunks/**]`；`asar: true` / `npmRebuild: false` 一字未动。
- `packages/app/scripts/preview-sandbox-probe.cjs`（新）、`scripts/cdp-eval-main.mjs`（新）。

### 测试（+70 条，678 → 748）
`convert-host.test.ts`(10) / `convert-path.test.ts`(8) / `office-safety.test.ts`(10) / `preview-window.test.ts`(13) / `preview-ipc.test.ts`(10) / `artifact-store.test.ts`(13) / `artifact-link.test.ts`(6) + `fixtures.ts`（全部程序化构造）。

---

## Verification

三大门禁与全部结构断言实跑输出：

| 判据 | 命令 | 实际 |
|---|---|---|
| typecheck | `pnpm --filter @pibuddy/app typecheck` | 退出 0 |
| 全量测试 | `pnpm -w test` | **88 files / 748 tests passed** |
| 构建 | `pnpm --filter @pibuddy/app build` | 成功 |
| 打包 | `pnpm --filter @pibuddy/app dist` | `PiBuddy-Setup-0.1.0.exe` 产出 |
| 纯 JS 闸门 | `node packages/app/scripts/check-pure-js-deps.mjs` | `OK（扫描 83 个包，无原生扩展）` 退出 0 |
| 契约唯一性 | `node scripts/check-contract-uniqueness.mjs` | 退出 0，contract exports 285 |
| 测试发现 | `node scripts/check-test-discovery.mjs` | discovered 88 = onDisk 88，退出 0 |
| respond-ui | `node scripts/check-respond-ui-guard.mjs` | 退出 0 |
| workflow pins | `node scripts/check-workflow-pins.mjs` | 退出 0 |

结构断言（逐条实跑）：

```
preview-window.ts 中非 `preload: undefined` 的 preload: 行   0
convert-worker.ts 中 renderPageAsImage|@napi-rs/canvas       0   （extractText 命中 5）
artifacts/ 下 unlinkSync|fs.rm(                              0
preview-ipc.ts 中 resolveInWorkspace                         4  (>=3)
全仓 assertInsideRoot                                        0
全仓 ipcMain.handle|on（排除 ipc-guard.ts）                  0
全仓 shell.openExternal（排除 window-policy.ts）             0
全仓 attachmentId                                            0
AppShell 四个具名插槽                                        4
package.json 命中 @napi-rs/canvas|pdfjs-dist|pdf-parse|xlsx  0
electron-builder.yml `asar: false`                           0；`asar: true` 1；npmRebuild: false 1
electron-builder.yml 含 out/main/convert-worker.js           1
git 跟踪的 vitest 配置                                       2（根目录 config + workspace）
新增 main/preload 下每个 .ts 引 @pibuddy/contract            17/17 全部 >= 1
preview-window.ts 含 sandbox: true / nodeIntegration: false /
contextIsolation: true / partition: 'sandbox:preview' /
script-src 'none'                                            全部命中
convert-host.ts 四项上限字面量                               全部命中；含 app.asar.unpacked 2 处
```

### 真机验证（packaged 构建，asar: true）

**沙箱窗口三趟探针**（`npx electron scripts/preview-sandbox-probe.cjs [--pass=js|nocsp]`，各自独立进程，退出码均 0）：

```
pass nojs （生产配置）
PASS (nojs-a0) 生产配置下 https 请求连网络栈都没进
PASS (nojs-b0) JS 引擎关闭：连 executeJavaScript 都执行不了
PASS (nojs-load) 敌意文档本身照常加载出来了
pass js   （只打开 javascript）
PASS (js-a0) 生产配置下 https 请求连网络栈都没进
PASS (js-b) 内联脚本未执行
PASS (js-c) 没有任何资源真的被下载（每条时序的字节数都是 0）
pass nocsp（打开 javascript 且不注入 CSP —— 单独量 webRequest 那一层）
PASS (nocsp-a1) img 请求恰走到 onBeforeRequest 一次且被 cancel
PASS (nocsp-a2) script 请求恰走到 onBeforeRequest 一次且被 cancel
PASS (nocsp-a3) 全部 https 回调入参均为 {cancel:true}
PASS (nocsp-b) 阳性对照：拿掉 CSP 之后内联脚本确实执行了
PASS (nocsp-c) 没有任何资源真的被下载（每条时序的字节数都是 0）
```

**packaged 应用内的十类预览**（单击文件树条目 → 预览区 DOM 文本长度）：

```
报告.docx        Word    12   销售.xlsx  Excel 23（带表格）  幻灯片.pptx PPT 29
文档.pdf         PDF     36   表格.csv   CSV   20（带表格）  图片.png    图片 37（带 data URL）
笔记.md/代码.ts/数据.json/音频.wav（IPC 层实测）kind 与 code 全部正确、text 非空
恶意宏文档.docx  142  安全提示「⚠ 这个文档里带了 2 项被拦下的内容…word/vbaProject.bin」含宏=false 含http=false
恶意宏表格.xlsm  131  安全提示同上（xl/vbaProject.bin、xl/connections.xml）含宏=false 含http=false
损坏文件.docx    37   界面文案 === SUGGESTION.corrupt 逐字相等
有密码.xlsx      34   界面文案 === SUGGESTION["password-protected"] 逐字相等
主窗口外部请求数 0    未捕获异常 0
```

**沙箱预览窗口实测**（`preview:open` 打开恶意 docx 后经 CDP 直连该 target）：

```
url            file:///…/Temp/pibuddy-preview/<uuid>/preview.html
typeof window.piBuddy  "undefined"   ← 够不到主 renderer
含 CSP script-src 'none' true；正文可见 true；无 <script> true；无裸 http true
preview:close 之后：临时目录条目 0，page target 回到 1
转换临时目录 <temp>/pibuddy-convert 残留 0
```

**路径收容**：`preview:convert` 传 `../../../Windows/System32/drivers/etc/hosts` → `PATH_TRAVERSAL_REJECTED`；传绝对路径 → `PATH_ABSOLUTE_REJECTED`。

**Artifact 全链路（真 agent 跑通）**：让 Agent 写 `agent-产物.md` → 产物库出现 `version 1 / ready / sha256=7e7141fc… / 31 字节`；让它改写同一文件 → `version 2 / ready / sha=75d545d4… / 32 字节`，**v1 原样留着**；`compare(v1,v2)` → `identical:false, sizeDelta:1, degraded:"只能比大小和校验值：历史版本的内容没有单独存档…"`。

**产物库 UI（packaged）**：搜索「销售」→ 4 条筛到 1 条；比较两版 → 面板出「v2 ↔ v1 · 内容不同 · 体积差 6442 字节」；重命名 → 列表即时变 `第二周周报`；复制一份 → 磁盘真的多出 `销售 副本.xlsx`（6500 字节）；移入回收站 → 主列表消失、回收站视图出现且只有「恢复 / 导出」两个动作、**磁盘文件 12 字节原样在**；恢复 → 回到主列表并因 hash 不符标为「已被外部改动」。状态标签 generating / ready / failed / conflicted 均按预期渲染。

**未破坏的既有功能（packaged 实测）**：preload 14 个命名空间方法逐一在位；55 个可用模型；11 个 provider；文件树 / 编辑器 / 变更集 IPC 正常；一轮真实对话验证 **流式增长 ✓ thinking 折叠 ✓ steer 插话（`pi.steer({message})`，模型改口回「好的」）✓ abort（返回 true 且正文停止增长）✓**；更新子系统按预期报 network 错（本机无 feed）；safeMode=false。

---

## Convergence 逐条

| # | 结论 |
|---|---|
| c[0] preview-window 五项 + 无主 preload | **PASS** |
| c[1] 拦截/未执行/零资源 三条可观察副作用 | **PASS**（分三趟测；两处口径调整见 Deviations 1、2） |
| c[2] 四项硬上限 + timeout/too-large/env | **PASS** |
| c[3] 宏与外部内容默认禁用 | **PASS** |
| c[4] 四类错误码 + SUGGESTION + 原文件 sha256 不变 | **PASS** |
| c[5] artifact 表字段 + version+1 | **PASS** |
| c[6] 消息链接携带 artifactId+version | **PASS**（磁盘侧 + 组件侧各一半） |
| c[7] 六类预览 + 恶意样本 + 错误文案 | **PASS**（真机） |
| c[8] 产物库八个动作 + 状态 | **PASS**（真机） |
| c[9] typecheck + preview/artifacts 测试 | **PASS** |
| c[10] 六个精确版本、禁用清单 0 命中 | **PASS** |
| c[11] check-pure-js-deps 退出 0 | **PASS** |
| c[12] 不走 canvas 渲染路径 | **PASS** |
| c[13] asar/asarUnpack/npmRebuild | **PASS**（另加 chunks，见 Deviations 3） |
| c[14] packaged worker 路径解析 | **PASS**（`rewriteAsarPath` 纯函数） |
| c[15] 临时目录必被清理（50 次 / 20 次失败） | **PASS** |
| c[16] 十类正向 + 三类负向 | **PASS** |
| c[17] artifact 软删不动磁盘 | **PASS** |
| c[18] preview 输入必过 resolveInWorkspace | **PASS**（计数 4；close 的说明见 Deviations 4） |
| c[19] IPC 守卫结构断言 | **PASS**（11 条而非 6 条） |
| c[20] 外链出口唯一 | **PASS** |
| c[21] 不得新建第二个 vitest 配置 | **PASS**（见 Deviations 5） |
| c[22] 预览分区权限全拒 | **PASS** |
| c[23] preview 只收 attachment token | **PASS** |
| c[24] AppShell 插槽契约不变 | **PASS** |

---

## Deviations

1. **生产配置下 webRequest 收不到那两个 https 请求**，因此 c[1](a) 无法在生产配置里直接观测。实测原因：CSP 的 `default-src 'none'` 在渲染进程里就把它们掐了，**根本没进网络栈**——这比「进了网络栈再被 cancel」更强。webRequest 是它后面的兜底，探针因此增加 `--pass=nocsp` 一趟，把 CSP 拿掉后单独证明那一层是活的（两个请求各恰好一次、入参均 `{cancel:true}`）。同时加了阳性对照：nocsp 趟里内联脚本**必须真的执行**，否则 js 趟的「未执行」就是空洞通过。

2. **`performance.getEntriesByType('resource').length === 0` 在 Chromium 上做不到**：被拦掉的请求照样留下时序条目，只是 `transferSize` / `encodedBodySize` / `duration` 全为 0。判据改成「每一条的 transferSize 与 encodedBodySize 都是 0」，语义等价（一个字节都没进来），实测两条条目全 0。

3. **asarUnpack 额外加了 `out/main/chunks/**`**（计划只写了 convert-worker.js）。这是一次真机抓到的必然故障：六个解析库被打进 `out/main/chunks/` 下的动态 chunk，worker 外置后从 `app.asar.unpacked/out/main/` 起算相对路径去 import 它们，而 chunk 还在 asar 内——三大门禁全绿、dev 全绿、装完之后每次预览都 `ERR_MODULE_NOT_FOUND`。另外把六个库从 externalizeDeps 的 exclude 里排除（打进产物）而不是留成 external，否则模块解析同样落空。`asar: true` / `npmRebuild: false` 一字未动。

4. **`preview:close` 不调 `resolveInWorkspace`**：它的入参是 `preview:open` 返回的不透明 previewId，不是路径，没有可收容的东西，也不该假装有。c[18] 的计数 4（import 1 + open 1 + convert 1 + 注释 1）满足 `>= 3`。

5. **c[21] 的 `find` 在本机返回 4 行**，多出的两行是 `packages/app/release/…` 与 `packages/app/resources/pi-runtime/node_modules/@mistralai/…` 里 vendored 的 vitest 配置，两者都在 `.gitignore` 内（`git check-ignore` 已确认），不是仓库源码。改用 `git ls-files` 判定：恰为 `vitest.config.ts` 与 `vitest.workspace.ts` 两行。

6. **本任务新增 11 条 channel 而不是计划里的 6 条**（preview 3 + artifacts 8）。断言改为「PREVIEW_CHANNELS ∪ ARTIFACT_CHANNELS 逐一出现在 ipc-guard 注册表且契约里有 schema，且注册表长度 >= 6」。

7. **`rg -c "from '@pibuddy/contract'"`（单引号）在本仓库恒为 0**——全仓 prettier 用双引号。按引号无关的口径判定，17 个新增 .ts 文件全部 >= 1。

8. **改了 scope 外的 `main/changeset/tool-watch.ts`（+3 处调用）**。ART-102 的 generating/ready/failed 状态机必须挂在工具执行的两个时点上，而那是唯一的时点来源。改动是纯追加的：新建 `artifacts/artifact-tracker.ts`（在 scope 内）承载全部逻辑，tool-watch 只多了一个 import 与两处调用。

9. **改了 scope 外的 `renderer/src/components/FileTreePanel.vue`（单击文件即预览）**。这是真机抓到的「两端齐全、中间没人接」：转换链路、沙箱窗口、错误建议表全都在，PreviewPane 也挂在界面上，但**没有任何东西会去调它**——用户点遍整棵文件树，预览区永远停在「选一个文件来看看」。三大门禁对此全绿。

10. **契约新增 `PreviewResult.notices`**（计划里没有）。同样是真机抓到的：Excel 走 tables 渲染分支不渲染 text，安全提示原本拼在 text 尾部，于是**一个带宏的 .xlsm 在界面上一个字的警告都没有，而同样带宏的 .docx 却有**。提示搬进 `notices`，两条渲染分支都显示；office-safety 增两条断言守它。

11. **版本比较对同链两版如实降级**。同一条链的老版本与新版本指向同一个磁盘路径，而磁盘上只有最新那一份——直接读两次得到同一段文本，逐行 diff 是空的。空 diff 会被用户读成「两版一样」（以为改动丢了）。现在按 sha256 复核：内容取不到就置 `degraded` 并返回空 textDiff，同时 `identical:false` 与 `sizeDelta` 照常给。**历史版本内容不做单独存档**是本任务的既定范围，这里只是让它不撒谎。

12. **`renderPreviewHtml` 的加载方式从 data: URL 改成白名单目录内的 file://**。原写法被本分区自己的 `onBeforeRequest` 拦掉（顶层文档也要过那道闸）：窗口开出来永远空白、`loadURL` 的 promise 挂着不结算、零报错。探针第一次跑就卡死在这里。改成写文件 + `allowPreviewDir` 之后 `allowPreviewDir`/`forgetPreviewDir` 才有了真实调用者。已加三条回归守卫（走 loadFile / 一次 loadURL 都不调 / 关窗后目录既出白名单又被删）。

13. **`openPreviewWindow` 去掉 `ready-to-show` 改为 `show: true`**。那个事件在 data:/file: 与某些平台组合下不保证触发，不触发的表现是「点了预览什么都没发生」——一个永远不 show 的隐藏窗口。

14. **naive-ui 的 `n-input`/`n-select` 不转发 `aria-label`**，挂在外层包裹元素上取不到。改用 `:input-props="{ 'aria-label': … }"`，真机 `document.querySelector('input[aria-label="搜索产物"]')` 已能命中。

15. **`scripts/cdp-eval-main.mjs`（新）**。原 `cdp-eval.mjs` 取 `find(t => t.type === "page")` 的第一个；预览窗口一开就打到沙箱窗口上，报一句「Cannot read properties of undefined (reading 'preview')」，看起来像 preload 挂了。新脚本按 URL 定向到主窗口。

16. **`convert-host` 增 `__setConvertTimeout`（仅测试用）**。`vi.useFakeTimers` 在这里不可用：convert 在装定时器之前要先 await 两次真实文件系统调用，假时钟推进那一刻定时器还没装上，表现是测试卡满 20 秒后超时而被测代码其实是好的。`CONVERT_LIMITS.timeoutMs` 的字面量由另一条断言逐字盯着。

17. **pdf.js 显式拒绝 Node `Buffer`**（`Please provide binary data as Uint8Array, rather than Buffer`），且抛的是普通 Error——不转换的话每份 PDF 都被归类成 `corrupt`，且看不出任何和 PDF 有关的线索。已改为 `new Uint8Array(buf)`。这一条是十类正向断言抓到的。

18. **`redactExternalTargets` 是刻意的有损处理**：正文里合法的网址也会被打成 `[外部链接已屏蔽]`。预览区是只读文本视图，把不可信文档里的 URL 原样摆出来等于把钓鱼链接伪装成应用自己的内容，而用户分辨不出。需要原文的用户可以用系统程序打开原件。

---

## M5 出口门禁场景

| 场景 | 结果 |
|---|---|
| 中文空格路径 | 工作区 `D:\pi\test\预览验证`、文件名含中文与空格（`销售 副本.xlsx`）全程正常 |
| symlink | `preview:open` 指向工作区外的 symlink → `PATH_ESCAPES_WORKSPACE`（单测；Windows 未开开发者模式时该用例显式跳过而非假装通过） |
| 深目录 / 超多文件 | 沿用 FS-101 的分页与 ignore 策略，本任务未改动 |
| 外部修改 | `verify()` 置 conflicted；restore 后自动复核，实测标出「已被外部改动」 |
| 磁盘满 / 只读目录 | 转换失败归类为 corrupt 并给建议；原文件不动（写路径只有导出与复制，均经 copyFile 且失败回 `ok:false`） |
| 并发编辑 | artifact 的 sha256 复核；文件写入仍走 FS-101 既有的 baseSha256 冲突判定 |
| **恶意文档** | 见上：宏不执行、外链不发、够不到主 renderer、正文照常抽出并如实列出被拦内容 |

## Notes

- 全计划最后一个 task，全量 748 测试绿、六个门禁脚本全绿、packaged 构建产出并真机验收完毕。
- 遗留（明确不在本任务范围）：历史版本内容不做单独存档，因此同链跨版本的逐行 diff 只能降级；`.doc/.xls/.ppt` 老式二进制格式返回 `unsupported` 并提示另存为 x 系格式；PPTX 的 SmartArt / 图表 / OLE 返回 `unsupported`（正文照常给）。
