/**
 * `window.piBuddy.diagnostics`（OBS-101）。
 *
 * 四个方法、三条通道。渲染进程在这里能表达的极限是「给我看清单」、
 * 「导出」、「现在状态如何」—— **没有**路径形参，也没有「收集这些文件」
 * 的参数：诊断包的取材范围与落盘位置都由主进程决定。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { BundleExportResult, BundlePreview, DiagnosticsReport } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const diagnostics = {
  /** 导出前的清单预览。**不写任何文件**，界面必须先展示它再让用户确认。 */
  previewBundle: () => invoke<BundlePreview>(CHANNELS.diagnosticsPreviewBundle),

  /** 用户确认后导出。主进程弹保存对话框；用户取消时返回的 path 为 null。 */
  exportBundle: (reveal = true) =>
    invoke<BundleExportResult>(CHANNELS.diagnosticsExportBundle, { reveal }),

  /** 安全模式态（含被禁用能力清单与上一稳定版本号）。 */
  getSafeModeState: async () =>
    (await invoke<DiagnosticsReport>(CHANNELS.diagnosticsGetReport)).safeMode,

  /** 最近一次启动健康检查的完整报告。 */
  getHealthReport: () => invoke<DiagnosticsReport>(CHANNELS.diagnosticsGetReport),
};
