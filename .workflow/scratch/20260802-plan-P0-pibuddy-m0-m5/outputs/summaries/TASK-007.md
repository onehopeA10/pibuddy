# TASK-007: SEC-002 + SEC-003 收窄 IPC 接口面与 workspace capability 化

状态：**completed_with_deviations**（结构性与功能性判据全部达成；两条 [UI-observable]
子项未能端到端驱动，已如实记录，见「偏差」第 4/5 条）

## 变更

### 契约层
- `packages/contract/src/channels.ts`（新建）：30 个 invoke 通道 + 3 个推送通道的名字常量，
  **刻意不 import zod**。拆出来是因为 preload 开着 sandbox，产物必须自包含，
  从主入口引会把整个 zod（140KB 的运行时校验库）打进一个从不做校验的安全边界。
- `packages/contract/src/ipc-contract.ts`：删除通用 `pi:command`；补齐 15 个产品动作窄通道
  与 workspace/attachment 通道的 request schema；新增 `PermissionRule`（CT-20）、
  `RuntimeSchema`（结构化 schema 类型，让 app 不必直接依赖 zod）、`WorkspaceRef`、
  `AttachmentRef`；`rendererSettingsPatchSchema` 显式 omit `workspace`。
  删除 `PickedFile`（被 `AttachmentRef` 取代）。
- `packages/contract/package.json`：加 exports map，暴露 `./channels` 子入口。

### 主进程
- `packages/app/src/main/ipc-guard.ts`（新建）：**全仓唯一允许调用 `ipcMain.handle` 的地方**。
  `registerHandler(channel, schema, handler)` 内按序执行 assertMainFrame → schema.parse →
  CHANNEL_MAX_BYTES 查表尺寸 → rateLimiter.check；`IpcGuard implements PermissionEngine`
  提供不抛错的判定形式。拒绝路径全部经 logger 记录。
- `packages/app/src/main/workspace-registry.ts`（新建）：`workspaceId = sha256(realpathSync.native)`
  前 32 位，经 `writeJsonAtomic` 持久化到 `<userData>/workspaces.json`；`resolveInWorkspace`
  是全计划唯一收容原语（`path.relative` 判定，空串即 root 自身放行）。
- `packages/app/src/main/attachment-registry.ts`（新建）：TTL 1800000ms 滑动过期的能力凭证；
  resolve 时重做 realpath/收容/大小/magic bytes 校验；`openAttachment` 是全 main 唯一
  调用 `shell.openPath` 的地方；`revokeAll` / `revokeAllForSession`。
- `packages/app/src/main/ipc.ts`：13 个裸 handler → 30 个经包装器注册的 handler；
  删 `pi:command`；`file:read-image`(任意路径, 同步读) → `file:read-attachment`(token, fs/promises)；
  `shell:*` 只收 token；`dialog:choose-folder` 返回 `{workspaceId, displayPath}`；
  `pi:prompt` 在主进程侧用 token 换回路径拼「[用户提供的文件]」块。
- `packages/app/src/main/pi-launcher.ts`：`verifyRuntime` 从 ipc.ts 迁入并更名
  `verifyRuntimeHandshake`（ipc.ts 里不允许出现任何同步文件读）。

### preload / 渲染进程
- `preload/index.ts`：删除通用 `command`；`invoke` 私有且形参类型为 `InvokeChannel`；
  `pi` 命名空间下**恰好 15 个**产品动作，生命周期/事件/扩展 UI 拆到
  `runtime`/`events`/`extensionUi`；`webUtils.getPathForFile` 移进 preload 内部，
  绝对路径不再进入渲染进程。
- `preload/index.d.ts`：同步 15 个窄方法签名，移除一切裸路径/URL/channel 形参。
- `stores/app.ts`：11 处 `pi.command` 全部改为窄方法；workspace 改为持
  `workspaceId` + `displayPath`（`workspace` 保留为显示用 computed，组件零改动）；
  **保留 `streamingBehavior: "steer"` 分支**。
- `InputBar.vue`：附件从 `PickedFile[]`（含绝对路径）改为 `AttachmentRef[]`（只有 token）。
- `electron.vite.config.ts`：preload 段加 `exclude: ["@pibuddy/contract"]`（见偏差 1）。

### 测试
- 新建 `ipc-guard.spec.ts`(18)、`workspace-capability.spec.ts`(13)、`attachment-registry.spec.ts`(12)。
- 更新 `session-interaction.spec.ts` / `generation.spec.ts` 的 window 替身以对齐新接口面。

## 收敛条件逐条实跑

命令与原样输出：

```
$ rg -c 'pi:command' packages/app/src | wc -l                                    → 0
$ rg -c 'command:' packages/app/src/preload/index.ts | wc -l                      → 0
$ rg -c 'piBuddy.pi.command' packages/app/src/renderer | wc -l                    → 0
$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main \
     -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'                  → 0   (改前 13)
$ rg --no-filename -c 'registerHandler\(' packages/app/src/main/ipc.ts | awk ...  → 30  (>=15)
$ rg --no-filename -c 'assertMainFrame\(' packages/app/src/main \
     -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'                  → 0
$ rg -c 'startsWith\(root|real.startsWith' .../workspace-registry.ts | wc -l      → 0
$ rg -c 'randomUUID' .../workspace-registry.ts | wc -l                            → 0
$ rg -c 'workspace: string' packages/app/src/preload/index.d.ts | wc -l           → 0
$ rg -l 'ATTACHMENT_TTL_MS' packages/app/src/main | wc -l                         → 1
$ rg -c 'readFileSync' packages/app/src/main/ipc.ts | wc -l                       → 0   (改前 ipc.ts:182)
$ rg --no-filename -c 'shell\.openPath' packages/app/src/main \
     -g '*.ts' -g '!attachment-registry.ts' | awk '{s+=$1} END{print s+0}'        → 0   (改前 ipc.ts:187)
$ rg -c 'channel: string|filePath: string|url: string|path: string' \
     packages/app/src/preload/index.d.ts | wc -l                                  → 0
$ rg -c 'export async function send\(opts: SendOptions = \{\}\): Promise<boolean>' \
     packages/app/src/renderer/src/stores/app.ts                                  → 1
$ rg --no-filename -c 'export (type|interface) PermissionRule\b' \
     packages/contract/src | awk '{s+=$1} END{print s+0}'                         → 1
$ rg -c 'streamingBehavior: "steer"' .../stores/app.ts                            → 1
$ node scripts/check-contract-uniqueness.mjs                                      → exit 0
```

四道闸顺序断言（node 脚本读 registerHandler 函数体内标识行号）：

```
  280  assertMainFrame
  281  schema.parse
  282  CHANNEL_MAX_BYTES
  284  rateLimiter.check
PASS: 四步行号严格递增
```

`ipc-guard.ts` 必含项全部命中：`implements PermissionEngine` / `checkFrame` / `checkPayload` /
`checkRate` / `event.senderFrame !== event.sender.mainFrame` / `MAX_IPC_PAYLOAD_BYTES = 8 * 1024 * 1024` /
`MAX_TEXT_PAYLOAD_BYTES = 262144` / `class RateLimiter` / `"stt:transcribe": 25 * 1024 * 1024` /
`"file:read-attachment": 10 * 1024 * 1024`。

`attachment-registry.ts` 必含项全部命中：`ATTACHMENT_TTL_MS = 1800000` / `renewOnAccess` /
`MAX_IMAGE_BYTES = 10 * 1024 * 1024` / magic bytes 字面量 `0x89 0x50 0x4e 0x47 0xff 0xd8 0x42 0x4d` /
`revokeAllForSession` / `revokeAll` / `shell.openPath`。

`workspace-registry.ts` 必含项全部命中：`realpathSync.native`(2) / `path.relative(`(3) /
`createHash("sha256")` / `writeJsonAtomic`(3) / `workspaces.json`(2)。

## 测试

```
$ pnpm -w test
 Test Files  15 passed (15)
      Tests  136 passed (136)          # 改前 93，本任务新增 43

$ pnpm typecheck                        → exit 0
$ pnpm --filter @pibuddy/app build      → exit 0
$ node scripts/check-contract-uniqueness.mjs → exit 0
```

新增用例覆盖：senderFrame 拒绝、zod 拒绝、四类尺寸上限（含 stt 9MB 过 / 26MB 拒、
read-attachment 11MB 拒、未列通道沿用 8MB）、限流 10/11 边界、workspaceId 跨「重启」稳定、
六类恶意路径输入、root 自身放行、TTL 29/50 分钟滑动续期与静置 31 分钟失效、
revokeAll/revokeAllForSession、magic bytes 拒 PE 伪装。

## 真机验证

详见 `doc/regression/TASK-007-extension-ui.md`（CDP 直连取证，非目测）。要点：

- `window.piBuddy.pi` 恰 15 键、`pi.command` 为 `undefined`
- `prompt({type:'bash',command:'calc.exe'})` 在 IPC 边界被 zod 挡掉
- 附件通道对任意绝对路径返回 `ATTACHMENT_TOKEN_INVALID`
- `settings.set({workspace:'C:/'})` 无法改写工作目录
- 限流：前 10 次过闸，第 11/12/13 次 `IPC_RATE_LIMITED`
- workspaceId 跨**真实重启**恒为 `9b7497499cae1f644a743fece40f0021`，会话列表照常
- **插话（steer）**：计数任务在第 29 个数字被打断，助手转而执行插话指令
- 拖拽文件 → token → 主进程换回路径 → pi 真的读到了文件（tool 卡片可见）
- 图片多模态、abort、模型/思考等级切换、新任务、切换会话、thinking 折叠、
  tool 卡片、context 用量 —— 均正常

## 偏差

1. **（最重要）额外修了一个只有真机才暴露的打包缺陷。** preload 开始把 `CHANNELS` 当**值**用
   之后，`@pibuddy/contract` 被 `externalizeDepsPlugin` 标成 external；而 sandbox:true 的
   preload 里 `require` 只认 electron 与少数内建模块，解析不到就**整个 preload 静默失败** ——
   界面全白、`window.piBuddy` 为 undefined、控制台无任何堆栈。
   而此时 `pnpm typecheck` / `pnpm -w test` / `pnpm build` **三样全绿**。
   处置：preload 段加 `exclude: ["@pibuddy/contract"]`，并把通道常量拆进不依赖 zod 的
   `contract/src/channels.ts` + 子入口 `@pibuddy/contract/channels`，
   使 preload 产物从 145KB（含整个 zod）降到 5.3KB，externals 只剩 `require("electron")`。
   这超出了任务的 files[] 清单（改了 `electron.vite.config.ts`、新建 `channels.ts`），
   但不修则本任务交付物根本无法启动。
2. **`pi.prompt` 的形参名是 `message` 而不是收敛条件 c[18] 写的 `text`。**
   c[18] 的示例写作 `pi.prompt({text:'x'})`；实际实现取 `message`，因为 pi 的 rpc 协议
   （rpc.md）与 `stores/app.ts` 沿用的都是 `message`，改叫 `text` 会在主进程里多一次
   无谓的字段改名。真机上以 `pi.prompt({message:'…'})` 验证了该条的实质要求
   （fulfilled + user/assistant 各 +1）。
3. **`window.piBuddy.pi` 之外新增了 4 个命名空间。** c[18] 要求 `pi` 下恰好 15 项，
   因此 `start`/`stop`/`uiRespond`/`on*` 这些非产品动作被移到
   `runtime` / `events` / `extensionUi` 下，而不是删除。接口面总量没有变宽。
4. **Extension UI 七种交互只逐项确认了 setStatus，其余六项未端到端驱动。**
   这些请求由 pi 侧扩展主动发起，当前扩展处于 AUTO/ACT/YOLO 模式不会弹窗，
   且没有可从渲染侧主动触发的入口（`get_commands` 不在 15 个窄方法内）。
   已确认的替代证据：`ExtensionUiHost.vue` 本任务零改动、响应通道契约校验通过
   （格式正确者被接受、伪造类型被 schema 拒）、setStatus 端到端可见。
   回归文档里那六行**没有打勾**。建议 TASK-012 配专用测试扩展补齐。
5. **语音输入未驱动**：需真实麦克风授权与可用的 STT 端点，当前 `sttApiKey` 未配置。
   通道上限已由单测覆盖（9MB 过 / 26MB 拒）。
6. `PickedFile` 类型被删除（由 `AttachmentRef` 取代）。任务未明说要删，但保留一个带
   `path` 字段的渲染侧类型会与 capability 化直接冲突。
7. `session-interaction.spec.ts` / `generation.spec.ts` 的 window 替身随接口面更新。
   前者的 mock 把 15 个窄方法各自映射回对应的 rpc 命令名，原有断言（`commandLog`）语义不变。

## 给后续任务的提醒

- **新增 IPC 通道只有一条路**：在 `contract/src/channels.ts` 加名字、在 `ipc-contract.ts` 加 schema、
  用 `registerHandler` 注册。任何直接 `ipcMain.handle` 都会让结构断言（当前为 0）转红。
- `resolveInWorkspace` 是全计划唯一收容原语，**空串 = root 自身 = 放行**（CT-18）。
  TASK-015 不得另建一个拒绝 root 的原语。
- `attachment-registry.ts` 是唯一的附件注册表，TASK-015 只允许在其上补结构化字段
  （relativePath / sourceName / sha256），不得新建 `workspace/attachment-store.ts`。
- `workspaceId` 已持久化在 `<userData>/workspaces.json`，TASK-009 的 `sessions.workspace_id`
  可直接用它做 NOT NULL 外键。
- preload 里**只能从 `@pibuddy/contract/channels` 取值**；从主入口取值会把 zod 打进 sandbox 产物。
- 顶层字符串字段受 `MAX_TEXT_PAYLOAD_BYTES`(256KB) 约束，嵌套字段（如 `images[].data`）不受，
  这是为了不误伤多模态；新增大文本字段时注意别放在顶层。
