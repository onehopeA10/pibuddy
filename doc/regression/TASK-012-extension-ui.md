# TASK-012 Extension UI 与 Pi 资源中心 人工回归记录

- 日期：2026-08-03
- 形态：`electron packages/app --remote-debugging-port=9222 --user-data-dir=…\.devdata-chrome`
  （`pnpm build` 产物，非 dev server）
- 工作目录：`D:\pi\test`
- 模型：`gpt-5.6-sol`（openai），thinkingLevel `max`
- 取证方式：`node scripts/cdp-drive.mjs "<指令>" "~<等待毫秒>" "!<表达式>"` 直连渲染进程
  调试端口，驱动真实 IPC 并读真实 DOM。下面附的都是脚本原样输出（JSON 转义未加工）。
- 专用测试扩展：`~/.pi/agent/extensions/pibuddy-ui-probe.ts`
  （注册 `/uiprobe <method>` 命令，主动发起 9 种 UI 请求 + timeout + 排队场景）

> **先记两条真机才抓得到的回归**，两条都在单测 / typecheck / build 三样全绿的情况下发生：
>
> 1. **trust 对话框弹出来但里面是空的**。`describeTrust` 在启动时先于任何一次资源扫描
>    发生，此时 `scan` 为 null；trust 态只写进 `scan.value.trust` 的话，那次写入被
>    `if (scan.value)` 整个跳过 —— 弹窗照常出现（`needsPrompt` 是从返回值直接读的），
>    而「将要加载的 project resources」永远是「（没有检测到需要信任的项目资源）」。
>    修法：trust 态由 store 独立持有（`stores/piResources.ts` 的 `trustState`）。
>    回归钉在 `stores/pi-resources-store.test.ts`。
> 2. **「Pi 资源」页列出 454 条包**。用户只装了 3 个 pi 包，`~/.pi/agent/npm/node_modules`
>    下平铺着 npm 拉下来的全部传递依赖（zod / chalk / @babel/runtime …）。更糟的是
>    `conflictWith` 会在这几百条之间互相点名，真正的同名技能冲突淹没在噪声里。
>    修法：只登记带 `pi` 键 / `pi-package` 关键字 / 约定目录的包。
> 3. **装完带技能的包，技能那一组一条不变**。扫描器只登记包本身，不展开包自带的
>    `skills/` 与 `extensions/`，用户看不到自己刚装的技能，只能盲发 `/skill:xxx` 试。

## 一、Extension UI 既有闭环的七个 method（TASK-007 c[17] 逐项对应）

TASK-007 当时只驱动了 setStatus，其余六项因扩展处于 AUTO/ACT/YOLO 不弹窗、
且没有渲染侧触发入口而未验证，那六行**没有打勾**。本次用专用测试扩展补齐。

- [x] `select` — pi 侧收到 `{"value":"苹果"}`（扩展回显 `select="苹果"`）— 2026-08-03T02:50:11+08:00
- [x] `confirm` — pi 侧收到 `{"confirmed":true}`（扩展回显 `confirm=true`）— 2026-08-03T02:54:22+08:00
- [x] `input` — pi 侧收到 `{"value":"探针输入的文字"}`（扩展回显 `input="探针输入的文字"`）— 2026-08-03T02:54:58+08:00
- [x] `editor` — pi 侧收到 `{"value":"改过的第一行\n改过的第二行"}`（扩展回显同值）— 2026-08-03T02:55:31+08:00
- [x] `notify` — 无响应体（fire-and-forget）；渲染侧 toast 文本 `探针：这是一条 warning 通知`，notifyType=warning — 2026-08-03T02:56:02+08:00
- [x] `setStatus` — 无响应体；顶栏 `.ext-status` 文本含 `探针状态：ON`，置 `undefined` 后该项消失 — 2026-08-03T02:56:09+08:00
- [x] `set_editor_text` — 无响应体；输入框 `textarea.value === "探针写进输入框的文字"` — 2026-08-03T02:57:04+08:00

原样输出（节选）：

```
/uiprobe select   -> {"dialogs":["探针：请选一个 | 苹果 | 香蕉 | 取消我"],"buttons":["苹果","香蕉","取消我"]}
点击「苹果」后    -> {"extStatus":["max · AUTO ON · ACT · YOLO · select=\"苹果\""]}

/uiprobe confirm  -> {"dialogs":["探针：确认吗？ | 这只是一次回归验证，选什么都行。 | 取消 | 确认"]}
点击「确认」后    -> {"extStatus":["… · confirm=true"]}

/uiprobe input    -> {"dialogs":["探针：输入点什么 | 随便打几个字 | 取消 | 确定"]}
填字并「确定」后  -> {"extStatus":["… · input=\"探针输入的文字\""]}

/uiprobe editor   -> {"dialogs":["探针：编辑这段文字 | 取消 | 确定"]}
改字并「确定」后  -> {"extStatus":["… · editor=\"改过的第一行\\n改过的第二行\""]}

/uiprobe notify   -> ["探针：这是一条 warning 通知"]
/uiprobe status   -> {"extStatus":["max · AUTO ON · ACT · YOLO · 探针状态：ON"]}
/uiprobe statusclear -> {"extStatus":["max · AUTO ON · ACT · YOLO"]}
/uiprobe editortext  -> {"editor":"探针写进输入框的文字"}
```

## 二、本任务新补的两个 method（不计入「既有闭环」）

| method | 结论 | 证据 |
|--------|------|------|
| `setWidget`（aboveEditor） | 通过 | `{"lines":4,"first":"── 探针 widget ──","clientH":89,"scrollH":89}` |
| `setWidget`（belowEditor） | 通过 | 两个 `.widget-host`：上方 `── 探针 widget ──`，下方 `下方 widget 第 1 行` |
| `setWidget`（120 行，30vh 上限） | 通过 | `{"lines":120,"clientH":252,"scrollH":2316,"vh30":253,"scrolls":true}` —— 内容一行不丢，超出滚动而非撑高输入区 |
| `setWidget`（清除） | 通过 | `widgetLines: undefined` 后 `{"widgets":0,"hosts":0}` |
| `setTitle`（200 字符） | 通过 | 渲染文本 `PiBuddy · 探针标题-长长…`，`len = 70`（前缀 10 + 截断 60） |

## 三、dialog timeout（EXT-101 的核心缺陷）

改造前 `timeout` 在全库只有 `pi-sdk/src/types.ts` 一行类型声明，没有任何实现读它。

| 步骤 | 结论 | 证据 |
|------|------|------|
| 弹窗出现并提示会过期 | 通过 | `探针：5 秒后自动放弃 \| 别点，等它自己消失。 \| 取消 \| 确认 \| 助手最多等 5 秒` |
| 5 秒后本地弹窗自动消失 | 通过 | 5s 后 `dialogs` 中不再有该框 |
| 给用户一句解释 | 通过 | toast `助手已不再等待这个回答` |
| 上游确实自行 auto-resolve | 通过 | 扩展回显 `timeout=false`（confirm 超时返回 false，rpc.md:2497） |
| 过期 id 作答被拒 | 通过 | `respond({id:'definitely-expired-id'})` → `{"ok":false,"reason":"expired"}`；主进程日志 `ext_ui_respond_rejected reason=expired` |

## 四、多请求排队 / 代际清理 / reload 快照

| 场景 | 结论 | 证据 |
|------|------|------|
| 连发 3 条 dialog | 通过 | 首框显示 `排队 1/3 \| A \| B \| 还有 2 个问题在排队`；答完第一条自动显示 `排队 2/3 … 还有 1 个问题在排队` |
| 三条各自拿到自己的答案 | 通过 | 扩展回显 `queue=["A","",true]` |
| runtime 重启清空挂起弹窗 | 通过 | 开着 select 弹窗时 `runtime.stop()` + `runtime.start()` → 弹窗消失 + toast `助手已不再等待这个回答`；`extensionUi.pending().requests.length === 0` |
| reload 快照通道 | 通过 | `pending()` 返回 `{"requests":[],"statuses":[{"key":"uiprobe",…}],"title":"探针标题-…","editorText":"探针写进输入框的文字"}` |

## 五、Pi 资源中心与 project trust（EXT-102）

| 场景 | 结论 | 证据 |
|------|------|------|
| 打开含 `.pi` 资源的项目先弹 trust | 通过 | 弹窗列出 `项目设置 .pi/settings.json → D:\pi\test\.pi\settings.json`、`项目技能 .pi/skills → D:\pi\test\.pi\skills` |
| allow / deny / remember 三个选择 | 通过 | 按钮 `不信任，先跳过这些` / `信任这个项目` + 复选框 `记住这个选择（会写入 pi 的 trust.json…）` |
| 固定文案 | 通过 | 弹窗内含 `信任不等于工具权限：信任只决定 pi 是否加载…` |
| 写 trust.json 且不砸终端里的 pi | 通过 | 写后文件为 `{"C:\\Users\\yehh\\Documents\\土狗":true,"D:\\pi\\test":true,"D:\\selftool\\pi-maestro-flow":true}` —— 原有两条原样保留，值全部是布尔（pi 的 `readTrustFile` 对非布尔值**整文件抛错**） |
| 信任后重启 runtime 生效 | 通过 | 主进程日志 `pi_runtime_launched generation=2`，project 技能 `probe-skill` 的 `enabled` 变为 true |
| 三类来源的 skill / extension 列表 | 通过 | `技能（1）/ 扩展（1）/ 包（3）`；`probe-skill 项目 D:\pi\test\.pi\skills\probe-skill`、`pibuddy-ui-probe 全局 C:\Users\yehh\.pi\agent\extensions\pibuddy-ui-probe.ts`、`pi-maestro-flow 全局 v0.14.0` |
| 安装一个技能 | 通过 | `install(ws,'D:/pi/probe-pkg','user')` → `{"ok":true,"output":"Installing D:/pi/probe-pkg...\nInstalled D:/pi/probe-pkg\n"}` |
| 装完在列表里看得见 | 通过 | `{"kind":"skill","name":"hello-probe","source":"package","path":"D:\\pi\\probe-pkg\\skills\\hello-probe","enabled":true}` |
| 装完 `/skill:` 真的能用 | 通过 | 发 `/skill:hello-probe` → 消息展开成 `<skill name="hello-probe" location="D:\pi\probe-pkg\skills\hello-probe\SKILL.md">…`，助手回 `探针技能已加载` |
| 卸载 | 通过 | `remove(...)` → `{"ok":true,"output":"Removing …\nRemoved …\n"}`，settings.json 的 packages 恢复为原来的 3 条 |
| 渲染进程执行不了包管理命令 | 通过 | `window.piBuddy.piResources` 上没有任何接受命令 / 参数数组的方法；install/remove 的 schema 恰有 `scope / spec / workspaceId` 三键 |

## 六、必须保护的既有功能（本任务不得破坏）

| # | 项目 | 结论 | 证据 |
|---|------|------|------|
| 1 | 流式（delta 折叠） | 通过 | 数到 400 的任务 4s 后 `{"streaming":true,"stop":true,"status":"正在努力工作中… 你可以随时输入新指令插话，或点「停止」"}` |
| 2 | thinking 折叠 | 通过 | `π 💭 思考过程 ▼` 出现在助手消息里 |
| 3 | steer 插话 | 通过 | 流式中发 `prompt + streamingBehavior:"steer"` → `success:true`，助手随后回 `已插话成功` |
| 4 | abort 停止 | 通过 | 点「停止」后 `{"streaming":false,"stopGone":true}` |
| 5 | 模型切换 | 通过 | `getAvailableModels` 55 项；切到 `claude-fable-5` → `getState().model.id === "claude-fable-5"`，切回 `gpt-5.6-sol` 成功 |
| 6 | thinking level | 通过 | `getState().thinkingLevel === "max"`，顶栏显示「思考：最强」 |
| 7 | 会话中心 | 通过 | `sessions.query(ws,{status:'active',limit:5})` 返回 5 条；侧栏 16 个会话条目 |
| 8 | 更新横幅 | 通过 | 无可用更新时不渲染（`.update-banner` 不存在），未被本任务的浮层挂载改动影响 |
| 9 | 工具卡片 | 通过 | 本轮对话未触发工具调用，`toolCards=0`；渲染路径未改动（`ToolActivity.vue` 零改动） |
| 10 | 顶栏布局 | 通过 | 200 字符标题被截断到 70 字符，模型下拉与「记忆已用 8%」仍在可视区内 |

## 七、未完成 / 未驱动项（如实记录，不粉饰）

1. **MCP 管理整体未实现**。增删改查、启停、连接测试、OAuth 状态、tool 列表、
   错误诊断本轮全部没做。界面上写的是「MCP 管理（…）本轮尚未实现」这句话，
   **不是**一个空列表 —— 空列表在同一块像素上表达的是「你还没配过 MCP」。
   这与任务 rationale.tradeoffs 一致（M3 出口门禁不含 MCP）。
2. **语音输入仍未驱动**（与 TASK-007 同因：需要真实麦克风授权与可用的 STT 端点，
   当前 `sttApiKey` 未配置）。本任务未改动语音路径。
3. **图片多模态未在本轮重新驱动**。本任务未改动 `send()` 的图片分支，
   TASK-007 已端到端验证过；这里不重复打勾。
4. **草稿恢复未在本轮重新驱动**。TASK-010 已验证；本任务只从 app store 迁出了
   `uiRequests / statusTexts`，未触碰草稿路径。
5. **`.agents/skills` 祖先目录遍历会一路走到盘符根**。这是 pi 自身的判定规则
   （security.md:16），照实现了；如果用户在 `C:\` 或 `~` 下放了 `.agents/skills`，
   任何子项目都会被判成「有项目资源」。label 里带上命中的祖先目录路径以便看懂。
6. **trust.json 写入未取 pi 的 `proper-lockfile` 锁**。pi 写这个文件时会锁目录，
   我们只做「读—合并—原子写」。同一秒内两边同时写仍可能丢一条决定。
   概率极低（都是用户手动触发），但确实存在，记在这里。
