# FIX-security：两条安全缺陷的修复

基线 HEAD `0370f01`。共两条：SEC-005（renderer 可指定任意可执行文件）与
SEC-006（packaged 主窗口放行任意 `file:` 导航）。

---

## 缺陷 1（P1，SEC-005）：renderer 被攻陷后可执行任意本地程序

### 缺陷成因

`piRuntimeMode` / `piExternalCommand` 在 `rendererSettingsPatchSchema` 的可写
字段里（`packages/contract/src/ipc-contract.ts`），`misc-ipc.ts` 的
`settings:set` 直接把 patch 交给 `saveSettings` 落盘，`pi-launcher.ts` 的
`resolveExternalCommand` 再把它变成 `spawn` 的 argv[0]。渲染进程一旦被 XSS
或恶意扩展内容影响，一次 `settings.set({piRuntimeMode:"external",
piExternalCommand:"C:\\Windows\\System32\\calc.exe"})` 就等价于让主进程启动
任意本机程序 —— 绕开了 TASK-007 把 `pi:command` 拆成 15 条窄通道所建立的
全部约束。

### 修复口径

**没有做「加一个确认框」这种最小改动**，而是把「路径」这件事整体从渲染
进程手里拿走，与本仓 `dialog:choose-folder`（工作目录只能经真实用户手势）
同一口径：

1. 两个字段整体从 `rendererSettingsPatchSchema` omit 掉。zod 的 `z.object`
   会丢弃形状外的键，而 ipc-guard 的 `schema.parse(raw)` 是交给 handler 之前
   的唯一入口 —— 因此「handler 忘了删字段」在结构上不再可能发生。
2. 新增 `settings:set-pi-runtime`，**入参恰好一个 mode 枚举，没有任何路径
   形参**。可执行文件由主进程弹 `dialog.showOpenDialog` 让用户当场挑，再经
   `dialog.showMessageBox`（`defaultId:0`/`cancelId:0` 都指向「取消」）展示
   **完整绝对路径**二次确认。
3. 落盘的是 `resolveExternalCommand()` 解析后的绝对路径（与 pi-launcher 共用
   同一份解析），不是用户点中的名字 —— 否则用户确认过的文件和日后真正被
   spawn 的文件可以因 PATH 变化而不是同一个。
4. 切回 bundled 是降权，不弹确认，并把 `piExternalCommand` 清空。

判定逻辑单独放在 `main/security/pi-runtime-approval.ts`，electron 对话框以
依赖注入接进来 —— 否则「取消了到底有没有落盘」只能靠真机点击验证。

### 涉及文件

- `packages/contract/src/ipc-contract.ts`（omit 两字段 + 两个新 schema + 契约表）
- `packages/contract/src/channels.ts`（`settingsSetPiRuntime`）
- `packages/contract/src/settings.ts`（字段语义注释：可读 ≠ 可写）
- `packages/app/src/main/security/pi-runtime-approval.ts`（新增）
- `packages/app/src/main/misc-ipc.ts`（注册 handler，接真 electron 对话框）
- `packages/app/src/main/pi-launcher.ts`（导出 `resolveExternalCommand`）
- `packages/app/src/preload/api/settings.ts`（`setPiRuntime(mode)`，签名无路径形参）
- `SettingsModal.vue` / `OnboardingWizard.vue` / `stores/app.ts`

---

## 缺陷 2（P2，SEC-006）：packaged 主窗口放行任意 file: 导航

### 缺陷成因

`window-policy.ts:87` 是 `if (url.protocol === "file:") return true;` ——
任何本地 HTML 被导航到主窗口都被判成「应用 URL」，从而绕过 `will-navigate`
拦截并继承同一个 preload（完整的 `window.piBuddy`）。攻击面：模型或工具往
工作区写一个 `.html`，诱导打开即可。

### 修复口径

`isAppUrl` 的 file: 分支改为只放行 `app.getAppPath()` 下的**那一个** renderer
入口（`out/renderer/index.html`）：

- 收容判定用 `path.relative(dirname(entry), target) === basename(entry)`，
  **不是** `startsWith`（与 workspace-registry.ts / preview-window.ts 同口径）。
- 只放行入口那一个文件，不放行整个 `out/renderer/` 目录。
- 带 host 的 UNC（`file://server/share/...`）直接拒。
- query / hash 忽略（`index.html#/chat` 指向同一文件）。
- `app.getAppPath()` 取不到时 file: 一律不放行。
- dev 的 `ELECTRON_RENDERER_URL` 分支原样保留（HMR 整页刷新不能被拦）。

打包形态的路径对齐已核实：`electron-builder.yml` 的 `files: out/**` 保留
`out/` 前缀，asar 头解析确认 `app.asar/out/renderer/index.html` 存在
（size=1361），与 `main/index.ts` 的 `loadFile(join(dirname, "../renderer/index.html"))`
是同一个文件。

### 涉及文件

- `packages/app/src/main/security/window-policy.ts`

---

## 测试与对拍验证

新增 `packages/app/test/pi-runtime-approval.spec.ts`（6 条），
`packages/app/test/window-policy.spec.ts` 增加 `isAppUrl 的 file: 收容`
（8 条），`packages/contract/test/ipc-contract.spec.ts` 的派生字段黑名单
补两项。只写关键路径断言，没写穷举矩阵。

### 对拍：把修复拆掉，确认测试真的变红

#### 对拍 1a —— 把两个字段放回 renderer 可写 schema

```bash
perl -0pi -e 's/  piRuntimeMode: true,\r?\n  piExternalCommand: true,\r?\n//' \
  packages/contract/src/ipc-contract.ts
npx vitest run --project unit packages/app/test/pi-runtime-approval.spec.ts \
  packages/contract/test/ipc-contract.spec.ts
```

变红（2 failed | 8 passed）：

```
× CT-09 设置里不再有任何密钥字段 > 渲染进程不能写主进程单向下发的派生字段
  → expected [ 'sessionDir', 'provider', …(11) ] to not include 'piRuntimeMode'
× [SEC-005 契约层] … > settings:set 的入参 schema 直接丢弃 piRuntimeMode / piExternalCommand
  → expected [ 'sessionDir', 'provider', …(11) ] to not include 'piRuntimeMode'
 Test Files  2 failed (2)
      Tests  2 failed | 8 passed (10)
```

#### 对拍 1b —— 把落盘挪到确认框之前（「先写下去，失败再改回来」）

```bash
# 在 confirm() 之前插一行 deps.persist({piRuntimeMode:"external",...})
npx vitest run --project unit packages/app/test/pi-runtime-approval.spec.ts
```

变红（2 failed | 4 passed）：

```
× 用户选了文件但在确认框点取消：persist 一次都不被调用
  → expected "spy" to not be called at all, but actually been called 1 times
× 确认框上展示的、以及落盘的，都是解析后真正会被 spawn 的那个文件
  → expected [ { …(2) }, { …(2) } ] to deeply equal [ { piRuntimeMode: 'external', …(1) } ]
 Test Files  1 failed (1)
      Tests  2 failed | 4 passed (6)
```

#### 对拍 2 —— 恢复缺陷本身（`file:` 一律放行）

```bash
# isAppUrl 的 file: 分支改回 return true
npx vitest run --project unit packages/app/test/window-policy.spec.ts
```

变红（7 failed | 13 passed）：

```
× isAppUrl 的 file: 收容 > 拒绝 工作区中的任意 html            → expected true to be false
× isAppUrl 的 file: 收容 > 拒绝 与应用根同前缀的兄弟目录        → expected true to be false
× isAppUrl 的 file: 收容 > 拒绝 入口同目录下的其它 html         → expected true to be false
× isAppUrl 的 file: 收容 > 拒绝 带 .. 穿越到应用根之外          → expected true to be false
× isAppUrl 的 file: 收容 > 拒绝 系统程序                        → expected true to be false
× isAppUrl 的 file: 收容 > appPath 取不到时 file: 一律不放行     → expected true to be false
× applyWindowPolicy > 注册 CSP 响应头、导航拦截、开窗拒绝与权限处理器
  → expected "spy" to be called 1 times, but got 0 times
 Test Files  1 failed (1)
      Tests  7 failed | 13 passed (20)
```

#### 对拍 3 —— 把收容判定换成字符串 `startsWith` + 目录放行

第一轮只红了 1 条（"入口同目录下的其它 html"），说明"与应用根同前缀的
兄弟目录"那条**没能覆盖前缀陷阱** —— `<root>-evil/out/renderer/index.html`
不以 `<root>/out/renderer` 开头，恒真。据此补了一条 `<root>/out/renderer-evil/index.html`，
再跑对拍变成 2 条红：

```
× isAppUrl 的 file: 收容 > 拒绝 与 renderer 目录同前缀的兄弟目录 → expected true to be false
× isAppUrl 的 file: 收容 > 拒绝 入口同目录下的其它 html          → expected true to be false
 Test Files  1 failed (1)
      Tests  2 failed | 19 passed (21)
```

（这一条是这次对拍的实际收获：不做对拍的话，仓库里会多一条恒真断言。）

#### 还原后

```
 Test Files  3 passed (3)
      Tests  31 passed (31)
```

---

## 真机验证

`pnpm --filter @pibuddy/app dist` 之后跑
`packages/app/release/win-unpacked/PiBuddy.exe`。

先确认产物里确实是修复后的代码：

```
"settings:set-pi-runtime" 出现: true
"确认使用外部 Pi 运行时" 出现: true
out/main/index.js 内含 rendererEntryPath() / isRendererEntryFile()（app.getAppPath() + path.resolve）
app.asar/out/renderer/index.html 存在: true size=1361
```

### 启动

```
ProcessId Start             Cmd
    61516 2026/8/3 11:51:47 "…\PiBuddy.exe"
   117384 2026/8/3 11:51:48 "…\PiBuddy.exe" --type=gpu-process …
   210892 2026/8/3 11:51:48 "…\PiBuddy.exe" --type=utility …network.mojom.NetworkService…
   163844 2026/8/3 11:51:49 "…\PiBuddy.exe" --type=renderer …
    56640 2026/8/3 11:51:49 …\PiBuddy.exe …\resources\pi-runtime\dist\cli.js
```

最后一行是关键：**pi 子进程起来了**，说明渲染进程已渲染、preload 挂上了、
`pi:start` 走通了 IPC。主进程日志：

```json
{"event":"window_ready","wcId":1}
{"event":"startup_health","ran":false,"ok":null,"failed":[],"safeMode":false}
{"event":"pi_runtime_resolved","runtimeSource":"bundled","bundledVersion":"0.83.0","protocolVersion":1}
```

（`update_error / net::ERR_CONNECTION_CLOSED` 是占位更新源，与本次无关。）

### 对着真二进制跑攻击（CDP `--remote-debugging-port=9333` 注入渲染进程）

```
UI 已渲染(body 文本长度): 1514
preload 命名空间: "artifacts,diagnostics,dialog,file,pi,piResources,preview,providers,
                   sessions,settings,shell,stt,update,workspace"
settings.setPiRuntime 类型: "function"

攻击 settings.set({piRuntimeMode:"external",
                   piExternalCommand:"C:\\Windows\\System32\\calc.exe"})
→ {"mode":"bundled","cmd":"D:/definitely-missing/pi-not-here.exe"}

导航 location.href="file:///D:/selftool/pi-ui/.verify/ws/evil.html"
→ location 仍是 "file:///D:/…/resources/app.asar/out/renderer/index.html"
导航后 typeof window.piBuddy: "object"（文档没被换掉）
```

两条攻击都没生效：注入的运行时字段被 schema 整体丢弃（返回值里 mode 仍是
bundled、cmd 仍是磁盘上的旧值），本地 html 导航被拦下。磁盘上的
`settings.json` 攻击后逐字节未变。主进程日志同步记下：

```json
{"event":"navigation_blocked","scheme":"file:"}
{"event":"external_link_blocked","reason":"scheme","scheme":"file:"}
```

（第二行是 will-navigate 拦下后转交外链通道，file: 不在外链白名单里被再拒
一次 —— 两道闸都生效。）

### 保护面回归（同一个活着的进程上）

```
settings.set 写 sttModel: "whisper-1"          ← STT 配置仍可写
settings.setPiRuntime('bundled'): {"applied":true,"mode":"bundled","cmd":""}
                                                ← 新通道端到端可用；降权不弹框，
                                                  并清掉了那条陈旧的 external 命令
providers.list 可用: true                       ← Provider 配置面完好
```

主进程日志：`{"event":"pi_runtime_choice","mode":"bundled","applied":true}`。
探针脚本与 evil.html 已删除，`sttModel` 已复原为 `""`。

收尾：`Stop-Process -Force` 后 `PiBuddy 残留进程数: 0`。

---

## 三大门禁

```
rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main \
   -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'   → 0

pnpm typecheck   → 3/3 Done
pnpm -w test     → Test Files 90 passed (90) / Tests 780 passed (780)
pnpm build       → ✓ built in 13.18s / 179ms / 12.74s
pnpm --filter @pibuddy/app dist → PiBuddy-Setup-0.1.0.exe + win-unpacked
```

## 偏差与说明

1. **超出了「SettingsModal.vue」的字面范围**：`OnboardingWizard.vue`
   与 `stores/app.ts` 同样在写 `piRuntimeMode`，不改它们编译就过不去。
   两处都不在其他三个 agent 的地盘内，改动限于把写法换到新通道。
2. **UI 交互形态有变**：外部命令的文本输入框换成了「外部命令…」触发的原生
   文件选择框 + 只读的当前路径展示 + 「重新选择…」。原来支持填 PATH 里的
   命令名（如 `pi`），现在必须定位到文件本身。这是刻意的：只要界面上还有
   一个能填路径的输入框，渲染进程就重新拥有了表达任意程序执行的能力。
3. **运行时切换不再跟随「保存」按钮**，改为选中即生效 —— 它要弹主进程的两个
   对话框，混进批量保存里的话「用户在对话框上确认的到底是什么」说不清。
4. `packages/contract/src/settings.ts` 只改了注释：两个字段仍在
   `APP_SETTINGS_PUBLIC_KEYS` 里（设置页要显示当前用的是哪个运行时），
   可读与可写是两件事。
5. 共享文件（`channels.ts` / `ipc-contract.ts` / `preload/api/*`）只增不改
   他人条目：`settingsSetPiRuntime` 与另一 agent 的 `workspaceRelease` 并存
   无冲突。

   **第一次提交（b90c42d）在这里出了错，已由 bfce710 修正**：为了让
   `ipc-contract.ts` 编得过，`git add` 连带把另一 agent 尚未提交的
   `workspaceRelease` 契约定义一起带上了。但注册它的 `workspace-ipc.ts`
   还没进来，于是**单看那一个提交**，`test/pi-resources-ipc.spec.ts:68` 与
   `test/sessions-ipc.spec.ts:80` 的「CHANNELS 里的每一条都必须在 ipc-guard
   注册表里」会红 —— 编得过、跑不过。bfce710 把三处契约定义退回基线
   （工作区文件保持原样，由那位 agent 连同注册一并提交），提交树里已无任何
   `workspaceRelease` 引用。

   教训：并行改共享文件时，`git add <file>` 是整文件粒度的，「只增不改他人
   条目」这条纪律在暂存那一步会自动失效，必须显式核对提交树的自洽性
   （`git show HEAD:<file>` + 反向断言），不能只看工作区跑绿。
