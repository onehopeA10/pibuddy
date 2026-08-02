# TASK-003: RUN-001 可靠内置 Pi runtime：ESM 解析 + 构建期自包含目录 + manifest 定位 + 环境变量白名单

## 依赖检查

`depends_on: ["TASK-002"]` → TASK-002 状态为 `completed_with_deviations`。按「带偏差完成」口径视为可继续，
其交付的 `@pibuddy/contract`（PROTOCOL_VERSION）、`logger.ts` 均被本任务直接复用。

## Changes

- `packages/app/src/main/pi-launcher.ts`：整文件重写。删除 `createRequire` 全部代码路径与第 24-26 行空 catch；
  dev 走 `fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))`；packaged 只读
  `process.resourcesPath/pi-runtime/runtime-manifest.json`；新增 `ENV_ALLOWLIST` + `buildChildEnv`、
  `resolvePiRuntime`、`resolveExternalCommand`；`shell` 恒为 `false`；解析失败抛
  `[PI_RUNTIME_RESOLVE_FAILED] …` 并记 error 日志。**已无任何全局 pi 回退分支。**
- `packages/app/src/main/pi-runtime-manifest.ts`（新增）：`RuntimeManifest` 类型、手写字段校验、
  `readRuntimeManifest` / `resolveRuntimeEntry`（越界与非普通文件均拒绝）、`assertRuntimeHandshake`、
  `PiRuntimeResolveError`。
- `packages/app/scripts/prepare-pi-runtime.mjs`（新增）：realpath 解开 pnpm symlink，BFS 收集 126 个生产依赖
  闭包，`fs.cpSync(dereference:true)` 产出扁平自包含目录 + `runtime-manifest.json`（含入口 sha256）；
  锁定版本 0.83.0，不符即失败；Windows 路径长度超限显式报错。
- `packages/app/scripts/after-pack.cjs`（新增，计划外）：补齐 electron-builder 丢失的 runtime `node_modules`。
- `packages/app/electron-builder.yml`：`asar: false` → `asar: true`；新增 `extraResources`（pi-runtime）、
  `afterPack`、`files` 增加 `"!resources/**"`。
- `packages/app/package.json`：新增 `prepare:runtime`；`dist` 前置 `node scripts/prepare-pi-runtime.mjs`；
  `@earendil-works/pi-coding-agent` 由 `dependencies` 移到 `devDependencies`（计划外，见偏差 3）。
- `pnpm-lock.yaml`：随上述依赖迁移更新。
- `packages/contract/src/settings.ts`：新增 `piRuntimeMode`（enum，默认 bundled）与 `piExternalCommand`；
  `parseAppSettings` 失败回落改为 `appSettingsSchema.parse({})`。
- `packages/app/src/main/settings.ts`：`loadSettings` 失败回落改为 `parseAppSettings({})`。
- `packages/app/src/main/ipc.ts`：`buildPiSpawn` 改为传入 `packaged/resourcesPath/settings/logger`；
  新增 `verifyRuntime()` 做启动握手并记 `runtimeSource/bundledVersion/protocolVersion`。
- `packages/app/src/renderer/src/stores/app.ts`：新增 `switchToBundledRuntime()`；`settings` 初值补默认。
- `packages/app/src/renderer/src/components/SettingsModal.vue`：新增「Pi 运行时」高级设置
  （内置/外部命令 + 路径输入）与 external 失败时的错误详情 + 「切回内置」按钮。
- `packages/app/src/renderer/src/components/AppShell.vue`：启动失败区在 external 模式下补「切回内置」按钮。
- `packages/app/test/pi-launcher.spec.ts`（新增）：8 个用例。
- `doc/regression/TASK-003-runtime.md`（新增）：人工/半自动回归记录。
- `.gitignore`：`resources/pi-runtime/` → `packages/app/resources/pi-runtime/`（原模式锚定仓库根，
  对 149MB 的实际产物目录**不生效**）。

## Verification（逐条实跑）

| # | 判据 | 结果 | 证据 |
|---|------|------|------|
| 0 | pi-launcher.ts 无 `createRequire` | PASS | `rg -c` 零命中 |
| 1 | 含 `import.meta.resolve("@earendil-works/pi-coding-agent")` 与 `fileURLToPath` | PASS | rg 命中 |
| 2 | 含 `process.resourcesPath` 与 `runtime-manifest.json` | PASS | rg 命中 |
| 3 | 含 `ENV_ALLOWLIST` 与 `ELECTRON_RUN_AS_NODE` | PASS | rg 命中 |
| 4 | 无 `shell: isWin\|shell: true` | PASS | 零命中 |
| 5 | 无空 catch；解析失败错误含原文与 `PI_RUNTIME_RESOLVE_FAILED`，logger 收到 `level==='error'` 且 `code===PI_RUNTIME_RESOLVE_FAILED` | PASS | 多行 rg 零命中 + spec「解析失败时抛出带错误码的错误，并记一条 error 日志」通过 |
| 6 | 注入类环境变量被剔除、`ELECTRON_RUN_AS_NODE==='1'` | PASS | spec「注入类变量被剔除…」通过 |
| 7 | manifest 缺失时错误含 `runtime-manifest.json` | PASS | spec 用临时目录断言 |
| 8 | `pnpm --filter @pibuddy/app exec node packages/app/scripts/prepare-pi-runtime.mjs` 退出码 0 | **FAIL（判据文本缺陷）** | 见偏差 1 |
| 9 | `resources/pi-runtime/dist/cli.js` 存在且非 symlink | PASS | `lstatSync(...).isSymbolicLink()` → `false` |
| 10 | manifest 含 version/entry/protocolVersion/sha256 | PASS | `0.83.0` / `dist/cli.js` / `1` / `af302f2314…` |
| 11 | `asar: true` 且无 `asar: false` | PASS | rg |
| 12 | 含 `extraResources:` 与 `pi-runtime` | PASS | rg |
| 13 | `dist` script 含 `prepare-pi-runtime` | PASS | `node scripts/prepare-pi-runtime.mjs && electron-vite build && electron-builder` |
| 14 | contract 含 piRuntimeMode/external/bundled；SettingsModal 含「切回内置」；launcher 无 `settings.set({ piRuntimeMode` | PASS | rg |
| 15 | `assertRuntimeHandshake` 版本不符抛错含双方值、相符不抛 | PASS | spec 2 个用例通过 |
| 16 | [UI-observable] dev + external 回退 | **部分 PASS** | `doc/regression/TASK-003-runtime.md`；GUI 人工点击项未执行，见偏差 4 |
| 17 | [UI-observable] packaged-smoke | **部分 PASS** | 同上；打包 + 启动 + 真实问答均实跑 |
| 18 | CT-11：`runtime-manifest.json` 出现 ≥1；无 `pi.cmd\|which pi\|command -v pi\|fallbackToGlobalPi` | PASS | 计数输出 `2`；零命中 |

### 关键实跑输出

```
$ pnpm typecheck            → packages/{contract,pi-sdk,app} typecheck: Done
$ pnpm -w test              → Test Files 7 passed (7) / Tests 45 passed (45)
$ pnpm build                → ✓ built in 1.52s / 28ms / 17.03s
$ node packages/app/scripts/prepare-pi-runtime.mjs
  [prepare-pi-runtime] 已复制 126 个依赖包
  [prepare-pi-runtime] 完成：…（@earendil-works/pi-coding-agent@0.83.0, sha256=af302f231437…）  EXIT=0
$ pnpm --filter @pibuddy/app dist   → EXIT=0
  • pi runtime deps copied  files=18486
  release/PiBuddy-Setup-0.1.0.exe（146.9MB）、release/win-unpacked/{PiBuddy.exe, resources/{app.asar, pi-runtime}}
$ find release/win-unpacked/resources/pi-runtime -type f | wc -l   → 19371（与源一致）
$ ELECTRON_RUN_AS_NODE=1 ./PiBuddy.exe resources/pi-runtime/dist/cli.js --version   → 0.83.0
```

打包产物真实问答（PATH 已剔除全局 pi 所在目录）：

```
[probe] PATH 条目 166 -> 162（已剔除全局 pi 所在目录）
[probe] get_state 成功=true model=gpt-5.6-sol
[probe] 助手回复："收到"
[probe] 一次完整问答耗时 11282ms
[probe] RESULT=PASS
```

打包 GUI 启动日志（`release/win-unpacked/PiBuddy.exe`）：

```
{"event":"app_ready","version":"0.1.0","platform":"win32"}
{"event":"pi_runtime_resolved","runtimeSource":"bundled","selectedRuntime":"bundled","bundledVersion":"0.83.0","protocolVersion":1,"command":"…\\PiBuddy.exe"}
{"event":"pi_runtime_handshake_ok","selectedRuntime":"bundled","bundledVersion":"0.83.0","protocolVersion":1}
```
并观察到 pi 子进程存活：`PiBuddy.exe …\resources\pi-runtime\dist\cli.js --mode rpc`。

开发形态（`pnpm --filter @pibuddy/app dev`）：
`{"event":"pi_runtime_resolved","runtimeSource":"bundled","command":"…\\electron\\dist\\electron.exe"}` —— 改前此路径必然
抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` 并被空 catch 吞掉后回退全局 pi。

## Tests

- `pnpm -w test`：7 files / 45 tests 全通过（含 TASK-004 的 window-policy.spec.ts）。
- `packages/app/test/pi-launcher.spec.ts` 8 用例：注入类变量剔除、白名单仅保留白名单键、
  厂商密钥按模式放行、解析失败错误码+日志、external ENOENT、manifest 缺失、握手不符/相符。

## Deviations

1. **c[8] 判据文本自身不可执行（FAIL，未改写判据）**。
   `pnpm --filter @pibuddy/app exec` 的 cwd 是 `packages/app`，故字面命令解析成
   `packages/app/packages/app/scripts/prepare-pi-runtime.mjs`：
   `Error: Cannot find module 'D:\selftool\pi-ui\packages\app\packages\app\scripts\prepare-pi-runtime.mjs'`，退出码 1。
   等价正确形式实跑通过（退出码 0）：`pnpm --filter @pibuddy/app exec node scripts/prepare-pi-runtime.mjs`，
   以及仓库根下 `node packages/app/scripts/prepare-pi-runtime.mjs`。脚本本身用 `import.meta.url` 定位，任意 cwd 可跑。
   建议后续修正判据文本，本任务不改写。

2. **`extraResources` 会静默丢弃 runtime 的 `node_modules`（计划外缺陷，已修）**。
   首次打包后 `resources/pi-runtime` 只剩 885 个文件（源 19371），启动 pi 立即
   `ERR_MODULE_NOT_FOUND: Cannot find package 'cross-spawn'`。显式写 `filter: ["**/*"]` 无效。
   修复：新增 `afterPack: scripts/after-pack.cjs` 手动复制并校验文件数一致（不一致即打包失败）。
   这正是任务 risks[1] 提示「必须实际启动验证」的那一类缺陷。

3. **`@earendil-works/pi-coding-agent` 移到 `devDependencies`（计划外）**。
   留在 `dependencies` 时 electron-builder 会把整个 pi 依赖树再打进 `app.asar` 一份（app.asar 155.9MB）；
   移动后降到 64.2MB。代码里对该包无任何静态 import（仅构建期脚本与 dev 期 `import.meta.resolve`），
   dev/打包链路实跑均通过。**副作用**：若 CI 用 `pnpm install --prod` 则 `prepare:runtime` 会失败，
   打包流水线必须装 devDependencies。

4. **c[16]/c[17] 的 GUI 人工项未执行**。无人值守执行，无法在界面里点选工作文件夹、打字提问、点击「切回内置」。
   已用等价自动化覆盖技术断言（打包产物真实问答、runtimeSource 日志、pi 子进程存活、external ENOENT 单测、
   「切回内置」按钮源码存在、主进程零 settings 写入）。逐项勾选与未执行原因见
   `doc/regression/TASK-003-runtime.md`。验收状态记 **packaged-smoke**，非 packaged-e2e。

5. **ENV_ALLOWLIST 增加了模式化条目（对 action 字面清单的扩充）**。
   只保留 action 给的 16 个固定键会打断一条既有能力：pi 支持用 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等
   三十余个厂商变量登录（pi `docs/providers.md`），设置界面也是这么写给用户的。
   故补 `ENV_ALLOWLIST_PATTERNS`：`^PI_[A-Z0-9_]+$`、`*_API_KEY`、`*_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、
   `AWS_BEARER_TOKEN_BEDROCK`、`HF_TOKEN`、`CLOUDFLARE_(ACCOUNT|GATEWAY)_ID`。
   这些模式匹配不到 NODE_OPTIONS / NODE_INSPECT_RESUME_ON_START / LD_PRELOAD / DYLD_INSERT_LIBRARIES /
   ELECTRON_RUN_AS_NODE，c[6] 断言不受影响且已通过。

6. **`pi-runtime-manifest.ts` 用手写校验而非 zod**（files[].change 原写「zod schema」）。
   zod 是 `@pibuddy/contract` 的依赖、不是 `@pibuddy/app` 的直接依赖，在 main 里直接 import 会
   `Cannot find package 'zod'`（vitest 实测）。给 app 加 zod 直接依赖会触发 W2 遗留隐患
   （externalizeDepsPlugin 会把 zod 变成 external，打包产物需要 node_modules 才能跑）。
   清单是自产的固定形状，改为几行字段检查，不引入依赖。`PROTOCOL_VERSION` 仍复用自 contract。

7. **`.gitignore` 的 `resources/pi-runtime/` 模式原本不生效**（含 `/` 的模式锚定仓库根），
   149MB 构建产物实际处于未忽略状态。已改为 `packages/app/resources/pi-runtime/` 并用 `git check-ignore` 验证。

8. **`package.json` 里一度用 `"//"` 键写注释导致 pnpm 解析失败**
   （`ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`），且第一次 `pnpm install --silent` 因此静默失败、
   lockfile 未随依赖迁移更新（`--frozen-lockfile` 会炸）。已移除该键并重跑 `pnpm install`，
   lockfile 现已把该包记在 `devDependencies` 下。

9. **未修改 `packages/app/src/main/index.ts`**（TASK-004 并行占用）。本任务无需改动它：
   `buildPiSpawn` 的唯一调用点在 `ipc.ts:103`。`ipc.ts` 自建了一个写同一目录的 logger 实例，
   因为 `registerIpc()` 无参且 main/index.ts 的 `mainLogger()` 未导出 —— 后续可由能改 index.ts 的任务
   改成注入式，属可选清理项，不影响功能（logger 用 appendFileSync 追加，同文件并写安全）。

10. **首次 `pnpm --filter @pibuddy/app dist` 因与 TASK-004 并行构建撞车而失败**
    （`ENOENT: out/preload/index.mjs` —— TASK-004 开 sandbox 后 electron-vite 把 preload 产物从 `.mjs`
    换成 `.cjs`，恰好在 electron-builder 收集文件时重写了 `out/`）。非本任务缺陷，重跑即通过。

## Notes（下游任务需要知道的）

- **TASK-012 修改 `buildPiSpawn` 追加 trust 参数时**：签名已变为
  `buildPiSpawn(ctx: PiLauncherContext = {}): PiSpawn & { runtime: ResolvedPiRuntime }`，
  返回值多了 `runtime` 字段。CT-11 断言（无全局 pi 回退）必须保持零命中。
- 子进程环境统一走 `buildChildEnv()`，新增需要透传的变量请加进 `ENV_ALLOWLIST` 或
  `ENV_ALLOWLIST_PATTERNS`，不要在调用点做 `{...process.env}` 展开。
- 升级 pi 版本时需同步改 `scripts/prepare-pi-runtime.mjs` 的 `EXPECTED_VERSION`，否则脚本主动失败。
- `packages/app/resources/pi-runtime/` 是构建产物（149MB），已 gitignore，不入库；
  任何打包前必须先跑 `prepare:runtime`（`dist` script 已内置）。
- `runtime-manifest.json` 的 `sha256` 目前只写入、未在启动时校验；完整性校验入口已备好，
  后续需要时在 `resolveRuntimeEntry` 之后加一次比对即可。
- 验收探针保留在 `.workflow/scratch/20260802-plan-P0-pibuddy-m0-m5/probe-task003-rpc.mjs`，
  可复用为打包产物的冒烟脚本。
