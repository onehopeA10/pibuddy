# TASK-009: SES-101 会话中心（SQLite 增量索引 + 会话管理 UI + preload 命名空间分层）

状态：`completed_with_deviations`（引号字面量类判据 3 条 + CT-21 的 find 口径 1 条；
另有已获批的分叉可视化裁剪）

## Changes

### 主进程
- `packages/app/src/main/sessions/session-index.ts`（新建）— `SessionIndex`，`node:sqlite`
  `DatabaseSync`，DDL 含 `workspace_id TEXT NOT NULL`，`PRAGMA user_version` 迁移。
  增量三道闸：`mtime_ms + size_bytes` 双命中整文件跳过 → 头部 64KB sha256 前 32 位
  失配则 `scan_offset` 归零全量重扫 → 否则 `createReadStream(start: scan_offset)`
  只读新增字节。尾部半行不解析、`scan_offset` 停在最后一个完整行尾。
  **全仓唯一枚举入口** `listSessionsForWorkspace` 在此。
- `packages/app/src/main/sessions/session-history.ts`（新建）— `readEntriesBefore()`，
  按 64KB 块反向回溯的**本地**字节分页，不含任何 pi RPC 调用。用 Buffer 累积再解码
  （块边界会劈开 UTF-8 字符）；半行丢弃并计 `skippedPartial`；读前比对索引的
  mtime/size，失配返回 `stale`。
- `packages/app/src/main/sessions/session-rename.ts`（新建）— 活动会话经
  `set_session_name` RPC 落盘，`success === false` 抛错；非活动会话只写索引。
- `packages/app/src/main/sessions/sessions-ipc.ts`（新建）— 恰 9 条 channel。
- `packages/app/src/main/pi/pi-ipc.ts`（新建）— pi 全部 handler + webContents→client 索引。
- `packages/app/src/main/misc-ipc.ts`、`ipc-registry.ts`（新建）；`ipc.ts` 收缩为 20 行门面。
- `packages/app/src/main/ipc-guard.ts` — 新增已注册 channel 表（`registeredChannels()`），
  供单测做结构断言而不钉死 handler 文件路径。
- 删除 `packages/app/src/main/sessions/session-repository.ts`（连同 `MAX_SESSIONS_SCANNED=200`）。

### 契约
- `channels.ts`：删 `sessions:list`，加 9 条 `sessions:*` + 5 条会话树/分叉 `pi:*`。
- `session.ts`：`SessionRow`（**无 sourcePath / workspaceRoot**）、`SessionQuery`、
  `DraftRecord`、`ReadHistoryRequest`、`SessionHistoryPage`。
- `pi:switch-session` 与 `pi:start` 的入参由路径改为不透明 `sessionId`。

### preload（命名空间分层）
- 新建 `api/{bridge,pi,sessions,settings,dialog,file,shell,stt,index}.ts`；
  `index.ts` 只剩 `contextBridge.exposeInMainWorld("piBuddy", api)`；
  `index.d.ts` 改为 `typeof api` 推导，不再手抄签名。

### 渲染进程
- 新建 `stores/sessions.ts`、`components/SessionListPanel.vue`；`Sidebar.vue` 换新面板；
  `app.ts` 的 `refreshSessions` 委托给 sessions store，`openSession({ sessionId })`。
- `AppShell.vue` 增 banner / sidebar / main / overlay 四个具名插槽（默认内容 = 原形态）。

## Verification（逐条实跑，输出为真实结果）

| 判据 | 命令 | 输出 |
|---|---|---|
| c0 | `rg -c 'SESSION_INDEX_SCHEMA_VERSION = 1' / 'PRAGMA user_version' / 'scan_offset'` | `1` / `3` / `8` |
| c0 | `rg -c 'readFileSync' session-index.ts \| wc -l` | `0` |
| c1 | `test ! -e packages/app/src/main/sessions-store.ts` | 通过 |
| c1 | `rg --no-filename -c 'export function encodeSessionDirSegment' .../main \| awk sum` | `1` |
| c2 | `rg -c 'writeFileSync\|appendFileSync\|createWriteStream' sessions/ \| wc -l` | `0` |
| c3 | `npx vitest run packages/app/src/main/sessions` | 4 files / 24 tests passed |
| c4 | `rg --no-filename -c 'sessions:list' packages/app/src \| awk sum` | `0` |
| c4 | `rg --no-filename -c 'export async function listSessionsForWorkspace' .../main \| awk sum` | `1`（在 session-index.ts） |
| c4 | `test ! -e .../session-repository.ts` / `MAX_SESSIONS_SCANNED` sum | 通过 / `0` |
| c4 | 单测断言 `SESSIONS_CHANNELS.length === 9` 且排序逐项相等 | passed |
| c5 | session-rename.test.ts（5 例） | passed |
| c6 | `export const api = { pi, sessions, settings, dialog, file, shell, stt }` | 命中 |
| c6 | `index.ts` 中 `invoke\|ipcRenderer` | 无 |
| c7 | 500 会话首屏 query | `< 200ms`，bench 2 例 passed；真机搜索 11 条中命中 7 条 |
| c8 | `pnpm typecheck` / `pnpm -w test` | 退出 0 / **217 passed (25 files)** |
| c8 | `doc/regression/TASK-009-session-center.md` 中 `^- \[x\]` 行数 | `4` |
| c9 | `node scripts/check-contract-uniqueness.mjs` | 退出 0（`contract exports 93`） |
| c10 | `rg -c 'workspace_root' preload+renderer \| wc -l` | `0` |
| c10 | `rg -c 'workspaceId' api/sessions.ts` | `2` |
| c11 | `rg -c 'export (async )?function readEntriesBefore' session-history.ts` | `1` |
| c11 | `rg -c 'get_entries' session-history.ts \| wc -l` | `0` |
| c12/13 | session-history.test.ts：1000 行 fixture 反向翻页序列与整文件解析**完全相等**；单次读取 < 总字节 20%；半行 `skippedPartial === 1`；追加后 `stale === true` | 5 例 passed |
| c14 | `rg -c 'getPath("userData")' session-index.ts` = `2`；`process.cwd()\|__dirname` \| wc -l = `0` | 通过 |
| c15 | 事务回滚：第 2 次 upsert 抛错后行数不变、`user_version` 不变；并发两次 sync 同 sourcePath 恰 1 行 | passed |
| c16 | `Object.keys(api).sort()` 与七元数组逐项相等、长度 `=== 7` | passed（真机 `window.piBuddy` 实测同样是这 7 个键） |
| c17 | 不存在的 sourcePath `saveDraft` 返回 `false` 且行数不变；无草稿 `getDraft` 返回 `null` | passed |
| c18 | `setStatus('trashed')` 后 .jsonl sha256 不变、未调 `trashItem`；仅 `purge` 调用之；`unlinkSync\|rmSync\|fs.rm(` \| wc -l = `0` | passed |
| c19 | `rg -c 'ipcMain\.(handle\|on)\(' main -g '!ipc-guard.ts' \| awk sum` | `0` |
| c19 | 单测：9 条 channel 均在 ipc-guard 注册表中；表中每条在契约有 schema；`ipcMain.handle` 收到的集合 === 注册表 | passed |
| c20 | `rg -c 'sourcePath' preload+renderer \| wc -l` | `0` |
| c20 | `readHistoryRequestSchema.shape` 键排序 | `['beforeOffset','limit','sessionId']` |
| c21 | `node scripts/check-test-discovery.mjs` | 退出 0，`discovered 25 / onDisk 25` |
| c22 | `rg -c '<slot name="(banner\|sidebar\|main\|overlay)"' AppShell.vue` | `4` |
| — | `REFRESH_SESSIONS_DEBOUNCE_MS =` in renderer \| awk sum | `1` |
| — | `fetch(` in main 排除 outbound-guard.ts | `0`（与 HEAD 基线一致，3 处均在 outbound-guard.ts 内部） |
| — | `pnpm build` | 成功；preload 产物只 `require("electron")`，**无 zod** |

## 真机验证（这是本任务抓到 3 个「三门禁全绿但功能已死」缺陷的地方）

真机方式：`electron-vite preview` 跑打包产物 + `scripts/cdp-eval.mjs` 从真实 DOM /
真实 pinia state 取证。工作目录 `D:\pi\test`，11 个真实会话。

**首次真机验证暴露、随后修复的 3 个缺陷（全部不会导致类型错误 / 测试失败 / 构建失败）：**

1. **新建会话后立刻改名 / 置顶 / 归档一律报 `SESSION_UNKNOWN`。**
   pi 在 `pi:start` 时创建的会话不在上一次 sync 的索引里。
   修复：`sessions-ipc.ts` 的 `tryRow()` 查不到时先 `syncWorkspace` 再查。
2. **pi 惰性写文件 —— 全新会话在磁盘上根本没有 .jsonl**，于是「开新任务顺手起个
   名字」仍然失败，且导出报的是开发者字符串 `SESSION_UNKNOWN`。
   修复：rename 对**当前活动会话**直接走 `set_session_name` RPC（pi 才是它的权威），
   索引可有可无；export 同理不查索引，改为核对 `state.sessionId`。
   实测：全新会话改名成功 → 发出第一条消息后，名字被索引读回并显示在列表中，
   且 `session_info` 记录确实出现在真实的 .jsonl 里。
3. **搜索结果可能乱序落地**（前一次查询比后一次晚返回，界面显示与输入框不符且不报错）。
   修复：`stores/sessions.ts` 的 `refresh()` 加请求序号闸门，只认最后一次。

**另外发现的一个验证方法学问题**：Git Bash 的 `pkill -f electron` 在本机无效，
旧实例因 `requestSingleInstanceLock` 一直占着调试端口，导致有一轮验证实际测的是
**旧构建**。已改用 `powershell Stop-Process -Force` 并每次核对进程 StartTime。

**最终构建上的完整回归（全部通过）**：`window.piBuddy` 恰 7 个键；列表 11 条
（store 与 DOM 一致）；搜索 11→7→11；重命名生效；置顶排到首位；归档/回收站/恢复
11→10→回收站 1→11 且**整轮操作前后 11 个 .jsonl 的 sha256 全部未变**；会话切换后
`.msg-row` 17 条 / tool 卡片 / thinking 块正常渲染；流式对话正常，
**流式中插话（prompt + streamingBehavior:"steer"）实测生效**（提示「已插话」，
助手回「已停止」）；`activityTick` 6→88（ChatView 滚动驱动未断）；
`droppedEnvelopes` 0；无僵死工具卡片；模型切换往返正常；费用 footer 实际渲染
「本次花费 $0.42」；反向分页对 25298 字节真实会话翻到底得 28 条 entry / 28 个唯一 id，
首尾 id 与整文件逐行解析逐字相同。

## Deviations

1. **引号字面量（3 条）**。仓库统一使用双引号（prettier 风格，全仓既有代码皆然），
   而这三条判据的 `rg` 模式写死了单引号：
   - c1 `rg -c "from './session-dir"` → 实测 `0`；双引号形式 `from "./session-dir` → `1`
   - c14 `app.getPath\('userData'\)` → 实测 `0`；`getPath("userData")` → `2`
   - c9 附加项 `rg -c "from '@pibuddy/contract'"` → 全部新增文件为 `0`；
     双引号形式下 `preload/api/` 8 个文件全部 ≥1，`main/` 新增文件中
     `sessions-ipc/pi-ipc/misc-ipc/session-index/session-history` 均为 1。
     `ipc-registry.ts`（纯装配，无跨进程类型）与 `session-rename.ts`
     （只依赖 pi-sdk 的 `RpcResponse`）为 0 —— 为满足字面量而加无用 import 会更糟。

   语义（每个跨进程文件的类型都取自契约包）已满足；**未为迁就字面量改动仓库代码风格**。

2. **CT-21 的 find 口径**。该 find 只排除了 `./node_modules/*` 与 `./source/*`，
   因此实测输出 4 行而非 2 行。多出的两行是
   `packages/app/{resources,release}/.../pi-runtime/node_modules/@mistralai/mistralai/tests/vitest.config.ts`
   —— 打包进来的 pi 运行时自带的第三方文件，`git ls-files` 显示**未被 git 跟踪**，
   且早于本任务存在。仓库源码层面受跟踪的 vitest 配置恰为
   `vitest.config.ts` 与 `vitest.workspace.ts` 两个，均在仓库根，本任务未新建任何配置。

3. **files[] 与 criteria 冲突时以 criteria 为准**。`files[]` 要求
   「Sidebar.vue 的 openSession 改为传 `row.sourcePath`」「app.ts 的 openSession 入参改为
   `{ sourcePath: string }`」，与 c20（CT-15：`sourcePath` 在 preload/renderer 命中必须为 0）
   直接互斥。已按 c20 实现：跨进程一律 `sessionId`，`pi:switch-session` 与 `pi:start`
   的入参也一并改为不透明 id，由 main 经索引解析。

4. **`packages/app` 原本没有 `test` 脚本**（c3 的 `pnpm --filter @pibuddy/app test` 无法执行）。
   已加 `"test": "vitest run --root ../.."`，仍指向仓库根那份唯一配置，不新建第二份。

5. **preload 的 7 个键**：`runtime` / `events` / `extensionUi` 收进 `pi` 之下，
   `workspace` 与 `attachments` 拆进 `dialog` / `file` / `shell`。因此
   `window.piBuddy.pi` 上除 20 个产品动作外还有三个**非动作**子命名空间；
   TASK-007 的「不存在通用命令转发口」这条不变量未受影响（单测已断言 `pi` 上
   没有 `command` / `send` / `invoke`）。

## Notes（后续任务必读）

- **分叉可视化 UI 未完成**（用户 2026-08-02 已批准裁剪，已登记进 TASK-009.json 的
  `deferred_requirements`）。`fork` / `clone` / `get_tree` / `get_fork_messages` /
  `get_entries` 的 RPC 与 IPC 通道已完整接入，但**没有任何分支图**。
  **任何声称 M3 出口门禁完整达成的表述都是错误的**，doc:329 的「分叉」本轮只有数据面。
- 新增 channel 仍只能经 `ipc-guard.ts` 的 `registerHandler` 注册；新增功能域请新建
  `<域>-ipc.ts` 并在 `ipc-registry.ts` 加一行，不要回到往 `ipc.ts` 里堆 handler。
- 新增 preload 命名空间 = 新增 `preload/api/<ns>.ts` + 在 `api/index.ts` 加一行。
  但 `api/index.ts` 的键集合被单测钉死为恰 7 个，加键必须同步改
  `packages/app/test/preload-api.spec.ts`。
- **pi 惰性写会话文件**：全新会话在发出第一条消息前磁盘上没有 .jsonl，因此不在索引里。
  任何按 sessionId 反查路径的新功能都要考虑这一条（用 `tryRow` 而不是 `requireRow`，
  或像 rename/export 那样对当前会话直接问 pi）。
- `AppShell.vue` 的插槽名集合固定为 `['banner','main','overlay','sidebar']`，
  TASK-011/012/014/015/016 只往里注入内容，不得改动集合。
- 真机验证时务必用 `powershell Stop-Process -Force` 关旧实例并核对进程 StartTime：
  `pkill -f electron` 在本机无效，旧实例会因单实例锁继续占着 9222 端口，
  让你以为在测新构建。
