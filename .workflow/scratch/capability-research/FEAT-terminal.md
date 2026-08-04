# FEAT-terminal：终端能力包（coding.terminal / PTY-101，第一个原生模块能力包，ADR-0002 方案 B）

在 `FEAT-git.md` / `FEAT-git-v2.md`（第一个垂直编码能力包）与 `FIX-capability-core.md`
（能力包架构第一阶段）之上**扩展**：把第一个**带原生依赖**（node-pty）的能力包接进
同一条链路——垂直能力声明 `process.shell` → 经核心 PermissionEngine 授权 → 可随编码
Profile 装卸，且原生二进制在 `npmRebuild:false` + 白名单 + asarUnpack 下随包装卸、不锁 ABI、
不重编译。

依据：`ADR-0002` 方案 B（原生模块白名单 + asarUnpack）、`FEAT-git-v2.md`（process.git 接法，
本包照搬到 process.shell）、`FEAT-permission-engine.md`（第五道闸）、`envelope.ts`
（PiEnvelope 代际 + 序号丢弃规则，输出重连复用它）。

---

## 1. 交付：十条窄通道 + 一条推送 + 一份原生模块清单

| 组 | 通道 |
|---|---|
| 会话 | `terminal:list` / `terminal:open` / `terminal:input` / `terminal:resize` / `terminal:snapshot` |
| 生命周期 | `terminal:clear` / `terminal:kill` / `terminal:restart` / `terminal:rename` |
| shell | `terminal:profiles`（列可用 shell + 默认） |
| 推送 | `terminal:event`（`PiEnvelope<TerminalEventPayload>`，data / exit 两类） |

入参一律 **不透明 workspaceId + 不透明 tabId + 用户键入的字节**，没有任何 cwd / shell 命令行 /
argv 字段。cwd 由主进程 `requireWorkspaceRoot(workspaceId)` 解析成 canonical root，渲染进程
在结构上表达不出「用这个目录跑这条命令」。

### 权限接线：扩 `TERMINAL_GATED_CHANNELS` 即自动接上第五道闸（照搬 git v2）

`permission-store` 的 `CHANNEL_PERMISSION_REQUIREMENTS` 追加一段
`TERMINAL_GATED_CHANNELS.map(ch => ({capabilityId: coding.terminal, permission: process.shell}))`。
manifest 声明 `process.shell`（`DANGEROUS_PERMISSION_ATOMS` 里已有），引擎上界校验与第五道闸
拦截对十条通道**自动生效**——`main/permission/**` 的既有决策逻辑一行未动（只往需求表追加数据）。
连只读的 list/profiles/snapshot 也在册：终端会话本身是敏感信息，未授权不该被观测到。
这是继 `process.git` 之后**第二个真实的危险权限消费者**。

### 输出：有界 ring buffer + 分帧下发 + reload 重连（复用现有信封）

PTY 输出经 `PtyManager` 的 node-pty `onData` 收集，按帧（16ms）合并成 chunk（一次
`npm install` 不再灌几万条 IPC——这就是「背压」：合并 + 有界，不是无限缓冲），每块 `++seq`
写进**按字符封顶**的 `TerminalRingBuffer`（超容量从头驱逐），装进复用 pi 那套 `PiEnvelope`
的 `terminal:event`（sessionId=tabId、generation=tab 代际、sequence=chunk 序号）单向广播。
渲染进程 reload 后由 `terminal:snapshot` 取回 ring buffer 当前内容 + 最后序号重建屏幕，再从
推送流里只接受更大序号的块（`shouldAcceptEnvelope`，与 agent-pool/workflow 同一套丢弃规则）。

### 原生模块（方案 B 的验证点）

- `packages/app/package.json` 加 `"node-pty": "1.1.0"`（精确版本）+ `@xterm/xterm` 系（渲染侧，纯 JS）。
- `check-pure-js-deps` 的 `NATIVE_ALLOWLIST` 已含 node-pty（合进 main 的 base）；xterm 系纯 JS 照过。
- `electron-builder.yml` 的 `asarUnpack` **追加** node-pty 的 `**/*.node` / `**/*.dll` / `**/*.exe`
  （prebuilt 二进制不能从 asar 虚拟路径执行，必须外置）。**npmRebuild 保持 false、pi runtime 的
  extraResources/afterPack 一字未动。**
- postinstall `scripts/fix-pty-permissions.js`：把 node-pty `unixTerminal.js` 无条件的
  `helperPath.replace('app.asar','app.asar.unpacked')` 改成**带条件**替换（已含 unpacked 就不再替换，
  避免 `app.asar.unpacked.unpacked`），并给 mac/linux 的 spawn-helper 补可执行权限。恒 exit 0、幂等
  （Windows 首发走 ConPTY 不触此路径，但为 mac/linux 稳妥无条件跑）。实测 install 时打出「unixTerminal 已修复」。

---

## 2. 严格文件边界

**新增**（我的地盘）：
```
packages/contract/src/terminal.ts                          schema + 分片 + TERMINAL_GATED_CHANNELS 等
packages/app/src/main/terminal/ring-buffer.ts              有界 ring buffer（纯逻辑，可对拍）
packages/app/src/main/terminal/pty-manager.ts              PtyManager（node-pty 懒加载，不 import electron）
packages/app/src/main/terminal/terminal-ipc.ts             10 条 registerHandler + 广播 + 拆卸
packages/app/src/main/capability/manifests/terminal.manifest.ts   纯数据 manifest
packages/app/src/preload/api/terminal.ts                   window.piBuddy.terminal（第 25 命名空间）
packages/app/src/renderer/src/stores/terminal.ts           标签页元数据 + 授权流
packages/app/src/renderer/src/components/TerminalPanel.vue  xterm 渲染 + 多 tab + 搜索/复制粘贴/重连
packages/app/scripts/fix-pty-permissions.js                postinstall
packages/app/test/terminal-pty.spec.ts                     11 条（真 PTY + ring buffer 对拍 + 重连）
packages/app/test/terminal-permission.spec.ts              4 条（第五道闸互斥对 + 对拍）
```

**追加自己的行**（共享中央文件）：
```
packages/contract/src/channels.ts        + terminal:* 10 条 invoke + terminal:event 1 条 push
packages/contract/src/ipc-contract.ts    + terminalContractShard 进分片数组 + terminalEvent 进 PUSH_CONTRACTS
packages/contract/src/index.ts           + export terminal.js
packages/app/src/main/permission/permission-store.ts       + 需求表派生一段（照搬 git，不改决策逻辑）
packages/app/src/main/capability/capability-catalog.ts     + register terminalCapability
packages/app/src/main/capability/capability-manifests.ts   + BUILT_IN + coding Profile 加 coding.terminal
packages/app/src/preload/api/index.ts    + terminal 命名空间
packages/app/src/renderer/src/components/AppShell.vue      + 💻 终端 门控（isEnabled("coding.terminal")）
packages/app/test/preload-api.spec.ts    命名空间集合 24 → 25（加 terminal）
packages/app/electron-builder.yml        + asarUnpack 三行
packages/app/package.json                + node-pty / xterm 系 + postinstall
```

**未改**：`main/permission/**` 的既有决策逻辑、`ipc-guard.ts` / `ipc-contract` 合并封口逻辑、
`git|connector|workflow|memory|mcp|tasks|agent-pool|child-agent/**`、`check-pure-js-deps.mjs`
（白名单 base 已加）、pi runtime（pi-launcher / prepare-pi-runtime / after-pack）、npmRebuild（仍 false）。

---

## 3. 可证伪对拍（临时拆掉机制，确认变红，还原后全绿）

| 拆掉的机制 | 命令 | 结果 |
|---|---|---|
| ring buffer 的驱逐 `while`（注释掉） | `vitest run terminal-pty -t "有界的核心判据"` | **RED**：`expected 1000 to be less than or equal to 100`——喂 1000 字符全留下，size 涨到 1000；还原后绿（size ≤ 100） |
| 第五道闸（`setPermissionGate(null)`，写在 terminal-permission.spec 内） | `vitest run terminal-permission` | 同一次未授权 `terminal:list`：装闸=DENIED、摘闸=`{tabs:[]}` 放行——闸是真门槛，非走过场 |

两条对拍都不是打桩：ring buffer 对拍用纯逻辑喂真实数据核对 `size`；权限对拍用真 `registerHandler`
的完整五道闸，未授权 `terminal:open` 抛 `IPC_PERMISSION_DENIED`（PTY 根本没 spawn），授权后
真 spawn 出 shell（`meta.running` 为真），撤销后又被挡（互斥闭环）。

reconnect 判据也落在真实序号上：`snapshot` 拿到 text + 最后序号后，一个 `sequence <= snapshot.sequence`
的迟到块被 `shouldAcceptEnvelope` 丢弃、更大序号的新块被接受（正是渲染进程 reload 后不重复写屏的机制）。

---

## 4. 门禁（全绿）

```
pnpm typecheck            contract / pi-sdk / app 全 Done
pnpm -w test              Test Files 136 passed (136) / Tests 1239 passed (1239)
                          （基线 134/1224 → +2 文件 terminal-pty.spec / terminal-permission.spec、+15 测试，
                           无既有用例被改判；drift 17 条、capability-gate 8 条全绿——manifest 对账通过）
pnpm --filter @pibuddy/app build   renderer 3184 modules（基线 3134 → +xterm/TerminalPanel/store），
                                   node-pty 被 externalize（不进 bundle，运行期 require）✓
pnpm exec electron-builder --dir   win-unpacked 出包，node-pty 的 .node/.dll/.exe 全部 unpack 到
                                   app.asar.unpacked（含签名）✓

守卫外 ipcMain.(handle|on) 命中数求和              = 0
main/terminal 内 child_process 字面量              0（用 node-pty，不 import child_process）
preload invoke(channel:string) 无约束入口          0
check-pure-js-deps.mjs                            OK（扫描 94 个包；node-pty 白名单破例，其余纯 JS）
check-contract-uniqueness.mjs                     OK（814 契约名唯一）
check-test-discovery.mjs                          OK（136 spec 全在发现范围）
```

---

## 5. 真机取证（`release/win-unpacked/PiBuddy.exe` + CDP，隔离 `--user-data-dir`）

seed 一个临时 userData（`capability-prefs.json{profileId:coding}` + `settings.json{workspace}`），
`--user-data-dir` 指向它（绝不碰真实 profile），`--remote-debugging-port=9223` 逐条 CDP 穿过打包
产物的真实五道闸。单次干净运行清单：

```
window.piBuddy.terminal 存在                 ns:true          ← 第 25 命名空间进了打包产物
未授权 terminal:open → DENIED                deniedBeforeGrant:true  ← 打包后的第五道闸真的挡住（PTY 没 spawn）
grant process.shell (allow-session)
terminal:open → {running:true, shellId:"cmd"}                ← 授权后真 spawn 出 cmd.exe
input "echo hello-packaged-terminal\r"
terminal:snapshot → text 含 "hello-packaged-terminal"  gotHello:true  ← **打包后终端真能起来、真有输出**
terminal:profiles → 3（cmd / powershell / git-bash）
terminal:list → 1
```

**这是整个方案 B 的验证点**：node-pty 的预编译 `.node` 从 `app.asar.unpacked` 加载成功、
`pty.spawn("cmd.exe")` 在打包产物里吐出真实数据——`.node` 加载失败是「三门禁全绿但功能已死」
的经典坑，这里被真机抓住了它没死。

**进程清理（无孤儿）**：硬杀（模拟崩溃）`Stop-Process -Name PiBuddy -Force` 后
`{PiBuddy:0, electron:0}`；本次运行新增的 cmd.exe 在 kill 后 `orphanCmdAfterKill:[]`
——node-pty spawn 的 cmd.exe 随 ConPTY 一并清，不留孤儿终端进程。取证脚本写在 gitignored 的
`release/` 下、用后即删，不进提交。

---

## 6. 本轮发现、未修（留给后续）

1. **node-pty 的 `conpty_console_list_agent` 在 headless（vitest / CI）下打 `AttachConsole failed`
   到 stderr**：这是 node-pty 在 Windows 上枚举控制台进程列表（用于杀进程树）的内部机制，无桌面
   会话时会失败并把错误打到 stderr——**不影响测试结果**（错误在被 spawn 的子进程里，不上抛），
   真机桌面会话下 `AttachConsole` 成功、真机取证的进程清理已证实无孤儿。若要在 CI 里消除这条
   stderr 噪音，需给 PtyManager 的 kill 路径加一个「headless 时跳过 console-list 枚举」的旁路——
   本轮不做（它只是噪音，不是缺陷）。
2. **xterm 随主包内联（inline），未拆 lazy chunk**：与 coding.git 一致（AppShell 静态引入面板）。
   xterm 体量中等（renderer 3134→3184 modules），未启用编码 Profile 时仍进包。`manifest.runtime`
   保持 `inline` + `heavyDependencies:[]`（那字段指渲染侧重依赖如 monaco；node-pty 是主进程原生
   依赖，不进渲染 bundle）。日后若要按启用集合拆分，再评估 lazy + entry + 预算（已由 capability
   schema 的 D2 约束钉住形状）。
3. **杀进程树依赖 node-pty 的 `kill()`**：Windows 上 ConPTY 关闭级联终止 cmd.exe 及其子进程，
   真机取证已证实无孤儿；若日后遇到深层子进程不被清的边角，再考虑在 `disposeAll` 里补一次
   `taskkill /T /F`（那会 import child_process，需同步把 manifest 的 teardown 已声明的 child-process
   继续保留）——当前 node-pty 的 kill 已足够，不提前引入。
