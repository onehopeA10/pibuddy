# TASK-004: SEC-001 + SEC-005 窗口与内容安全：sandbox / CSP / 导航拦截 / 权限收敛 / 渲染侧限额

## Changes

- `packages/app/src/main/security/window-policy.ts`（新建）：`CSP_POLICY` 常量、
  `applyWindowPolicy(win)`、`openExternalSafely(raw)`、`isAppUrl(raw)`、`setSecurityLogger`。
  集中注册 CSP 响应头（`onHeadersReceived`）、`will-navigate` 拦截、`setWindowOpenHandler`
  恒 deny、`setPermissionRequestHandler` / `setPermissionCheckHandler`。
- `packages/app/src/main/index.ts`：`sandbox: false` → `sandbox: true`；
  `preload` 路径 `../preload/index.mjs` → `../preload/index.cjs`；创建窗口后调
  `applyWindowPolicy(win, { logger: mainLogger() })`；加载分支加 `!app.isPackaged &&` 前置条件。
- `packages/app/electron.vite.config.ts`：preload 产物由 ESM 改为 CJS
  （`output: { format: "cjs", entryFileNames: "index.cjs" }`）—— **见下方偏差 D1，这是开启
  sandbox 的硬前提**。
- `packages/app/src/renderer/index.html`：新增与 `CSP_POLICY` 等价的
  `<meta http-equiv="Content-Security-Policy">`（覆盖 packaged 的 file:// 加载路径）。
- `packages/app/src/renderer/src/markdown.ts`：新增 `MAX_TOOL_OUTPUT_BYTES = 65536`、
  `validateLink()` 链接 scheme 白名单、图片 src 白名单、`truncateToolOutput()` 按字节截断；
  `highlight` 改为自行输出 `<pre class="hljs">` 外壳（见偏差 D3）。
- `packages/app/src/renderer/src/components/MessageItem.vue`：文本块渲染前过 `truncateToolOutput`。
- `packages/app/test/window-policy.spec.ts`（新建）：13 条关键路径断言。
- `doc/regression/TASK-004-security.md`（新建）：人工回归记录，逐项 `- [x]`。

## Verification

逐条实跑，命令与输出如下。

### c[0] sandbox

```
$ rg -c 'sandbox: true' packages/app/src/main/index.ts   → 1
$ rg -c 'sandbox: false' packages/app/src/main/index.ts | wc -l → 0
```
- [x] 通过。构建产物 `out/main/index.js` 中亦为 `sandbox: true`。

### c[1] CSP 指令齐备（window-policy.ts）

```
default-src 'self'             1
script-src 'self'              1
object-src 'none'              1
base-uri 'none'                1
frame-ancestors 'none'         1
img-src 'self' data: blob:     1
```
- [x] 通过。

### c[2]/c[3] 五个 handler + onHeadersReceived

```
will-navigate                  3
setWindowOpenHandler           2
action: "deny"                 1
setPermissionRequestHandler    2
setPermissionCheckHandler      2
onHeadersReceived              2
```
- [x] 通过。

### c[4] ELECTRON_RENDERER_URL 生产屏蔽

```
$ rg -c -F '!app.isPackaged && process.env.ELECTRON_RENDERER_URL' packages/app/src/main/index.ts → 1
```
- [x] 通过。

### c[5] index.html meta

```
$ rg -c -F 'http-equiv="Content-Security-Policy"' packages/app/src/renderer/index.html → 1
$ rg -c -F "object-src 'none'" packages/app/src/renderer/index.html → 1
```
- [x] 通过。构建后的 `out/renderer/index.html` 已确认带该 meta。

### c[6] 外链出口唯一

```
$ rg --no-filename -c 'shell\.openExternal' packages/app/src -g '*.ts' -g '*.vue' \
    -g '!**/security/window-policy.ts' | awk '{s+=$1} END{print s+0}'   → 0
$ rg -c 'shell\.openExternal' packages/app/src/main/security/window-policy.ts → 3
```
- [x] 通过。

### c[7] markdown 限额

```
html: false                    1
validateLink                   5
MAX_TOOL_OUTPUT_BYTES = 65536  1
```
- [x] 通过。

### c[8]/c[9]/c[10] 单测

```
$ pnpm vitest run packages/app/test/window-policy.spec.ts
 ✓ packages/app/test/window-policy.spec.ts (13 tests) 21ms
 Test Files  1 passed (1)
      Tests  13 passed (13)
```
- [x] 6 个危险输入（`file:///C:/Windows/System32/calc.exe`、`javascript:alert(1)`、
  `data:text/html,<script>1</script>`、`vbscript:msgbox`、`search-ms:query=x`、
  `https://example.com/a\u0000b`）全部返回 false 且 `shell.openExternal` 零调用；
  `https://example.com/` 与 `mailto:a@b.com` 放行。
- [x] `renderMarkdown('[x](javascript:alert(1))')` 输出不含 `javascript:`。
- [x] 10 万字符 tool output 截断后字节数 ≤ 65536 + 截断标记；中文按字节计同样受控。
- [x] 权限：`media/['audio']` → true；`media/['video']` → false；
  `media/['audio','video']` → false；`geolocation` → false；非主窗口 webContents 的
  audio 请求 → false；check handler 的单数 `mediaType` 同样收敛。

### c[11] 全量门禁

```
$ pnpm -w test
 Test Files  7 passed (7)
      Tests  44 passed (44)
 → 退出码 0

$ pnpm --filter @pibuddy/app build
 ✓ built in 1.06s / 17ms / 9.34s
 → 退出码 0
```
- [x] `pnpm -w test` 通过。
- [x] `pnpm --filter @pibuddy/app build` 通过。
- [ ] **`pnpm typecheck` 未通过 —— 但 0 条错误来自本任务文件，见偏差 D2。**

### c[12]/c[13] UI-observable

见 `doc/regression/TASK-004-security.md`，全部 `- [x]`。要点：

| 判定 | 实测值 |
|---|---|
| 渲染进程无 node | `typeof require === 'undefined' && typeof process === 'undefined'` → true |
| CSP 拦内联脚本 | 动态注入 `<script>` 后 `window.__pwn` 仍为 undefined |
| data:/blob: 图片 | 均 `naturalWidth > 0` |
| 拖拽图片 | `.attach-chip` = `probe-drop.png`，其内 `<img>` 已加载 |
| 拖拽非图片（webUtils） | `📎probe-drop.txt` chip 出现 → `getPathForFile` 在沙箱下返回了非空路径 |
| 麦克风 | `getUserMedia({audio:true})` → `granted` |
| 摄像头 / 定位 | `NotAllowedError` / `code1` |
| https 外链点击 | `chrome.exe` 进程 +1，Electron 页面 target 数不变 |
| 危险外链点击 | 新窗口增量 0，console error 增量 0 |
| `<a>` href | `["https://example.com/", null, null]` |
| 代码高亮 | `.markdown .hljs` 计数 = 1 |
| thinking 展开 | 高度 20.79px |
| tool 卡片展开 | 高度 161.33px |

验证手段：CDP 连真实运行的 Electron（build 产物、file:// 加载），向 Pinia store 注入合成
assistant/user 消息驱动真实 Vue 渲染，再对真实 DOM 取 `getBoundingClientRect()` /
`naturalWidth` / `getAttribute('href')`；拖拽用 `Input.dispatchDragEvent` 投递真实落盘文件。
探针脚本保留在 `.workflow/scratch/20260802-plan-P0-pibuddy-m0-m5/probe-task004.mjs`。

## Deviations

### D1（必须知晓）计划外修改 `packages/app/electron.vite.config.ts`

计划把 `sandbox: true` 描述为"成本极低"，前提是"preload 只用 contextBridge/ipcRenderer/webUtils
所以天然兼容沙箱"。**这个前提只覆盖了 API 依赖，漏掉了模块格式。** 实测：Electron 的 ESM
preload（`.mjs`）只在 `sandbox: false` 下加载；开启沙箱后 preload 静默不执行，
`window.piBuddy` 直接是 `undefined`，整个应用与主进程失联。

第一轮探针实测证据：

```
"webUtils_pathFor_available": "undefined",
"webUtils_pathFor_works": "THREW: Cannot read properties of undefined (reading 'file')",
"user_image_rendered": false, "hljs_rendered": 0, "anchor_hrefs": []
```

修复：preload 产物改为 CJS（`format: "cjs"`, `entryFileNames: "index.cjs"`），
`main/index.ts` 的 preload 路径同步改为 `index.cjs`。改后同一组探针全绿。

**这条改动落在 `electron.vite.config.ts` 的 `preload` 块**，与并行的 TASK-003 边界相邻。
TASK-003 截至本任务提交时未修改该文件（`git status` 确认）。若 TASK-003 后续也要改它，
请保留 `preload.build.rollupOptions.output`，删掉即等于关掉 sandbox。
另外若 `electron-builder.yml` 的 `files` 白名单显式列了 `out/preload/index.mjs`，
需同步改为 `index.cjs`（该文件归 TASK-003，本任务未动）。

### D2 `pnpm typecheck` 退出码 2，错误全部来自 TASK-003 在飞的改动

```
$ pnpm typecheck
packages/contract/src/settings.ts(42,41): error TS2741: Property 'piRuntimeMode' is missing ...
packages/app/src/main/pi-runtime-manifest.ts(12,19): error TS2307: Cannot find module 'zod'
packages/app/src/main/pi-runtime-manifest.ts(76,15): error TS7006: Parameter 'i' implicitly has an 'any' type
packages/app/src/main/settings.ts(16,5): error TS2741: Property 'piRuntimeMode' is missing ...
packages/app/src/renderer/src/stores/app.ts(79,37): error TS2345: ... 'piRuntimeMode' is missing ...
```

5 条错误，`pi-runtime-manifest.ts` / `settings.ts` / `contract/settings.ts` /
`stores/app.ts:79` 全部是 TASK-003 的 `piRuntimeMode` 运行时定位改造（工作区共享，
提交时其尚未收口）。**本任务改动的 6 个文件零错误**：`main/index.ts`、
`security/window-policy.ts`、`renderer/index.html`、`markdown.ts`、`MessageItem.vue`、
`electron.vite.config.ts` 均未出现在错误列表中。TASK-003 收口后需复跑全量 typecheck 确认。

### D3 `markdown.ts` 的 highlight 外壳（超出计划的一处小修）

c[13](d) 要求"代码块渲染出 `class="hljs"` 的元素"。改前实测该断言为假：原
`highlight()` 只返回 hljs 的 token HTML，不带外壳，因此 DOM 里从来没有 `.hljs` 元素，
highlight.js 主题挂在 `.hljs` 上的背景/前景色一条都没生效（既有缺陷，非 sandbox 回归）。
改为自行输出 `<pre class="hljs"><code class="language-X">`，`.markdown .hljs` 计数由 0 变 1。
`lang` 经 `hljs.getLanguage(lang)` 校验后才插入 class，无注入面；fallback 分支用
`md.utils.escapeHtml` 转义。

### D4 `ToolActivity.vue` 按计划未改动

`files[]` 明确"本任务不改动 expanded 与 `!run` 判定"，与 `implementation[9]` 的"在
ToolActivity.vue 接入"表述冲突。取 `files[]` 为准：未改动。现有 4000 **字符**截断在
UTF-8 下最坏 12000 字节，严于 65536 字节上限，接入 `truncateToolOutput` 不会改变行为。
展开交互已实测未回归（高度 161.33px）。

### D5 SEC-005 的附件数量/尺寸/magic bytes 不在本任务 criteria 内

用户口述的"附件数量/单文件/单次总量/尺寸上限 + magic bytes 嗅探"未出现在 TASK-004 的
`convergence.criteria` 中，且 TASK-007 的 `files[]` 明确包含
`packages/app/src/main/attachment-registry.ts` 与 `test/attachment-registry.spec.ts`。
判定为 TASK-007 的交付面，本任务未实现，避免与并行任务撞车。本任务只交付 SEC-005 的
markdown scheme 白名单与 tool output 字节上限。

### D6 CSP 的两处评估结论

- `app.enableSandbox()`：未调用。`webPreferences.sandbox: true` 已对唯一的
  BrowserWindow 生效；全局开关只在需要覆盖后续新建窗口时才有增量价值，而
  `setWindowOpenHandler` 恒 deny 意味着不存在计划外的新窗口。
- `connect-src 'self'`：实测会阻断渲染进程对 `data:` URL 的 `fetch()`。当前代码
  一律把 data URL 直接赋给 `img.src`，不受影响；已在回归文档记录为已知副作用。
  STT 与 Provider 请求本就由主进程发起（`ipc.ts` 的 `stt:transcribe`），未被影响。

## Notes

- `will-navigate` 判定 dev origin 时读的是 `ELECTRON_RENDERER_URL`，且被 `app.isPackaged`
  短路，因此 HMR 的整页刷新不会被拦、生产环境也拿不到这条放行。
- `md.validateLink` 被刻意设为恒 true，过滤下沉到 `link_open` / `image` 渲染规则。
  原因写在代码注释里：markdown-it 的 validateLink 返回 false 时**不生成 link token**，
  `[x](javascript:alert(1))` 会被原样输出成文本，危险 URL 反而留在 DOM 里。
  下沉之后输出是干净的 `<a>x</a>`，URL 整体消失。改这里要连带看 `test/window-policy.spec.ts`
  的 `no_dangerous_href` 组用例。
- `openExternalSafely` 是全仓唯一的 `shell.openExternal` 出口，且被 `will-navigate` 与
  `setWindowOpenHandler` 两条路径共用。任何新增外链入口都必须走它，c[6] 的结构断言
  不随新增入口失效。
- 主进程 `ipc.ts` 的 `shell:open-path`（接受任意绝对路径）**本任务未收窄** —— 它属于
  IPC 接口面，是 TASK-007（SEC-002/003）的交付面，且 `ipc.ts` 当前正被 TASK-003 修改。
