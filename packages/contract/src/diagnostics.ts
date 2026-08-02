/**
 * 诊断、启动健康检查与安全模式的共享形状（OBS-101 / UPD-006）。
 *
 * 这些类型同时被 main（生产者）、preload（转发）、renderer（消费）用到，
 * 因此住在契约包里 —— 三边各写一份的必然结果是漂移，而漂移在这里的表现是
 * 「界面显示一切正常，主进程其实已经进了安全模式」。
 */
import { z } from "zod";

/**
 * 更新后第一次启动要过的三项检查。
 *
 * 只有三项、而且都很轻：这是**启动路径**上的检查，不是自检套件。多一项都
 * 意味着用户下次打开应用要多等一会儿。
 */
export const healthCheckNameSchema = z.enum(["db-migration", "renderer-ready", "pi-handshake"]);
export type HealthCheckName = z.infer<typeof healthCheckNameSchema>;

export const healthCheckResultSchema = z.object({
  ok: z.boolean(),
  /** 没过的项。超时算没过 —— 卡住和失败对用户是同一件事。 */
  failed: z.array(healthCheckNameSchema),
  /** 各项耗时（ms），用于判断是"慢"还是"死" */
  durations: z.record(z.string(), z.number()).optional(),
  checkedAt: z.number(),
});
export type HealthCheckResult = z.infer<typeof healthCheckResultSchema>;

/**
 * 安全模式态。
 *
 * `previousVersion` 是 last-known-good marker 里的版本号 —— 界面上那个
 * 「下载上一稳定版本」的入口要显示它。v1 **不做**真实的二进制自动回滚
 * （见 docs/product/ADR-0001-update-feed.md），只给出退路。
 */
export const safeModeStateSchema = z.object({
  active: z.boolean(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** 上一次成功启动过的版本；没有记录时为 null */
  previousVersion: z.string().nullable(),
  /** 安全模式下被禁用的能力，逐条展示给用户，不含糊其辞 */
  disabled: z.array(z.string()),
});
export type SafeModeState = z.infer<typeof safeModeStateSchema>;

/** diagnostics:get-report 的返回。 */
export const diagnosticsReportSchema = z.object({
  safeMode: safeModeStateSchema,
  health: healthCheckResultSchema.nullable(),
  /** 是否有一次更新还没确认健康（pending-update marker 仍在） */
  pendingUpdate: z.boolean(),
  currentVersion: z.string(),
});
export type DiagnosticsReport = z.infer<typeof diagnosticsReportSchema>;

/**
 * 诊断包里的一个条目。
 *
 * `redacted` 必须逐条给出，而不是在界面上写一句「已脱敏」了事：日志与
 * settings 副本是脱敏过的文本，而 crash dump 是二进制、**没法**脱敏 ——
 * 把这两种混在一句话里，等于骗用户说崩溃转储也安全。
 */
export const bundleEntrySchema = z.object({
  /** 在 zip 内的相对路径（不是磁盘上的绝对路径） */
  path: z.string(),
  sizeBytes: z.number().nonnegative(),
  redacted: z.boolean(),
  /** 一句人话，说明这个文件是什么 */
  description: z.string(),
});
export type BundleEntry = z.infer<typeof bundleEntrySchema>;

/** diagnostics:preview-bundle 的返回：清单本身，**不写任何文件**。 */
export const bundlePreviewSchema = z.object({
  entries: z.array(bundleEntrySchema),
  totalBytes: z.number().nonnegative(),
  /** 用户是否已就崩溃转储做过明确选择；unset 时界面必须先问 */
  crashDumpConsent: z.enum(["unset", "allow", "deny"]),
});
export type BundlePreview = z.infer<typeof bundlePreviewSchema>;

/** diagnostics:export-bundle 的入参。**没有路径形参**。 */
export const bundleExportRequestSchema = z.object({
  /** 导出后是否在文件管理器里定位到它 */
  reveal: z.boolean().default(true),
});

/** diagnostics:export-bundle 的返回。用户取消保存对话框时 path 为 null。 */
export const bundleExportResultSchema = z.object({
  path: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
});
export type BundleExportResult = z.infer<typeof bundleExportResultSchema>;

/**
 * 更新交接 marker（UPD-006）。
 *
 * installAndRestart 之前写 pending-update，健康启动之后写 last-known-good
 * 并清掉 pending。两个文件都经 fs-atomic 的 writeJsonAtomic 落盘 —— 半写的
 * marker 会让下次启动读到损坏 JSON 并直接进安全模式。
 */
export interface PendingUpdateMarker {
  fromVersion: string;
  toVersion: string;
  startedAt: number;
}

export interface LastKnownGoodMarker {
  version: string;
  verifiedAt: number;
}
