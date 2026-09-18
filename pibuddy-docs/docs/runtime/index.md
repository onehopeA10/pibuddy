# pi 运行时生命周期

pi 是可替换的 Agent runtime。默认使用随应用发布并经过回归测试的 **bundled Pi**；高级设置允许选择 **external Pi**。外部 Pi 绝不能破坏 bundled Pi 的可用性。

## RUN-001：可靠 bundled Pi

- 不使用会触发 `ERR_PACKAGE_PATH_NOT_EXPORTED` 的 `createRequire().resolve(package-root)`。开发态用 ESM `import.meta.resolve()` + `fileURLToPath()` 解析公开入口；生产态不依赖碰巧存在的 workspace `node_modules`。
- 构建期 `prepare-pi-runtime`：把锁定版本及完整生产依赖/动态资源准备为自包含 runtime 目录，生成 `runtime-manifest.json`（版本、入口、构建时间、协议能力、内容校验）。
- packaged mode 只从 `process.resourcesPath` 下的 manifest 定位 bundled Pi；路径必须存在、是普通文件且属于 runtime 根。
- 启动时进行 version/protocol/capability handshake，记录 `bundledVersion`、`selectedRuntime`、`protocolVersion`；不兼容时拒绝启动并提供恢复动作。
- 所有启动参数使用 argv 与 `shell:false`。子进程环境变量采用 allowlist/显式构造，默认剔除或受控处理 `NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`、调试端口等可改变 Node/Electron 启动语义的变量。

## RUN-002：generation 与生命周期状态机

状态机至少包含：

```
idle → starting → running → stopping → stopped
                     │
                     ├─→ crashed → recovering → starting
                     └─→ stopped (expected-stop)
```

- 每次 runtime start 生成不可复用的 `runtimeId` / generation。所有 Agent event、UI request、response、stderr、exit 都携带 `runtimeId + sessionId + sequence`。
- 主进程只转发当前 generation；renderer 再丢弃旧 generation 或 sequence 倒退事件。
- `dispose` 必须取消 batch timer、清空队列、移除 listeners、拒绝 pending、区分 `expected-stop` 与 `crash`。
- 初始化任一 RPC 失败时，立即停止子进程、删除 map、清理 listener，并向 UI 返回结构化错误与最近脱敏 stderr。
- 非法转换在开发态抛错并有单测。

## RUN-003：SDK 请求可靠性

- 每条请求有自动生成且不可碰撞的 ID、默认 timeout、可覆写 timeout、`AbortSignal`；timeout/abort 后必须从 pending map 删除。
- 监听 child `error/exit/close`、stdin `error` 和 write callback；处理 backpressure / `drain`。
- JSONL reader 设置单行和累计 buffer 上限；malformed line、orphan response、重复 response、未知 event 进入有界诊断，不静默吞掉关键协议错误。
- spawn `ENOENT` 后对象必须进入 crashed/stopped，而不是 `running=true`；同一对象若允许 restart，旧 child callback 不得清空新 child。
- stop 顺序：停止接收新命令 → graceful abort / 关闭 stdin → 等待 → terminate → kill process tree / Windows Job Object；每层都有超时与测试。

## SES-001：统一会话解析

- 优先通过 pi 公开导出的 `SessionManager.list(cwd, sessionDir)` 或同一 resolver 获取会话，删除自写的 POSIX cwd 编码复制逻辑。
- 正确支持 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、pi settings `sessionDir` 和 `path.resolve(cwd)`。
- 解析在 worker / utility process 或异步 I/O 中进行，不同步全量读取阻塞 Electron main。
- 单个损坏 / 超大 JSONL 不影响其它会话；记录脱敏错误并允许用户导出诊断。

## 出口验证要点

- 没有全局 `pi` 的 packaged Windows 安装包仍能启动 bundled Pi。
- macOS `/Users/...`、Linux `/home/...`、Windows `C:\...` 会话列表正确。
- spawn ENOENT、启动后立即 crash、RPC timeout、畸形 JSON、超大无换行输出、stdin EPIPE、强制 kill 均可恢复。
- 快速连续换 workspace/session，旧 exit/update/UI request 不影响新 generation（依赖 [事件信封](/architecture/event-flow) 的代际 + 序号）。
