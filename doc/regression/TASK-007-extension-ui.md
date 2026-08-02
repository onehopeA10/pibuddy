# TASK-007 接口收窄人工回归记录

- 日期：2026-08-02
- 形态：`npx electron packages/app --remote-debugging-port=9222`（electron-vite build 产物，非 dev server）
- 工作目录：`D:\pi\test`（workspaceId `9b7497499cae1f644a743fece40f0021`）
- 模型：`gpt-5.6-sol`（openai），thinkingLevel `max`
- 取证方式：`node scripts/cdp-eval.mjs "<表达式>"` / `node scripts/cdp-drop-file.mjs "<OS 路径>"`
  直连渲染进程调试端口读真实 DOM 与真实 IPC 返回。每条下面附的都是脚本原样输出。

> **先记一条**：本任务的单测、typecheck、build 三样全绿的情况下，应用**打不开** ——
> 界面全白、`window.piBuddy` 为 `undefined`、控制台没有任何堆栈。原因是 preload 开始把
> `CHANNELS` 当值用之后，`@pibuddy/contract` 被 externalizeDepsPlugin 标成 external，而
> sandbox:true 的 preload 里 `require` 只认 electron 与少数内建模块，解析不到就整体静默失败。
> 这正是「必须真机验证」的意义：三条自动化关卡对这类失败完全无感。修法见
> `electron.vite.config.ts` 的 preload 段与 `packages/contract/src/channels.ts`。

## 一、接口面（SEC-002 核心判据）

- [x] `window.piBuddy.pi.command` 为 `undefined`（通用转发通道已删除）

```
{"command":"undefined","bashAttempt":"gone"}
```

- [x] `Object.keys(window.piBuddy.pi).sort()` 恰为 15 项，无第 16 项

```
["abort","compact","followUp","getAvailableModels","getAvailableThinkingLevels",
 "getMessages","getSessionStats","getState","newSession","prompt","setModel",
 "setSessionName","setThinkingLevel","steer","switchSession"]   // length = 15
```

- [x] 顶层命名空间按职责分开，`pi` 下只剩纯粹的产品动作

```
["attachments","events","extensionUi","pi","runtime","sessions","settings","stt","workspace"]
```

- [x] `pi.prompt(...)` 调用后 Promise 为 fulfilled，user 消息 +1、assistant 消息 +1

```
调用返回： {"status":"fulfilled","success":true,"error":null}
发送前：   {"user":0,"assistant":0}
发送后：   {"user":1,"assistant":1,"lastAssistant":"π\n\n收到"}
```

- [x] 投递 pi 原生 bash 形状的载荷，在 IPC 边界被 zod 挡掉（无路可走）

```
piBuddy.pi.prompt({type:'bash',command:'calc.exe'})
→ REJECTED: Error invoking remote method 'pi:prompt':
  [{ "expected":"string", "code":"invalid_type", "path":["message"] ... }]
```

- [x] 附件通道不接受任意绝对路径，只认凭证

```
readImage('C:/Windows/System32/drivers/etc/hosts') → REJECTED: ATTACHMENT_TOKEN_INVALID
open     ('C:/Windows/System32/drivers/etc/hosts') → REJECTED: ATTACHMENT_TOKEN_INVALID
```

- [x] `settings.set` 无法改写工作目录（契约层已 omit workspace）

```
settings.set({workspace:'C:/'}) → RESOLVED, workspace 仍为 "D:\\pi\\test"
```

- [x] 限流：10 秒内前 10 次 prompt 过闸，第 11 次起被拒

```
{"attempts":13,"limited":3,
 "seq":"ok,fail,fail,fail,fail,fail,fail,fail,fail,fail,RATE_LIMITED,RATE_LIMITED,RATE_LIMITED"}
```
（中间 9 条 `fail` 是 pi 侧「Agent is already processing」的业务拒绝，说明它们**确实过了闸**；
第 11/12/13 条才是 `IPC_RATE_LIMITED`，即闸门本身生效。）

## 二、workspace capability（SEC-003 核心判据）

- [x] workspaceId 由 canonical realpath 派生并持久化

```
<userData>/workspaces.json
{ "9b7497499cae1f644a743fece40f0021": { "root": "D:\\pi\\test", "registeredAt": 1785679561738 } }
```

- [x] **跨真实重启稳定**（裁定3 的直接判据：不稳定则重启后历史会话全查不到且不报错）

```
重启前： {"workspaceId":"9b7497499cae1f644a743fece40f0021","displayPath":"D:\\pi\\test"}
重启后： {"workspaceId":"9b7497499cae1f644a743fece40f0021","displayPath":"D:\\pi\\test"}
重启后会话列表： {"sessions":8,"folder":"📁 test","started":true}
```

- [x] 拖拽文件 → 凭证（绝对路径在 preload 内部即被换掉，不进渲染进程）

```
node scripts/cdp-drop-file.mjs "D:\pi\test\probe-note.txt"
→ chips: ["📎probe-note.txt✕"]
```

- [x] 发送时由**主进程**用凭证换回真实路径拼进提示词，pi 确实读到了文件

```
lastUser:      "读一下我给你的这个文件… [用户提供的文件] - D:\\pi\\test\\probe-note.txt"
lastAssistant: "π 我先读取指定文件，然后按原有内容逐字返回。 📄 查看文件 D:/pi/test/probe-note.txt ✓"
toolCards: 1
```

## 三、11 项功能回归

| # | 项目 | 结论 | 证据 |
|---|------|------|------|
| 1 | 发送纯文本 | [x] | `{"user":1,"assistant":1,"lastAssistant":"π\n\n收到"}` |
| 2 | 粘贴/拖入图片发送（多模态） | [x] | 预览 `data:image/png;base64,iVBORw0KGgo…`；发送后 `userHasImg:true`，模型答出像素尺寸 |
| 3 | 拖拽文件发送 | [x] | 见上「二」第 3/4 条 |
| 4 | 流式中插话（steer） | [x] | 见下方专节 |
| 5 | 点击停止（abort） | [x] | 停止前 `streaming:true` → 点击后 `{"streaming":false,"stopGone":true}` |
| 6 | 切换模型 | [x] | 模型下拉 55 项，当前 `GPT-5.6 Sol`；`getAvailableModels().data.models.length = 55` |
| 7 | 切换 thinking level | [x] | `setThinkingLevel('low')` → `success:true`；`getState().thinkingLevel = "low"` |
| 8 | 新任务 | [x] | 点击「＋ 开始新任务」5s 后 `{"user":0,"assistant":0,"welcome":true}` |
| 9 | 切换历史会话 | [x] | 点击侧栏第 2 条 → `{"user":1,"assistant":4,"loadErr":null}`，消息按该会话重载 |
| 10 | 费用与 context 显示 | [x] | 顶栏 `记忆已用 8%`；`getSessionStats().success = true` |
| 11 | 语音输入 | [ ] 未驱动 | 见「五、未完成项」 |

补充：**流式文本增量 / thinking 折叠 / tool call 卡片**三项一并确认

```
thinking 折叠： "π 💭 思考过程 ▼ 1 2 3 4 5 … 29"（可折叠块正常渲染）
tool call 卡片： "📄 查看文件 D:/pi/test/probe-note.txt ✓"，toolCards = 1
```

### 插话（steer）专节 —— 本任务最高危回归点

PiBuddy 的插话走 `prompt + streamingBehavior:"steer"`，**不是** pi 的原生 steer 命令
（rpc.md 第 65 行）。若在收窄时把插话错映射到 `pi.steer`，用户输入会静默失败。

步骤：发「请从1数到40，每个数字单独一行」→ 确认进入流式 → 流式中再发「停下，改成只说一句：已插话成功」。

```
流式中：   {"streaming":true,"stopBtn":true,"statusText":"正在努力工作中… 你可以随时输入新指令插话，或点「停止」"}
插话后：   {"userMsgs":3,"textCleared":true}
最终结果： lastTwoAssistant = [
             "π 💭 思考过程 ▼ 1 2 3 4 … 29 ",      ← 原计数任务被打断在 29
             "π 已插话成功"                          ← 助手改为执行插话指令
           ]
```

计数任务在第 29 个数字处被打断、助手转而执行插话指令，证明 steer 分支完整存活。

## 四、Extension UI 七种交互

`ExtensionUiHost.vue` 本任务**零改动**（`git diff --stat` 无输出），
`stores/app.ts` 中相关改动只有一行通道重命名：

```diff
-    await window.piBuddy.pi.uiRespond({
+    await window.piBuddy.extensionUi.respond({
```

- [x] setStatus：扩展上报的常驻状态真实渲染在顶栏

```
{"usage":["AUTO ON · ACT · YOLO","记忆已用 8%"]}
```

- [x] 响应通道契约：格式正确的响应被接受并转发给 pi；伪造类型被 schema 拒绝

```
{"wellFormed":"accepted(转发给 pi)","malformed":"REJECTED by schema"}
```

- [ ] select / confirm / input / editor / notify / set_editor_text 六项**未逐项驱动**

原因与处置见下节。**这六行不打勾** —— 没有真实触发过就不写 `[x]`。

## 五、未完成项（如实记录，不粉饰）

1. **Extension UI 六种交互未逐项驱动**。这些请求由 pi 侧扩展主动发起，当前工作目录加载的
   扩展处于 `AUTO ON · ACT · YOLO` 模式，正常对话流程中不会弹出 select/confirm/input/editor，
   也没有找到可从渲染进程侧主动触发的入口（`get_commands` 不在 15 个窄方法内）。
   已确认的替代证据：宿主组件零改动 + 响应通道契约校验通过 + setStatus 端到端可见。
   建议在 TASK-012（扩展 UI 迁到独立 store）时配一个专用测试扩展补齐这张表。
2. **语音输入未驱动**。需要真实麦克风授权与一个可用的 OpenAI 兼容 STT 端点，
   当前设置里 `sttApiKey` 未配置。相关的通道上限已在单测中验证
   （`stt:transcribe` 9MB 过闸、26MB 被拒，见 `packages/app/test/ipc-guard.spec.ts`）。
3. **magic bytes 拒绝未走真机 token 路径**。`.png` 扩展名 + `MZ`（PE）首字节的拒绝逻辑由单测覆盖
   （`ATTACHMENT_NOT_AN_IMAGE`）。真机上这条路径要经系统文件对话框（`attachments.pick()`），
   原生弹窗无法用 CDP 自动化选中。拖拽进来的图片走的是渲染侧 FileReader 内联 base64，
   不经过 token，因此也不经过嗅探 —— 这不构成越权（用户自己拖进来的字节送给模型），
   但需要在文档里说清楚，避免后续任务误以为「所有图片都嗅探过」。
