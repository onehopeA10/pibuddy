# TASK-006: SES-001 + SES-002 会话解析统一与交互一致性垂直切片

## Changes

### 主进程 · 会话解析（SES-001）

- `packages/app/src/main/sessions/session-dir.ts`（新建）：纯函数 resolver。
  `encodeSessionDirSegment` 逐字复刻 pi 的
  `` `--${resolvedPath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--` ``（关键是
  **先剥前导分隔符**）；`resolveSessionDir(cwd, settings)` 实现
  `settings.sessionDir` → `PI_CODING_AGENT_SESSION_DIR` →
  `PI_CODING_AGENT_DIR/sessions/<seg>` → `~/.pi/agent/sessions/<seg>` 四级链。
  全文件不含任何文件系统 API，TASK-009 换枚举器时可原样存活。
- `packages/app/src/main/sessions/session-repository.ts`（新建）：全仓唯一枚举入口
  `listSessionsForWorkspace`。优先走 pi 导出的 `SessionManager.list(cwd, sessionDir)`
  （以变量形式动态 import，避免 electron-vite 把整个 pi 打进主进程包，实测
  out/main/index.js 仍为 197KB）；失败时回退自实现的 `node:fs/promises` 异步扫描，
  `MAX_SESSIONS_SCANNED = 200`、每文件只读前 `MAX_SESSION_HEAD_BYTES = 1_048_576`，
  单个坏文件只填 `parseError` 并保留条目。
- `packages/app/src/main/sessions-store.ts`：**删除**（同步 readdir/stat/整文件读入
  的旧路径整体消失）。
- `packages/app/src/main/ipc.ts`：`sessions:list` 改为 `await
  listSessionsForWorkspace(workspace, loadSettings())`；`pi:start` 把
  `resolveSessionDir(...)` 结果传给 supervisor。
- `packages/app/src/main/pi-supervisor.ts`、`packages/contract/src/ports.ts`：
  `PiRuntimeStartOptions` 增加 `sessionDir` 并透传到 client。
- `packages/pi-sdk/src/client.ts`：`PiClientOptions.sessionDir` +
  `args.push("--session-dir", o.sessionDir)`。
- `packages/contract/src/settings.ts`：`AppSettings` 增加 `sessionDir?`。

### 渲染进程 · 交互一致性（SES-002）

- `packages/app/src/renderer/src/stores/app.ts`
  - 模块级 `registerSessionScopedReset` / `resetSessionScopedState`：换会话时清哪些
    状态由各 store 自行注册，不再是散落在 start/newTask 里的手写字段枚举。
    app.ts 自己注册 items / toolRuns / queue / statusTexts / uiRequests / liveAssistant 六项。
  - 模块级 `export async function send(opts: SendOptions = {}): Promise<boolean>`：
    返回值即「RPC 是否已接受」。RPC 抛异常也返回 false 而不是把异常泄给调用方。
  - `newTask` / `openSession` 读 `resp.data.cancelled`，为 true 时只给 warning、
    不动任何状态。
  - `openSession` 切换成功后先 `resetSessionScopedState()` 再 `reloadMessages()`；
    拉消息失败设 `sessionLoadError`，绝不留旧消息冒充新会话。
  - `start(sessionPath)` 用 `if (sessionPath === undefined) { ... } else { ... }`
    分支控制是否套用全局 settings 的 provider/modelId/thinkingLevel；
    `set_thinking_level` 前比较 `result.state.thinkingLevel !== saved.thinkingLevel`。
    else 块留给 TASK-014 的 modelMismatchPrompt。
  - `REFRESH_SESSIONS_DEBOUNCE_MS = 2000` + `scheduleRefreshSessions()`：
    `agent_settled` 不再每条触发一次全量目录扫描。
- `packages/app/src/renderer/src/components/InputBar.vue`：
  `if (await store.send(payload)) { 清空三项 }` + `catch` 分支，消除
  `void submit()` 下的静默未处理 rejection。
- `packages/app/src/renderer/src/components/ChatView.vue`：`sessionLoadError` 非空时
  显示错误条与「重试」按钮（绑 `store.reloadMessages()`）。
- `packages/app/src/renderer/src/components/Sidebar.vue`：名称 / 首条消息 / 消息数 /
  修改时间四字段各占其位，`parseError` 非空时加「解析失败」标记而不隐藏条目。
- `packages/app/src/renderer/src/styles.css`：`.preview` / `.parse-error` /
  `.session-load-error` 样式。

### 测试与工具

- `packages/app/test/session-dir.spec.ts`（新建，8 用例）
- `packages/app/test/session-interaction.spec.ts`（新建，15 用例）
- `packages/app/doc`→ `doc/regression/TASK-006-session.md`（人工回归取证记录）
- `scripts/cdp-eval.mjs` / `scripts/cdp-drop-file.mjs`（新建）：连 Electron 调试端口
  读真实 DOM / 投带 OS 路径的文件拖拽，让 [UI-observable] 条目留下可复核证据。

## Verification

逐条实跑，命令与真实输出如下。

- [x] c[1] 枚举单一路径

```
$ rg -c 'SessionManager\.list\(' packages/app/src/main/sessions/session-repository.ts
2
$ rg -c 'from "@earendil-works/pi-coding-agent"' packages/app/src/main/sessions/session-repository.ts
1
$ rg --no-filename -c 'export async function listSessionsForWorkspace' packages/app/src/main | awk '{s+=$1} END{print s+0}'
1
```

- [x] c[2] resolver 与枚举分离

```
$ python -c "…'export function encodeSessionDirSegment' in s, '.replace(/^[/\\]/, \"\")' in s"
c2 replace-literal present: True
c2 encode export present: True
$ [ "$(rg -c 'readdir|readFile|statSync|fs\.' packages/app/src/main/sessions/session-dir.ts | wc -l)" -eq 0 ]
c2-no-fs: PASS
```

（注：直接用 rg 搜 `.replace(/^[/\\]/, "")` 会被 shell 转义吃掉反斜杠，
故改用 python 做字面量比对，结论一致。）

- [x] c[3] 四级优先链

```
$ rg -c 'PI_CODING_AGENT_SESSION_DIR' … → 2
$ rg -c 'PI_CODING_AGENT_DIR' …          → 2
$ rg -c 'settings\.sessionDir' …         → 2
$ rg -c 'export function resolveSessionDir\(cwd: string, settings: AppSettings\): string' … → 1
```
四级各一个用例在 `session-dir.spec.ts` 的「resolveSessionDir 四级优先链」describe 中，全部通过。

- [x] c[4] 无同步 I/O + 旧模块消失

```
$ [ "$(rg -c 'readFileSync|readdirSync|statSync' packages/app/src/main/sessions/session-repository.ts | wc -l)" -eq 0 ]
no-sync-fs: PASS
$ test ! -e packages/app/src/main/sessions-store.ts
sessions-store deleted: PASS
```

- [x] c[5] 上限常量 — `MAX_SESSIONS_SCANNED = 200` × 1、`MAX_SESSION_HEAD_BYTES` × 4
- [x] c[6] `parseError` × 5，单个坏文件只标记不影响其它条目
- [x] c[7] `rg -c -F '"--session-dir"' packages/pi-sdk/src/client.ts` → 1
- [x] c[8] 纯函数断言（`pnpm -w test` 内通过）

```
encodeSessionDirSegment("/home/u")        === "--home-u--"     ✓
encodeSessionDirSegment("/home/u").includes("---") === false   ✓
encodeSessionDirSegment("D:\\x")          === "--D--x--"       ✓
encodeSessionDirSegment("C:\\Users\\yehh")=== "--C--Users-yehh--" ✓
```

- [x] c[9] `rg -c --no-filename 'cancelled' …/stores/app.ts | awk …` → **6**（>= 2）
- [x] c[10] `export function registerSessionScopedReset` × 1、
  `function resetSessionScopedState` × 1、`resetSessionScopedState()` × 4（>= 2）；
  单测「注册的回调恰被调用一次」通过
- [x] c[11] 六项断言（items / toolRuns / queue / statusTexts / uiRequests / liveAssistant）通过
- [x] c[12] `rg -c -F 'export async function send(opts: SendOptions = {}): Promise<boolean>'` → 1
- [x] c[13] node 脚本按行号区间断言

```
c13 if-line: 146 | contains 'catch': true
c13 if-block lines: 146 .. 150
c13 `store.editorText = ""` at lines: [ 147 ]
c13: PASS
```

- [x] c[14] node 脚本 else 分支断言

```
c14 if-line: 617
c14 if-block: 617 .. 634 | has setModel: true | has set_thinking_level: true
c14 else on close line: "} else {"
c14 else-block: 634 .. 638 | setModel count in else: 0
c14: PASS
```

- [x] c[15] `app.ts:628  if (saved.thinkingLevel && result.state.thinkingLevel !== saved.thinkingLevel) {`
- [x] c[16] `sessionLoadError` × 8；ChatView.vue 含「重试」按钮绑 `store.reloadMessages()`
- [x] c[17] `rg --no-filename -c 'REFRESH_SESSIONS_DEBOUNCE_MS =' packages/app/src/renderer | awk …` → 1；
  fake timers 单测「连续 10 次 agent_settled 只触发一次目录枚举」通过
- [x] c[18] 三组用例（new_session cancelled / switch_session cancelled / send success:false → false）通过
- [x] c[19] `pnpm typecheck` 退出码 0、`pnpm -w test` 退出码 0

```
Test Files  12 passed (12)
     Tests  93 passed (93)
EXIT=0
packages/app typecheck: Done
TC_EXIT=0
```

- [x] c[20] 草稿保留（人工，取证见 `doc/regression/TASK-006-session.md`）
- [x] c[21] (a)(b)(c) 三小项（人工，同上）

### 补充实跑（非 criteria 但直接对着 definition_of_done）

真实会话目录枚举（`SessionManager.list` 路径实际生效，非回退）：

```
dir = C:\Users\yehh\.pi\agent\sessions\--C--Users-yehh--
count = 1
{ "id": "019fb5f0-…", "firstMessage": "学习 Wechatsync 代码…", "messageCount": 764,
  "modified": 1785501898466, "cwd": "C:\\Users\\yehh" }
```

pi 子进程真的收到了同一个目录：

```
…\dist\cli.js --mode rpc --session-dir C:\Users\yehh\.pi\agent\sessions\--D--pi-test--
```

`pnpm --filter @pibuddy/app build` 通过，主进程包 197KB（pi 未被打进包里）。

## Tests

- `pnpm -w test` → 12 files / 93 tests passed，退出码 0
- `pnpm typecheck` → 3 个包全部 Done，退出码 0
- `pnpm --filter @pibuddy/app build` → main / preload / renderer 三段全部成功

## Deviations

1. **`SessionManager.list` 用变量形式的动态 import 而非静态 import。**
   任务 action 写的是「优先调用 pi 公开导出的 SessionManager.list」，静态
   `import { SessionManager } from "@earendil-works/pi-coding-agent"` 会被
   electron-vite 静态解析并把整个 pi（devDependency，且带动态 require）打进主进程包。
   改为 `await import(PI_MODULE_ID)` + `import type { SessionInfo }`，语义不变、
   打包形态安全，且失败时永久降级到回退扫描。已实测走的是 pi 路径（返回带
   `cwd` 字段的结果，回退路径同样能填，但耗时 2s 的 module 加载可证）。

2. **`send()` 是模块级导出函数而非 store 内闭包。**
   收敛条件 c[12] 锁定的签名 `export async function send(...)` 无法写在
   `defineStore` 的 setup 闭包里。实现为模块级函数、内部 `useAppStore()` 取实例，
   并在 store 返回对象里以 `send` 暴露 —— 组件侧 `store.send(...)` 调的就是它，
   没有第二份实现。为此 store 额外导出了 `notify`。

3. **`send()` 的入参从三个位置参数改为 `SendOptions` 对象。**
   这是 c[12] 锁定签名的直接后果，唯一调用点 InputBar.vue 已同步。

4. **c[21](c) 的「Extension UI 弹窗数 === 0」是空环境下的 0。**
   本机没有会主动发起 `select` 的 pi 扩展，无法在会话 A 里造出一个真实弹窗再切走。
   实测的 0 是「切换后没有弹窗」而非「弹窗被清掉了」。清空动作本身由
   `session-interaction.spec.ts` 的两条用例覆盖（reset 后 `uiRequests.length === 0`、
   openSession 正常路径后 `uiRequests.length === 0`）。tool 卡片与状态文字两项是
   在真实 DOM 上从「2 个 tool 卡片 + 1 个 AUTO ON 状态」变成「0 + 0」，为真实取证。

5. **`runtimeVersion` 填的是会话文件格式版本（jsonl 头部的 `version`），不是 pi 版本号。**
   实测 pi 的 session 头部只有 `{"type":"session","version":3,"id":…,"cwd":…}`，
   没有写入 pi 自身版本。字段语义已在代码注释里写明，不做臆测映射。

## Notes（下游任务需要知道的）

- **`send(opts: SendOptions = {}): Promise<boolean>` 的签名被 c[12] 逐字锁定**，
  TASK-007/010/014/015 改这里之前先看那条断言。返回 true 的唯一判据是
  「RPC 已接受」（`success: true`），这是 InputBar 清空草稿的唯一依据。
- **`resetSessionScopedState()` 是注册表驱动的**。TASK-012 把 uiRequests /
  statusTexts 迁到 `stores/extensionUi.ts` 时，删掉 app.ts 里 `registerSessionScopedReset`
  回调中对应两行、在新 store 里自行 `registerSessionScopedReset` 即可，
  c[11] 的六项行为断言逐字不变仍会通过。
- **`start()` 里 `if (sessionPath === undefined)` 的 else 块是空的**，那是 TASK-014
  写 `modelMismatchPrompt` 的落点，别把它删掉（c[14] 断言 else 存在且不含 setModel）。
- **`listSessionsForWorkspace` 是全仓唯一枚举入口**。TASK-009 上 SQLite 索引时在
  `session-repository.ts` 里原地替换，不要新增第二个枚举函数（c[1] 断言恒为 1）。
  `session-dir.ts` 是纯函数、不碰磁盘，替换枚举器时原样保留。
- `AppSettings` 新增了 `sessionDir?`，目前没有 UI 入口去设置它；一旦设置，
  主进程枚举与 `--session-dir` 会同时以它为准。
- `scripts/cdp-eval.mjs` / `scripts/cdp-drop-file.mjs` 可复用：
  `npx electron packages/app --remote-debugging-port=9222` 起应用后，
  这两个脚本能给任何 [UI-observable] 条目留下真实 DOM 证据。
