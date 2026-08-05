/**
 * `window.piBuddy.backup`（BKP-101）。
 *
 * 四个方法、四条通道，**没有一个形参**。渲染进程在这里能表达的极限是
 * 「现在什么状态」「做一次备份」「校验一份备份」「从一份备份恢复」——
 * 备份写到哪、从哪个目录恢复，全由主进程弹出的目录选择框决定。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  BackupCreateResult,
  BackupRestoreResult,
  BackupStatus,
  BackupValidation,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const backup = {
  /** 上次备份时间、上次校验结论、是否有待套用的恢复、本次构建的备份范围。 */
  describe: () => invoke<BackupStatus>(CHANNELS.backupDescribe),

  /** 主进程弹目录选择框 → 逐库快照 → 自校验 → 就位。用户取消时 path 为 null。 */
  create: () => invoke<BackupCreateResult>(CHANNELS.backupCreate),

  /** 只读校验一份既有备份。失败原因逐条返回，不是一句「无效」。 */
  validate: () => invoke<BackupValidation>(CHANNELS.backupValidate),

  /** 恢复。主进程会先弹确认框；成功后恒 restartRequired（见契约注释）。 */
  restore: () => invoke<BackupRestoreResult>(CHANNELS.backupRestore),
};
