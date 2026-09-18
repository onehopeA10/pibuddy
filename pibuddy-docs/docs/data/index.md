# SQLite 分区与备份

## 12 个独立库

持久状态按能力域分区在 **12 个独立 sqlite 库**里。全仓 `FOREIGN KEY` / `REFERENCES` / `ATTACH DATABASE` 命中数为 0：库之间既无外键也无跨库事务。

| 文件 | 代际来源 | 内容 |
| --- | --- | --- |
| `artifacts.db` | `PRAGMA user_version` | 产物版本链与状态 |
| `changesets.db` | `PRAGMA user_version` | 工作区改动评审 |
| `connectors.db` | `PRAGMA user_version` | 外部渠道连接器 |
| `home-assistant.db` | `PRAGMA user_version` | 家居实体注册表 |
| `home-automation.db` | `PRAGMA user_version` | 家居自动化规则 |
| `memory.db` | `PRAGMA user_version` | 记忆 / 知识库 / 向量 |
| `remote.db` | `PRAGMA user_version` | 远程设备与审计 |
| `session-index.db` | `PRAGMA user_version` | 会话索引 |
| `tasks.db` | `PRAGMA user_version` | 定时任务与运行 |
| `usage.db` | `usage_meta` 表的一行 | 用量与花费 |
| `workflows.db` | `PRAGMA user_version` | 工作流定义与运行 |
| `workspaces.db` | `PRAGMA user_version` | 工作区偏好 |

## 一致性口径：逐库快照，不是原子快照

备份逐个调用 `node:sqlite` 的在线 `backup()`：每个库**自身**完整一致，跨库一致性是 best-effort（第 1 个与第 12 个库的快照点之间隔着几十到几百毫秒）。

这是分区架构的**直接后果，不是缺陷**——因为库之间没有任何跨库不变量要维护。这句话必须原样出现在设置页上。

## 备份范围

- **包含**：12 个库 + `workspaces.json`（工作区注册表，库里的 `workspace_id` 列靠它才有含义）。
- **不含**：`settings.json`、账号凭据（`auth.json` / secret-store）、日志，以及产物文件本体（那是用户工作区里的普通文件）。

备份清单 schema 版本为 `BACKUP_SCHEMA_VERSION = 1`（`contract/src/backup.ts`）。

## 恢复是两段式

```
backup:restore
   │  只把校验通过的副本落到 userData/pending-restore/
   ▼
下次启动（main/index.ts 的 whenReady 首行，任何 store 打开之前）
   │  applyPendingRestoreOnStartup() 真正套用
   ▼
全部 rename 成功后才删暂存区
```

当场替换做不到——12 个句柄正开着，Windows 上 rename 覆盖会 EPERM。暂存区在全部 rename 成功之后才删，因此中途崩溃会在下次启动继续收敛。

## 单点实现

| 能力 | 唯一实现 |
| --- | --- |
| 备份纯逻辑（库登记表 / 清单编解码 / 路径收容 / 盘点比较） | `app/src/main/backup/backup-manifest.ts` |
| 备份 IO（快照 / fsync / 校验 / 暂存 / 套用） | `app/src/main/backup/backup-service.ts` |
| 四条通道接线（含目录选择框与确认框） | `app/src/main/backup/backup-ipc.ts` |

> 更新不能迁移或删除用户会话、settings、vault、索引和草稿；数据库 migration 必须向前兼容、可备份，失败时应用进入恢复模式而非循环崩溃。详见 [更新与发布](/delivery/)。
