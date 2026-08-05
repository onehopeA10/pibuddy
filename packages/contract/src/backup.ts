/**
 * SQLite 备份 / 恢复的契约（BKP-101，平台内核）。
 *
 * ## 一致性口径：逐库快照，不是原子快照
 *
 * 本应用的持久状态按能力域分区在 12 个独立的 sqlite 库里（D4 铁律：一个域
 * 一个库，跨库既无外键也无事务）。备份因此是**逐库依次做在线 backup()**，
 * 不是「全应用某一瞬间的原子快照」：第 1 个库的快照点与第 12 个库的快照点
 * 之间隔着几十到几百毫秒，期间发生的写入会出现在后者而不在前者。
 *
 * 每个库**自身**是完整一致的（sqlite 在线备份 API 的保证），跨库一致性是
 * **best-effort**。这句话必须原样出现在 UI 上：把它说成「快照」会让用户在
 * 一次事故之后才发现自己相信的是一件从未成立的事。
 *
 * ## 不含什么
 *
 * 只备份 sqlite 库 + `workspaces.json`（工作区注册表——没有它，库里的
 * workspace_id 列失去全部含义）。**不含** settings.json / 凭据 / 密钥
 * （auth.json、secret-store）、日志、以及产物文件本体（那些是用户工作区里
 * 的普通文件，属于用户自己的备份范畴）。同样必须如实写在 UI 上。
 */
import { z } from "zod";

import { defineContractShard, voidRequestSchema } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

/** 备份目录里的清单文件名。 */
export const BACKUP_MANIFEST_FILE = "pibuddy-backup.json";
/** 清单的 `format` 字段常量（认错格式比认错版本更值得单独报一句）。 */
export const BACKUP_FORMAT = "pibuddy-sqlite-backup";
/** 清单代际。改布局或校验口径必须 +1。 */
export const BACKUP_SCHEMA_VERSION = 1;

/** 备份里的一个文件条目（路径以 `/` 归一，跨平台可逐字比较）。 */
export const backupFileSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type BackupFile = z.infer<typeof backupFileSchema>;

/** 一个 sqlite 库在备份时刻的代际（供恢复前逐库比对）。 */
export const backupStoreSchema = z
  .object({
    /** 库的稳定标识（= 文件名去扩展名，与 SQLITE_STORES 的 id 一致） */
    id: z.string().min(1),
    /** 备份内的相对路径 */
    path: z.string().min(1),
    /** 备份时刻该库的 schema 代际 */
    schemaVersion: z.number().int().nonnegative(),
  })
  .strict();
export type BackupStore = z.infer<typeof backupStoreSchema>;

export const backupManifestSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
    /** 应用版本，仅供人排查（不参与准入判定） */
    appVersion: z.string(),
    createdAt: z.number().int().nonnegative(),
    /**
     * 逐库依次快照的口径标记。恒为 "per-store"——留这个字段是为了让将来
     * 若真做出原子快照时，老备份不会被误读成新语义。
     */
    consistency: z.literal("per-store"),
    stores: z.array(backupStoreSchema),
    files: z.array(backupFileSchema),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/**
 * 产物元数据 ↔ 文件系统的对账结果。
 *
 * **不是准入判据**（见 backup-service.ts 的 crossCheckArtifacts 注释）：产物
 * 本体是用户工作区里的普通文件，用户随时可能改它、删它、把工作区整个搬走，
 * 而那恰恰是 artifact-store 用 `conflicted` 状态建模的正常情形。让它决定
 * 「备份能不能做」等于因为用户编辑了一个表格就拒绝备份。它只被如实报出。
 */
export const artifactReconciliationSchema = z
  .object({
    /** 参与对账的 ready 产物条数 */
    checked: z.number().int().nonnegative(),
    /** 元数据在库里、文件已不在磁盘上 */
    missing: z.number().int().nonnegative(),
    /** 文件在，但字节数与库里记的 size_bytes 不符 */
    sizeMismatch: z.number().int().nonnegative(),
    /** 所属工作区未在注册表里（换机器恢复时的正常情形） */
    unresolvedWorkspaces: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactReconciliation = z.infer<typeof artifactReconciliationSchema>;

/**
 * 校验结论。
 *
 * `reasons` 是逐条的失败原因，不是一句「备份无效」：完整性坏了、外键对不上、
 * 代际不符、缺表、sha256 不匹配，这五种在现场要查的方向完全不同，而运维拿到
 * 的往往只有一行被 `cause` 丢光的 message。
 */
export const backupValidationSchema = z
  .object({
    ok: z.boolean(),
    path: z.string().nullable(),
    createdAt: z.number().int().nonnegative().nullable(),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    /** 校验通过的库 id */
    stores: z.array(z.string()),
    reasons: z.array(z.string()),
    artifacts: artifactReconciliationSchema.nullable(),
    checkedAt: z.number().int().nonnegative(),
  })
  .strict();
export type BackupValidation = z.infer<typeof backupValidationSchema>;

/** `backup:create` 的返回。用户取消目录选择框时 path 为 null。 */
export const backupCreateResultSchema = z
  .object({
    path: z.string().nullable(),
    validation: backupValidationSchema.nullable(),
  })
  .strict();
export type BackupCreateResult = z.infer<typeof backupCreateResultSchema>;

/** `backup:restore` 的返回。恢复恒需重启：句柄已开，当场换文件做不到。 */
export const backupRestoreResultSchema = z
  .object({
    /** 被采纳的备份目录；用户取消时为 null */
    path: z.string().nullable(),
    /** 已落到暂存区、等待下次启动套用 */
    staged: z.boolean(),
    restartRequired: z.boolean(),
    validation: backupValidationSchema.nullable(),
  })
  .strict();
export type BackupRestoreResult = z.infer<typeof backupRestoreResultSchema>;

/** 上一次成功备份的痕迹（落在 userData/backup-state.json）。 */
export const backupRecordSchema = z
  .object({
    path: z.string(),
    at: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type BackupRecord = z.infer<typeof backupRecordSchema>;

/** `backup:describe` 的返回：设置页区块渲染所需的全部事实。 */
export const backupStatusSchema = z
  .object({
    lastBackup: backupRecordSchema.nullable(),
    lastValidation: backupValidationSchema.nullable(),
    /** 有一份恢复已落到暂存区，等下次启动套用 */
    pendingRestore: z.boolean(),
    /** 本次构建会备份哪些库（供 UI 如实列出范围） */
    storeIds: z.array(z.string()),
  })
  .strict();
export type BackupStatus = z.infer<typeof backupStatusSchema>;

/**
 * 四条通道。入参一律是 `void` 或一个布尔，**没有任何路径字段**。
 *
 * 分片 id 用 `backup`：它是平台内核（与 diagnostics 同层），不是能力包——
 * 「数据能不能备份」不该是一个可以被 Profile 关掉的选项。
 */
export const backupContractShard = defineContractShard("backup", {
  [CHANNELS.backupDescribe]: {
    request: voidRequestSchema,
    response: backupStatusSchema,
  },
  [CHANNELS.backupCreate]: {
    request: voidRequestSchema,
    response: backupCreateResultSchema,
  },
  [CHANNELS.backupValidate]: {
    request: voidRequestSchema,
    response: backupValidationSchema,
  },
  [CHANNELS.backupRestore]: {
    request: voidRequestSchema,
    response: backupRestoreResultSchema,
  },
});
