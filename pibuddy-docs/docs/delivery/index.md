# 更新与发布

目标：形成从版本、构建、签名、发布、检测、下载、安装、重启到升级后健康检查的**完整闭环**。仅仅"打开 GitHub Releases"不算自动更新。

## UPD-001：更新服务边界

- 建立 main-only `UpdateService`。renderer 不接触 feed URL、token、文件路径或 raw updater，只通过窄 API 获取状态、请求检查/下载/安装和修改允许的偏好。
- 版本真相来自 `app.getVersion()` / packaged metadata，不信任 renderer 或手写常量；使用严格 semver，默认拒绝 downgrade。
- dev/test 模式返回明确 `unsupported-in-dev` 或注入 fake provider，不访问生产更新源。
- 私有 GitHub token / API key 绝不能打进客户端；需要私有发布时使用受控下载授权或公开无密钥制品源。

## UPD-002：状态机

共享、可序列化的状态至少包含：

```
unsupported · idle · checking · available · not-available ·
downloading · downloaded · waiting-for-agent · installing · error
```

状态字段至少包含 current version、candidate version、channel、check source、last checked、release notes、download bytes/percent/speed、error code、retryable 和 dismissed version。事件带单调 sequence，renderer reload 后先取 snapshot 再订阅。

初始化规则集中在 `UpdateService` 并有单测：`autoDownload = false`、`autoInstallOnAppQuit = false`、`allowPrerelease = channel === 'beta'`、设置 channel 后最后再次明确 `allowDowngrade = false`。产品层 `stable` 映射到 feed 的 `latest`、`beta` 映射到 `beta`。

## UPD-003：检测策略

- packaged app 主窗口可交互约 30 秒后首次检查；此后约每 4 小时检查，加入 10%–20% jitter；timer `unref()`，不阻止退出。
- 同一时间只允许一个 check/download/install；重复调用返回当前 operation，而不是新建竞态。
- 默认 `autoDownload:false`：先展示版本、发布时间、净化后的 release notes 和预计大小；用户同意后下载。
- 绝不在用户有未保存草稿、录音、运行中 Agent 或 pending permission 时强行重启。
- 同一 candidate 在本进程只主动提示一次；"稍后"默认 24 小时内不重复弹窗，但 Settings 始终可见。

## UPD-005：三平台产物

| 平台 | 首发自更新目标 | 关键要求 |
| --- | --- | --- |
| Windows | per-user NSIS + `latest.yml` + blockmap | 对 app exe、helper、installer 统一签名；升级不改变 appId/用户数据目录 |
| macOS | DMG（分发）+ ZIP + `latest-mac.yml` | Developer ID、Hardened Runtime、entitlements、notarization、stapling；麦克风用途说明 |
| Linux | AppImage + `latest-linux.yml` | DEB/RPM 若无法可靠自更新，UI 明确降级为下载新包，不伪装自动安装 |

每个平台的 metadata、artifact、blockmap/checksum 必须原子可见：**先上传 artifact，最后发布 manifest**，避免客户端读到半次发布。

## UPD-006：签名、完整性与回滚

- production release 缺少签名/公证条件时必须**失败关闭**，不能静默产出"正式版未签名包"。
- 证书、Apple 凭证、发布 token 只存在 CI secret，不写仓库、日志或 artifact。
- 客户端依赖平台签名与 updater 完整性验证；manifest/下载错误、签名/hash 不匹配全部中止安装并给出脱敏错误。
- v1 不虚假声称自动二进制回滚；至少实现更新后 health marker、safe mode/诊断入口、分阶段放量与快速撤回 feed。

## OBS-101：诊断与健康检查

- 更新 handoff 前写 `pending-update` marker；成功健康启动后写 `last-known-good` 并清 marker。
- 更新后第一次启动执行轻量 health check：数据库 migration、renderer ready、bundled Pi handshake；成功标记 healthy，失败进入 safe mode 并保留诊断。
- 提供一键 support bundle，用户可预览将导出的文件；默认脱敏 prompt、key、Authorization、完整 home 路径和环境变量。

## UPD-007：应用更新与 pi 更新分层

- bundled Pi 版本默认跟随应用版本，由应用 release 统一签名和回归，不在用户机器里直接 `npm update`。
- external Pi 只检测当前路径、版本、兼容范围和可用升级，不擅自执行全局 npm 修改；提供切回 bundled。

> 真实发布值（GitHub owner/repo、签名 identity、Apple Team、下载域名等）必须由产品所有者配置，写在 `docs/product/RELEASE_SETUP.md`，Coding Agent 不得编造；缺失时 release job 必须失败关闭，验收状态写 `not-tested/blocked-by-credential`。
