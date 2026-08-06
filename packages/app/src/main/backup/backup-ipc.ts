/**
 * 备份 / 恢复四条通道的接线（BKP-101）。
 *
 * 与其余 *-ipc.ts 同构：**本文件不出现 ipcMain.handle**，注册一律经
 * ipc-guard 的 registerHandler，四道闸因此对备份通道自动生效。
 *
 * 四条通道**都不接受路径形参**：备份写到哪、从哪个目录恢复，由主进程弹出的
 * 目录选择框决定。渲染进程若能给出路径，「备份」就退化成一条「把应用数据
 * 复制到任意目录」的旁路，而「恢复」更严重 —— 它退化成「用任意目录的内容
 * 覆盖应用数据」。这与 diagnostics 三条通道是同一条纪律。
 */
import { BrowserWindow, app, dialog, shell } from "electron";
import path from "node:path";

import {
  CHANNELS,
  voidRequestSchema,
  type BackupCreateResult,
  type BackupRestoreResult,
  type BackupStatus,
  type BackupValidation,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { createLogger, type Logger } from "../logger.js";
import {
  applyPendingRestore,
  backupDirName,
  backupStoreIds,
  createBackup,
  hasPendingRestore,
  quarantinePendingRestore,
  readBackupState,
  stagePendingRestore,
  validateBackupAt,
  writeBackupState,
} from "./backup-service.js";

/**
 * 本内核设施注册的全部通道。
 *
 * **不导出**：本文件 import 了 electron（目录选择框 / 覆盖确认框），单测导入不了它，
 * 所以「供对账恰 4 条」这种导出理由在这里根本兑现不了——仓库里另外二十几个
 * `*_CHANNELS` 都是同一个成因的死导出。通道数真正的守卫在契约侧：分片进
 * `sealChannelContracts` 时少一条会加载期抛错，`check-contract-uniqueness` 再对一遍。
 */
const BACKUP_CHANNELS = [
  CHANNELS.backupDescribe,
  CHANNELS.backupCreate,
  CHANNELS.backupValidate,
  CHANNELS.backupRestore,
] as const;

let cachedLog: Logger | null = null;
function log(): Logger {
  if (!cachedLog) cachedLog = createLogger("main").child({ mod: "backup" });
  return cachedLog;
}

function dataDir(): string {
  return app.getPath("userData");
}

function ownerWindow(senderId?: number): BrowserWindow | null {
  const all = BrowserWindow.getAllWindows();
  if (senderId !== undefined) {
    const hit = all.find((w) => w.webContents.id === senderId);
    if (hit) return hit;
  }
  return all[0] ?? null;
}

/**
 * 弹目录选择框，返回用户选中的目录；取消返回 null。
 *
 * `openDirectory` 而不是 `openFile`：备份是一个目录（清单 + db/ 子目录），
 * 让用户去选其中某一个文件只会选错。
 */
async function pickDirectory(title: string, senderId: number): Promise<string | null> {
  const win = ownerWindow(senderId);
  const picked = win
    ? await dialog.showOpenDialog(win, { title, properties: ["openDirectory", "createDirectory"] })
    : await dialog.showOpenDialog({ title, properties: ["openDirectory", "createDirectory"] });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  return picked.filePaths[0] ?? null;
}

async function status(): Promise<BackupStatus> {
  const state = await readBackupState(dataDir());
  return {
    lastBackup: state.lastBackup,
    lastValidation: state.lastValidation,
    pendingRestore: await hasPendingRestore(dataDir()),
    storeIds: backupStoreIds(),
  };
}

/**
 * 启动期套用暂存的恢复。
 *
 * **调用点必须在任何 store 打开之前**（main/index.ts 的 whenReady 里、
 * registerIpc() 之前）。放到后面一行，第一条被打开的 sqlite 就会在 Windows 上
 * 让 rename 以 EPERM 失败，而失败的表现是「恢复了但数据没变」。
 */
export async function applyPendingRestoreOnStartup(): Promise<void> {
  try {
    const outcome = await applyPendingRestore(dataDir());
    if (outcome.applied) {
      log().info("backup_restore_applied", { files: outcome.stores });
    } else if (outcome.reason !== null) {
      log().warn("backup_restore_discarded", { reason: outcome.reason });
    }
  } catch (err) {
    // 恢复失败不许拦启动：拦了的话用户连「换一份备份再试」的界面都进不去。
    let quarantinedPath: string | null = null;
    try {
      quarantinedPath = await quarantinePendingRestore(dataDir());
    } catch (quarantineError) {
      log().warn("backup_restore_quarantine_failed", { error: String(quarantineError) });
    }
    log().warn("backup_restore_failed", { error: String(err), quarantinedPath });
  }
}

export function registerBackupIpc(): void {
  registerHandler<void, BackupStatus>(CHANNELS.backupDescribe, voidRequestSchema, () => status());

  registerHandler<void, BackupCreateResult>(
    CHANNELS.backupCreate,
    voidRequestSchema,
    async (_payload, event): Promise<BackupCreateResult> => {
      const parent = await pickDirectory("选择备份保存位置", event.sender.id);
      if (parent === null) return { path: null, validation: null };

      const at = Date.now();
      const destination = path.join(parent, backupDirName(at));
      const result = await createBackup({
        dataDir: dataDir(),
        destinationRoot: destination,
        appVersion: typeof app.getVersion === "function" ? app.getVersion() : "0.0.0",
      });
      const state = await readBackupState(dataDir());
      await writeBackupState(dataDir(), {
        ...state,
        lastBackup: {
          path: result.path,
          at: result.manifest.createdAt,
          fileCount: result.validation.fileCount,
          totalBytes: result.validation.totalBytes,
        },
        lastValidation: result.validation,
      });
      log().info("backup_created", {
        stores: result.manifest.stores.length,
        fileCount: result.validation.fileCount,
        totalBytes: result.validation.totalBytes,
      });
      // showItemInFolder 只定位，不是 openExternal —— 外链出口依然唯一。
      shell.showItemInFolder(result.path);
      return { path: result.path, validation: result.validation };
    }
  );

  registerHandler<void, BackupValidation>(
    CHANNELS.backupValidate,
    voidRequestSchema,
    async (_payload, event): Promise<BackupValidation> => {
      const picked = await pickDirectory("选择要校验的备份目录", event.sender.id);
      if (picked === null) {
        return {
          ok: false,
          path: null,
          createdAt: null,
          fileCount: 0,
          totalBytes: 0,
          stores: [],
          reasons: ["已取消"],
          artifacts: null,
          checkedAt: Date.now(),
        };
      }
      const validation = await validateBackupAt(picked);
      const state = await readBackupState(dataDir());
      await writeBackupState(dataDir(), { ...state, lastValidation: validation });
      log().info("backup_validated", { ok: validation.ok, reasons: validation.reasons.length });
      return validation;
    }
  );

  registerHandler<void, BackupRestoreResult>(
    CHANNELS.backupRestore,
    voidRequestSchema,
    async (_payload, event): Promise<BackupRestoreResult> => {
      const picked = await pickDirectory("选择要恢复的备份目录", event.sender.id);
      if (picked === null) {
        return { path: null, staged: false, restartRequired: false, validation: null };
      }
      // 覆盖式恢复是不可撤销的。确认框里必须逐字说清「会覆盖什么、什么时候
      // 生效」——「确定要恢复吗？」这种问法等于没问。
      const win = ownerWindow(event.sender.id);
      const confirmOptions = {
        type: "warning" as const,
        buttons: ["取消", "恢复并重启后生效"],
        defaultId: 0,
        cancelId: 0,
        title: "从备份恢复",
        message: "恢复会覆盖当前的会话索引、记忆、任务、工作流等全部本地数据库。",
        detail:
          "被覆盖的数据无法找回。恢复不会立刻生效：数据库此刻正被应用打开着，" +
          "副本会先落到暂存区，下次启动应用时才真正套用。\n\n" +
          "恢复范围不含设置、账号凭据与产物文件本体。",
      };
      const confirm = win
        ? await dialog.showMessageBox(win, confirmOptions)
        : await dialog.showMessageBox(confirmOptions);
      if (confirm.response !== 1) {
        return { path: null, staged: false, restartRequired: false, validation: null };
      }

      const outcome = await stagePendingRestore(picked, dataDir());
      const state = await readBackupState(dataDir());
      await writeBackupState(dataDir(), { ...state, lastValidation: outcome.validation });
      log().info("backup_restore_staged", { path: picked });
      return {
        path: picked,
        staged: true,
        restartRequired: true,
        validation: outcome.validation,
      };
    }
  );
}
