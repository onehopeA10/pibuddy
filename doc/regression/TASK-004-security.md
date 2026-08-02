# TASK-004 窗口安全策略人工回归记录

环境：Windows 11 / Electron 43.2.0 / `pnpm --filter @pibuddy/app build` 后以
`npx electron . --remote-debugging-port=9333 --inspect=9334` 启动，渲染进程加载
`file:///D:/selftool/pi-ui/packages/app/out/renderer/index.html`（即 packaged 的加载路径，
CSP 只由 index.html 的 meta 生效）。

验证方式不是"肉眼看一眼"：用 CDP 连上真实运行的渲染进程，向 Pinia store 注入合成的
assistant / user 消息与 toolRun，再对真实 DOM 取 `getBoundingClientRect()`、`naturalWidth`、
`getAttribute('href')` 做判定；拖拽用 `Input.dispatchDragEvent` 投递真实落盘文件。
探针脚本：`.workflow/scratch/20260802-plan-P0-pibuddy-m0-m5/probe-task004.mjs`。

## c[12] sandbox:true 后的关键回归

- [x] 拖拽本地图片进输入框仍能解析并作为图片附件：`Input.dispatchDragEvent(drop)` 投递
      `probe-drop.png`，`.attach-chip` 出现 `probe-drop.png`，其内 `<img>` 的
      `naturalWidth > 0`（走 FileReader → data: URL，未被 CSP img-src 拦截）
- [x] 拖拽非图片文件仍能取到绝对路径：投递 `probe-drop.txt` 后出现 `📎probe-drop.txt` chip。
      该 chip 只在 `webUtils.getPathForFile(file)` 返回非空字符串时才会 push，
      因此 chip 存在即证明沙箱 preload 里 `webUtils` 可用
- [x] 麦克风授权：`navigator.mediaDevices.getUserMedia({audio:true})` → `granted`
- [x] 权限收敛反例：`getUserMedia({video:true})` → `NotAllowedError`；
      `geolocation.getCurrentPosition` → `PERMISSION_DENIED (code 1)`；
      主进程日志同步出现 `permission_denied`

## c[13] 六项逐项判定

- [x] (a) 助手回复中的 https 链接点击后系统浏览器打开该 URL：点击 `href="https://example.com/"`
      后 `chrome.exe` 进程数 +1，Electron 页面 target 数不变（未开新窗口）
- [x] (b) 回复中含 `file:///C:/Windows/System32/calc.exe` 与 `[x](javascript:alert(1))`，
      点击后新窗口增量 = 0，console error 增量 = 0
- [x] (c) 同一条回复渲染出的 `<a>` href 依次为 `["https://example.com/", null, null]`
      —— file: 与 javascript: 的 href 被整条剥掉，输出中不含 `javascript:` / `file:`
- [x] (d) 代码块渲染出 `class="hljs"` 的元素（`.markdown .hljs` 计数 = 1）
- [x] (e) thinking 段落点击后展开高度 = 20.79px > 0
- [x] (f) tool 卡片点击后展开高度 = 161.33px > 0

## 附加基线断言

- [x] 渲染进程内 `typeof require === 'undefined' && typeof process === 'undefined'`（沙箱确实生效）
- [x] `<meta http-equiv="Content-Security-Policy">` 存在
- [x] 动态注入内联 `<script>` 被 `script-src 'self'` 拦下（`window.__pwn` 保持 undefined）
- [x] `data:` 与 `blob:` 图片均可加载（img-src 白名单未打断多模态与运行时对象 URL）

## 已知副作用（非回归，需知晓）

- `connect-src 'self'` 会阻断渲染进程对 `data:` URL 的 `fetch()`。当前代码路径不依赖它
  （图片一律直接赋给 `img.src`），但今后若在渲染侧写 `fetch('data:...')` 会失败。
