# TASK-002: M0 架构护栏 —— @pibuddy/contract 共享契约 + 事件 envelope + 端口接口 + 脱敏日志

状态：**completed_with_deviations**（19 条 criteria 中 17 条完全通过，1 条因判据命令的引号风格与仓库不符而字面失败、实质满足，1 条 UI 冒烟只完成到「启动无新增报错」层级）

依赖：TASK-001 状态为 `completed_with_deviations`（非 `completed`）。按错误行为约定视为可继续的终态，未阻塞。

---

## Changes

### 新建 `@pibuddy/contract`（四方唯一真相源）

- `packages/contract/package.json` — `@pibuddy/contract`，`type: module`，`main`/`types` 指向 `./src/index.ts`（照抄 pi-sdk 的源码消费模式），直接依赖 `zod ^4.4.3`
- `packages/contract/tsconfig.json` — 非 composite，`extends ../../tsconfig.base.json`
- `packages/contract/src/envelope.ts` — `PROTOCOL_VERSION = 1`；`PiEnvelope<T>` 八字段（`protocolVersion` / `workspaceId` / `sessionId` / `runtimeId` / `generation` / `sequence` / `occurredAt` / `payload`）；`envelopeSchema`；`parseEnvelope`（**先比版本再比结构**，不等直接返回 `{ok:false, reason:"protocol-version-mismatch"}`）；`wrapEnvelope` / `createEnvelopeSequencer` / `createSequenceGate`
- `packages/contract/src/settings.ts` — `appSettingsSchema` + `AppSettings` + `AppSettingsPatch` + `parseAppSettings`（磁盘文件被手改坏时回落 `{}`，不让应用起不来）
- `packages/contract/src/session.ts` — `sessionMetaSchema` + `SessionMeta`，预留 `cwd` / `runtimeVersion` / `parseError` 三个 M1 字段；`SessionSummary` 为同构别名
- `packages/contract/src/ipc-contract.ts` — `CHANNELS`（13 个 invoke）+ `PUSH_CHANNELS`（3 个 push）+ `CHANNEL_CONTRACTS` 的 per-channel `request`/`response` schema + `isKnownChannel`；具名化 `PiStartParams` / `StartResult<TState,TModel,TMessage>` / `PickedFile` / `ReadImageResult` / `SttTranscribeRequest` / `SttTranscribeResult`
- `packages/contract/src/ports.ts` — 五个 interface（`PiRuntimeSupervisor` / `SessionRepository` / `PermissionEngine` / `SettingsStore` / `UpdateService`）+ 依赖方向注释；`PermissionEngine` 方法恰为 `checkFrame` / `checkPayload` / `checkRate`
- `packages/contract/src/index.ts` — 桶导出
- `packages/contract/test/envelope.spec.ts` — 8 个用例（版本不匹配 / 缺 protocolVersion / 缺 sequence / 非对象 / 往返闭合 / 序号单调 / 代际重置）

### 单点实现（不得各写一份）

- `packages/app/src/main/logger-redact.ts` — 唯一 `redactSecrets`。键名正则 `/apiKey|authorization|token|secret|password/i` 整值抹掉；`prompt`/`message`/`text`/`content`/`delta`/`output` 只留 `<name>Length`；`env` 只记白名单命中的**键名**；字符串内 `Bearer …`、`sk-/ghp_/xoxb-…`、home 路径就地替换
- `packages/app/src/main/logger.ts` — 唯一 `createLogger`。JSONL；`MAX_LOG_BYTES = 5*1024*1024`；`MAX_LOG_FILES = 5`；`.1 → .2 → …` 逐级顺移轮转；跨天换文件。**刻意不 import electron**，目录由 `main/index.ts` 传入 `app.getPath("userData")/logs`，因此可在纯 node 的 vitest 里跑真实实现而不是桩
- `packages/app/src/main/fs-atomic.ts` — 唯一 `writeJsonAtomic`：`open(.tmp)` → `writeFileSync` → `fsyncSync` → `close` → `renameSync`；任何一步失败都清理 `.tmp` 后重抛
- `packages/app/src/main/index.ts` — 新增 `mainLogger()` 惰性单例，`whenReady` 时记一条 `app_ready`

### 类型去重（7 处 → 0）

| 类型 | 改前 | 改后 |
|---|---|---|
| `AppSettings` | `main/settings.ts:5` + `preload/index.d.ts:28` | contract 唯一，两处改为 import |
| `SessionMeta` | `main/sessions-store.ts:5` + `preload/index.d.ts:19` | 同上 |
| `PickedFile` | `preload/index.d.ts:38`（+ `ipc.ts` describeFile 内联返回类型） | contract 唯一 |
| `StartResult` | `preload/index.d.ts:13` | contract 泛型版，preload 实例化为 `PiStartResult` |
| pi:start 参数 | `preload/index.ts:15` + `ipc.ts:91` 内联 | `PiStartParams` |
| 图片返回 | `preload/index.ts:35` + `ipc.ts:157` 内联 | `ReadImageResult` |
| STT 请求 | `preload/index.ts:44-50` + `ipc.ts:177-183` 内联 | `SttTranscribeRequest` / `SttTranscribeResult` |

- `packages/app/src/preload/index.d.ts` — 重写，不再自己声明任何跨进程形状，全部 re-export 自 `@contract`
- `packages/app/src/main/ipc.ts` — 四处内联对象类型字面量改为契约具名类型

### 构建接线（两个易漏点）

- `packages/app/electron.vite.config.ts` — `exclude: ["@pibuddy/pi-sdk", "@pibuddy/contract"]`；renderer alias 增加 `"@contract"`
- `packages/app/tsconfig.node.json` / `tsconfig.web.json` — include 各追加 `../contract/src/**/*.ts`；web 的 paths 增加 `"@contract"`
- `packages/app/package.json` — 增加 `"@pibuddy/contract": "workspace:*"`

### 跨层硬编码路径清零

- `stores/app.ts:17` 与 `InputBar.vue:5` 的 `"../../../preload/index.d"` → `"@contract"`

### runtime/lifecycle 状态按 sessionId 归一化

`stores/app.ts` 新增 `RuntimeScope {started, streaming, runtimeId, generation}` 与 `runtimeScope: Record<string, RuntimeScope>` + `currentSessionId`。`started` / `streaming` 改为**可写 computed 代理**，组件调用点（`store.started` / `store.streaming`）零改动。`start()` 成功时 `generation += 1` 并生成 `runtimeId`。`adoptSession()` 在会话 ID 首次可知时把占位 scope 原样搬到新 key（不搬就会让 `started` 瞬间回落 false、输入框被禁用且不报任何错）。**显式未动** `items` / `toolRuns` / `queue` / `statusTexts` / `activityTick`。

### AgentEvent 判别式修复（用户指令追加，见「偏差」）

`packages/pi-sdk/src/types.ts` 去掉兜底成员 `{ type: string; [key: string]: unknown }`，补齐 rpc.md 中缺失的 `summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished`，新增 `AGENT_EVENT_TYPES`（21 个）/ `KnownAgentEventType` / `isKnownAgentEventType` / `toAgentEvent`；兜底改为带独立判别式的 `{ type: "unknown"; raw: unknown }`。`client.ts` 的两处 `obj as AgentEvent` 改为 `toAgentEvent(obj)`。

### 闸门与文档

- `scripts/check-contract-uniqueness.mjs` — 三类断言：名字碰撞（contract vs app/pi-sdk，含 contract 包内自重复）、第二套契约包、跨层 `preload/index.d` 引用。已接入 `.github/workflows/ci.yml`（**modify**，未重建）
- `doc/architecture.md` / `doc/threat-model.md` / `doc/traceability.md`

### 测试

- `packages/contract/test/envelope.spec.ts`（8）
- `packages/app/test/logger.spec.ts`（3：脱敏 / Authorization+env / 轮转）
- `packages/app/test/fs-atomic.spec.ts`（2：正常写 / rename 前注入异常）
- `packages/app/test/store-runtime-scope.spec.ts`（1：computed 代理读写落在 runtimeScope 上）

---

## Verification —— 逐条实跑

### c[1] contract package.json

```
$ grep -c '"name": "@pibuddy/contract"' packages/contract/package.json  → 1
$ grep -c '"zod"' packages/contract/package.json                        → 1
```
**PASS**

### c[2] PROTOCOL_VERSION

```
$ grep -c 'export const PROTOCOL_VERSION = 1' packages/contract/src/envelope.ts  → 1
```
**PASS**

### c[3] 八个信封字段 + 泛型 + wrapEnvelope

```
protocolVersion=4 workspaceId=5 sessionId=8 runtimeId=5 generation=9 sequence=11 occurredAt=10 payload=11
$ grep -c 'export interface PiEnvelope<T' packages/contract/src/envelope.ts  → 1
$ grep -c 'export function wrapEnvelope' packages/contract/src/envelope.ts   → 1
```
**PASS**

### c[4] protocol-version-mismatch

```
$ grep -c 'protocol-version-mismatch' packages/contract/src/envelope.ts  → 2
```
**PASS**

### c[5] 五个端口 + PermissionEngine 三方法

```
interface PiRuntimeSupervisor=1 interface SessionRepository=1 interface SettingsStore=1 interface PermissionEngine=1 interface UpdateService=1
$ grep -c 'checkFrame\|checkPayload\|checkRate' packages/contract/src/ports.ts  → 6  (>= 3)
```
**PASS**

### c[6] electron.vite exclude

```
$ grep -c 'exclude: \["@pibuddy/pi-sdk", "@pibuddy/contract"\]' packages/app/electron.vite.config.ts  → 1
```
**PASS**

### c[7] 两个 tsconfig include

```
$ grep -c '\.\./contract/src/\*\*/\*\.ts' packages/app/tsconfig.node.json  → 1
$ grep -c '\.\./contract/src/\*\*/\*\.ts' packages/app/tsconfig.web.json   → 1
```
**PASS**

### c[8] renderer 不再引用 preload/index.d

```
$ test -e packages/app/src/renderer && rg -c 'preload/index.d' packages/app/src/renderer | wc -l  → 0
```
**PASS**（改前 2 处：stores/app.ts:17、InputBar.vue:5）

### c[9] 四个具名类型逐一收敛（8 条断言）

```
app+sdk:   AppSettings=0  SessionMeta=0  PickedFile=0  StartResult=0
contract:  AppSettings=1  SessionMeta=1  PickedFile=1  StartResult=1
```
**PASS**（8/8）

### c[10] 三个内联匿名类型收敛

```
$ rg --no-filename -c 'export (interface|type) (SttTranscribeRequest|ReadImageResult|PiStartParams)\b' packages/contract/src | sum  → 3
$ rg -c 'SttTranscribeRequest|ReadImageResult|PiStartParams' packages/app/src/preload/index.ts        → 6  (>= 3)
$ rg -c 'workspace: string; session\?: string|\{ data: string; mimeType: string \}' .../index.ts | wc -l  → 0
```
**PASS**

### c[11] 唯一日志器

```
MAX_LOG_BYTES        = 2
MAX_LOG_FILES        = 4
export createLogger  = 1
redact regex literal = 1   ('/apiKey|authorization|token|secret|password/i')
createLogger uniq    = 1
redactSecrets uniq   = 1

[判据原文命令] rg -c "from './logger-redact" packages/app/src/main/logger.ts  → 0   ← 字面 FAIL
[实质]        rg -c "from [\"']\./logger-redact" packages/app/src/main/logger.ts  → 1
              logger.ts:14  import { redactSecrets } from "./logger-redact.js";
```
**PARTIAL** —— 判据原文写的是单引号导入 `from './logger-redact`，本仓库全量使用双引号导入（pi-sdk、app main/preload/renderer 无一例外）。为通过一条引号风格断言而把单个 import 改成单引号，会在仓库里制造唯一一处风格例外。**未改写判据，如实记为字面失败**；import 关系本身已由等价的引号无关命令证实存在且唯一。其余 6 项全 PASS。

### c[12] logger 脱敏断言在 pnpm -w test 中通过

`packages/app/test/logger.spec.ts` 传入 `{apiKey:'sk-live-XYZ', prompt:'机密正文'}`，落盘内容 not contains `sk-live-XYZ`、not contains `机密正文`、contains `promptLength`（并断言 `apiKey === "[redacted]"`、`promptLength === 4`）。3 个用例全绿。
**PASS**

### c[13] envelope 断言在 pnpm -w test 中通过

`parseEnvelope({protocolVersion:2,...}).ok === false`（reason 为 `protocol-version-mismatch`）；缺 `sequence` 时 `ok === false`（reason 为 `malformed-envelope`，detail 含 `sequence`）。8 个用例全绿。
**PASS**

### c[14] store runtimeScope

```
$ grep -c 'runtimeScope' packages/app/src/renderer/src/stores/app.ts             → 5
$ grep -c 'Record<string, RuntimeScope>' packages/app/src/renderer/src/stores/app.ts → 1
```
另有 `packages/app/test/store-runtime-scope.spec.ts` 实跑证明 `store.started = true` 后 `store.runtimeScope[""].started === true` 且读回一致 —— 组件调用点 API 未变。
**PASS**

### c[15] toolRuns 未迁移

```
$ rg -c --no-filename 'toolRuns = reactive' packages/app/src/renderer/src/stores/app.ts | sum  → 1
```
**PASS**

### c[16] 三大命令

```
$ pnpm typecheck                        EXIT=0   (contract / pi-sdk / app 三包全 Done)
$ pnpm -w test                          EXIT=0   (5 files / 24 tests passed)
$ pnpm --filter @pibuddy/app build      EXIT=0   (main 161.41 kB, preload 1.49 kB, renderer 6 chunks)
```
**PASS**

### c[17] UI-observable 冒烟

```
$ timeout 45 pnpm --filter @pibuddy/app dev
build the electron main process successfully
build the electron preload files successfully
dev server running for the electron renderer process at http://localhost:5173/
start electron app...
{"ts":"2026-08-02T11:06:26.274Z","level":"info","event":"app_ready","version":"0.1.0","platform":"win32"}
(node:175596) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true ...   ← 既有，来自 pi-launcher 的 shell:true spawn
ERROR: Network service crashed or was terminated / GPU process exited exit_code=143                       ← timeout SIGTERM 拆卸期噪声
Exit status 143  ← timeout 送出的 SIGTERM
```
**PARTIAL** —— 已证实：三进程构建与启动均正常，contract 被正确打进 main bundle（无未解析 external），logger 单例生效并输出结构化 JSONL，无新增启动期报错。**未证实**：「输入 → 流式文本增量 → thinking 折叠 → tool 卡片展开 → 费用与 context 显示」的交互全流程 —— 该流程需要人工在 GUI 里操作并持有可用模型凭据，本次执行环境无法驱动。**建议在合并前由人工补跑一次。**

### c[18] 契约唯一性闸门（含自证）

```
$ node scripts/check-contract-uniqueness.mjs
contract exports 46
OK: 契约名字唯一、无第二套契约包、无跨层 preload/index.d 引用
EXIT=0

# 负向自证：往 packages/app/src/main/settings.ts 尾部注入与契约同名的
#            `export interface AppSettings { injected?: string }` 后重跑
$ node scripts/check-contract-uniqueness.mjs
contract exports 46
契约唯一性检查失败：
  - "AppSettings" 已由契约包定义于 packages/contract/src/settings.ts:21，不得在 packages/app/src/main/settings.ts:28 再次 export（改为 import type）
EXIT=1                     ← 输出含文件路径与行号，闸门确实会失败

# 还原后再跑
EXIT=0

$ grep -c 'node scripts/check-contract-uniqueness.mjs' .github/workflows/ci.yml  → 1
```
ci.yml 为 **modify**（在 TASK-001 交付的文件上追加一个 step，位于 `Check test discovery scope` 之后），未重建（CT-14）。
**PASS**

### c[19] 原子写唯一实现

```
$ grep -c 'export function writeJsonAtomic(filePath: string, value: unknown): void' .../fs-atomic.ts  → 1
fsyncSync=2  renameSync=2  .tmp=3
$ rg --no-filename -c 'export function writeJsonAtomic' packages/app/src/main | sum  → 1
```
`packages/app/test/fs-atomic.spec.ts` 用 `vi.spyOn(fs,"renameSync")` 在 rename 前注入异常，断言原文件**逐字节**未变（`Buffer.equals`）且 `.tmp` 已被清理。2 个用例全绿。
**PASS**

### 附加：既有闸门未被破坏

```
$ node scripts/check-test-discovery.mjs
discovered 5 / onDisk 5 / OK   EXIT=0
```

---

## Tests

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **EXIT=0** — contract / pi-sdk / app（tsc + vue-tsc）三包全 Done |
| `pnpm -w test` | **EXIT=0** — 5 files / 24 tests passed（contract 8、logger 3、fs-atomic 2、store 1、pi-sdk client 10） |
| `pnpm --filter @pibuddy/app build` | **EXIT=0** |
| `node scripts/check-contract-uniqueness.mjs` | **EXIT=0**（负向注入时 EXIT=1，已自证） |
| `node scripts/check-test-discovery.mjs` | **EXIT=0** |

---

## Deviations

1. **`AgentEvent` 兜底成员：选择「显式枚举全集 + 带判别式的 unknown」而非「纯枚举」。**
   `packages/pi-sdk/src/types.ts` 与 `client.ts` 严格说在本 task 的 `scope`（"packages/contract + packages/app 构建配置与 main/logger"）之外，此改动依据用户显式指令执行。
   **理由**：单纯去掉兜底会让 `client.ts:131/138` 的 `obj as AgentEvent` 变成谎言 —— 其中 131 行透出的是**无 id 的 `{type:"response"}`**，它根本不在事件全集里；而 pi 上游随时可能加新事件类型。改为 `{ type: "unknown"; raw: unknown }` 后：(a) 它有独立判别式，不污染其余成员的 `switch` 收窄；(b) 原始对象保留在 `raw` 里不丢信息；(c) 由 `toAgentEvent()` 在 SDK 边界一次性归一，上层无需再判断。同时补齐了 rpc.md 里缺的 3 个 `summarization_retry_*`。`stores/app.ts` 的 `handleEvent` 因此获得真实收窄能力（现有 `as Extract<...>` 断言从「必需」降级为「冗余」，本 task 不做清理以控制改动面）。

2. **`SttTranscribeRequest` 字段为 `{baseUrl, apiKey, model, audio, mimeType}`，不是判据描述的 `{endpointId, audio, mimeType}`。**
   `{endpointId,...}` 是 SEC-004（TASK-008）把凭据挪进主进程之后的形状。M0 现在就改会直接打断语音输入功能（属于「必须保护的现有功能」）。判据的机器断言只检查名字存在与内联字面量消失，两者均已满足。已在 `ipc-contract.ts` 注释与 `doc/threat-model.md` 的 G-5/SEC-004 条目里标注该缺口。

3. **`PiStartParams` 字段名保持 `workspace`（路径），未按判据文字改为 `workspaceId`。**
   `workspaceId` 在 `PiEnvelope` 里表示 M1 引入的**稳定工作区标识**，与「工作目录绝对路径」不是一回事。M0 就把路径叫 `workspaceId` 会让 TASK-007 落地 workspace capability 时语义打架。判据的机器断言（内联字面量 `workspace: string; session?: string` 从 preload/index.ts 消失）已满足。

4. **c[11] 的 `rg -c "from './logger-redact"` 字面失败。** 见上文 c[11]。未改写判据，未为通过单条断言而破坏仓库的双引号导入风格。

5. **c[17] UI 交互全流程未验证。** 见上文 c[17]。需人工补跑。

6. **新增 1 个计划外测试文件 `packages/app/test/store-runtime-scope.spec.ts`（1 个用例）。**
   用户指令要求测试精简。但 task 的 `risks[]` 明确点名「runtimeScope 归一化若破坏…会导致流式期间无任何报错」，而 `started`/`streaming` 从 `ref` 改为可写 `computed` 是本 task 风险最高的改动且无任何静态检查能覆盖。用 1 个 20 行用例把它钉住，判断为值得。未写任何穷举矩阵。

7. **`settings.ts` / `sessions-store.ts` 未改用 `writeJsonAtomic`。** 判据 c[19] 把 settings.json 的原子写明确指派给 TASK-008，本 task 只交付唯一实现与单测，不抢跑。

8. **`zod` 未加入 `packages/app` 的 dependencies。** 因此 `externalizeDepsPlugin` 不会把它 external 化，zod 被**打进** `out/main/index.js`（161.41 kB，已实测无 `import "zod"` 残留）。这是当前可用的状态，但属于隐式行为：若后续任务把 `zod` 加进 app 的 dependencies，它会立刻变成 external 并依赖 node_modules 打包 —— 见「Notes」。

---

## Notes（下游任务需知）

- **新增 workspace 包必改三处**：`electron.vite.config.ts` 的 `externalizeDepsPlugin exclude`、两个 tsconfig 的 `include`、`tsconfig.web.json` 的 `paths` + renderer `alias`。已写进 `doc/architecture.md` §1。
- **`zod` 的打包形态是隐式的**（偏差 8）。任何任务若给 `packages/app/package.json` 加 `zod` 直接依赖，必须同时确认 electron-builder 会打包 node_modules，否则运行时报无法解析的 external。
- **`TASK-007` 的 `ipc-guard.ts` 可直接 `implements PermissionEngine`**，并从 `CHANNEL_CONTRACTS` 取每个 channel 的 `request`/`response` schema，不要另写一份 channel 清单。
- **`TASK-005` 的代际治理**直接用 `createEnvelopeSequencer` 产序号、`createSequenceGate` 在渲染侧丢弃上一代迟到事件。`stores/app.ts` 的 `runtimeScope[sid].generation` / `.runtimeId` 已经在 `start()` 里递增，但**尚未与主进程的真实 runtime 对齐**（M0 只是渲染侧自增的占位），TASK-005 需把它换成主进程下发的值。
- **`TASK-006` 的 `SessionRepository`** 落地时，`sessionMetaSchema` 里的 `cwd` / `runtimeVersion` / `parseError` 三个 optional 字段就是给它填的；损坏 jsonl 应产出带 `parseError` 的降级条目而不是被 `catch {}` 静默丢弃（现状 `sessions-store.ts:41` 就是静默丢弃）。
- **`TASK-008` / `TASK-013` / `TASK-014`** 一律 import `main/fs-atomic.ts` 的 `writeJsonAtomic` 与 `main/logger-redact.ts` 的 `redactSecrets`，`check-contract-uniqueness.mjs` 不会拦这类重复（它只查 export 名字碰撞），但 c[11]/c[19] 的结构断言会。
- **`main/logger.ts` 不 import electron**，日志目录由调用方传入。`main/index.ts` 导出 `mainLogger()` 惰性单例，其它主进程模块从那里取，不要自己 `createLogger`。
- **`AgentEvent` 现在可判别式收窄**。`stores/app.ts` 中残留的 `as Extract<AgentEvent, {type:"..."}>` 断言已成冗余，后续触碰该文件的任务可顺手删掉。
