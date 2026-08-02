/**
 * UpdateService 的**进程内部**类型。
 *
 * 这里刻意只放不跨进程的东西：跨进程的 UpdateStatus / UpdateState /
 * UpdateErrorCode / UpdateBlocker 全部住在 @pibuddy/contract/update.ts，
 * 本文件一律 import 过来用，绝不再声明第二份（契约唯一性闸门会当场拦下）。
 *
 * 本文件也刻意**不 import electron 或 electron-updater**：UpdateService 的
 * 状态机、调度与去重是这个子系统里最容易错、也最不可能靠人工点测发现的
 * 部分，它必须能在纯 node 的 vitest 里跑。真正的 autoUpdater 由
 * update-ipc.ts 在主进程里注入。
 */
import type { UpdateBlocker, UpdateErrorCode } from "@pibuddy/contract";

/**
 * electron-updater `autoUpdater` 的最小可替身面。
 *
 * 只列出 UpdateService 真正会碰的成员 —— 面越窄，单测里的假替身与真实
 * updater 之间的偏差就越小。
 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  /**
   * electron-updater 在 `app.isPackaged === false` 时会直接跳过检查
   * （日志里只有一句 "Skip checkForUpdates because application is not packed"）。
   * 这个开关是它官方留的 dev 逃生口，**只在注入 fake feed 时才置 true**：
   * 没有它，本地 fake feed 全流程验证根本跑不起来；乱开则等于让开发机
   * 直连生产 feed。
   */
  forceDevUpdateConfig?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
  listenerCount(event: string): number;
  setFeedURL(options: unknown): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(cancellationToken?: CancellationTokenLike): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** builder-util-runtime 的 CancellationToken 的最小面。 */
export interface CancellationTokenLike {
  cancel(): void;
}

/**
 * 定时器句柄。
 *
 * `unref` 是可选的：单测的假句柄要能记录「有没有被调用过」，而生产的
 * NodeJS.Timeout 本来就有。检查定时器必须 unref，否则用户点了关闭之后
 * 主进程还要挂到下一次 4 小时轮询才肯退出。
 */
export interface TimerHandle {
  unref?(): void;
}

/** 可注入的定时器 API（生产是 node 的 setTimeout/clearTimeout）。 */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** 生产环境的定时器实现。 */
export const nodeTimerApi: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

/** UpdateService 需要落盘的偏好（渲染进程不持有任何一份副本）。 */
export interface UpdatePrefs {
  channel: "stable" | "beta";
  autoCheck: boolean;
  autoDownload: boolean;
  /** 用户点过「稍后」的候选版本 */
  dismissedVersion: string | null;
  /** 该候选版本在此时间戳之前不再主动弹 banner（默认 +24h） */
  dismissedUntil: number | null;
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = {
  channel: "stable",
  autoCheck: true,
  autoDownload: false,
  dismissedVersion: null,
  dismissedUntil: null,
};

/** 偏好的持久化端口。生产实现落在 userData/update-prefs.json。 */
export interface UpdatePrefsStore {
  load(): UpdatePrefs;
  save(prefs: UpdatePrefs): void;
}

/** 最小日志面（接的是 main/logger.ts 的 createLogger，不新建第二个日志器）。 */
export interface UpdateLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * 安装阻断源。
 *
 * `whenIdle` 是**订阅式**的：注册一个回调，等到阻断项真的清空时被调用一次
 * 并自动退订。绝不允许写成「每秒查一次 collectBlockers()」—— 轮询在这里
 * 意味着应用永远有一个醒着的定时器，笔记本合盖后照样耗电。
 */
export interface BlockerSource {
  collectBlockers(): UpdateBlocker[];
  whenIdle(callback: () => void): () => void;
}

/** UpdateService 的构造依赖。全部可注入 = 全部可测。 */
export interface UpdateServiceDeps {
  updater: UpdaterLike;
  /** 取自 app.getVersion()；渲染进程侧任何硬编码版本号一律禁止 */
  currentVersion: string;
  /** app.isPackaged。false 且无 fake feed 时状态恒为 unsupported */
  isPackaged: boolean;
  prefs: UpdatePrefsStore;
  logger: UpdateLogger;
  blockers: BlockerSource;
  /** 把信封推给全部窗口 */
  broadcast(envelope: unknown): void;
  /** 本 electron-updater 是否导出可用的 CancellationToken */
  cancelSupported: boolean;
  /** 建一个取消令牌；cancelSupported=false 时可不提供 */
  createCancellationToken?: () => CancellationTokenLike;
  /** 安装前的完整性校验（版本单调 + sha512），返回 ok:false 时必须中止 */
  verifyBeforeInstall(candidate: InstallCandidate): IntegrityResult;
  /** 仅在 PIBUDDY_FAKE_UPDATE_FEED 存在时非空 */
  fakeFeedUrl?: string | null;
  timers?: TimerApi;
  now?: () => number;
  random?: () => number;
}

/** 安装前校验的入参。 */
export interface InstallCandidate {
  version: string | null;
  currentVersion: string;
  /** 已下载文件的绝对路径（只在主进程里流转） */
  filePath?: string | null;
  /** feed 声明的 sha512 */
  expectedSha512?: string | null;
}

/** 安装前校验的结果。ok:false 时 quitAndInstall 绝不允许被调用。 */
export interface IntegrityResult {
  ok: boolean;
  errorCode?: UpdateErrorCode;
  reason?: string;
}
