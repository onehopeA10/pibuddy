# TASK-010: SES-102 长对话与输入队列（delta 流式 / 分段数据源 / 插话分流 / 草稿恢复）

## Changes

### 主进程
- `packages/app/src/main/pi/event-forwarder.ts`：折叠规则从「保留末帧全量快照」升级为
  **delta 累加**。只有同类型、同 `contentIndex` 的 `text_delta` / `thinking_delta` 才合并，
  合并结果以**末帧为基底**展开（`message` / `assistantMessageEvent.partial` 全量快照与信封的
  `sequence` / `occurredAt` 都取最后一帧），只有 `delta` 首尾累加。
  `text_start` / `text_end` / `thinking_*` / `toolcall_*` / `done` / `error` 一律不合并。
  同 `toolCallId` 的 `tool_execution_update` 仍是覆盖式折叠（仍是累积快照语义）。
  判据路径逐字为 `payload.assistantMessageEvent`，入参类型锁死 `PiEnvelope<AgentEvent>[]`。
- `packages/app/src/main/pi/event-forwarder.test.ts`（新建）：200 条单字符 delta 拼接无损、
  W-4 三帧快照取末帧、跨 contentIndex / 非 delta 不合并、33ms 窗口内 20 条只发 1 次、
  窗口销毁时 0 次且不抛。fixture 全部经 `wrapEnvelope(...)`。

### 渲染进程
- `stores/app.ts`
  - 流式改 delta 拼帧：模块级 `streamBuffer` / `streamContentIndex` / `streamKind` / `rafId`，
    delta 只入缓冲并用 `requestAnimationFrame` 调度一次落地；边界事件先 flush 再用事件
    携带的全量快照对齐一次（漂移在每个内容块边界自愈）。`message_end` 直接丢缓冲、
    用最终消息入列。切会话 / `message_start` 都 `resetStream()`。
  - `send()` 三路分流：非 streaming 发裸 `prompt`；streaming 必须带 `mode`，
    映射表 `STREAMING_BEHAVIOR` 把 `steer` / `followUp` 映成 `streamingBehavior` 取值。
    **mode 缺失时在发 RPC 之前抛错**（rpc.md:65）。传输命令恒为 `prompt`。
  - 本地未提交队列 `localQueue` + `enqueueLocal` / `updateLocalQueueItem` / `removeLocalQueueItem`。
  - 草稿：`scheduleSaveDraft()` 尾沿防抖 500ms → `saveDraftNow()` → `sessions.saveDraft`；
    `restoreDraft()` 在 `refreshSessions()` 之后调用。
  - 会话级清空回调里补上 `resetStream()` 与 `clearChatUiState()`。
- `stores/chat-ui.ts`（新建）：`openThinking` / `expandedTools` 两个 reactive 容器 + `thinkingKey()` +
  `clearChatUiState()`。展开态从组件内 ref 提到 store。
- `stores/chat-window.ts`（新建）：向更早翻页只走
  `window.piBuddy.sessions.readHistoryBefore({ sessionId, beforeOffset, limit })`，
  `nextBeforeOffset === null` 即到顶不再请求；`stale` 时先 `sessions.query()` 同步再**只重试一次**；
  失败置 `loadError` 并暴露 `retry()`。另含未读分界线（只插第一条、回底 1000ms 后撤）。
- `components/ChatView.vue`：接入 `useChatWindow`，**保留 activityTick 订阅**（流式滚动唯一驱动），
  新增「跳到底部」、未读分界线 `[data-unread-divider]`、历史加载失败重试。
- `components/MessageItem.vue`：展开态读 store；**流式走纯文本、非流式才 `renderMarkdown`**；
  复制 / 重新发送 / 分叉 / 错误详情按钮与 aria-label；思考展开用 `<button aria-expanded>`。
- `components/ToolActivity.vue`：展开态读 store；`missing`（查不到 run）与 `running` 分开渲染，
  查不到时显示「工具记录已不可用」；`role="region"` / `aria-expanded`。
- `components/InputBar.vue`：streaming 时给出「先攒着」/「立即插话」/「下一轮处理」三个按钮
  （后两个带 aria-label）；草稿由 `watch([editorText, images, files])` 触发；挂载 `QueuePanel`。
- `components/QueuePanel.vue`（新建）：本地未提交段「编辑 + 删除」，已提交段只读并标注
  「不可撤回：pi 没有提供撤回队列的命令」。

### 测试
新建 8 个 spec：`event-forwarder.test.ts`、`send-routing.test.ts`、`chat-window.test.ts`、
`stream-buffer.test.ts`、`message-item.test.ts`、`tool-activity.test.ts`、`queue-panel.test.ts`、
`input-bar.test.ts`、`chat-view.test.ts`、`chat-window.perf.test.ts`。

### 工程
- `vitest.config.ts` 加 `plugins: [vue()]`（**未新建第二份配置**，CT-21 不变）。
- 根 devDeps 增加 `@vue/test-utils` / `happy-dom` / `@vitejs/plugin-vue` / `vue` / `pinia` / `naive-ui`。
  最后三个是必须的：`@vitejs/plugin-vue` 会设 `resolve.dedupe: ['vue']`，强制从仓库根解析 vue，
  而根 `node_modules` 原先没有它 —— 不加这三个，**所有 import store 的既有 spec 会整批解析失败**。
- 更新 `packages/app/test/event-forwarder.spec.ts` 的 fixture（原来投喂不带
  `assistantMessageEvent` 的 message_update，新规则下不再折叠）。

## Verification

| 收敛条件 | 结果 | 证据 |
|---|---|---|
| c[0] collapseEnvelopes 签名逐字 / 含 `'text_delta'` `'thinking_delta'` `contentIndex` `payload.assistantMessageEvent` / 不读裸事件 / 无 `= e;` 覆盖 | PASS | 1 / 1,1,2,2 / 0 / 0 |
| c[1] fixture 经 wrapEnvelope、200 delta 拼接、跨 index 不合并 | PASS | `rg -c wrapEnvelope\(` = 2；单测通过 |
| c[2] W-4 三帧：delta='abc'、两处快照='abc'、sequence=3 | PASS | `event-forwarder.test.ts` "W-4" 用例 |
| c[3] activityTick 仍在 + ChatView 滚动单测 | PASS | app.ts 5 处 / ChatView 2 处；`chat-view.test.ts` 正反两个用例 |
| c[4] rAF+streamBuffer ≥2；流式不走 Markdown（双向断言） | PASS | 计数 8；`message-item.test.ts` streaming=true→0 次、false→1 次 |
| c[5] steer/followUp 各 ≥1、原生命令 0、send 签名不变、四条行为断言 | PASS | 1/1/0/0/1；`send-routing.test.ts` (a)(b)(c)(d) 全过 |
| c[6] chat-ui 两个容器、组件内 ref 归零 | PASS | 2 / 0 |
| c[7] `!run \|\| running` 归零 + 「工具记录已不可用」正向断言 | PASS | 0；`tool-activity.test.ts` |
| c[8] 插话/下一轮 aria-label、队列编辑删除、草稿重启恢复、longtask 门禁 + 落盘 | PASS（一处口径差异见下） | `input-bar.test.ts` / `queue-panel.test.ts` / 真机重启恢复 / `doc/regression/TASK-010-perf.json` |
| c[9] `typecheck` 与 `test` 退出 0 | PASS | typecheck 0；`vitest run` 45 files / **347 tests 全过** |
| c[10] `check-contract-uniqueness.mjs` | PASS | exit 0（`contract exports 113 / OK`） |
| c[11] chat-window 含 readHistoryBefore + beforeOffset；renderer 无 get_entries | PASS | 2 / 3 / 0 |
| c[12] 三页翻完到顶不再请求、stale 重试一次、失败重试一次 | PASS | `chat-window.test.ts` 5 个用例 |
| c[13] 切会话后 rafId=null、streamBuffer=''、新会话不含旧字符 | PASS | `stream-buffer.test.ts` |
| c[14] 33ms 内 20 条只 1 次 send；窗口销毁 0 次不抛 | PASS | `event-forwarder.test.ts` |
| c[15] 已提交队列无删除按钮 + 「不可撤回」；本地项有编辑+删除 | PASS | `queue-panel.test.ts` + **真机 DOM**：committed 分区 `buttons=[]`，文案含「不可撤回」 |
| c[16] 草稿 debounce 500ms，10 次 keystroke 只调 1 次 | PASS | `input-bar.test.ts` |
| c[17] 未读分界线三场景（1 / 0 / 仍 1） | PASS | `chat-view.test.ts` + `chat-window.test.ts` |
| c[18] 仓库唯一 vitest 配置；test-discovery discovered==onDisk | PASS（find 口径差异见下） | `git ls-files` 只有根两份；discovery 45 == 45，exit 0 |
| c[19] AppShell 插槽名集合不变 | PASS | 4 |

### 实跑输出（关键）
```
pnpm --filter @pibuddy/app typecheck   → exit 0
npx vitest run                          → Test Files 45 passed / Tests 347 passed
pnpm build                              → ✓ built（main/preload/renderer 三段全过）
node scripts/check-contract-uniqueness.mjs → exit 0
node scripts/check-test-discovery.mjs   → discovered 45 / onDisk 45 / exit 0
```

## 真机验证（`npx electron packages/app --remote-debugging-port=9222` + `scripts/cdp-eval.mjs`）

杀进程一律用 `powershell Stop-Process -Force` 并核对进程数归 0 后再重启。

1. **长回复零丢字**（本任务最危险的一处）
   提示词「从 1 数到 300，逗号分隔」，完成后从真实 DOM 取正文：
   `{"len":1091,"count":300,"first":"1","last":"300","gaps":[],"tail":"…,298,299,300"}`
   —— 300 个数字一个不缺、无错序。delta 拼帧路径在真机长回复上无损。
2. **流式不进 Markdown**：streaming 期间 `.stream-text` 有内容而
   `.msg-assistant .markdown` 计数为 0；`agent_settled` 之后变成 `.markdown` 计数 1。
3. **插话两种模式**：streaming 期间按钮 aria-label 实测为
   `["复制这条消息","重新发送这条消息","从这条消息分叉","立即插话","下一轮处理"]`；
   点「立即插话」后状态栏出现「（已排队 1 条插话）」，队列面板 committed 分区渲染出
   「已经交给助手了（不可撤回：pi 没有提供撤回队列的命令）立即插话 停，改成只写 1 到 3 就好」，
   且该分区 `querySelectorAll('button')` 为**空数组**（没有假的删除按钮）。
4. **草稿恢复**：输入草稿 → 3 秒后直接读 SQLite：
   `draft_json = {"text":"这是一段还没发出去的草稿，重启后应该还在",...}`；
   `Stop-Process -Force` 确认进程数 0 → 重启 → 打开同一会话 →
   `{"restoredDraft":"这是一段还没发出去的草稿，重启后应该还在","rows":2}`。
5. **滚动跟随**：把 `.chat-scroll` 压到 180px 后发长回复，末态
   `{"h":5106,"top":4926,"gap":0}` —— 视口全程贴底。

### 真机抓到并已修复的两个「三大门禁全绿但功能已死」

- **[已修]「草稿永远存不上」**。`saveDraft` 的 payload 里 `attachments` / `queue` 是 Vue 的
  响应式代理，Electron IPC 的结构化克隆直接抛
  `Error: An object could not be cloned.`。这个异常只在 `await` 处冒出来，被
  `saveDraftNow` 里的**空 catch** 吞掉：typecheck / 单测 / 构建全绿，主进程一行日志都没有，
  界面上没有任何征兆，表现就是草稿静默丢失。
  修复：加 `plainCopy()`（JSON 往返剥代理）+ 把空 catch 换成写 `lastDraftError`；
  并补单测断言交给 IPC 的草稿 `isReactive === false` 且 `structuredClone` 不抛。
  （诊断过程记一笔：生产构建会丢掉 `console.warn`，只能用 `document.title` 探针把原因取出来。）
- **[已修] 每次启动一条 `ipc_rejected: SESSION_UNKNOWN`**。`restoreDraft()` 原本紧跟
  `start()` 调用，而**全新会话在 pi 写下第一条消息之前根本没有 .jsonl 文件**，不可能在索引里。
  修复：`restoreDraft()` 挪到 `refreshSessions()` 之后，并在调用 `getDraft` 前先确认
  sessionId 在 `useSessionsStore().rows` 里。真机复验 `grep -c SESSION_UNKNOWN` = 0。

## Deviations

1. **`readHistoryBefore` 入参用 `sessionId` 而不是 action 里写的 `sourcePath`。**
   TASK-009 落地的 preload 签名是 `{ sessionId, beforeOffset, limit }`，JSONL 绝对路径全程留在
   主进程（CT-15）。按 action 原文传 `sourcePath` 会把路径泄回渲染进程，与已交付的边界冲突。
2. **性能门禁观测 `measure` 而非 `longtask`。** `longtask` 这个 entryType 只有浏览器主线程会
   产生，happy-dom / Node 下不存在，按原文写会得到一个恒为空的 entries 数组（永真断言）。
   改为脚本对每个阶段显式打点，判据（>200ms 即失败）与落盘路径 `doc/regression/TASK-010-perf.json`
   不变。另：10 次扩窗**分别打点**而不是合成一条 —— longtask 的定义是「一段不被打断的同步
   工作」，合成一条量的是吞吐不是卡顿。实测最大单段 97ms（load），全部在预算内。
3. **c[10] 的 `rg -c "from '@pibuddy/contract'"` 用的是单引号字面量**，而本仓 Prettier 风格是
   双引号。本任务在 `main/` 下新增的唯一 .ts 是 `event-forwarder.test.ts`，它确实
   `import ... from "@pibuddy/contract"`（双引号），按字面 grep 命中为 0。没有为了迁就一条
   grep 去破坏全仓引号风格；`check-contract-uniqueness.mjs` 本体退出 0。
   本任务未在 `preload/api/` 下新增文件。
4. **c[18] 的 `find` 口径**：该命令只排除 `./node_modules` 与 `./source`，因此还会命中
   `packages/app/resources/pi-runtime/node_modules/@mistralai/**/vitest.config.ts` 与
   `packages/app/release/win-unpacked/**` 里同一份 vendored 配置（TASK-003 自包含 runtime 的产物，
   改前就存在，且 `git ls-files` 不跟踪）。**我方源码的 vitest 配置仍恰为根上两份**，
   且 `check-test-discovery.mjs` 的 discovered 与 onDisk 均为 45、退出 0。
5. **修改了不在 focus_paths 里的 `packages/app/test/event-forwarder.spec.ts`**：它的 fixture 依赖
   旧折叠规则（不带 `assistantMessageEvent` 的 message_update 也折叠），新规则下必然失败。
   同时补了一条「没有 assistantMessageEvent 的 message_update 不再折叠」的正向断言。
6. **修改了共享的根 `vitest.config.ts`**（只加 `plugins: [vue()]`）与根 `package.json` devDeps。
   与 TASK-011 并行，两处都是纯增量。
7. **`enqueueLocal` 需要一个入口**，否则本地未提交队列在真实 UI 里永远是空的（可编辑可删除
   就成了空话）。为此在 streaming 期间加了「先攒着」按钮（aria-label「先加入队列稍后再发」）。
   计划里没有明写这个按钮，属为满足 c[8]「队列区显示未发送项且每项同时存在编辑与删除」
   所必需的最小补充。
8. **会话树可视化 / fork-rewind 不静默删分支未做**（计划 risks[4] 已标注延期）。
   本任务只做了「从这条消息分叉」的按钮入口（emit `fork`），尚未接后端命令。
9. **「重新发送」目前是把原文回填输入框**，不是直接重发 —— 直接重发在助手运行期间会需要
   mode 选择，回填让用户自己决定发送方式，语义更安全。

## Notes（下游任务需要知道的）

- **`send()` 在 streaming 时不带 `mode` 会抛错**（且一次 RPC 都不发）。所有调用点在 streaming
  期间必须显式给 `"steer"` 或 `"followUp"`。TASK-014/015 如果新增发送入口，照此办理。
- **展开态已经不在组件里了**：读写 `stores/chat-ui.ts` 的 `openThinking[thinkingKey(key, i)]`
  与 `expandedTools[toolCallId]`。换会话由 `clearChatUiState()` 统一清，已挂进
  `registerSessionScopedReset`。
- **任何要跨 IPC 的对象都必须先剥响应式代理**。`stores/app.ts` 里的 `plainCopy()` 可以直接复用。
  这类错误不会被 typecheck / 单测 / 构建拦住，只会在真机上静默失败。
- **`useChatWindow()` 的首屏 `beforeOffset` 目前由 ChatView 用 0 初始化**（即「不向前翻」）。
  会话列表打开会话时应把 `SessionRow.sizeBytes` 传进来，向上翻页才真正生效 —— 这条留给
  接手会话打开流程的任务补，`chat-window.ts` 一侧已经就绪且有单测覆盖。
- **`packages/app/test/preload-api.spec.ts` 的「七个键」断言**在 TASK-011 加了 `update` 命名空间
  后已由对方更新为八个键，本任务未触碰。
