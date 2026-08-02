# TASK-014: PROV-101 + UX-101 Provider 与模型中心、用量页与首次启动向导

## 一句话

用户不再需要打开终端跑 `pi` 然后 `/login`：账号在应用里填、连通性在应用里测、
模型能力在应用里看得见、每天花多少钱在应用里查得到。

## Changes

### 契约（packages/contract/src/）
- `providers.ts`（新建）：`ProviderView` / `ProviderTestResult` / `ModelRef` /
  `UsageRow` 等 15 个形状。**没有 key 字段**，渲染进程能看到的极限是
  `{configured, last4}`。
- `channels.ts`：新增 10 条通道（7 provider + 3 usage）。
- `ipc-contract.ts`：10 条通道的 request/response schema；
  `rendererSettingsPatchSchema` 追加 omit `workspaceDefaults`（只能经
  `providers:set-scope-default` 写，那条路上会校验 workspaceId）。
- `settings.ts`：schema 升到 **v2**，新增 `workspaceDefaults` /
  `onboardingStep` / `onboardingCompletedAt` / `notificationsEnabled` /
  `voiceEnabled`；新增 `AppSettingsPublic` 类型（`Pick` 绑定白名单）。

### 主进程（packages/app/src/main/）
- `providers/auth-store.ts`（新建）：`~/.pi/agent/auth.json` 的合并式读写。
  先读 → 备份到 `<userData>/auth-backup/auth.<epochMs>.json` → `writeJsonAtomic`
  → `chmod 0600`。Windows 上如实返回 `permissionEnforced:false` 并记 warning。
  key 一律钉成字面量（`!` → `$!`，`$` → `$$`），避免用户粘贴的字符串被 pi
  当成 shell 命令执行。
- `providers/models-store.ts`（新建）：`~/.pi/agent/models.json` 的自定义
  provider CRUD + `discoverModels`（`GET {baseUrl}/models`，经 safeFetch）。
  **写前备份**（见下方「真机验证抓到的问题」#3）。
- `providers/connectivity.ts`（新建）：`testProvider()`，错误分
  auth/network/model/unknown，返回值与日志**都**经 logger-redact 的
  `redactSecrets`。
- `providers/provider-catalog.ts`（新建）：10 个服务商目录。**一个模型名都没有** ——
  模型列表的唯一来源是 pi 的 `get_available_models`。
- `providers/model-scope.ts`（新建）：`resolveModel()`，session > workspace > global。
- `providers/providers-ipc.ts`（新建）：10 条 handler，全部经 `registerHandler`。
- `usage/usage-store.ts`（新建）：`usage_daily` 按 (day, workspace, provider, model)
  聚合；增量钳到非负；CSV 公式前缀转义。
- `settings.ts`：`SETTINGS_SCHEMA_VERSION = 2`；migrate 加 v1→v2 分支（老用户
  不弹回向导）；`publicSettings()` 从 misc-ipc 迁来并改为**逐键写出**。
- `misc-ipc.ts` / `ipc-registry.ts`：改用共享的 `publicSettings`；注册新域。

### preload / renderer
- `preload/api/providers.ts`（新建）+ `index.ts`：第 11 个命名空间。
  有 `saveKey` 没有 `getKey`。
- `stores/model-capability.ts`（新建）：`assertImageCapable()`，判据只有
  `Model.input` 是否含 `"image"`。
- `stores/providers.ts`（新建）：`useProvidersStore`。
- `stores/app.ts`：
  - `send()` 最前面加图片能力守卫，拦截时 `return false`；
  - `start()` 的恢复历史会话分支里**一次 setModel 都不发**，改置
    `modelMismatchPrompt`；新增 `keepSessionModel` / `switchToPromptedModel`；
  - `refreshStats()` 后上报用量（见下方 #4）。
- 组件：`OnboardingWizard.vue` / `ProviderCenter.vue` / `UsagePanel.vue` /
  `StatusCenter.vue` 新建；`AppShell.vue`（向导分支 + no-model 空状态）、
  `TopBar.vue`（状态中心 + 模型不匹配提示条 + 能力标签）、
  `SettingsModal.vue`（**删除终端 `/login` 引导文案**）、`InputBar.vue`
  （附件 `aria-disabled` / 发送键禁用 / 切换模型列表）修改。

### 顺手修的既存 CI 红
- `packages/app/test/attachment-registry.spec.ts`：`tmpRoot` 用
  `fs.realpathSync` 归一化。GitHub windows runner 的 `os.tmpdir()` 返回 8.3
  短路径（`RUNNER~1`），而 attachment-registry 内部对每个文件做 `realpath`
  拿到长路径（`runneradmin`），两者逐字符不等 —— 本机绿、CI 红。

## Verification

三大门禁：

- [x] `pnpm typecheck` — 3 个包全 Done
- [x] `pnpm -w test` — **76 files / 640 tests 全通过**（改前 62/510）
- [x] `pnpm build` — main / preload / renderer 三段产物均成功

结构性断言（逐条实跑，输出附后）：

| 条件 | 期望 | 实测 |
|---|---|---|
| `writeJsonAtomic` in auth-store | >=1 | 3 |
| `writeFileSync(` in auth-store | 0 | 0 |
| `sttApiKeySet` 全仓 | 0 | 0 |
| `assertHttpsOrLocalhost` 全仓 | 0 | 0 |
| `fetch(` in main（排除 outbound-guard / 测试） | 0 | 0 |
| `assertImageCapable` in model-capability.ts / app.ts | 各 >=1 | 1 / 2 |
| `/login` in renderer | 0 | 0 |
| 硬编码模型名 in providers/ + stores/providers.ts | 0 | 0 |
| `redactSecrets` 实现数 in main | 1 | 1 |
| `ipcMain.(handle\|on)(` in main（排除 ipc-guard） | 0 | 0 |
| `send` 签名 | 1 | 1 |
| `SETTINGS_SCHEMA_VERSION = 2` | 1 | 1 |
| AppShell 四个具名插槽 | 4 | 4 |
| 仓库内 tracked vitest 配置 | 2 | 2 |
| `node scripts/check-contract-uniqueness.mjs` | exit 0 | exit 0 |
| `node scripts/check-test-discovery.mjs` | discovered==onDisk | 76==76 |

> 两处**如实记录的偏差**：收敛条件里 `rg -c "from '@pibuddy/contract'"` 与
> `rg -c "from '.*logger-redact"` 用的是**单引号**字面量，而本仓库
> import 一律用双引号（logger.ts 自己也是），照原样跑必得 0。改用
> quote-agnostic 模式 `from ["'][^"']*…` 复核：新增的 12 个 .ts 文件
> 全部 >=1，connectivity.ts 的 logger-redact 导入 =1。

## 真机验证（本轮抓到 6 个「三大门禁全绿但功能已死」的问题）

真机：Windows 11，`electron-vite preview` + `--remote-debugging-port=9222`，
每轮先 `powershell Stop-Process -Name electron -Force` 并核对进程数归 0 与
新 StartTime，证据全部经 `scripts/cdp-eval.mjs` 读真实 DOM / 真实 IPC。

### 抓到并已修的问题

1. **`models.json` 里的内联 apiKey 被无视** —— 本机三个 provider 的 key 都写在
   `models.json` 的 `apiKey` 字段（pi 确实会用它），而我只看 auth.json，
   于是能跑的服务商在界面上显示成「未配置」。用户会据此重填一遍，把一份
   本来好好的配置改坏。已修：`configured` 同时看内联 key，占位值不算数。
2. **显示名回落成裸 id** —— 同上路径，界面上出现一串全小写的 `anthropic`。
   已修：条目 name → 目录正式名 → id 三级回落。
3. **`models.json` 写入无备份（不可逆数据丢失）** —— 真机验证时一条
   `providers:remove('openai')` 把本机 models.json 里那个 provider 连同
   baseUrl 与 apiKey 一起删掉了，当时**没有任何退路**（auth.json 有备份，
   这份没有）。已修：`writeModelsFile()` 成为唯一写入口，写前备份到同一个
   `auth-backup/`；UI 上删除按钮按 custom/非 custom 分文案，并加二次确认。
   补 `models-store.test.ts` 13 条断言（备份 sha256 与删除前一致、
   合并写入不丢用户手写条目与未知顶层字段、被拒地址零字节落盘）。
4. **用量页整体是死的** —— `usage-store` 单测全绿、表格渲染正常、导出按钮
   点了也有反应，但表里**一行数据都没有**：没有任何地方调用 `usage:record`。
   已修：`refreshStats()` 后上报会话累计快照；失败次数从
   `stopReason==='error'` 与 `auto_retry_end(success=false)` 两处累计。
   补 `usage-record.test.ts` 6 条断言（断言的是**连接**而不是实现）。
5. **导出文件名用 UTC** —— 东八区用户在 8/3 凌晨导出，文件叫 `2026-08-02`
   而表里第一行写着 `2026-08-03`。已修：改用 `localDay()`。
6. **provider 列表对老用户永远不加载** —— AppShell 里那个 `watch` 少了
   `immediate: true`，而绝大多数用户打开应用时 `onboardingPending` 从头到尾
   就是 false，回调永不触发。表现是状态中心「服务商账号」恒为「暂不可用」。
   已修并复验：修前 `provider=服务商账号 | 暂不可用（还没读到账号列表）`，
   修后 `provider=服务商账号 | 已配置 3 个`。

### 真机通过的验收项

- **老用户不被弹回向导**：v1 设置文件（有 workspace）启动后
  `wizard:false, hasTopbar:true, hasComposer:true`，顶栏出现
  `["📁 test","🧩 资源","🔑 账号","📊 用量","状态"]`。
- **全新用户看到向导**：清空 settings 后 `wizard:true, step:"0",
  role:"dialog", mainUiRendered:false`。
- **向导可中断恢复**：第 1 步立刻把 `onboardingStep:1` 写进磁盘（v2 文件已确认）；
  重启后从 step 3 继续（`wizardStep:"3", title:"服务商账号"`）。
- **推进闸门**：没选工作文件夹时 `下一步` disabled 且提示
  「请先选一个工作文件夹」。
- **走完向导能发第一条消息**：`开始使用` → `wizardGone:true, mainUi:true,
  inputEnabled:true` → `send()` 返回 true、助手回「收到」（stopReason: stop）。
  **全程没有打开终端。**
- **auth.json 合并写 + 备份**（真机对着真实 pi）：
  - 写前 sha256 `0f60d834…` == 备份文件 sha256 `0f60d834…`（逐字节一致）
  - OAuth 条目 `anthropic-oauth` 写入前后逐字段不变
  - 返回给渲染进程的快照 `leaksKey:false`
  - **pi 真的读得懂**：写入 deepseek key 后重启 pi，模型数 55 → 57，
    新增的正是 `deepseek-v4-flash` / `deepseek-v4-pro`；删除后复原。
- **连通性测试**（真打 api.deepseek.com）：
  - 没配 key → `errorCode:"auth"`
  - 错的 key → `HTTP 401 · {"error":{"message":"Authentication Fails…"}}`（含状态码）
  - http:// 端点 → `OUTBOUND_BLOCKED: 只允许 HTTPS 端点`
- **图片能力拦截（[UI-observable] 逐项以 DOM 属性判定）**：
  切到 `o3-mini`（`input:["text"]`）后拖入真实 PNG →
  - 附件条目 `aria-disabled="true"`，`title="当前模型 o3-mini 不支持图片"`
  - 发送按钮 `disabled:true`，`title` 含同一模型 id
  - 说明文本 `当前模型「o3-mini」不支持图片…`
  - 「切换到支持图片的模型」列表 **51 项，每一项 `data-model-input` 都含
    `image`，offenders 数组为空**；`text-only-model` / `another-text` 不在列表里
  - 选中 `claude-haiku-4-5` 后：`aria-disabled → "false"`、发送键 `disabled → false`、
    受阻说明整体消失、能力标签 `🚫 不收图` → `🖼 可收图`
- **多模态没被拦坏**（回归）：`gpt-5.6-sol` 下同一张图正常发出，
  `msg-user-bubble` 内出现 `<img>`，助手回「收到图了」。
- **历史会话不被静默换模型**：用 `claude-fable-5` 跑一轮 → 全局默认改成
  `gpt-5.6-sol` → `start(sessionId)` 恢复 →
  `currentModel` 仍是 `claude-fable-5`（未被覆盖），顶栏出现
  「这个会话原来用的是「claude-fable-5」，当前默认是「gpt-5.6-sol」，是否切换？」；
  点「保持原来的」→ 模型不变、提示消失；点「切换到默认」→ 切到 `gpt-5.6-sol`。
- **用量页有真数据**：发一轮后 `usage.query()` 返回
  `{day:"2026-08-03", provider:"openai", model:"gpt-5.6-sol",
  inputTokens:22319, cost:0.1117…}`；表格 8 列渲染正确；
  CSV 首行为约定表头且 workspaceId 已换成显示路径；JSON 导出带 schemaVersion。
- **状态中心**六类齐全：runtime / session / provider / context / tasks / update。
- **受保护功能回归**：流式（`streaming:true` 中途）、steer 插话
  （streaming 中 `send(mode:'steer')` 返回 true）、abort（之后
  `streaming:false`）、thinking 切换（max → low → high 逐次生效）、
  模型切换、会话列表 19 条、Provider 中心 dialog 有 `aria-labelledby`。

## Tests

新增 8 个 spec，共 **+130 条**：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `main/providers/auth-store.test.ts` | 14 | 合并写 / OAuth 保留 / 备份 sha256 / 0600 / 字面量转义 / 结构断言 |
| `main/providers/models-store.test.ts` | 13 | 写前备份 / 合并 / 落盘前校验 / discoverModels |
| `main/providers/connectivity.test.ts` | 13 | 脱敏 / key 不进日志 / SSRF 三拒绝用例 / 错误分类 |
| `main/providers/model-scope.test.ts` | 12 | 8 种组合逐一 + mismatch 边界 |
| `main/usage/usage-store.test.ts` | 11 | 聚合 / 增量不出负数 / CSV 注入 |
| `renderer/stores/send-image-capability.test.ts` | 10 | 阻断 / 放行 / 边界 + 15 方法有界枚举 |
| `renderer/stores/model-capability.test.ts` | 13 | 判据 / 建议列表 / 不查名单 |
| `renderer/stores/session-model-scope.test.ts` | 9 | 行为层 + 源码 else 块结构层 |
| `renderer/stores/usage-record.test.ts` | 6 | 上报连接 / 失败计数 |
| `renderer/components/image-capability-ui.test.ts` | 6 | DOM 属性逐项 |
| `renderer/components/onboarding-wizard.test.ts` | 9 | 可中断恢复 / 401 与 ENOTFOUND 文案 / 闸门 / aria |
| `test/settings-redaction.spec.ts` | 9 | 公开键集合 / v1→v2 迁移 |
| `test/providers-ipc.spec.ts` | 5 | 注册面（运行时表，不钉死文件） |

## Deviations

1. **OAuth 端内登录本轮不做**（计划已预告）。pi 的 `/login` 是交互式 TUI，
   RPC 协议无对应命令。界面**如实显示**「这是订阅制账号，登录流程需要在
   终端里完成」，不摆一个点了没反应的按钮。检测到已有 OAuth 凭据时正常
   显示为「已配置 / 订阅账号」。
2. **两条收敛条件的 rg 模式与仓库引号风格不符**（详见 Verification 节），
   已用 quote-agnostic 模式复核通过。
3. **`vitest.config.*` 的 find 会多出 2 行**：来自 gitignore 的
   `packages/app/resources/pi-runtime/` 与 `packages/app/release/`（vendored
   第三方 + 构建产物）。仓库内 tracked 的恰为 2 个且都在根。
4. **settings 迁移不主动回写磁盘**：`migrate()` 只在 `loadSettings()` 时
   在内存里折叠，schemaVersion 要等第一次 `saveSettings()` 才落盘。这与
   TASK-008 既有行为一致，且 v1→v2 的判据（`workspace` 是否存在）是幂等的。
5. **`providers:remove` 对自定义端点是连 baseUrl 一起删**。这是「删除服务商」
   的正确语义，但已按上文 #3 补了备份 + 文案 + 二次确认。

## Notes

给后续任务：

- **`~/.pi/agent/*` 的任何写入都必须先备份**。本轮实测证明这不是理论风险：
  一次 remove 就删掉了用户真实配置。`auth-store.ts` 的 `backupDir()` 已被
  `models-store.ts` 复用，第三个文件（如 trust.json）请继续复用它。
- **新增「有数据源 + 有 UI」的功能时，先验证中间那条上报/订阅链**。用量页
  这次是完整的两端 + 空的中间，而三大门禁对此完全无感。同理适用于任何
  `watch` —— 少一个 `immediate: true` 就是一条永不触发的死链。
- `providerLogger()` / `__setProviderLogger()` 在 `auth-store.ts` 导出，
  providers 域共用。要断言「密钥没进日志」只能靠注入 spy 捕获全部调用参数。
- 模型能力的唯一来源是 `get_available_models` 返回的 `Model.input`。
  `provider-catalog.ts` 里**只有服务商没有模型**，结构断言钉死了这一点。
- `window.piBuddy` 是 contextBridge 暴露的只读代理，**CDP 里 monkeypatch
  不生效**（会静默失败）。要观测出参请用单测，或从 pinia 实例
  （`#app.__vue_app__.config.globalProperties.$pinia._s`）读状态。
