# TASK-012: EXT-101/EXT-102 Extension UI 全方法覆盖、dialog timeout 与 Pi 资源中心（含 project trust）

## Changes

### 契约（packages/contract）
- `src/channels.ts`：新增 8 条 invoke 通道（`pi:ui-pending` + `pi-resources:*` 5 条 + `trust:describe` / `trust:decide`），新增 2 条推送通道（`pi:ui-expire` / `pi:ui-expire-all`）。
- `src/pi-resources.ts`（新建）：资源 / trust / 包安装 / 快照的全部 schema 与类型；两个固定文案常量 `UI_EXPIRED_HINT`、`TRUST_NOT_PERMISSION_NOTE`（组件与单测引同一个常量，改文案测试会立刻发现）。
- `src/ipc-contract.ts`：把上述 schema 接进 `CHANNEL_CONTRACTS` / `PUSH_CONTRACTS`；`pi:ui-respond` 的返回由 `void` 改为 `{ok, reason?}`。

### pi-sdk
- `src/types.ts`：新增 `EXTENSION_UI_METHODS` / `EXTENSION_UI_DIALOG_METHODS` / `isDialogMethod`，`ExtensionUiRequest.method` 改为引用该常量表（contract test 的唯一来源，升级 pi 后自动变严）。`summarization_retry_*` 三个成员 TASK-002 已补齐，本任务只补消费方。
- `src/client.ts`：`respondUi` 由 `void` 改为 `boolean`（进程已退出 / stdin 已关时返回 false 而不是抛错直写）；`PiSpawn` 新增 `args?: string[]`，在 `--mode rpc` 之后展开。

### 主进程
- `src/main/extension-ui/ext-ui-service.ts`（新建）：挂起表 + timeout 定时器 + 代际清理 + respond 校验 + widget/title/status 状态维护 + AbortSignal + reload 快照。到期**不向 pi 写任何响应**（上游已 auto-resolve）。
- `src/main/pi/event-forwarder.ts`：新增 `sendPush()` —— 非合批推送通道的唯一出口，从而让「`.send("pi:` 出了 event-forwarder 就是 0」这条结构断言成立。
- `src/main/pi-supervisor.ts`：`pi:ui-request` / `pi:exit` 改经 `sendPush`（顺手归一了 c[23] 那条既存 FAIL）；新增 `setUiHook()` 与 `push()`。
- `src/main/pi/pi-ipc.ts`：`pi:ui-respond` 委托 service 并返回结构化结果 + 记一条 warn；新增 `pi:ui-pending`；`disposeClientFor` 先作废挂起弹窗再停进程；`pi:start` 组装 trust 参数。
- `src/main/pi-resources/`（新建）：`trust-store.ts` / `resource-scanner.ts` / `package-install.ts` / `pi-resources-ipc.ts`。全目录禁用同步 fs API。
- `src/main/pi-launcher.ts`：`PiLauncherContext` 新增 `trustArgs`，`buildPiSpawn` 返回 `args`。运行时定位逻辑一行未动。

### preload / 渲染
- `src/preload/api/pi.ts`：新增 `events.onUiExpire` / `onUiExpireAll`、`extensionUi.pending()`；`respond` 返回值改为 `ExtensionUiRespondResult`。
- `src/preload/api/piResources.ts`（新建）：资源与 trust 命名空间。**没有**任何接受命令或参数数组的方法。
- `src/renderer/src/stores/session-scope.ts`（新建）：从 app.ts 抽出清空回调表，消除 app ↔ extensionUi 的循环 import；app.ts 原地再导出，既有引用点零改动。
- `src/renderer/src/stores/extensionUi.ts`（新建）：`uiRequests` / `statusTexts` / `widgets` / `title` 四样状态 + 未知事件计数器。
- `src/renderer/src/stores/piResources.ts`（新建）：资源列表与 trust 的渲染侧状态。
- `src/renderer/src/stores/app.ts`：`handleUiRequest` 补齐九个 method 且去掉 `default`；`handleEvent` 的裸 `default: break` 改为 `recordUnknownEvent`，并补 `turn_start` / `turn_end` / `agent_end` / `bash_execution_update` / `summarization_retry_*` 五类显式处理；`respondUi` 检查返回值并给用户解释；新增两条 expire 订阅。
- 组件：`ExtensionUiHost.vue`（失效即关、aria-label、焦点回归、Esc 取消、超时提示、排队计数）、`ExtensionWidgetHost.vue`（新建，30vh 上限 + 滚动 + 稳定 key）、`PiResourcesPanel.vue`（新建）、`ProjectTrustDialog.vue`（新建）、`AppShell.vue`（挂载三者 + 启动时问 trust）、`TopBar.vue`（标题 + 资源入口）、`InputBar.vue`（widget 两个挂载点）。

### 脚本
- `scripts/check-respond-ui-guard.mjs`（新建）：c[13] 的机器判据。
- `scripts/cdp-drive.mjs`（新建）：真机驱动脚本，回归文档据它取证。

## Verification

按 convergence.criteria 逐条实跑，输出照录：

| # | 判据 | 结果 |
|---|------|------|
| c[0] | ext-ui-service 含 `setTimeout(` / `expired` / `runtimeGeneration`；实现目录里 `timeout` 命中 | **PASS** 1 / 2 / 6；`rg -c timeout .../extension-ui/ \| wc -l` = 4 |
| c[1] | 9 个 method 的 contract test | **PASS** `ext-ui-contract.test.ts` 21 用例全绿，表驱动（不硬编码 9） |
| c[2] | timeout 单测：expire 广播 + 之后 respond 为 expired + respondUi 调用 0 次 | **PASS** `ext-ui-timeout.test.ts` 6 用例 |
| c[3] | 代际清理 + 无未处理 rejection | **PASS** `ext-ui-lifecycle.test.ts` 9 用例，`unhandledRejection` 计数 0 |
| c[4] | 三个 `summarization_retry_*` 字面量 ≥ 3；三条取值断言 | **PASS** 求和 6；`extension-ui-store.test.ts` 四条断言（非空且含「重试」/ 含 `(1/3)` / 含「分支摘要」/ finished 后 `undefined`） |
| c[5] | scanner 字段齐全 + renderer 不执行包管理命令 + `export async function scanResources` = 1 | **部分 PASS**，见下方偏离 1 |
| c[6] | `ALLOWED_SUBCOMMANDS` 字面量 + 4 类注入被拒 | **PASS** 字面量命中 1；`package-install.test.ts` 16 用例，`;` `&&` `\|` 反引号逐一 reason=injection |
| c[7] | trust 经 `writeJsonAtomic`；三条互斥断言；UI 含「信任不等于工具权限」 | **PASS** `trust-decision.test.ts` 7 用例（`-na` / `-a` / `[]` 三条互斥，走真实 `buildPiSpawn().args`）；文案命中 2 |
| c[8] | [UI-observable] | **PASS** 见 `doc/regression/TASK-012-extension-ui.md` |
| c[9] | typecheck + 回归文档恰 7 行 `- [x]` | **PASS** `pnpm -r typecheck` 全绿；`grep -c '^- \[x\]'` = 7，每行含 method / 响应体字段值 / ISO 时间戳 |
| c[10] | `check-contract-uniqueness.mjs` | **PASS** exit 0；附加断言见偏离 2 |
| c[11] | app.ts 无 `default: break`；未知事件计数 | **PASS** 命中 0；单测断言计数 +1 且出现在 debug 快照里 |
| c[12] | respondUi 返回值被使用（(L, L+5] 内有守卫） | **PASS** `check-respond-ui-guard.mjs`：调用点 1 处，未守卫 0 处；`no-runtime` 单测 stdin write spy 0 次 |
| c[13] | 定时器不泄漏 | **PASS** 100 次建/答后 `pendingTimerCount === 0`；代际清理路径同样归 0 |
| c[14] | widget 生命周期 + 30vh | **PASS** set→unset 后 `widgets.size === 0`；`30vh` 命中 3；组件测断言 120/300 行不丢且滚动 |
| c[15] | title 截断与前缀 | **PASS** 200 字符输入渲染长度 70，以 `PiBuddy · ` 开头（store 测 + TopBar 组件测 + 真机 70） |
| c[16] | trust.json 合并写入与路径归一 | **PASS** `trust-store.test.ts` 19 用例；真机写入后原有两条原样保留。归一化实现见偏离 3 |
| c[17] | pi-resources 无同步 fs + 用 fs/promises + 5000 条不阻塞 | **PASS** 同步 fs 命中 0；`fs/promises` 求和 8；5000 条 fixture 下 `setImmediate` 在 50ms 内执行 |
| c[18] | 全仓 `ipcMain.handle` 直接注册 = 0；新 channel 全在注册表且有 schema | **PASS** 命中 0；`pi-resources-ipc.spec.ts` 8 用例 |
| c[19] | `.send("pi:` 出 event-forwarder = 0 | **PASS** 命中 0（改前含 `pi-supervisor.ts:135`，本任务归一） |
| c[20] | vitest 配置唯一 + 发现范围 | **PASS**（口径见偏离 4）；`check-test-discovery.mjs` discovered 63 = onDisk 63 |
| c[21] | CT-11 不复活全局 pi 回退 | **PASS** `runtime-manifest.json` 命中 2；`pi.cmd\|which pi\|command -v pi\|fallbackToGlobalPi` 命中 0；`pi-launcher.spec.ts` 8 用例全绿 |
| c[22] | CT-25 迁出后清空语义不丢 | **PASS** `registerSessionScopedReset` 命中 3；单测断言 2 条 uiRequests + 1 条 statusTexts 经 `resetSessionScopedState()` 均归 0 |
| c[23] | AppShell 四个具名插槽 | **PASS** = 4 |

## Tests

- `pnpm -w test` → **63 个文件 / 510 个测试全部通过**（基线 45 / 347，本任务净增 18 个文件 / 163 个用例，其中 TASK-013 并行贡献若干）
- `pnpm -r typecheck` → 三个包全绿
- `pnpm build` → 成功（`✓ built in 9.78s`）
- `node scripts/check-contract-uniqueness.mjs` → exit 0
- `node scripts/check-test-discovery.mjs` → discovered 63 / onDisk 63，exit 0
- `node scripts/check-respond-ui-guard.mjs` → 调用点 1 处，未守卫 0 处，exit 0

## 真机验证（doc/regression/TASK-012-extension-ui.md）

写了专用测试扩展 `~/.pi/agent/extensions/pibuddy-ui-probe.ts`（`/uiprobe <method>`），
逐个触发 9 种 UI 方法 + timeout + 排队 + 代际清理，全部取证。**抓到 3 个三大门禁全绿
但功能已死的回归**（详见回归文档开头），均已修复并配了钉死的单测：

1. **trust 弹窗里资源清单永远为空** —— 启动时 `describeTrust` 先于任何 scan，
   trust 态只写进 `scan.value.trust` 会被 `if (scan.value)` 整个跳过。
2. **资源页列出 454 条包** —— 用户只装了 3 个，其余是 npm 传递依赖；`conflictWith`
   在这几百条之间互相点名，真冲突被淹没。
3. **装完带技能的包，技能那一组一条不变** —— 扫描器不展开包自带的 `skills/`。

另外发现并修掉一个**会砸坏用户终端里 pi** 的问题：pi 的 `readTrustFile` 对
trust.json 里任何非 `true/false/null` 的值**整文件抛错**。子模块最初写的是
`{trusted, at}` 对象形状 —— 那会让用户在终端里跑 pi 时看到 "Invalid trust store"，
且他对**所有**项目做过的决定一起失效。已改为只落盘布尔，`at` 只活在内存里，
并加了三条逐字照搬 pi 校验逻辑的单测。

## Deviations

1. **c[5] 的 `exec(|execSync(|spawn(` 判据命中 1，不是 0。** 唯一命中是
   `packages/app/src/renderer/src/markdown.ts:18` 的 `/^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(raw.trim())`
   —— 正则的 `RegExp.prototype.exec`，TASK-004 就在那里，与执行命令无关。
   按判据的**意图**收紧后重测：`rg -c "child_process|execFile|npmCommand" packages/app/src/renderer | wc -l` = **0**。
2. **c[10] 附加断言 `rg -c "from '@pibuddy/contract'" <file>` 对全仓每一个文件都输出 0。**
   判据写的是单引号，而本仓 prettier 强制双引号，因此该模式在改造前后都恒为 0，
   是一条**空判据**。按意图用引号无关的模式重测：本任务在
   `packages/app/src/preload/api/` 与 `packages/app/src/main/` 下新增的 15 个 .ts 中，
   14 个有契约 import；唯一没有的是 `pi-resources/trust-store.test.ts`
   （纯文件系统层单测，只引 `./trust-store.js`）。
3. **c[16] 的 key 用的是 `fs.realpath`（非 native），不是 `fs.realpathSync.native`。**
   理由是互操作性优先：pi 的 `core/trust-manager.js` 里 `canonicalizePath` 用的正是
   非 native 的 `realpathSync`。Windows 上两者的大小写结果可能不同，用 native 会让
   key 对不上 —— 表现是用户在 PiBuddy 里点了「信任」，终端里的 pi 仍认为没信任，
   而两边都不报错。判据真正想钉的「symlink 与真实路径落在同一个 key 上」，
   非 native 的 realpath 同样满足（它一样解 symlink），单测照测不误。
4. **c[20] 的 find 结果是 4 行不是 2 行。** 多出的两条是
   `packages/app/resources/pi-runtime/node_modules/@mistralai/mistralai/tests/vitest.config.ts`
   及其在 `release/win-unpacked/` 下的副本 —— 由 TASK-013 的 `prepare:runtime` 从
   pi 运行时整包复制进来的**第三方 node_modules 内容**，不是本仓的第二份配置。
   判据的排除模式只写了 `-not -path './node_modules/*'`（顶层），漏掉了嵌套的。
   把排除改成 `-not -path '*/node_modules/*'` 后输出**恰为 2 行**，且
   `check-test-discovery.mjs` 的 discovered = onDisk = 63，发现范围完整。
5. **`respondUi` 的守卫判据用自写脚本判定「调用」而非「出现」。**
   `scripts/check-respond-ui-guard.mjs` 只认成员调用 `.respondUi(`，跳过注释行；
   接口里的方法声明（`respondUi(response): boolean;`，无前置点）不算调用点。
   这是判据原文「定位每个 `respondUi(` **调用**所在行」的忠实实现，不是放宽。
6. **`buildPiSpawn` 的签名再次变化**：`PiLauncherContext` 增加了 `trustArgs?: string[]`，
   返回值增加 `args: string[]`（恒为数组，不为 undefined）。CT-11 的两条断言与
   TASK-003 的 `pi-launcher.spec.ts` 8 个用例在改动后仍全绿。
7. **本任务的在途文件被 TASK-013 的提交 `7d14bf5` 一并带走**（二者共用
   `contract/channels.ts` 等文件，对方在提交前已在 commit message 里注明）。
   本任务自己的提交只含此后的增量：扫描器的两处修复、真机回归抓到的 store 修复、
   回归文档、summary 与两个校验脚本。

## Risks / 未完成（不得用空面板冒充）

1. **MCP 管理整体未实现**：CRUD、启停、连接测试、OAuth 状态、tool 列表、错误诊断
   本轮全部没做。界面上写的是「MCP 管理（…）本轮尚未实现」这句话，**不是空列表**
   —— 空列表表达的是「你还没配过 MCP」，那是另一件事。与 rationale.tradeoffs 一致。
2. **trust.json 写入未取 pi 的 `proper-lockfile` 锁**。pi 写它时会锁目录，我们只做
   「读—合并—原子写」。同一秒内两边同时写仍可能丢一条决定。
3. **pi 版本绑定**：UI method 全集以 0.83.0 的 rpc.md 为准。测试断言的是常量表本身，
   升级 pi 后需重新对照 rpc.md 更新 `EXTENSION_UI_METHODS`，届时 contract test 会
   自动变严而不是静默放行。
4. **`.agents/skills` 祖先遍历会走到盘符根**（pi 自身规则，照实现）。用户若在 `C:\`
   或 `~` 下放了 `.agents/skills`，任何子项目都会被判成「有项目资源」。
5. **语音、图片多模态、草稿恢复未在本轮重新驱动**（分别由 TASK-007 / TASK-010 验证过，
   本任务未触碰这三条路径）。

## Notes（给后续任务）

- **新增 main→renderer 推送必须经 `pi/event-forwarder.ts` 的 `sendPush()`**，否则
  c[19] 的结构断言立刻变红，而且新通道会绕过渲染侧的代际/序号丢弃规则。
- **`pi:ui-respond` 现在有返回值**，调用方必须看 `{ok, reason}`。
- **`statusTexts` 的写入方已迁到 extensionUi store**（`setStatus` 给扩展用、
  `setLocalStatus` 给本机运行态用），`stores/app.ts` 只保留同名只读代理。
- **清空回调表搬到了 `stores/session-scope.ts`**，`stores/app.ts` 原地再导出。
  新 store 要注册会话级清空时引 `session-scope`，不要引 `app`（会形成循环）。
- **`~/.pi/agent/extensions/pibuddy-ui-probe.ts` 留在了本机**，是可复用的 Extension UI
  真机探针（`/uiprobe <method>`）。它只注册一个命令，不订阅任何事件；后续任务要
  复验扩展 UI 时可直接用，不需要时删掉该文件即可。
- **`scripts/cdp-drive.mjs`** 是本次回归的驱动脚本，用法见回归文档抬头。
