# 产品范围与里程碑

PiBuddy 的目标不是做 Demo，也不是只增加几个 UI 按钮，而是把现有项目逐步升级为**可安装、可恢复、可更新、可诊断、可安全交付**的跨平台桌面 Agent 产品。

- `PRIMARY_PLATFORM`：Windows 11 x64
- `SECONDARY_PLATFORMS`：macOS arm64/x64、Ubuntu x64
- `PRODUCT_MODE`：面向普通用户的个人 Agent / AI 办公助手；开发者能力放入高级模式

默认产品界面面向非开发者：聊天、文件/产物、历史、任务、设置。PTY、Git 高级操作、worktree 和调试日志放在"开发者/高级模式"。

## 里程碑地图

| 里程碑 | 目标 | 发布含义 |
| --- | --- | --- |
| M0 | 基线、契约、测试骨架 | 不发布 |
| M1 | bundled Pi、session resolver、runtime supervisor | 内测 |
| M2 | Electron/IPC/权限/密钥安全 | 内测 |
| M3 | 会话、Provider、Extension/Pi 资源与日常 UX | 功能公测 |
| M4 | 更新、签名、CI/CD、诊断 | 可分发公测基线 |
| M5 | Workspace、Office/PDF、artifact | 办公产品 v1 核心 |
| M6 | PTY、Git/Review、checkpoint/worktree | 开发者高级模式 |
| M7 | 后台会话池、child Agent 编排 | Agent 平台 Beta |
| M8 | durable tasks、长期记忆 | 个人 Agent OS Beta |
| M9 | Remote/PWA/IM、浏览器与插件平台 | 高风险能力，独立 Beta |
| M10 | GA 性能、可访问性、隐私与支持 | GA |

不得跳过 M1–M2。M7 不得早于 worktree 和权限中心；M9 不得早于统一认证、设备 scope 和审计。

## 需求前缀

需求以带 ID 的前缀组织，便于从需求追踪到实现与测试：

| 前缀 | 领域 | 前缀 | 领域 |
| --- | --- | --- | --- |
| `RUN-*` | Pi runtime/SDK | `UPD-*` | 应用/Pi 更新 |
| `SES-*` | 会话 | `AGT-*` | 后台/child Agent |
| `SEC-*` | IPC/权限/密钥/导航 | `AUT-*` | 自动化 |
| `EXT-*` | Extension UI/Pi 资源 | `MEM-*` | 记忆 |
| `PROV-*` | Provider/model/auth | `REM-*` | 远程与设备 |
| `FS-*` | 文件与附件 | `OBS-*` | 日志/诊断/崩溃 |
| `ART-*` | Office/artifact/preview | `QA-*` | 测试/CI/发布 |
| `PTY-*` | 终端 | `GIT-*` | Git/worktree/checkpoint |

## 通用完成定义（DoD）

一个需求只有同时满足以下条件才可标记完成：

1. 用户从 UI 能进入、操作、取消并看到成功/失败/恢复状态。
2. main/preload/renderer 边界完整，IPC 有 runtime schema 和 sender 校验。
3. 关键状态在窗口 reload、Agent crash 或应用重启后按需求恢复或明确清理。
4. 错误不泄露 key、完整环境变量、敏感路径或任意 stderr；同时保留可导出的脱敏诊断。
5. 覆盖正常、取消、超时、异常退出、重复调用和至少一个平台差异测试。
6. 类型检查、单测、集成测试、renderer E2E 和生产 build 通过。
7. 涉及安装/更新/runtime 的功能必须在 packaged app 上验证，不能只用 dev server。
8. 文档、设置说明、迁移与必要文案已同步；可从需求追踪到实现与测试。

## 明确延期与不做

- 不自研 agent 运行时（pi 的职责），不自建 provider / 模型网关层（pi 原生支持）。
- Office 第一版做安全预览、artifact 版本和受控导出，不承诺完整在线 Office 编辑器。
- Git 第一版先本地 status/diff/stage/commit/worktree，不复制完整 PR 平台。
- 没有进程/realm 隔离时只允许 built-in 插件，不靠 manifest 自称安全。
- 记忆先做显式保存、来源与删除，不默认把所有对话自动写入长期记忆。
- Remote 默认关闭；不做 i18n（自用中文）、不做 telemetry 上报。
