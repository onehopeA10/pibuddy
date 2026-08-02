# TASK-015: FS-101 + FS-102 Workspace 文件服务、结构化附件、编辑器冲突检测与 Agent changeset diff

## Changes

### 契约（唯一真相源）
- `packages/contract/src/workspace.ts`（新建）：文件树 / 搜索 / 读写 / 变更文件 / 结构化附件 / 变更集的全部 schema 与类型。跨进程边界上**没有任何字段能承载绝对路径**。
- `packages/contract/src/channels.ts`：新增 8 条 `workspace:*` + 4 条 `changeset:*` invoke 通道，以及 push 通道 `workspace:tree-event`。
- `packages/contract/src/ipc-contract.ts`：12 条通道各自的 request/response schema 进 `CHANNEL_CONTRACTS`；`attachmentRefSchema` 增补可选 `relativePath`（供附件条显示，仍非绝对路径）。
- `packages/contract/src/index.ts`：导出 workspace 契约。

### main
- `main/workspace/workspace-store.ts`（新建）：workspace 档案表（SQLite + `PRAGMA user_version` 迁移），字段为 `{id, canonicalRoot, displayName, trust, createdAt, lastOpenedAt, ignorePolicy, defaultModel, permissionRules}`，`canonicalRoot` 取 `fs.realpathSync.native`。
- `main/workspace/ignore-rules.ts`（新建）：gitignore 模式编译与匹配（支持 glob、`**`、`!` 否定、目录限定），**不含 look-around**。单独成文件是为了让搜索子进程不必拖进 electron 依赖链。
- `main/workspace/file-tree.ts`（新建）：`listDir`（单层、5000 项上限、symlink 不跟随、ignore 生效）、`watchDir`/`unwatchDir`（引用计数）、`closeWatchers`/`closeAllWatchers`。
- `main/workspace/search-scan.ts` / `search-entry.ts` / `search-worker.ts`（新建）：内容与文件名搜索，跑在 `utilityProcess.fork` 的独立进程里，可取消、分页、有结果上限、preview 硬截断 200 字符。
- `main/workspace/file-editor.ts`（新建）：`detectEncoding`（utf8-bom / utf8 / gbk / binary）、`detectNewline`、`readFile`、`saveFile`（mtime + sha256 冲突判定、错误分类 permission/disk/encoding/missing）。
- `main/workspace/workspace-ipc.ts`（新建）：8 条通道 + `disposeWorkspaceResources` / `disposeAllWorkspaceResources`。
- `main/changeset/changeset-store.ts`（新建）：changesets 表（含 `session_id, turn_id, tool_call_id, relative_path, before_sha256, after_sha256, status, created_at`）、LCS 逐行 diff、降级判定。
- `main/changeset/apply.ts`（新建）：`acceptChange`（重算 hash → 备份 → 写盘）、`rejectChange`（不写盘）、`acceptBatch`（硬跳过 unverified 并列出）、`composeAccepted`（逐 hunk 接受）。
- `main/changeset/tool-watch.ts`（新建）：订阅 `tool_execution_start/end`，抓 before 快照、登记待审阅变更。
- `main/changeset/changeset-ipc.ts`（新建）：4 条通道。
- `main/attachment-registry.ts`（改）：在 TASK-007 的**唯一**注册表上扩 `access` / `relativePath` / `sourceName` / `mimeType` / `sha256`；新增 `createAttachment()` 返回八字段结构化引用（标识恒为 `token`）；`resolve` 更名 `resolveAttachment` 并新增 `access: "read-write"` 的写权限校验。
- `main/fs-atomic.ts`（改）：抽出 `writeFileAtomic(path, bytes)`，`writeJsonAtomic` 委托到它 —— 全仓仍只有一条写文件实现。
- `main/pi/pi-ipc.ts`（改）：附件提示块由「绝对路径清单」改为「结构化附件清单」，工作区内一律呈现 relativePath。
- `main/pi-supervisor.ts`（改）：`client.on("event")` 里接入 `observeToolEvent`（在转发之前，before 快照才抓得到）。
- `main/ipc-registry.ts` / `main/index.ts`（改）：注册两域 handler；窗口关闭与 `window-all-closed` 时收掉 watcher 与搜索子进程。

### preload / renderer
- `preload/api/workspace.ts`（新建）+ `preload/api/index.ts`（改）：第 12 个命名空间，出入参一律相对路径。
- `renderer/src/stores/workspace.ts`（新建）：文件树 / 搜索 / 编辑器 tab / 冲突 / 变更集状态。
- `renderer/src/components/FileTreePanel.vue`（新建）：惰性展开、刷新、隐藏项切换、超大目录逐层折叠、右键新建/重命名/复制/删除（回收站 + 精确范围确认）/加入附件。
- `renderer/src/components/FileEditorPane.vue`（新建）：CodeMirror 6、编码/换行显示、dirty 圆点、Ctrl+S、冲突三选一（查看差异 / 重新载入 / 覆盖）。
- `renderer/src/components/ChangesetPanel.vue`（新建）：file/hunk diff、逐 hunk 与整文件接受、拒绝、批量接受、跳到编辑器、降级提示、冲突提示。
- `renderer/src/components/AppShell.vue`（改）：文件树注入 sidebar、编辑器与变更面板注入 main，**四个插槽名集合不变**。
- `renderer/src/components/InputBar.vue`（改）：附件条显示 relativePath；新增取走文件树推来的附件（`immediate: true`）。
- `renderer/src/stores/app.ts`（改）：新增 `inboundAttachments` 中转队列；删除注释里残留的旧「[用户提供的文件]」措辞。

### 构建 / 门禁
- `packages/app/electron.vite.config.ts`：main 增加第二个 rollup input `search-entry`，产出独立的 `out/main/search-entry.js`。
- `packages/app/package.json`：新增 codemirror 4 个依赖，**全部精确版本**（6.0.2 / 6.7.1 / 6.43.7 / 6.10.4）。
- `packages/app/scripts/check-update-deps.mjs`：把 4 个 codemirror 依赖纳入比对；顺手修了 lockfile 解析对**作用域包**（`'@scope/pkg':` 带单引号）不认的缺陷 —— 不修的话新增任何 `@scope/*` 都会被误报成「lockfile 里找不到」。

### 测试
- 新建：`main/workspace/file-editor.test.ts`(8)、`file-tree.test.ts`(8)、`search-worker.test.ts`(6)、`workspace-ipc.test.ts`(4)、`main/changeset/apply.test.ts`(7)。
- 追加：`test/workspace-capability.spec.ts`（junction 越界、中文空格路径）、`test/attachment-registry.spec.ts`（八字段、capability 校验、CT-17 同一句柄）。
- 更新：`test/preload-api.spec.ts` 命名空间清单加 `workspace`。

## Verification

三大门禁：
- [x] `pnpm --filter @pibuddy/app typecheck` 退出码 0
- [x] `pnpm -w test` **81 文件 / 678 用例全绿**（改前 640，本任务净增 38）
- [x] `pnpm --filter @pibuddy/app build` 成功，`out/main/` 含独立的 `search-entry.js`

结构性判据（逐条实跑）：
- [x] c[0] `test ! -e .../workspace/path-guard.ts` → PASS；`assertInsideRoot` 计数 → 0；用户指令的 `startsWith(root` 计数 → 0
- [~] c[0] `rg -c 'export function resolveInWorkspace'` → **0，非 1**。判据文本与代码不符：TASK-007 把它写成 `export async function resolveInWorkspace`，字面命令匹配不到 `async`。语义（全计划唯一实现）成立：`rg -c 'export async function resolveInWorkspace' packages/app/src/main` → 1，且全仓无第二处实现。**未改代码去迎合判据**。
- [x] c[1] `preload/api/workspace.ts` 存在且 `absolutePath|sourcePath|abs` 命中 0；`workspace-ipc.test.ts` 断言树/读文件/附件/变更集四类返回值 JSON 序列化后均不含 canonical root
- [x] c[2] `test ! -e .../workspace/attachment-store.ts` → PASS；`createAttachment` 八字段逐项相等；`attachmentId` 计数 0；`ATTACHMENT_TTL_MS` 文件数 1；`stores/app.ts` 的「用户提供的文件」计数 0
- [x] c[3] 编辑冲突 (a)~(e) 五条全部有断言并通过（ENOSPC 经 `__setFileWriter` 注入，权限经 EACCES 注入）
- [x] c[4] encoding/newline：BOM / 无 BOM / GBK 三样本判对；CRLF 样本 read→save 后落盘无裸 LF（用 `split('\n').slice(0,-1).every(endsWith('\r'))` 的等价写法，无 look-around）
- [x] c[5] `utilityProcess.fork` 调用点可 grep；`search()` 返回 `{items,nextCursor,truncated}`；limit 生效、取消后 200ms 内停、preview ≤ 200
- [x] c[6] changeset 表列齐；conflict / alreadyApplied / hunk 级接受三条单测通过
- [x] c[7] [UI-observable] 真机全流程通过（见下）
- [x] c[8] [UI-observable] 真机全流程通过（见下）
- [x] c[9] `typecheck && test -- src/main/workspace src/main/changeset` 退出码 0
- [x] c[10] `node scripts/check-contract-uniqueness.mjs` 退出码 0（契约导出 250 个，无碰撞）
- [~] c[10] 附加断言 `rg -c "from '@pibuddy/contract'"`（**单引号**）对 13 个新增文件全部输出 0 —— 仓库 prettier 统一用双引号，该字面命令在本仓库恒不成立。按语义核验：13 个文件的双引号形态命中数全部 ≥ 1（详列见下）。
- [x] c[11] `expiresAt` 计数 6（≥2）；TTL 滑动续期与 capability 拒绝均有断言
- [x] c[12] watcher 展开/折叠 200 次后活跃数 0；`closeWatchers` 后为 0；引用计数正确
- [x] c[13] `node_modules`/`.git` 默认忽略；glob 与 `!` 否定模式各一条 fixture 断言
- [x] c[14] `search-worker.test.ts` 断言 `JSON.stringify(result.items)` 不含 canonicalRoot（含 Windows 反斜杠转义形态）
- [x] c[15] 关闭后 `child.killed === true`；连续 20 轮开关后活跃子进程 0、spawn 次数恰 20
- [x] c[16] accept 后备份字节 === 应用前原文件；reject 后 mtimeMs 与内容均未变
- [x] c[17] unverified 单条接受返回 `requiresManualReview` 且未写盘；批量接受在 `skippedUnverified` 中列出
- [x] c[18] codemirror 4 项均为精确版本；`node packages/app/scripts/check-update-deps.mjs` 退出码 0
- [x] c[19] `ipcMain.(handle|on)` 直接注册点计数 0；`workspace-ipc.test.ts` 断言 12 条通道逐一在 ipc-guard 注册表中、表中每条在契约里有 schema、表长 ≥ 8
- [x] c[20] `send()` 签名断言输出 1
- [~] c[21] `find` 输出 **4 行**而非 2 行。多出的两条位于 `packages/app/resources/pi-runtime/**`（`prepare:runtime` 产物）与 `packages/app/release/**`（构建产物），二者均被 `.gitignore` 忽略（`git check-ignore` 已确认），**与本任务无关且改前已存在**。排除这两个未受控目录后恰为 `./vitest.config.ts` 与 `./vitest.workspace.ts` 两行。`node scripts/check-test-discovery.mjs` 退出码 0 且 discovered 81 === onDisk 81，本任务新增的 5 个 spec 全在发现范围内。
- [x] c[22] `createAttachment` 的 token 可直接被 `resolveAttachment` 解析（TASK-016 的 preview handler 尚未存在，按同一句柄语义核验）；`attachmentId` 计数 0
- [x] c[23] AppShell 四插槽断言输出 4

其它脚本门禁：`check-respond-ui-guard.mjs` OK、`check-workflow-pins.mjs` OK。

## 真机验证（dev + CDP，用临时 fixture 目录，未对用户真实文件做任何破坏性操作）

**动手前先做了恢复路径**：`D:\selftool\pi-ui-backup-TASK015-053707/` 备份了整个 userData 与 `~/.pi/agent/models.json`；验证结束后已还原 `settings.json` / `workspaces.json`，并逐字节确认 `models.json` 与备份 `identical: True`（TASK-014 的教训）。

fixture：`D:\selftool\pibuddy-fs-fixture`，含 5200 文件的「大 目录」、CRLF 文件、中文空格文件名、`node_modules`/`.git`、`.gitignore`（`*.log` + `!keep.log`）。

| 场景 | 实测结果 |
|---|---|
| 文件树列根目录 | `大 目录 / src / .gitignore / 中文 文件.txt / crlf.txt / keep.log`；`node_modules`、`.git`、`drop.log` 已隐藏，`keep.log` 被 `!` 否定模式重新包含 |
| 超大目录 | 折叠为「目录过大（5200 项），已折叠，点击加载」，DOM 行数 **6**（修复前为 5006） |
| 内容搜索 | 3 条命中，形如 `src/a.txt:3needle here`，无绝对路径泄漏 |
| 打开 crlf.txt | CodeMirror 挂载，行号 5，meta 显示 `utf8 / CRLF` |
| 编辑 + Ctrl+S | dirty 圆点 1 → 保存后 0；落盘字节 `b'da\r\nb\r\nc\r\n'`（CRLF 保留，无裸 LF） |
| 外部改同一文件后保存 | 弹出冲突面板，三个动作齐全 |
| 点「查看差异」 | 显示磁盘内容；磁盘字节前后**逐字节相同** |
| 点「重新载入」 | 缓冲区 === 外部编辑器写入的内容，冲突态清除 |
| 点「覆盖」 | 磁盘内容 === 缓冲区，CRLF 保留 |
| 右键「加入输入框附件」 | 附件条显示 `src/a.txt`（相对路径），无 `D:` / `selftool` 子串 |
| Agent 真实改文件 | 真跑一轮（gpt-5.6-sol）：磁盘保持 before，变更面板出现 2 条「待审阅」 |
| 变更 diff | `- hello world` / `+ GREETINGS EARTH`，「第 1 行起」 |
| 接受整个文件 | 磁盘变为 `GREETINGS EARTH...`；`changeset-backup/<id>` 内容 === 应用前原文件 |
| 接受过期的第二条 | **被拦下**：「这个文件在你审阅期间被外部改过了，已拦下」，磁盘字节未变 |
| 拒绝 | mtime_ns 与内容前后完全相同（零磁盘写） |
| 删除确认 | 「将把 文件「keep.log」 移到系统回收站，之后可以在回收站里找回」；确认后走回收站 |
| 保留功能 | InputBar / TopBar / Sidebar 在位，`pi.prompt` / `pi.steer` / `pi.abort` 均为 function |
| 进程 | 搜索 utility process（`node.mojom.NodeService`）确认存在；`Stop-Process -Force` 后 electron 进程数 **0** |

### 真机验证抓到并已修复的三个回归（三大门禁全绿但功能已死）

1. **超大目录提示挂错了目录，且真正超限的目录把 5000 个节点铺进了 DOM。**
   `listDir` 用 `total > entries.length` 判 truncated，而被 ignore 规则挡掉的条目也计入 total —— 于是任何含 `node_modules` 的目录（几乎必然包括工作区根）都被报成「目录过大（9 项）」，而 5200 项的子目录 `truncated` 虽为 true，UI 却只把提示绑在根上，实测一次展开耗时 **3.9 秒、渲染 5006 个行节点**。修复：main 侧把「撞上限」与「被 ignore」拆成两个计数器，`truncated` 只认前者；renderer 侧把折叠提示改成**按目录**出现在扁平列表自己的位置上，并加 `forceLoaded` 让「点击加载」真的能展开。已补单测断言「被 ignore 过滤不得置 truncated」。

2. **CodeMirror 编辑器从未挂载。**
   `mountEditor()` 只在 `onMounted` 调一次，而 `<div ref="host">` 在 `v-else`（有打开的文件才渲染）里 —— 组件挂载时还没有任何 tab，`host.value` 恒为 null，于是双击文件后 tab 出来了、编码/换行也显示了，**唯独正文区永远是空的**。typecheck / 单测 / 构建全绿。修复：改为 `watch(host, ..., { immediate: true, flush: "post" })`，宿主 div 出现的那一刻才建编辑器。

3. **搜索取消的 200ms 兜底 kill 是死代码。**
   `onAbort` 里先 `finish()`（内部 `slot.pending.delete(requestId)`），随后定时器再判 `slot.pending.has(requestId)` —— 该条件恒为 false，卡在大文件上的子进程永远不会被杀掉，表现只是内存持续上涨、UI 上完全无感。修复：finish 之后换上一个只记「子进程认没认账」的哨兵，期限内没认账才 kill。单测已覆盖（该用例正是抓到它的那一条）。

## Tests
- [x] `pnpm --filter @pibuddy/app typecheck`：pass
- [x] `pnpm --filter @pibuddy/app test -- src/main/workspace src/main/changeset`：pass
- [x] `pnpm -w test`：81 文件 / 678 用例全 pass
- [x] `rg -n "用户提供的文件" packages/app/src`：0 命中
- [x] `node scripts/check-contract-uniqueness.mjs` / `check-test-discovery.mjs` / `packages/app/scripts/check-update-deps.mjs`：退出码均为 0

## Deviations

1. **c[0] 的 `rg -c 'export function resolveInWorkspace'` 判据文本有误**（TASK-007 写的是 `export async function`），字面命令输出 0 而非 1。已按语义核验为唯一实现，未修改源码去迎合字面判据。
2. **c[10] 附加断言用单引号 `from '@pibuddy/contract'`**，本仓库 prettier 统一双引号，该命令在本仓库恒输出 0。已按双引号形态逐文件核验（13/13 命中 ≥ 1）。
3. **c[21] 的 `find` 多出两行**，来自 `.gitignore` 忽略的 `pi-runtime` 与 `release` 构建产物，改前已存在、与本任务无关。仓库内受版本控制的 vitest 配置恰为根目录两份。
4. **changeset 表未复用 session-index 的同一个 DB**（`read_first` 的建议），改为同目录下独立的 `changesets.db`，迁移模式（`DatabaseSync` + `PRAGMA user_version`）与 B01 一致。理由：让 changeset 域不必反向依赖 sessions 域的连接持有者；收敛条件只约束表结构，未约束 DB 文件。
5. **changeset 采用「暂存待审阅」语义**：入库时若磁盘内容正是工具刚写下的 after，先还原成 before 再把 after 留给用户审阅。这是让 criteria 中「accept 前重算 hash 比对 before」「reject 不得产生任何磁盘写」两条同时成立的唯一自洽解释，且产品上「先审后落盘」才是这个面板存在的意义。
6. **GBK 文件只读不写**：Node 内建只有 UTF-8 编码器，`saveFile` 对 GBK 文件返回 `errorCode: 'encoding'` 并说明原因，而不是按 UTF-8 写回制造乱码。
7. **只读目录用例改为只读目标文件**：Windows 上 `chmod` 对目录不产生 ACL 效果，单测改用 `__setFileWriter` 注入 EACCES/EPERM 验证分类逻辑（ENOSPC 同法）。
8. **c[22] 的 preview 联动只验到 token 可解析**：`preview:open` handler 属 TASK-016，尚不存在。
9. **临时 fixture 目录残留**：`D:\selftool\pibuddy-fs-fixture` 内容已全部清空，但空目录本身被某个句柄占住删不掉（`Device or resource busy`）。位于仓库之外，不影响任何产物；重启后可手动删除。

## Notes

- **`resolveInWorkspace` 是全计划唯一的收容原语**，本任务新增的 5 个 main 文件全部复用它，没有新建 `path-guard.ts`，也没有引入 `assertInsideRoot`。`changeset/apply.ts` 与 `workspace-ipc.ts` 里两处「目标还不存在」的场景（新建文件 / rename 目标）用「先解析父目录再拼文件名」绕开 realpath 对不存在路径的限制，判定仍是 `path.relative`，不是字符串前缀。
- **附件注册表仍然只有一套**（`main/attachment-registry.ts`），标识恒为 `token`。`resolve` 已更名 `resolveAttachment`，调用点已全部同步。
- **TASK-007 的 InputBar token 链路未被打断**：拖拽 → `file.fromDrop` → capability token 的路径原样保留，本任务只在 chip 上多显示一个 `relativePath`（`AttachmentRef` 新增的可选字段）。
- **给 TASK-016 的接口**：`createAttachment()` 返回的 `token` 可直接交给任何走 `resolveAttachment` 的 handler；preview handler 应接受 attachment token，不接受裸标识也不接受路径。
- **给后续任务的坑**：`packages/app/scripts/check-update-deps.mjs` 的 lockfile 解析现已同时认作用域包的单引号形态；再往 `PINNED` 里加 `@scope/*` 不会再被误报。
