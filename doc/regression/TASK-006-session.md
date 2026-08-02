# TASK-006 会话交互人工回归记录

- 日期：2026-08-02
- 形态：`npx electron packages/app --remote-debugging-port=9222`（electron-vite build 产物，非 dev server）
- 工作目录：`D:\pi\test`
- 取证方式：`node scripts/cdp-eval.mjs "<表达式>"` 直连渲染进程调试端口读真实 DOM 与 IPC 返回，
  不是「看一眼觉得没问题」。每条下面附的都是脚本原样输出。

## c[20] 发送失败时草稿不丢

步骤：输入一段文字 → 粘贴 1 张图片（dot.png）→ 拖入 1 个真实文件
（`D:\pi\test\regression-note.txt`，经 CDP `Input.dispatchDragEvent` 带 OS 路径投递）
→ `window.piBuddy.pi.stop()` 停掉运行时 → 点「发送 ↩」。

- [x] 发送前 composer 状态

```
{ "chips": ["dot.png✕", "📎regression-note.txt✕"],
  "text": "这段文字发送失败后必须原样保留" }
```

- [x] 运行时停掉后点发送，三者全部原样保留，且弹出真实错误而非静默

```
{ "text": "这段文字发送失败后必须原样保留",
  "chips": ["dot.png✕", "📎regression-note.txt✕"],
  "notice": ["Error invoking remote method 'pi:command': Error: 智能体运行时不可用：尚未启动，请先选择工作文件夹"] }
```

- [x] 恢复运行时后直接点发送即成功，此时才清空

```
{ "text": "\"\"", "chips": 0, "chatItems": 10 }
```

## c[21](a) 侧栏历史会话列表

- [x] 条目数 5（>= 1）
- [x] 每条同时渲染 名称 / 首条消息 / 消息数 / 修改时间 四个字段

```
[ { "title": "（未命名任务）", "preview": "从1数到30，每个数字一行",  "meta": "今天 20:50 · 8 条消息" },
  { "title": "（未命名任务）", "preview": "你好，能收到吗",          "meta": "今天 20:46 · 4 条消息" },
  { "title": "（未命名任务）", "preview": "请用中文逐条列出 1 到 15 的平方数，每条单独一行，慢慢说。", "meta": "今天 20:46 · 4 条消息" },
  { "title": "（未命名任务）", "preview": "你是谁",                  "meta": "今天 11:07 · 2 条消息" },
  { "title": "（未命名任务）", "preview": "你好",                    "meta": "今天 10:28 · 2 条消息" } ]
```

说明：这 5 个会话的 jsonl 里都没有 `session_info` 名称记录，因此「名称」位显示占位
文案「（未命名任务）」。四个字段各占其位（改前是 `name || firstMessage` 挤在一行，
有名字的会话就再也看不到内容预览）。

- [x] 主进程枚举目录与 pi 写入目录同源（实测 pi 子进程命令行）

```
...\dist\cli.js --mode rpc --session-dir C:\Users\yehh\.pi\agent\sessions\--D--pi-test--
```

## c[21](b) 历史会话沿用自身记录的模型

前置：全局设置置为 `openai/gpt-5.6-sol`，重载后新会话确实按全局设置启动
（顶栏 `GPT-5.6 Sol`，`get_state().model.id === "gpt-5.6-sol"`）。

打开一个 jsonl 中 `model_change` 记录为 `gpt-5.6-luna` 的历史会话：

- [x] 顶栏模型 === 会话记录的 model id，且 !== 全局设置

```
{ "topbar": "📁 test 记忆已用 8% 思考：最强GPT-5.6 Luna",
  "stateModelId": "gpt-5.6-luna",
  "sessionFile": "\\--D--pi-test--\\2026-08-02T03-04-43-352Z_019fc06e-....jsonl",
  "globalSettingsModelId": "gpt-5.6-sol",
  "chatItems": 2 }
```

## c[21](c) 换会话时会话级状态清干净

在会话 A 里跑一次 `prompt` 触发真实 tool 调用，并让扩展上报 setStatus，
此时 DOM：

```
{ "toolChips": 2, "extStatus": 1, "extStatusText": "AUTO ON", "uiDialogs": 0, "chatItems": 6 }
```

点侧栏切到会话 B 之后：

- [x] tool 卡片数 === 0
- [x] 状态文字元素数 === 0
- [x] Extension UI 弹窗数 === 0

```
{ "toolChips": 0, "extStatus": 0, "statusLine": 0, "uiDialogs": 0,
  "chatItems": 8,
  "sessionFile": "\\--D--pi-test--\\2026-08-02T12-49-45-223Z_019fc285-....jsonl",
  "topbar": "📁 test 记忆已用 8% 思考：最强GPT-5.6 Sol" }
```

关于 Extension UI 弹窗：本环境里没有会主动发起 `select` 的扩展，实测数为 0 是
「切换后没有弹窗」而不是「弹窗被清掉了」。清空动作本身由
`packages/app/test/session-interaction.spec.ts` 的两条用例覆盖 ——
`resetSessionScopedState()` 后 `uiRequests.length === 0`，以及
`openSession()` 正常路径后 `uiRequests.length === 0`。

## 顺带确认（没有回归）

- [x] 会话列表按 `agent_settled` 防抖刷新：一轮任务跑完后侧栏顺序与消息数自动更新
      （item 0 从「你是谁 11:07 · 2 条消息」变为「你是谁 21:23 · 8 条消息」）
- [x] 流式文本、tool 卡片渲染、模型/思考等级下拉、图片粘贴附件、文件拖入附件均照常工作
