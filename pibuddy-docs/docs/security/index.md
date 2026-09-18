# 威胁模型与权限

> 本文用 STRIDE 描述**信任边界**与缓解策略。核心假设：**renderer 随时可能已被污染。**

## 信任边界

```
   低信任                     半信任                       全权
┌──────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ 模型输出 /     │  IPC │ renderer (Chromium)│  IPC │ main (Node 全权)  │
│ 工具产物 /     │─────▶│ 渲染 markdown /    │─────▶│ 文件系统 / 网络 / │
│ 外部读取文件   │      │ 拼工作区内容        │      │ 子进程            │
└──────────────┘      └──────────────────┘      └──────────────────┘
```

模型输出会被渲染成 markdown、工具产物会被拼进 DOM——任何一处 XSS 若能拿到 renderer 全部 IPC 能力就是灾难。**因此所有安全判定都必须在 main 完成，renderer 侧的检查只是 UX。**

## SEC-001：安全窗口与导航

- `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`，并评估 `app.enableSandbox()`。
- CSP 默认至少 `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`；图片默认只允许 `self data: blob:`。
- `will-navigate` 拒绝非应用 origin；`setWindowOpenHandler` 默认 deny；外链只允许规范化后的 `https/http/mailto`。
- 权限请求（麦克风等）设置 `session.setPermissionRequestHandler`，只允许主窗口、可见用户动作和所需权限。

## SEC-002：窄 IPC 与 schema

- 删除 renderer 通用 `pi.command({type,...})`，按产品动作暴露 `prompt/steer/followUp/abort/newSession/switchSession/setModel/...` 等窄方法。
- 所有 handler 校验 `event.senderFrame === event.sender.mainFrame`、可信 origin/webContents、payload schema、字符串/数组/二进制大小和 rate limit。
- preload 不暴露任意 channel 名、任意绝对路径、任意 URL、环境变量、raw Electron API。
- 事件订阅返回 unsubscribe；窗口销毁时清理 listener，防止重复订阅和内存泄漏。

## SEC-003：Workspace capability

- 用户选择目录后，main 注册 canonical realpath，renderer 只持有不透明 `workspaceId` 和 relative path。
- 每次文件操作重新做 root containment、symlink/traversal、文件类型和大小校验；**禁止只用字符串 `startsWith()`**。
- pi 工具层与桌面文件 API 使用同一个 `PermissionEngine`：至少支持 deny、allow once、allow session、allow workspace，并有审计与撤销。
- 产品文案必须把这一层称为"工具审批/策略"，不能承诺 OS 级沙箱——只有实现并验证进程隔离后，才能宣传强隔离。

## SEC-004：密钥、STT 与网络

- STT/API key 存入 OS 安全存储或主进程加密 vault（`secret-store.ts` / safeStorage，fail closed）；renderer 只能看到"已配置/尾四位"，不能取回明文。
- Provider/STT 请求由主进程根据保存的 endpoint ID 发起，renderer 不同时提交任意 base URL 与 key。
- 自定义 endpoint 保存前做 URL 标准化、HTTPS 要求，以及 DNS/IP 私网/loopback/link-local/metadata 阻断策略。
- SSRF 测试至少覆盖 `localhost`、`127/8`、`0.0.0.0`、整数/八进制/十六进制 IP、IPv6 `::1`、IPv4-mapped IPv6、RFC1918、CGNAT、link-local、云 metadata、DNS rebinding；**每次 redirect 都重新解析并校验目标。**

## 已闭合的历史缺口

| 编号 | 缺口 | 状态 |
| --- | --- | --- |
| G-5 | STT 的 `baseUrl` / `apiKey` 由 renderer 提供（SSRF + 凭据经 IPC 落地/中转） | **已闭合**：IPC 收窄为 `{endpointId, audio, mimeType}`，地址/模型/密钥全部由 main 按 id 查表 |
| G-6 | `settings.json` 明文存密钥、非原子写 | **已闭合**：密钥入 `secret-store.ts`（safeStorage，fail closed），配置统一走 `fs-atomic.ts` 原子写 + `.bak` 备份 |

## 当前重点

- 所有子进程使用参数数组，内部命令默认 `shell:false`；只有用户明确打开的真实终端允许 shell 语法。
- 拒绝未知字段、超长字符串、非法枚举、越界路径和非主 frame 调用。
- 每个高权限功能先定义 threat model、权限边界和失败语义，再暴露 UI。
