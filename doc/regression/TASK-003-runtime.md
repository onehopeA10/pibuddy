# TASK-003 内置 Pi 运行时 —— 人工/半自动回归记录

验收环境：本机 Windows 11 Pro for Workstations 10.0.26200，无 clean VM。
打包侧验收状态一律记为 **packaged-smoke**（本机 `release/win-unpacked` 冒烟），不是 packaged-e2e。

约定：`- [x]` 表示实跑并观察到结果；`- [ ]` 表示未执行（后附原因）。
命令与真实输出见 `.workflow/scratch/20260802-plan-P0-pibuddy-m0-m5/outputs/summaries/TASK-003.md`。

## c[16] 开发形态与 external 回退

- [x] (a-1) 2026-08-02T12:02:47Z 开发形态 `pnpm --filter @pibuddy/app dev` 成功用 ESM
      `import.meta.resolve` 定位到自带 pi，日志出现
      `{"event":"pi_runtime_resolved","runtimeSource":"bundled","command":"…\\electron\\dist\\electron.exe"}`。
      改前该路径（`createRequire().resolve`）必然抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` 并被空 catch 吞掉。
- [x] (a-2) 2026-08-02T12:01:39Z 打包形态启动 `release/win-unpacked/PiBuddy.exe`，日志出现
      `{"event":"pi_runtime_resolved","runtimeSource":"bundled","bundledVersion":"0.83.0","protocolVersion":1}`
      与 `{"event":"pi_runtime_handshake_ok",…}`；`Get-CimInstance Win32_Process` 观察到 pi 子进程
      `PiBuddy.exe …\resources\pi-runtime\dist\cli.js --mode rpc` 真实存活。
- [x] (a-3) 2026-08-02T12:00Z 用打包产物里的 `PiBuddy.exe` + `resources/pi-runtime/dist/cli.js`
      跑完整一次问答（`get_state` → `prompt` → 助手回复「收到」，11.3s），
      spawn 时 PATH 已剔除全局 pi 所在目录（166 → 162 条），证明不依赖系统上已装的 pi。
      探针：`.workflow/scratch/20260802-plan-P0-pibuddy-m0-m5/probe-task003-rpc.mjs`。
- [ ] (a-4) 「把全局 pi 命令重命名（rename pi.cmd）后在 GUI 里人工输入问题完成问答」——**未执行**。
      需要人坐在机器前点选工作文件夹并打字，本次为无人值守执行。已用 (a-1)(a-2)(a-3) 覆盖其技术断言：
      运行时来源为 bundled、真实问答成功、不依赖 PATH 上的 pi。
      另：代码里已不存在任何全局 pi 回退分支（c[17] 断言 `pi.cmd|which pi|command -v pi|fallbackToGlobalPi`
      在 pi-launcher.ts 中零命中），即使全局 pi 存在也不会被用到。
- [x] (b-1) external 指向不存在的命令时抛出的错误同时包含 `ENOENT` 与该命令名 ——
      由 `packages/app/test/pi-launcher.spec.ts` 的
      「external 模式指向不存在的命令时报 ENOENT 并带上命令名」用例断言，`pnpm -w test` 通过。
- [ ] (b-2) 「界面上肉眼看到该错误文案」——**未执行**（同 a-4，需人工操作）。
      源码侧可判定：`AppShell.vue` 启动失败区渲染 `store.startError`，
      `SettingsModal.vue` 在 external 模式下用 `n-alert` 展示同一文案。
- [x] (b-3) 两处界面均存在文案为「切回内置」的按钮：
      `SettingsModal.vue`（n-alert 内，`@click="backToBundled"`）与
      `AppShell.vue` 启动失败区（`v-if="store.settings.piRuntimeMode === 'external'"`）。
- [ ] (c) 「点击『切回内置』后完成一次问答」——**未执行**（需人工点击）。
      代码路径可判定：`store.switchToBundledRuntime()` 先
      `settings.set({ piRuntimeMode: "bundled" })` 再 `start()`。
- [x] (d) external 启动失败不会自动改写设置：主进程侧零写入 ——
      `rg -c 'settings.set\(\{ piRuntimeMode' packages/app/src/main/pi-launcher.ts` 零命中，
      `pi-launcher.ts` / `ipc.ts` 在解析失败路径上只抛错与记日志，不调用 `saveSettings`。
      唯一写回 `piRuntimeMode: "bundled"` 的地方是渲染层用户点击「切回内置」。

## c[17] packaged-smoke

- [x] 2026-08-02T11:59Z `pnpm --filter @pibuddy/app dist` 退出码 0，
      产出 `release/win-unpacked/PiBuddy.exe` 与 `release/PiBuddy-Setup-0.1.0.exe`（146.9MB）。
- [x] `release/win-unpacked/resources/` 下同时存在 `app.asar`（asar 保护已恢复）与 `pi-runtime/`。
- [x] `resources/pi-runtime` 文件数 19371，与源目录 `packages/app/resources/pi-runtime` 完全一致。
- [x] `ELECTRON_RUN_AS_NODE=1 ./PiBuddy.exe resources/pi-runtime/dist/cli.js --version` 输出 `0.83.0`。
- [x] 启动 exe 后 pi 子进程真实存活并完成 RPC 握手（见 a-2）。
- [ ] 「在 GUI 里选择工作文件夹并人工完成一次问答」——**未执行**（需人工操作），
      技术等价覆盖见 a-2 / a-3。

## 本轮发现并修复的打包缺陷（记录，避免回归）

1. `extraResources` 会跳过被复制目录中名为 `node_modules` 的子目录，显式写
   `filter: ["**/*"]` 也无效。首次打包后 `resources/pi-runtime` 只剩 885 个文件（源 19371），
   启动 pi 直接 `ERR_MODULE_NOT_FOUND: Cannot find package 'cross-spawn'`。
   修复：`afterPack: scripts/after-pack.cjs` 手动补齐依赖并校验文件数一致。
2. `@earendil-works/pi-coding-agent` 留在 `dependencies` 会被 electron-builder 原样再打进
   `app.asar` 一份（app.asar 155.9MB）。移到 `devDependencies` 后 app.asar 降到 64.2MB。
   运行时不受影响：代码里没有对该包的静态 import，只有构建期脚本与开发期的 `import.meta.resolve`。
