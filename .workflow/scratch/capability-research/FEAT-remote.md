# FEAT-remote：Remote / PWA 远程访问能力包 v1（REM-101）

能力 id：`connector.remote`（tier=connector）。四层边界里**唯一开对外网络监听**的能力。
默认对外零暴露：服务默认不监听；开启后默认只绑 loopback（127.0.0.1），LAN 需用户主动开启。

## 1. 安全姿态落地（逐条对应审计红线）

| 审计红线 | 落地 | 证据 |
|---|---|---|
| 默认只监听 loopback，LAN 主动开启 | `RemoteServer.start(bindScope)`：loopback→`127.0.0.1`，lan→`0.0.0.0`。默认 `enabled=false`（连 loopback 都不开）。UI 显示实际地址 + LAN 警示 + 一键关 | `remote-netstat.spec` 真进程 netstat：loopback 本地地址列**只有 127.0.0.1、绝无 0.0.0.0**；lan 才出现 0.0.0.0 |
| 配对：QR 短时单次 challenge；长期 token 只存 hash | challenge = 随机 secret，只存 `sha256(pepper:secret)`；consume 走 `UPDATE...WHERE used=0` 原子置位（单次）+ TTL 3min。token = 32B 随机，**只存 hash**，原文仅配对时经网络发给设备一次 | `remote-security.spec`「同一 challenge 第二次消费被拒」「过期被拒」；`device-registry` 全程无明文 token |
| 设备可逐台撤销 / 轮换；有 id/name/created/last-used/scopes | `remote_devices` 表；`remote:revoke-device` 删 hash + 断连接；`remote:rotate-device` 生成轮换配对（旧 token 失效） | `remote-security.spec`「撤销后 token 立即 401」 |
| v1 能力范围（看会话/实时消息/发 prompt/停止/后台状态/通知/permission inbox） | `REMOTE_SAFE_SCOPES` 七项；HTTP `/api/pool`、`/api/sessions/:id/history`、`/api/prompt`、`/api/stop`、`/api/permission`、WS 快照推送、`/events` SSE | 见 `remote-server.ts` 路由表 |
| 危险 scope 默认关（terminal/workspace.write/permission.approve/admin） | `REMOTE_DANGEROUS_SCOPES`；配对只发 safe scope；危险 scope 须 owner 经 `remote:set-device-scope` 显式授予 | `remote-security.spec`「permission.approve 默认 403，owner 授予后放行」 |
| 统一鉴权：HTTP/WS/SSE/file/upload **每个入口**过同一套 auth + origin/CSRF + 限速 + 尺寸 + 审计 | `remote-auth.authorize()` 五道闸（尺寸→限速→origin→token→scope），**唯二调用点**：HTTP 表驱动分发 + WS 升级。免 token 的只有静态壳 + `/pair`，但仍过 origin/限速/尺寸/审计 | `remote-security.spec` 未配对访问 HTTP/WS/file/upload/SSE **每个**都被拒 |
| 离线缓存不含 secret | PWA `sw.js` 只 cache-first 应用壳（html/js/css/manifest），`/api`、`/pair`、`/upload`、`/files`、`/events` 一律 network-only；token 存 localStorage，绝不进 Cache API | `pwa-content.ts` sw.js |

CSRF 结构性防御：鉴权走 **Authorization: Bearer / WS 副协议**，不用 cookie → 无环境凭据可被 CSRF 利用；origin 白名单是第二重防御（`remote-security.spec` 跨站 origin 403）。

## 2. 交付清单

**契约**（`packages/contract/src/`）：
- `remote.ts`：scope 模型、bindScope、DeviceView/PairingInfo/RemoteState、八条管理通道分片 `remoteContractShard`
- `channels.ts`（追加 8 行）、`ipc-contract.ts`（分片入表）、`index.ts`（导出）

**主进程**（`packages/app/src/main/remote/`）：
- `device-registry.ts`：sqlite（`node:sqlite`，零原生依赖）——设备（token hash）/ challenge（hash）/ config / audit；hashSecret/newSecret
- `remote-auth.ts`：纯逻辑统一鉴权 `authorize()` + `RemoteRateLimiter` + token 解析（DI，可脱 electron 单测）
- `remote-pairing.ts`：challenge 生成 / 消费（单次 + TTL），铸 token 只发一次、只存 hash
- `remote-ws.ts`：纯 JS RFC6455（握手 + 帧编解码 + 连接 hub），零新依赖
- `remote-server.ts`：http + ws 服务，生命周期，唯二 `authorize()` 调用点，SSE / file / upload / 静态壳 / 配对
- `remote-backend.ts`：与内核设施的唯一桥（复用会话中心 / agent-pool / 权限引擎，**不 import pi 域**）
- `remote-manager.ts`：八条管理动作门面 + 启动恢复 + dispose
- `remote-ipc.ts`：`registerRemoteIpc`（八条通道）+ `disposeRemoteResources`（manifest exposure）
- `pwa-assets/`（子目录，不参与 drift 权限对账）：`asset-server.ts` + `pwa-content.ts`（内嵌 PWA 应用壳，零 fs 读）
- `capability/manifests/remote.manifest.ts`；catalog + capability-manifests（追加）；`index.ts`（追加恢复 / dispose 挂钩）

**preload / 渲染**：`preload/api/remote.ts`（+聚合追加）；`stores/remote.ts`；`components/RemotePanel.vue`（开关 / 监听范围 / 配对 QR/码 / 设备撤销·轮换·危险 scope 授予 / 审计）；`AppShell.vue`（追加门控 + 面板挂载）

**PWA 客户端**（内嵌）：应用壳 + 配对页 + service worker（离线壳，不缓存 secret）+ manifest。会话列表、实时消息（WS 快照推 + 轮询回退）、发送 / 停止、permission inbox（读 / 批准按 scope）、通知（Notification API）。

## 3. 架构关键决策

- **零新依赖**：http/ws/crypto/sqlite 全用 node 内置；WS 手写 RFC6455（免引 `ws` 的可选原生 bufferutil）。`check-pure-js-deps` 恒绿。
- **不 import pi 域**：`kernel-boundary.spec` 的 pi-import 允许表「只减不增」。远程「发 prompt / 停止」经 **agent-pool**（`poolRuntimeHost().deliver` / `agentPool().stopSession`）投递——与 child-agent / workflow 驱动 runtime 同一 sanctioned 入口，因此 remote 一条 `pi/` import 都没有。**诚实标注的 v1 限制**：deliver 只对池托管会话生效，前台 supervisor 独占的那个会话不在其列（接它须动 pi-ipc，越出任务边界）。
- **manifest permissions 为空**：顶层实现只用内置模块起服务 + 复用内核设施，无任何 drift 权限标记（readFile/writeFile/spawn/safeFetch/runGit/shell.open/secret）。真正风险面是网络 listener，由 `runtime.teardown:["listener"]` + `exposure.dispose` 强制可拆卸表达。静态壳内嵌为字符串（零 fs），且置于 `pwa-assets/` 子目录（drift 只扫顶层、不递归）。

## 4. 可证伪测试 + 对拍（M9 出口门禁）

`remote-security.spec.ts`（19）：真起 loopback 服务、真 HTTP/WS 请求打它。
`remote-unit.spec.ts`（15）：WS 帧编解码（含 RFC 样例 accept-key）、authorize 五闸、限流。
`remote-netstat.spec.ts`（3，win32）：真进程 netstat 监听范围 + 端口释放。

**对拍（临时拆机制 → 变红 → 复原）**：
1. 拆统一 token 闸（fail-open）→ 未配对访问 HTTP/WS/file/upload/SSE **五个入口全部变红**（`5 failed`）→ 复原全绿。证明测试真的在每个入口上验鉴权，不是「断言函数被调用」。
2. 拆单次消费（`used=0` 不置位）→「同一 challenge 第二次消费被拒」变红 → 复原。
3. 拆 scope 闸（`if(false&&...)`）→「permission.approve 默认 403 / 授予后放行」两条变红（`200 to be 403`）→ 复原。

## 5. 真机 / 真进程验证

- `pnpm install`（worktree 缺 node_modules）→ OK；`check-pure-js-deps` OK（无原生扩展）。
- `pnpm typecheck`（含 vue-tsc）全绿；`electron-vite build`（main+preload+renderer 生产 bundle）全绿——内嵌 PWA + http/ws server 正常打包。
- `pnpm -w test` 全绿：**139 文件 / 1276 测试通过，0 失败**（新增 3 个 remote spec 文件：security 19 + unit 15 + netstat 3；改 preload-api 期望列表加 `remote`、无回归）。
- **真进程 netstat**（vitest 的 node 进程 = 真实 OS 进程 + 真实绑定 socket）：loopback 只绑 127.0.0.1、LAN 绑 0.0.0.0、stop() 后端口从 netstat 消失（监听真释放）。
- **真 socket HTTP/WS**（vitest `http.request` + 真实 upgrade 握手）：未配对每入口 401、WS 升级 101/401、配对→token→200、单次失效、危险 scope 403、撤销后 401、跨站 origin 403。

### 真机：`pnpm dist` + 打包 `PiBuddy.exe` + 真 curl（全部实跑）
`pnpm dist` 成功产出 `release/win-unpacked/PiBuddy.exe`（NSIS 安装包亦生成）。

1. **默认零暴露**：全新启动 PiBuddy.exe（userData `Roaming/@pibuddy/app` 无 remote.db）→ `netstat` 8787 **无任何 LISTENING**（此前误报的 8787 是我 vitest 的残留 node，杀掉后仍 0）。默认对外零暴露在真 exe 上成立。
2. **enabled 自动恢复**：向真 userData seed 一份 remote.db（enabled=1 + 一台预配设备 + 一条未消费 challenge）→ 重启 PiBuddy.exe → `restoreRemoteServerIfEnabled` 自动拉起服务，`netstat` = `127.0.0.1:8787 LISTENING`（本地地址列只有 127.0.0.1，进程确为 PiBuddy）。
3. **真 curl 矩阵**（对真 exe 的 127.0.0.1:8787）：
   - `GET /api/pool` 无 token → **401**；带有效 Bearer → **200**
   - `POST /pair` 带 challenge → **200**（回一枚只含 safe scope 的新 token）；同一 challenge 再 POST → **401**（单次失效）
   - `POST /api/permission/decide` 带 safe-only token（危险 scope permission.approve）→ **403**（默认拒）
   - WS 升级无 token → **401**；带有效 token（副协议）→ **101**（握手成功）
   - 带有效 token + `Origin: http://evil.example.com` → **403**（跨站拒）
4. **杀进程归零 + 端口释放**：`Stop-Process -Force PiBuddy` → 进程数 0；`netstat` 8787 **无 LISTENING**（仅剩 curl 客户端侧 TIME_WAIT，正常 TCP 回收）。
   - 验后清理：删除 seed 的 remote.db 与一次性 seed 脚本（不入库）。

### 诚实标注（未做到 / 限制）
- 无真实手机 / 公网，端到端「手机 PWA 实机 UI 操作」未验；但 loopback / 统一鉴权 / scope 拒绝 / 单次 challenge / 撤销失效 / 端口释放等核心安全属性全部经**真打包 exe + 真 curl + 真 netstat**（以及真 socket 单测）验到——这些不需真实设备。
- 撤销「立即失效」在真 exe 上未单独 curl（app 独占 db 句柄，无 UI 触发撤销），但由真 socket 集成测试完整覆盖（撤销 + dropDevice → 401）。
- 「发 prompt」v1 只作用于池托管会话（见 §3）。

## 6. 边界遵守

新建 `main/remote/**`、`remote.manifest.ts`、`preload/api/remote.ts`、`stores/remote.ts`、`RemotePanel.vue`、`remote.ts` 契约分片；中央文件（channels/ipc-contract/index/catalog/capability-manifests/AppShell/preload index/index.ts/preload-api.spec）**只追加自己的行**。未改 git/terminal/connector/workflow/memory/mcp/tasks/agent-pool/child-agent/permission/pi 的既有逻辑（只 import 调用其导出做复用）。
