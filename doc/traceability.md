# 需求追踪矩阵

> 三列对照：需求 ID ↔ 承载任务 ↔ 验收条件（可执行的那种）。
> 任务 ID 对应 `.workflow/scratch/20260802-plan-P0-pibuddy-m0-m5/outputs/tasks/TASK-*.json`
> 的 `convergence.criteria`；本表只写判据摘要，全文以 task JSON 为准。

## M0 工程与架构护栏

| 需求 ID | 承载任务 | 验收条件 |
|---|---|---|
| QA-001 | TASK-001 | 仓库根唯一 `vitest.config.ts`；`pnpm -w test` 退出码 0 |
| QA-002 | TASK-001 | fake Pi RPC fixture 覆盖 9 场景，手写 LF 分帧；`packages/pi-sdk/test/client.spec.ts` 通过 |
| QA-003 | TASK-001 | `.github/workflows/ci.yml` 在 ubuntu + windows 上跑 typecheck / test / build |
| QA-004 | TASK-002 | `node scripts/check-contract-uniqueness.mjs` 退出码 0，且注入同名 export 后退出码 1；已接入 ci.yml |
| OBS-001 | TASK-002, TASK-005, TASK-013 | `main/logger.ts` 是唯一 `createLogger` 实现；`packages/app/test/logger.spec.ts` 断言 API key 与 prompt 正文不落盘、保留 `promptLength` |
| OBS-002 | TASK-002, TASK-008 | `logger-redact.ts` 是唯一 `redactSecrets` 实现；键名正则 `/apiKey\|authorization\|token\|secret\|password/i` |

## M1 运行时与会话可靠性

| 需求 ID | 承载任务 | 验收条件 |
|---|---|---|
| RUN-001 | TASK-003 | 内置 pi runtime 以 manifest 定位，构建期自包含；环境变量白名单生效 |
| RUN-002 | TASK-005 | 代际状态机：上一代 runtime 的迟到事件被丢弃（依赖 `PiEnvelope.generation` / `sequence`，TASK-002 已就位） |
| RUN-003 | TASK-005 | SDK 可靠性：崩溃重启、在途请求 reject、stderr 归集 |
| SES-001 | TASK-006 | 会话 jsonl 解析统一到 `SessionRepository`；损坏文件降级为带 `parseError` 的条目而非静默丢弃 |
| SES-002 | TASK-006, TASK-007 | 会话切换的交互一致性；切换期间禁止并发 start |

## M2 安全

| 需求 ID | 承载任务 | 验收条件 |
|---|---|---|
| SEC-001 | TASK-003, TASK-004 | `sandbox: true`、权限请求默认拒绝、runtime 环境变量白名单 |
| SEC-002 | TASK-007 | `ipc-guard.ts implements PermissionEngine`（`checkFrame` / `checkPayload` / `checkRate`，接口已由 TASK-002 定型）；16 个 channel 全部走 schema |
| SEC-003 | TASK-007 | workspace capability：涉路径 channel 只接受已授权 workspace 内的真实路径 |
| SEC-004 | TASK-008 | 凭据经 safeStorage 存储；出站请求 SSRF 白名单；设置落盘走 `writeJsonAtomic`（唯一实现已由 TASK-002 交付） |
| SEC-005 | TASK-004, TASK-007 | CSP、导航拦截、markdown 消毒、渲染侧限额 |

## M3 产品化

| 需求 ID | 承载任务 | 验收条件 |
|---|---|---|
| SES-101 | TASK-009 | SQLite 增量索引的会话中心；preload 命名空间分层 |
| SES-102 | TASK-010 | delta 流式、分段消息源、插话/下一轮分流、草稿恢复 |
| FS-101 / FS-102 | TASK-015 | Workspace 文件服务、结构化附件、编辑器冲突检测、changeset diff |
| ART-101 / ART-102 | TASK-016 | 受限沙箱预览、Office/PDF 转换、Artifact 仓库 |
| PROV-101 / UX-101 | TASK-014 | Provider 与模型中心、用量页、首次启动向导 |
| EXT-101 / EXT-102 | TASK-012 | Extension UI 全方法覆盖、dialog timeout、Pi 资源中心 |

## M4 / M5 更新与发布

| 需求 ID | 承载任务 | 验收条件 |
|---|---|---|
| UPD-001..004 | TASK-011 | main-only `UpdateService`（接口已由 TASK-002 定型）；十态状态机；检测策略；更新 UI |
| UPD-005..007 | TASK-013 | 三平台产物与签名 CI；更新后 health check 与 safe mode |
| OBS-101 | TASK-013 | 结构化日志诊断包（support-bundle 复用 `logger-redact.ts`） |
| QA-401 | TASK-013 | 发布前回归门槛 |

## TASK-002 已闭合的判据

| 判据 | 验证方式 |
|---|---|
| 四方共用同一套类型 | `AppSettings` / `SessionMeta` / `PickedFile` / `StartResult` 在 `packages/app/src` 与 `packages/pi-sdk/src` 的 `export` 计数为 0，在 `packages/contract/src` 为 1 |
| 统一信封 + 未知版本 fail closed | `packages/contract/test/envelope.spec.ts` |
| 端口接口定型 | `packages/contract/src/ports.ts` 五个 interface |
| 敏感信息不落盘 | `packages/app/test/logger.spec.ts` |
| 架构与依赖方向可查 | `doc/architecture.md` |
| 威胁模型可查 | `doc/threat-model.md` |
