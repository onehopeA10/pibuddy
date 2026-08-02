# PiBuddy 威胁模型（STRIDE）

> 基线：TASK-002 完成时的 16 个 IPC channel。
> 缓解列写的是**计划中的**措施与落地任务，未打勾即尚未实现 —— 本文不是现状证明。

## 0. 信任边界

```
   不可信                     半可信                       可信
┌───────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ 模型输出 /     │  →   │ renderer（Chromium│  →   │ main（Node 全权限）│
│ 工具产物 /     │ IPC  │ 渲染任意 markdown │ IPC  │ 文件系统 / 网络 /  │
│ 被读取的文件   │      │ 与工具输出）      │      │ 子进程            │
└───────────────┘      └──────────────────┘      └──────────────────┘
```

**核心假设：renderer 随时可能已被攻陷。** 模型输出会被渲染成 markdown、
工具产物会被拼进 DOM，任何一处 XSS 都让攻击者取得 renderer 的全部 IPC 能力。
因此所有安全判定必须在 main 侧做，renderer 侧的检查只算 UX。

## 1. 现存缺口（M0 基线）

| 编号 | 缺口 | 影响 |
|---|---|---|
| G-1 | 16 个 channel **零运行时校验**，`ipcMain.handle` 直接信任 payload 的 TS 类型标注 | 攻陷的 renderer 可传任意值 |
| G-2 | 无 `senderFrame` 校验 | 任意 iframe / 被导航到的页面都能发 IPC |
| G-3 | `webPreferences.sandbox: false` | renderer 进程未沙箱化 |
| G-4 | 无 CSP、无导航拦截 | 外链与远程脚本可直接加载 |
| G-5 | ~~STT 的 `baseUrl` / `apiKey` 由 renderer 提供并原样发出~~ | SSRF + 凭据经 IPC 明文流转 —— **已闭合（TASK-008）**：请求形状收窄为 `{endpointId, audio, mimeType}`，地址/模型/密钥全部由 main 按 id 查得 |
| G-6 | ~~`settings.json` 明文存转写密钥，非原子写~~ | 凭据落盘 + 掉电截断 —— **已闭合（TASK-008）**：密钥移入 `secret-store.ts`（safeStorage，fail closed），设置一律经 `fs-atomic.ts` 原子写 + `.bak` 备份 |
| G-7 | 无速率限制 | 单个 channel 可被刷爆 |

## 2. 逐 channel STRIDE

`S`=Spoofing `T`=Tampering `R`=Repudiation `I`=Info disclosure `D`=DoS `E`=Elevation

### 2.1 invoke 通道（renderer → main，13 个）

| Channel | 主要威胁 | 说明 | 缓解 |
|---|---|---|---|
| `pi:start` | **E**, T, D | `workspace` 是任意路径 → 在任意目录起一个有 shell 能力的 agent；重复调用可无限 spawn | SEC-002 schema 校验 + SEC-003 workspace capability 化（TASK-007）；RUN-002 代际状态机限制并发（TASK-005） |
| `pi:command` | **E**, T | 任意 RPC 命令直达 pi，含 `prompt` / `bash` 语义 | SEC-002 per-channel schema + 命令白名单（TASK-007） |
| `pi:ui-respond` | S, T | 伪造 `id` 冒充用户对扩展 dialog 的回答 | SEC-002 校验 `id` 属于在途请求（TASK-007、TASK-012） |
| `pi:stop` | D | 反复 stop 打断他人任务（同 webContents 内） | 低危；RUN-002 代际机制（TASK-005） |
| `sessions:list` | **I**, D | 任意 workspace 路径 → 枚举并读取 `~/.pi/agent/sessions` 下会话正文 | SEC-003 workspace capability（TASK-007）；SES-001 解析统一（TASK-006） |
| `settings:get` | **I** | 返回含明文转写密钥的完整设置到 renderer | SEC-004 ✓ 密钥已移出 settings 存入 safeStorage；返回值按 `APP_SETTINGS_PUBLIC_KEYS` 白名单挑选，renderer 只见 `sttApiKeyConfigured` / `sttApiKeyLast4`（TASK-008） |
| `settings:set` | T, E | 写入任意 `workspace` 值改变后续 `pi:start` 的落点 | SEC-002 ✓ schema 剔除 workspace（TASK-007）+ SEC-004 ✓ 原子写、端点地址落盘前过 SSRF 判定（TASK-008） |
| `dialog:choose-folder` | D | 无提示地弹窗骚扰 | SEC-005 渲染侧限额（TASK-004） |
| `dialog:choose-files` | D | 同上 | 同上 |
| `file:read-image` | **I** | 任意路径读文件并 base64 回传（扩展名限制只挡格式不挡路径） | SEC-003 限制在 workspace capability 内（TASK-007） |
| `shell:open-path` | **E** | `shell.openPath` 对 `.exe` / `.bat` / `.lnk` 会**执行**而不只是打开 | SEC-002 扩展名白名单 + SEC-003 路径归属校验（TASK-007） |
| `shell:show-in-folder` | I | 泄漏路径存在性 | 低危；随 SEC-003 一并收敛 |
| `stt:transcribe` | **I**, **E**, D | `baseUrl` 任意 → SSRF 打内网 / 云元数据端点；密钥明文经 IPC 且被写进 Authorization 头 | SEC-004 ✓ 入参收窄为 `{endpointId, audio, mimeType}`；出站唯一经 `net/outbound-guard.ts` 的 `safeFetch`（TASK-008） |
| `settings:set-secret` | T | 覆盖他人密钥 | 只进不出：无任何通道可取回明文；safeStorage 不可用时 fail closed 拒写（TASK-008） |
| `settings:describe-secret` | I | 泄漏尾四位 | 刻意为之：尾四位是用户辨认「这是哪一把」的最小信息量，不可逆 |

### 2.2 push 通道（main → renderer，3 个）

| Channel | 主要威胁 | 说明 | 缓解 |
|---|---|---|---|
| `pi:event` | T, I | 事件正文含模型输出与工具产物，直接进 DOM 渲染路径 | SEC-005 markdown 渲染消毒（TASK-004）；信封 `parseEnvelope` fail closed（TASK-002 ✓） |
| `pi:ui-request` | S | 扩展可请求任意 dialog 文案，可用于钓鱼 | EXT-101 明示来源（TASK-012） |
| `pi:exit` | R | 退出码无上下文，事后无法归因 | OBS-001 结构化日志（TASK-002 ✓ / TASK-013） |

## 3. SEC-001 .. SEC-005 缓解总表

| ID | 措施 | 覆盖缺口 | 落地任务 | 状态 |
|---|---|---|---|---|
| SEC-001 | 窗口安全基线：`sandbox: true`、`contextIsolation`、禁用 `nodeIntegration`、权限请求默认拒绝、内置 runtime 的环境变量白名单 | G-3, G-4 | TASK-003, TASK-004 | 待做 |
| SEC-002 | 收窄 IPC 接口面：channel 白名单 + per-channel schema + `senderFrame` 校验 + 速率限制，由 `ipc-guard.ts implements PermissionEngine` 统一实施 | G-1, G-2, G-7 | TASK-007 | 端口已定型（TASK-002 ✓），实现待做 |
| SEC-003 | workspace capability 化：所有涉路径的 channel 只接受**已授权 workspace 内**的路径，main 侧解析真实路径后再判定 | G-1（路径面） | TASK-007 | 待做 |
| SEC-004 | 凭据安全存储（safeStorage）+ 出站请求 SSRF 防护 + 设置原子写 | G-5, G-6 | TASK-008 | **已落地 ✓**（`secret-store.ts` / `net/outbound-guard.ts` / `endpoints.ts` / `settings.ts`；人工回归见 `doc/regression/TASK-008-secrets.md`） |
| SEC-005 | 内容安全：CSP、导航/新窗口拦截、markdown 与工具输出消毒、渲染侧限额 | G-4 | TASK-004, TASK-007 | 待做 |

## 4. 日志与取证（OBS）

- `logger-redact.ts` 是全仓唯一脱敏实现：键名命中 `/apiKey|authorization|token|secret|password/i`
  的值整体抹掉；`prompt` / `message` / `text` 等正文只留 `<name>Length`；
  环境变量只记白名单命中的**键名**、不记值；字符串里的 `Bearer …`、`sk-…`
  与 home 路径就地替换。
- 日志按 5 MB 轮转、保留 5 份，避免磁盘被打满（这本身是一条 DoS 缓解）。
- 未覆盖：日志文件本身的权限。攻击者若已取得本机文件读权限，日志不构成新增暴露面。

## 5. 出站请求的残余风险（TASK-008）

`net/outbound-guard.ts` 是全仓唯一的出站原语（结构断言：`packages/app/src/main`
下除它自己以外 `fetch(` 命中数为 0）。它拦得住的：

- 非 HTTPS 协议；URL 内嵌用户名密码
- 环回 / 未指定 / RFC1918 / CGNAT(100.64/10) / link-local(169.254/16，含
  `169.254.169.254`) / IPv6 `::1` `fc00::/7` `fe80::/10` / IPv4-mapped `::ffff:`
- 数字形态 IP 绕过（`2130706433` / `0x7f000001` / `0177.0.0.1` / `127.1`）
- 域名解析到内网（`dns.lookup(all:true)` 后**逐条**判定，不是只看第一条）
- 重定向到内网：`redirect:"manual"`，最多 3 跳，**每跳重跑 normalize + assert**；
  跨源时丢弃 `Authorization` / `Cookie`
- 响应体 > 2MB、content-type 非 `application/json`、连接/整体两级超时
- 错误消息统一脱敏：不含完整 URL、不含任何请求头

### 拦不住的（明确记录，不假装闭合）

**DNS rebinding 的第二跳。** 当前实现是「解析后校验 → 再把 URL 交给 fetch
自己解析一次」，两次解析之间存在 TOCTOU 窗口：恶意权威 DNS 可以在第二次
解析时返回内网地址。彻底封死需要用自定义 `lookup` 把已校验的 IP 钉死给连接层
（undici `dispatcher` + 固定 IP + SNI 保留原 host），列为后续改进方向。

当前实现拦得住的是两类现实攻击面：域名本身就解析到内网，以及先应答 302
再指向元数据端点。

**本机模型端点（localhost / 127.0.0.1）目前一律被拒。** 若将来要支持本地
Whisper，必须做成用户显式授予的 local-network scope（一次明确的手势 + 明确
的风险提示），**不得**在 `isBlockedAddress` 里默认放开环回段 —— 那等于把
上面所有判定的第一道门拆掉。
