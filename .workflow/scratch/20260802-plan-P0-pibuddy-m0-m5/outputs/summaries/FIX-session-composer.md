# FIX-session-composer：session / composer 四条缺陷

四条缺陷都先自行核实，再动手；每条都有一条**可证伪**的回归测试（临时拆掉修复跑一遍确认变红），
末尾附真机验证取证。

---

## 缺陷 1（P2）composer 与草稿跨 session 串写

### 核实

- `stores/app.ts` 的 `registerSessionScopedReset` 回调清了 `items / toolRuns / queue / localQueue`，
  **没清** `editorText`、`draftAttachments`，也没取消挂起的草稿定时器。
- `scheduleSaveDraft()` 只有**一个全局** `draftTimer`，回调体里才读 `currentSessionId.value` ——
  「在 A 打字 → 500ms 内切到 B → 定时器触发」这条时序下，A 的正文被写进 B 的草稿。
- `InputBar.vue` 的 `images` / `files` 是**组件级 `ref([])`**。组件不随会话重建，
  切走之后图片和文件原样留在输入框里，一按发送就发进了新会话。

### 修法

不是「切会话时清空」，而是**按会话存**（清空会把用户没发完的内容直接丢掉）：

- 新增 `ComposerState { text, images, attachments, queue }`，`composers: Record<sessionId, ComposerState>`。
  `editorText` / `draftImages` / `draftAttachments` / `localQueue` 全部改成同名 computed 代理，
  既有读写点一个字都没改。
- `scheduleSaveDraft()` **在发起时捕获 sessionId**，并按会话各持一个防抖句柄
  （`draftTimers: Map<sessionId, timer>`）；`saveDraftNow(sessionId)` 从**捕获到的那个会话**的
  composer 取数落盘。定时器触发时读「当前会话」正是根因。
- `adoptSession()` 只在「占位空串 → 真 id」这一种转移上搬运 composer（A → B 是换会话，搬过去就是串写本身）。
- `adoptWorkspace()` 换工作区时整表作废（两个工作区可能有同 id 的会话）。
- `restoreDraft()` 写进**发起这次恢复的那个会话**的格子，而不是「现在打开的那个」——
  getDraft 是一次 IPC 往返，期间用户完全可能又切走了。
- `InputBar.vue` 的 `images` / `files` 改成 store 代理；`onDraftChanged` 里那句
  `store.draftAttachments = [...files.value]`（两处状态互相同步的接缝）删掉。
- reset 回调里**不再**清 composer：那个回调是在 `currentSessionId` 还指着旧会话时跑的
  （openSession / newTask 都先 reset 再 refreshState），在那里清等于把用户刚打的字从旧会话里抹掉。

### 测试与对拍

新增 `packages/app/src/renderer/src/stores/composer-session-scope.test.ts`（7 条）
+ `input-bar.test.ts` 新增 1 条（判据落在真实 DOM 上）。

时序测试真的制造了「切走之后定时器才触发」：

```
store.editorText = "只属于 A 的一段话";
store.scheduleSaveDraft();
vi.advanceTimersByTime(200);        // 防抖窗口只走了 200ms，定时器没触发
expect(saveDraft).toHaveBeenCalledTimes(0);
store.currentSessionId = "sess-B";  // 用户切走
store.editorText = "只属于 B 的一段话";
vi.advanceTimersByTime(500);        // 现在才让 A 的定时器到点
```

**对拍 A**（把防抖还原成单个全局句柄 + 触发时读 currentSessionId）：

```
$ npx vitest run .../composer-session-scope.test.ts
   × A 打完字立刻切到 B，到点写下的仍是 A 的会话与 A 的正文
     → expected 'sess-B' to be 'sess-A' // Object.is equality
   × 两个会话各自的防抖互不吞并
     → expected [ [ 'sess-B', 'B 的草稿' ] ] to deeply equal [ [ 'sess-A', 'A 的草稿' ], …(1) ]
   × 从未编辑过的会话不会被写一份空草稿盖掉磁盘上已有的那份
     → expected "spy" to be called +0 times, but got 1 times
      Tests  3 failed | 4 passed (7)
```

**对拍 B**（把 `composer()` 退化成全局单份，即改造前的形态）：

```
$ npx vitest run .../composer-session-scope.test.ts .../input-bar.test.ts
   × A 打完字立刻切到 B…            → expected '只属于 A 的一段话' to be ''
   × 两个会话各自的防抖互不吞并        → expected [ [ 'sess-A', '' ], …(2) ] to deeply equal […]
   × 正文 / 图片 / 附件 / 本地队列切走都不跟过去 → expected 'A 的正文' to be ''
   × 会话 id 未知时打的字…            → expected '' to be '开机就打的一段话'
   × restoreDraft 写进发起恢复的那个会话 → expected 'A 的旧草稿' to be 'B 里正在打的字'
   × InputBar > 10 次连续 keystroke…   → expected { text: '' } to match object { text: '字字字…' }
   × InputBar > 交给 IPC 的草稿是纯数据 → expected [] to deeply equal [ '先攒着的一条' ]
   × InputBar > 切走之后上一会话的图片与附件不留在输入框里
                                      → expected [ DOMWrapper{…} ] to have a length of +0 but got 1
      Tests  8 failed | 4 passed (12)
```

修复后：`Tests 12 passed (12)`。

---

## 缺陷 2（P3）共享自定义 sessionDir 会串 workspace

### 核实

`session-dir.ts` 的第一优先级是 `settings.sessionDir` —— 多个工作区可以共用同一个目录。
而 `session-index.ts` 的 `syncLocked` 无条件 `workspaceId = workspaceIdFor(workspaceRoot)`，
`upsert` 又有 `workspace_id = excluded.workspace_id`：A 同步一次就把 B 的会话全部重标成自己的，
B 再同步一次又抢回去。用户看到的是「历史会话时有时无」，日志里一行错都没有。

### 修法

用 JSONL 头部的 `cwd` 判归属（pi 的 `SessionHeader`：
`source/pi/packages/coding-agent/src/core/session-manager.ts:32-39`，
形如 `{"type":"session","version":3,"id":...,"cwd":...}`）。

- 新增 `headerCwd(head)`：从**已经为算哈希读过的**那 64KB 里取第一行，不多读一个字节。
- 新增 `samePath(a, b)`：`path.resolve` + win32 大小写归一化 —— 与 `workspaceIdFor` 同一套口径。
  pi 记的 cwd 是用户敲进命令行的形态（`d:\proj`），我们的 root 是 realpath（`D:\proj`），
  逐字比较会把它们判成两个目录，表现是「历史会话一条都列不出来」。
- `planFile()` 在算出任何一行**之前**判定：`cwd && !samePath(cwd, workspaceRoot)` → 整份跳过。
- 头部没写 cwd（v1 老会话）时**按当前工作区收下**：拿不准归属就沿用旧行为，
  绝不因为一个读不出来的字段把用户的历史会话整批藏起来。

### 测试与对拍

`session-index.test.ts` 新增 describe「共享 sessionDir 的会话归属（SES-2）」3 条。
测试夹具的 `sessionHeader()` 也跟着改成写真实的 `cwd`（原先写死 `C:\\w`）。

**对拍**（把归属判定退化成无条件重标）：

```
$ npx vitest run .../session-index.test.ts
   × 同一个会话目录被两个工作区共用时，各自只看得到自己的会话
     → expected [ 'theirs', 'mine' ] to deeply equal [ 'mine' ]
   × 对方的会话被追加内容后，本工作区再同步也不会把它重标成自己的
     → expected 1 to be +0 // Object.is equality
      Tests  2 failed | 16 passed (18)
```

修复后：`Tests 18 passed (18)`。

---

## 缺陷 3（P3）磁盘历史分页后备路径被关闭

### 核实

`ChatView.vue` 的会话切换 watcher 写死 `win.reset(0)`，而 `chat-window.ts` 的
`reachedTop = initialBeforeOffset <= 0` —— reset 那一刻就判定已到文件头，
`loadEarlier()` 的第一道闸 `if (loading || reachedTop) return` 直接返回。
设计中的 JSONL 反向分页**一次都不会执行**：不报错、不失败类型检查。

### 修法

- store 新增 `currentSessionBytes`，三处落点：
  `openSession()` 用列表行带来的 `sizeBytes`（**先于 currentSessionId 变化写入**，
  晚一步就等于用 0 去 reset）；`newTask()` / `start()` 归 0；
  `refreshSessions()` 收尾调 `adoptSessionBytes()` 从刚刷新的索引里补齐 ——
  开机直接恢复的那个会话没有「从列表点开」这一步，少了它永远翻不了页。
- `ChatView.vue` 改成 `win.reset(store.currentSessionBytes)`，并加一个
  `watch(currentSessionBytes → win.adoptOffset)` 补迟到的字节数。
- `chat-window.ts` 新增 `adoptOffset(offset)`：**只在还没翻过页时生效**
  （翻过页之后游标代表阅读进度，被文件末尾顶回去等于清零）。

**两条路径的协调（不重复渲染）**：`store.items` 由 `getMessages()` 填充，而首屏的
`beforeOffset` 就是文件长度 —— 第一页磁盘数据必然与内存里那一段是同一批消息。

- `prependMessages()` 按 `role|timestamp|正文前缀` 去重，返回**真正接上去**的条数。
  （不用 `JSON.stringify` 整条：两条路径上同一条消息的字段顺序可能不同。）
- `loadEarlier()` 在「整页消息都被去重掉」时再往前一页，上限 `MAX_OVERLAP_PAGES = 5`；
  「这一页本来就没有消息条目」（全是 model_change 之类）不算重叠，不再往前追 ——
  否则一次点击可能把整个文件读完。

### 测试与对拍

- `chat-window.test.ts` 新增两个 describe（5 条）：字节上界 / 与内存数据的重叠。
- 新增 `packages/app/src/renderer/src/components/chat-view-history.test.ts`（3 条），
  判据落在**真实 DOM 与真实 IPC 调用**上：按钮存在 + `readHistoryBefore` 收到的
  `beforeOffset` 就是会话文件字节数。

**对拍 A**（ChatView 还原成 `win.reset(0)`）：

```
$ npx vitest run .../chat-view-history.test.ts
   × 换会话后按真实字节数 reset，点「查看更早的消息」真的读磁盘
     → Unable to get [aria-label="查看更早的消息"] within: <div class="chat-scroll">
      Tests  1 failed | 2 passed (3)
```

（按钮**根本不渲染** —— 这正是缺陷的真实形态。）

**对拍 B**（`prependMessages` 去掉去重）：

```
$ npx vitest run .../chat-window.test.ts
   × 整页都是内存里已有的消息时去重，并自动再往前取一页
     → expected '已经在内存里' to be '真正更早的一条'
   × 同一页读两次也只接上一次（重入不会把消息插重）
     → expected [ {…}, {…} ] to have a length of 1 but got 2
      Tests  2 failed | 9 passed (11)
```

修复后：`chat-window 11 passed` / `chat-view-history 3 passed`。

`showEarlier` 的重入闸（`expanding`）一个字没动。

---

## 缺陷 4（P3）重复 sessionId 会跨 workspace 操作错误记录

### 核实

`SessionIndex.bySessionId()` 是全局 `WHERE session_id = ? ORDER BY mtime_ms DESC LIMIT 1`，
而 rename / set-pinned / set-status / purge / get-draft / save-draft / read-history 七条通道
的入参里**没有 workspaceId**。复制会话文件、从备份恢复、或共用 session-dir 之后，
这些动作可能落到另一个工作区的会话上 —— `purge` 那一条不可逆。
`sessions-ipc.ts` 的 `tryRow` 还拿 `loadSettings().workspace`（"上一次选过的目录"）去同步。

### 修法

- 契约：新增内部常量 `workspaceScoped = { workspaceId, sessionId }`，
  五个 session 请求 schema 一律以它开头；`readHistoryRequestSchema` 加 `workspaceId`。
  **必填而不是可选** —— 漏传要在编译/校验期就炸。
- `bySessionId(sessionId, workspaceId)` 改成联合过滤，`workspaceId` **必填**。
- `sessions-ipc.ts`：七条 handler 全部按 `(workspaceId, sessionId)` 定位；
  `tryRow` 的工作区取自入参并经 `requireWorkspaceRoot()` 解出 root。
- `pi/pi-ipc.ts` 的 `resolveSessionPath()` 同样带上 `workspaceIdFor(workspaceRoot)` ——
  pi:start / pi:switch-session 走的是同一条解析，漏了它等于只堵了一半。
- preload：`workspaceId` 恒为首参（与既有的 `query(workspaceId, filter)` 一致）。
- 渲染侧：`stores/sessions.ts` 加 `scope()`（恒取 `lastWorkspaceId` —— 这份列表是从哪个工作区
  查出来的）；`stores/app.ts` 的草稿与 readHistory 调用带上 `workspaceId.value`。

### 测试与对拍

`session-index.test.ts` 新增 describe「同 id 会话按工作区限定（SES-4）」1 条
（两份同 id 会话，**后写的那份 mtime 更新** —— 全局「取最近修改的那行」一定会命中它）；
`sessions-ipc.spec.ts` 新增「会动到具体会话的通道，入参一律带 workspaceId」结构断言。

**对拍**（`bySessionId` 退化成全局取最新行）：

```
$ npx vitest run .../session-index.test.ts
   × bySessionId 解出的是本工作区那一份，哪怕另一个工作区的更新
     → expected 'C:\Users\yehh\AppData\Local\Temp\pibu…' to be 'C:\Users\yehh\AppData\Local\Temp\pibu…'
      Tests  1 failed | 17 passed (18)
```

修复后：`Tests 18 passed (18)`。

---

## 收尾门禁

```
$ pnpm typecheck
packages/contract typecheck: Done
packages/pi-sdk  typecheck: Done
packages/app     typecheck: Done

$ pnpm -w test
 Test Files  93 passed (93)
      Tests  817 passed (817)

$ pnpm build
✓ built in 16.00s / 335ms / 14.47s（main / preload / renderer）

$ pnpm dist（packages/app）
• building  target=nsis file=release\PiBuddy-Setup-0.1.0.exe archs=x64
• building block map
```

`main/ipc-guard.ts` 仍是全仓唯一 `ipcMain.handle` 调用点
（`sessions-ipc.spec.ts` 的「registerHandler 是唯一入口」断言绿）。

---

## 真机验证（release/win-unpacked/PiBuddy.exe，--remote-debugging-port=9222）

取证一律经 `scripts/cdp-eval.mjs` 从真实 DOM 读。

**启动 + 会话列表**（同时是缺陷 2 的回归护栏：cwd 判定不能把历史藏起来）

```
{ "title": "PiBuddy · AI 办公小助手",
  "body": "…（未命名任务）\n请用中文逐条列出 1 到 15 的平方数…今天 11:07 · 8 条消息…" }
{ "sessions": 19, "started": true }
```

**缺陷 3：磁盘分页这条路是通的**

```
点开第一个会话 →
{ "sessions": 19, "active": "（未命名任务）\n请用中文逐条列出 1 到 15 的平方数…",
  "showEarlierBtn": true, "earlierText": "↑ 查看更早的消息", "messages": 9 }

点「查看更早的消息」→
{ "before": 9, "after": 8,
  "firstMsgOccurrencesBefore": 1, "firstMsgOccurrencesAfter": 1,   ← 没有重复渲染
  "stillHasBtn": false }                                            ← 读到文件头，按钮撤掉
```

**缺陷 1：composer 不跨会话**

```
在 A 打字 → 立刻切到 B → 再切回 A：
{ "typedInA":        "这段字只属于第一个会话",
  "afterSwitchToB":  "",                          ← B 的输入框是空的
  "activeB":         "（未命名任务）\n这段文字发送失败后必须原样保留 [用户提供的",
  "backInA":         "这段字只属于第一个会话" }    ← 切回来原样还在
```

落盘证据（直接读 `%APPDATA%/@pibuddy/app/session-index.db`）：

```
019fc280-… | 请用中文逐条列出 1 到 15 的平方数… | bytes=10807 | draft= 这段字只属于第一个会话
019fc2a7-… | 这段文字发送失败后必须原样保留…     | bytes=31912 | draft=
--- 全表 workspace_id 分布 ---
[{"workspace_id":"9b74…0021","c":21},{"workspace_id":"c1e2…4beb","c":2}]
```

草稿落在**打字的那个会话**上，切过去的那个是空的；两个工作区各自独立，没有串标。

**必须保护的功能：发送 / 流式 / steer 插话**

```
发送「只回答两个字：收到」→
{ "streamingDot": true, "composerAfterSend": "",
  "tail": "…只回答两个字：收到\n复制\n重新发送\n分叉\nπ\n\n收到\n\n复制\n分叉",
  "stillStreaming": false }

流式中插话（走 prompt + streamingBehavior:"steer"，未改成原生 steer）→
{ "steerButtonVisible": true, "streaming": true, "composerAfterSteer": "",
  "tail": "…请把 1 到 60 每个数字单独写一行，慢慢来。…停下，只说 OK…π\n\nOK\n\n复制\n分叉",
  "stillStreaming": false }
```

**进程收尾**

```
$ powershell Stop-Process -Name PiBuddy -Force; (Get-Process -Name PiBuddy).Count
PiBuddy=0
```

---

## 已知取舍（写下来，不藏）

1. **缺陷 2 不回溯纠正历史错标**。修复前已经被错标成 A 的行会一直留着（闸 1 的
   mtime+size 双命中让它连读都不读）。只要那份文件之后被追加过一次，A 的同步就会
   跳过它、B 的同步会把它标回去。全新安装不存在这个状态。
2. **composers 表按 sessionId 存**，不按 `${workspaceId}::${sessionId}`；换工作区时整表清空，
   因此跨工作区同 id 不会共用格子。代价是切走的工作区里那些未落盘的输入区内容不再保留
   （已经落盘的草稿不受影响）。
3. **`loadEarlier` 的重叠追页上限 5 页**。压缩得极狠的超长会话理论上重叠段可能更长，
   此时用户要多点一次。无上限的替代方案是一次点击可能把整个文件读完。
4. **`sessions:export-html` 也带上了 workspaceId**（它与 purge/get-draft 共用
   `sessionIdRequestSchema`），但那条 handler 用的是 pi 当前打开的会话，参数只被校验、不被使用。
