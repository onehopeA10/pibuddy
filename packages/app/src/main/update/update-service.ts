/**
 * UpdateService —— 更新子系统的**唯一状态源**（UPD-001 ~ UPD-004）。
 *
 * ## 为什么状态必须集中在 main
 *
 * 更新是唯一一个错了就可能砸掉用户数据的子系统。渲染进程可以被刷新、被
 * 注入、被开多个窗口；只要状态有一份副本在那边，就一定会出现「界面显示
 * 下载中，主进程其实已经失败了」这种分叉。因此这里的规则是：renderer 只
 * 读快照 + 订阅事件，任何写入都必须是一次 IPC 动作，动作的返回值又是新的
 * 权威快照。
 *
 * ## 三件靠人工点测发现不了的事，全部在这里，全部有单测
 *
 *  1. **初始化顺序**。`allowDowngrade = false` 必须写在 channel /
 *     allowPrerelease 之后 —— 这两个 setter 在 electron-updater 内部可能
 *     联动 downgrade 标志，先写就会被后面的赋值覆盖掉。表现是某次发布回滚
 *     后，所有用户被"更新"回旧版本。
 *  2. **single-flight**。用户连点三下「检查更新」，或者自动检查与手动检查
 *     撞在一起，底层必须只跑一次。多跑的表现是进度条来回跳、下载文件互相
 *     覆盖。
 *  3. **监听器只注册一组**。重复 init 会让 download-progress 叠加 N 份，
 *     进度事件按 N 倍频率推给渲染进程。
 *
 * ## 本文件不 import electron / electron-updater
 *
 * 真正的 autoUpdater 由 update-ipc.ts 注入。这样以上三条能在纯 node 的
 * vitest 里被断言，而不是断言一个给 electron 打的桩。
 */
import {
  PROTOCOL_VERSION,
  sanitizeReleaseNotes,
  type UpdateBlocker,
  type UpdateChannel,
  type UpdateCheckSource,
  type UpdateEnvelope,
  type UpdateState,
  type UpdateStatus,
} from "@pibuddy/contract";

import { isPrerelease } from "./release-integrity.js";
import { mapUpdaterError } from "./update-errors.js";
import {
  DEFAULT_UPDATE_PREFS,
  nodeTimerApi,
  type CancellationTokenLike,
  type TimerApi,
  type TimerHandle,
  type UpdatePrefs,
  type UpdateServiceDeps,
} from "./update-types.js";

/** 主窗口可交互后，等这么久才做第一次检查。 */
export const FIRST_CHECK_DELAY_MS = 30_000;
/** 静默检查的基线间隔。 */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/**
 * 网络失败后的退避阶梯。第四次及以后停在 4h，不再继续拉长 ——
 * 再长就等于放弃更新，而用户完全看不到发生了什么。
 */
export const BACKOFF_MS = [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000] as const;
/** 手动检查的防连点窗口。不是节流策略，只是防手抖。 */
export const MANUAL_DEBOUNCE_MS = 500;
/** 「稍后」之后，同一候选版本多久内不再主动弹 banner。 */
export const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

/** updater 的六个事件；注册一次，一个不多。 */
const UPDATER_EVENTS = [
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
  "error",
] as const;

type UpdateInfoLike = {
  version?: string;
  releaseDate?: string;
  releaseNotes?: unknown;
  files?: Array<{ sha512?: string; size?: number }>;
};

type ProgressLike = {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
};

export class UpdateService {
  private readonly deps: UpdateServiceDeps;
  private readonly timers: TimerApi;
  private readonly now: () => number;
  private readonly random: () => number;

  private prefs: UpdatePrefs;
  private state: UpdateState;

  /** 传输层序号。与 state.stateSequence 是两件事，见 contract/update.ts。 */
  private txSequence = 0;
  /** 主进程一次运行的代际。进程重启后由调用方 +1（默认取启动时间）。 */
  private readonly generation: number;

  /**
   * **通道代际**。与上面的进程 `generation` 是两件事：那个标识"哪一次进程
   * 运行"，这个标识"哪一次通道配置"，每次 setChannel +1。
   *
   * 口径抄自 main/pi-supervisor.ts 的 runtime generation：作废一批在途任务
   * 的唯一可靠办法不是"把它停下来"（停不下来 —— 请求已经在网络上了），
   * 而是给它盖一个戳，回来时对不上就丢掉。
   */
  private channelGeneration = 0;
  /** 最近一次启动的检查/下载所属的通道代际。事件按它判定是否迟到。 */
  private opGeneration = 0;

  // ---- single-flight：三个动作各一把锁，进入时判空，finally 复位 ----
  private checkInFlight = false;
  private downloadInFlight = false;
  private downloadCancellationPending = false;
  private installInFlight = false;
  private lastManualCheckAt = 0;

  private timer: TimerHandle | null = null;
  private failureStreak = 0;
  private cancelToken: CancellationTokenLike | null = null;
  private idleUnsubscribe: (() => void) | null = null;
  private started = false;

  /** 本进程内已经主动提示过的候选版本（「同一 candidate 只主动提示一次」）。 */
  private readonly announced = new Set<string>();

  /** 已下载安装包的路径与校验信息，只在主进程里流转。 */
  private downloadedPath: string | null = null;
  private expectedSha512: string | null = null;

  constructor(deps: UpdateServiceDeps, generation = 0) {
    this.deps = deps;
    this.timers = deps.timers ?? nodeTimerApi;
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.generation = generation;
    this.prefs = { ...DEFAULT_UPDATE_PREFS, ...deps.prefs.load() };

    this.state = {
      status: this.supported() ? "idle" : "unsupported",
      stateSequence: 0,
      currentVersion: deps.currentVersion,
      candidateVersion: null,
      channel: this.prefs.channel,
      checkSource: null,
      lastCheckedAt: null,
      releaseDate: null,
      releaseNotes: null,
      bytesTransferred: 0,
      totalBytes: 0,
      percent: 0,
      bytesPerSecond: 0,
      errorCode: null,
      retryable: false,
      dismissedVersion: this.prefs.dismissedVersion,
      autoCheck: this.prefs.autoCheck,
      autoDownload: this.prefs.autoDownload,
      cancelSupported: deps.cancelSupported,
      blockers: [],
    };

    if (this.supported()) this.initAutoUpdater();
  }

  // ------------------------------------------------------------ 环境判定

  /**
   * 本环境是否支持自更新。
   *
   * dev 下**绝不**访问生产更新源：没打包时 app-update.yml 根本不存在，
   * 真去 check 只会得到一串对开发者毫无意义的报错；更重要的是，只要这条
   * 路存在，某次调试就可能把开发机指向真实 feed 并装下一个包。
   * 唯一的例外是显式设置 PIBUDDY_FAKE_UPDATE_FEED —— 那是本地 fake server。
   */
  private supported(): boolean {
    return this.deps.isPackaged || Boolean(this.deps.fakeFeedUrl);
  }

  // ------------------------------------------------------------ 初始化

  /**
   * updater 的属性赋值。**顺序写死，不许重排**。
   *
   *   autoDownload → autoInstallOnAppQuit → channel → allowPrerelease → allowDowngrade
   *
   * allowDowngrade 排最后的理由见文件头。logger 的接线**不在**这里，
   * 那是日志的事，不是更新策略的事（也让上面这条顺序断言保持干净）。
   */
  private initAutoUpdater(): void {
    const u = this.deps.updater;

    // 重复 init 不叠加监听器。先摘干净再挂，是唯一能让 listenerCount 恒为 1
    // 的写法 —— 靠「记得只调一次 init」不是结构性保证。
    for (const event of UPDATER_EVENTS) u.removeAllListeners(event);

    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    u.channel = this.prefs.channel === "beta" ? "beta" : "latest";
    u.allowPrerelease = this.prefs.channel === "beta";
    u.allowDowngrade = false;

    if (this.deps.fakeFeedUrl) {
      // 只有 fake feed 分支才碰 setFeedURL 与 forceDevUpdateConfig。
      // 生产走 app-update.yml，主进程都不该有第二个地方能改 feed；
      // 而 forceDevUpdateConfig 在打包产物里恒不被触碰。
      u.forceDevUpdateConfig = true;
      u.setFeedURL({ provider: "generic", url: this.deps.fakeFeedUrl });
    }

    u.on("checking-for-update", () => this.onChecking());
    u.on("update-available", (info: unknown) => this.onAvailable(info as UpdateInfoLike));
    u.on("update-not-available", () => this.onNotAvailable());
    u.on("download-progress", (p: unknown) => this.onProgress(p as ProgressLike));
    u.on("update-downloaded", (info: unknown) =>
      this.onDownloaded(info as UpdateInfoLike & { downloadedFile?: string })
    );
    u.on("error", (err: unknown) => this.onError(err));
  }

  // ------------------------------------------------------------ 状态广播

  /**
   * 提交一次状态变更。
   *
   * stateSequence 在这里、且只在这里 +1。快照与事件带的是同一个数，
   * renderer 因此可以在 reload 之后先取快照、再订阅，并丢掉所有
   * stateSequence 不大于快照的迟到事件。
   *
   * 「无订阅者时状态不丢」也由这里保证：状态先落在 this.state 上，广播只是
   * 副产品。renderer 是后挂载的，若状态只走事件不进快照，用户刷新窗口会
   * 看到一个假的 idle。
   */
  private commit(patch: Partial<UpdateState>): UpdateState {
    this.state = {
      ...this.state,
      ...patch,
      stateSequence: this.state.stateSequence + 1,
    };
    const envelope: UpdateEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      generation: this.generation,
      sequence: this.txSequence++,
      occurredAt: this.now(),
      payload: this.state,
    };
    try {
      this.deps.broadcast(envelope);
    } catch (err) {
      // 广播失败（窗口刚销毁）不能反过来把状态机搞坏
      this.deps.logger.warn("update_broadcast_failed", { error: String(err) });
    }
    return this.state;
  }

  /** 当前权威快照。 */
  getState(): UpdateState {
    return this.state;
  }

  // ------------------------------------------------------------ 迟到事件闸门

  /**
   * 这个事件是不是"切换通道之前那次请求"带回来的。
   *
   * 只重配 updater 是不够的：`initAutoUpdater` 里的 `removeAllListeners`
   * 摘掉的是**旧的监听器**，而旧请求的回调是在同一个 emitter 上发出的，
   * 落进的是**新挂上去的**监听器。因此判据必须挂在"这次请求属于哪一代"
   * 上，而不是"这个监听器属于哪一代"。
   */
  private dropStale(event: string): boolean {
    if (this.opGeneration === this.channelGeneration) return false;
    this.deps.logger.info("update_stale_event_dropped", {
      event,
      eventGeneration: this.opGeneration,
      currentGeneration: this.channelGeneration,
      channel: this.prefs.channel,
    });
    return true;
  }

  /**
   * 第二道、也是决定性的一道：候选版本与当前通道是否相符。
   *
   * 代际闸门挡不住这种交错 —— 旧的 beta 请求还在路上，用户切到 stable 之后
   * 又点了一次「检查更新」（opGeneration 因此追平），此时旧 beta 响应回来，
   * 代际对得上。但 beta 产物的版本号必然带 prerelease 标记，而 stable 通道
   * 按定义永远不接受 prerelease，于是它在这里被拦下。
   *
   * 反方向（stable→beta 后收到一个正式版候选）刻意放行：beta 通道本来就是
   * stable 的超集（allowPrerelease=true 时正式版照收），那不是错配。
   */
  private matchesChannel(version: string | null): boolean {
    if (!version) return true;
    if (this.prefs.channel === "beta") return true;
    return !isPrerelease(version);
  }

  /** 通道对不上就丢，并留痕。 */
  private dropOffChannel(event: string, version: string | null): boolean {
    if (this.matchesChannel(version)) return false;
    this.deps.logger.info("update_off_channel_candidate_dropped", {
      event,
      version,
      channel: this.prefs.channel,
    });
    return true;
  }

  // ------------------------------------------------------------ updater 事件

  private onChecking(): void {
    if (this.dropStale("checking-for-update")) return;
    if (this.state.status === "checking") return;
    this.commit({ status: "checking" });
  }

  private onAvailable(info: UpdateInfoLike): void {
    if (this.dropStale("update-available")) return;
    const version = info?.version ?? null;
    if (this.dropOffChannel("update-available", version)) return;
    this.expectedSha512 = info?.files?.[0]?.sha512 ?? null;
    this.failureStreak = 0;
    this.commit({
      status: "available",
      candidateVersion: version,
      releaseDate: info?.releaseDate ?? null,
      releaseNotes: sanitizeReleaseNotes(info?.releaseNotes),
      totalBytes: info?.files?.[0]?.size ?? 0,
      errorCode: null,
      retryable: false,
      lastCheckedAt: this.now(),
    });
    if (version) {
      this.announced.add(version);
      while (this.announced.size > 100) {
        const oldest = this.announced.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.announced.delete(oldest);
      }
    }
    if (this.prefs.autoDownload) void this.downloadUpdate();
  }

  private onNotAvailable(): void {
    if (this.dropStale("update-not-available")) return;
    this.failureStreak = 0;
    this.commit({
      status: "not-available",
      candidateVersion: null,
      errorCode: null,
      retryable: false,
      lastCheckedAt: this.now(),
    });
  }

  private onProgress(p: ProgressLike): void {
    if (this.dropStale("download-progress")) return;
    this.commit({
      status: "downloading",
      percent: Math.max(0, Math.min(100, p?.percent ?? 0)),
      bytesTransferred: p?.transferred ?? 0,
      totalBytes: p?.total ?? this.state.totalBytes,
      bytesPerSecond: p?.bytesPerSecond ?? 0,
    });
  }

  private onDownloaded(info: UpdateInfoLike & { downloadedFile?: string }): void {
    if (this.dropStale("update-downloaded")) return;
    // 通道对不上的产物连 downloadedPath 都不许落下来：留着它就意味着
    // 「切到 stable 之后仍然能把刚下完的 beta 包装上去」。
    if (this.dropOffChannel("update-downloaded", info?.version ?? null)) return;
    this.downloadedPath = info?.downloadedFile ?? null;
    if (info?.files?.[0]?.sha512) this.expectedSha512 = info.files[0].sha512 ?? null;
    this.commit({
      status: "downloaded",
      candidateVersion: info?.version ?? this.state.candidateVersion,
      releaseDate: info?.releaseDate ?? this.state.releaseDate,
      releaseNotes: info?.releaseNotes
        ? sanitizeReleaseNotes(info.releaseNotes)
        : this.state.releaseNotes,
      percent: 100,
      bytesPerSecond: 0,
    });
  }

  private onError(err: unknown): void {
    // 旧通道请求的失败不该染红新通道的界面：用户刚切到 stable，看到的却是
    // 一条来自 beta 源的网络错误，而重试按钮点下去一切正常。
    if (this.dropStale("error")) return;
    if (this.downloadCancellationPending && this.state.status === "idle") {
      this.deps.logger.info("update_cancel_error_dropped");
      return;
    }
    const info = mapUpdaterError(err);
    this.deps.logger.warn("update_error", { code: info.code, detail: info.detail });
    if (info.code === "network") this.failureStreak++;
    this.commit({ status: "error", errorCode: info.code, retryable: info.retryable });
  }

  // ------------------------------------------------------------ 动作

  /**
   * 检查更新。
   *
   * single-flight：并发进来的第二、三次直接返回当前快照，底层
   * checkForUpdates 只跑一次。手动检查另外有 500ms 防连点窗口 ——
   * 那不是节流策略（手动检查按规格不受静默节流约束），只是防手抖。
   */
  async checkForUpdates(source: UpdateCheckSource = "auto"): Promise<UpdateState> {
    if (!this.supported()) return this.state;
    if (this.checkInFlight) return this.state;

    if (source === "manual") {
      const now = this.now();
      if (now - this.lastManualCheckAt < MANUAL_DEBOUNCE_MS) return this.state;
      this.lastManualCheckAt = now;
    } else if (!this.prefs.autoCheck) {
      return this.state;
    }

    const gen = this.channelGeneration;
    this.opGeneration = gen;
    this.checkInFlight = true;
    this.commit({ status: "checking", checkSource: source, errorCode: null });
    try {
      await this.deps.updater.checkForUpdates();
    } catch (err) {
      this.onError(err);
    } finally {
      // 代际变了说明这次请求已经被 setChannel 作废：锁与调度都已由
      // abortInFlight 复位、并可能已被新一次检查重新占用。旧任务的 finally
      // 在这里回写，等于把**新任务**的 single-flight 锁解开。
      if (gen === this.channelGeneration) {
        this.checkInFlight = false;
        // 无论成败都重排下一次：失败走退避阶梯，成功回 4h 基线。
        this.scheduleNext();
      }
    }
    return this.state;
  }

  /** 开始下载。同样 single-flight。 */
  async downloadUpdate(): Promise<UpdateState> {
    if (!this.supported()) return this.state;
    if (this.downloadInFlight) return this.state;
    if (this.state.status === "downloaded") return this.state;

    const gen = this.channelGeneration;
    this.opGeneration = gen;
    this.downloadInFlight = true;
    this.downloadCancellationPending = false;
    this.cancelToken = this.deps.createCancellationToken?.() ?? null;
    this.commit({
      status: "downloading",
      percent: 0,
      bytesTransferred: 0,
      bytesPerSecond: 0,
      errorCode: null,
    });
    try {
      await this.deps.updater.downloadUpdate(this.cancelToken ?? undefined);
    } catch (err) {
      this.onError(err);
    } finally {
      // 同 checkForUpdates：作废掉的旧下载不许再碰锁与令牌，否则它的收尾
      // 会把切换之后新开的那次下载一起解锁。
      if (gen === this.channelGeneration) {
        this.downloadInFlight = false;
        this.downloadCancellationPending = false;
        this.cancelToken = null;
      }
    }
    return this.state;
  }

  /**
   * 取消下载。
   *
   * 只有在 updater 真的支持 CancellationToken 时才可能被调到 —— 界面上
   * 那个按钮由 `cancelSupported` 能力位控制，不支持就根本不渲染，绝不放
   * 一个点了没反应的按钮。
   */
  cancelDownload(): UpdateState {
    if (!this.deps.cancelSupported) return this.state;
    if (!this.downloadInFlight || !this.cancelToken) return this.state;
    this.cancelToken.cancel();
    this.cancelToken = null;
    this.downloadCancellationPending = true;
    return this.commit({
      status: "idle",
      percent: 0,
      bytesTransferred: 0,
      bytesPerSecond: 0,
    });
  }

  /**
   * 安装并重启。
   *
   * 三步，一步都不能省：
   *   1. **完整性校验** —— 版本必须严格更新、文件 sha512 必须对得上。
   *      不通过直接进 error，quitAndInstall 一次都不会被调用。
   *   2. **阻断项检查** —— 有正在跑的 Agent / 未保存草稿 / 正在录音 /
   *      待处理权限请求时，绝不静默重启。mode='wait' 进 waiting-for-agent
   *      并**订阅** agent_settled（不是轮询）；mode='force' 才继续。
   *   3. quitAndInstall。
   */
  async installAndRestart(mode: "now" | "wait" | "force" = "now"): Promise<UpdateState> {
    if (!this.supported()) return this.state;
    if (this.installInFlight) return this.state;
    if (this.state.status !== "downloaded" && this.state.status !== "waiting-for-agent") {
      return this.state;
    }

    this.installInFlight = true;
    try {
      const verdict = this.deps.verifyBeforeInstall({
        version: this.state.candidateVersion,
        currentVersion: this.state.currentVersion,
        filePath: this.downloadedPath,
        expectedSha512: this.expectedSha512,
      });
      if (!verdict.ok) {
        this.deps.logger.error("update_integrity_rejected", {
          code: verdict.errorCode,
          reason: verdict.reason,
        });
        this.commit({
          status: "error",
          errorCode: verdict.errorCode ?? "unknown",
          retryable: false,
        });
        return this.state;
      }

      const blockers = this.deps.blockers.collectBlockers();
      if (blockers.length > 0 && mode !== "force") {
        if (mode === "wait") {
          this.armIdleWait();
          this.commit({ status: "waiting-for-agent", blockers });
        } else {
          // mode='now' 且有阻断项：把清单交给界面，由用户三选一
          this.commit({ blockers });
        }
        return this.state;
      }

      this.disarmIdleWait();
      this.commit({ status: "installing", blockers: [] });
      this.stopSchedule();

      // pending-update marker 必须在 quitAndInstall **之前**落盘：这一行之后
      // 进程随时可能被替换掉，marker 写晚一步就永远写不上，下次启动也就
      // 无从知道「这是更新之后的第一次启动」，健康检查与安全模式整条链失效。
      // 写失败不阻断安装 —— 更新本身比诊断能力重要，但要留痕。
      try {
        this.deps.markers?.writePendingUpdate(
          this.state.currentVersion,
          this.state.candidateVersion ?? "unknown"
        );
      } catch (err) {
        this.deps.logger.warn("update_marker_write_failed", { error: String(err) });
      }

      this.deps.updater.quitAndInstall(false, true);
      return this.state;
    } finally {
      this.installInFlight = false;
    }
  }

  /**
   * 订阅「任务真的空了」。
   *
   * 订阅式而不是轮询：本目录下的定时轮询命中数必须恒为 0（结构断言）。
   * 回调触发后立刻退订，否则每尝试一次安装就漏一个监听器。
   */
  private armIdleWait(): void {
    this.disarmIdleWait();
    this.idleUnsubscribe = this.deps.blockers.whenIdle(() => {
      this.idleUnsubscribe = null;
      void this.installAndRestart("force");
    });
  }

  private disarmIdleWait(): void {
    if (this.idleUnsubscribe) {
      this.idleUnsubscribe();
      this.idleUnsubscribe = null;
    }
  }

  // ------------------------------------------------------------ 偏好

  /**
   * 切换更新通道。
   *
   * 重配 updater **不等于**作废旧任务。切换之前发出的那次检查/下载仍然在
   * 路上，它带回来的候选版本属于用户刚刚切走的通道；写进状态的表现是
   * 「我明明切回 stable 了，它却告诉我有个 beta 版可以装」，而那个 beta 包
   * 甚至已经躺在磁盘上、点一下就装得上去。
   *
   * 因此这里做三件事，一件都不能省：
   *   1. 通道代际 +1 —— 旧任务的事件与收尾从这一刻起全部作废；
   *   2. 取消在途下载、丢弃已下载产物；
   *   3. 才是重跑 initAutoUpdater（allowPrerelease 与 channel 联动，
   *      allowDowngrade 必须在它们之后被重新钉成 false）。
   */
  setChannel(channel: UpdateChannel): UpdateState {
    if (channel === this.prefs.channel) return this.state;

    this.channelGeneration++;
    this.abortInFlight();

    this.savePrefs({ channel });
    if (this.supported()) this.initAutoUpdater();
    return this.commit({
      channel,
      candidateVersion: null,
      status: "idle",
      // 进度与错误一起清干净：留下 87% 的进度条属于上一条通道的下载。
      percent: 0,
      bytesTransferred: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      releaseDate: null,
      releaseNotes: null,
      errorCode: null,
      retryable: false,
      blockers: [],
    });
  }

  /**
   * 作废在途任务。
   *
   * `downloadedPath` / `expectedSha512` 必须一起清 —— 它们指向的是另一条
   * 通道的安装包，留着就等于「切到 stable 之后仍然能把刚下好的 beta 包装上」。
   * `announced` 也清：换了通道之后，同一个版本号应当被重新当作新消息。
   */
  private abortInFlight(): void {
    this.cancelToken?.cancel();
    this.cancelToken = null;
    this.checkInFlight = false;
    this.downloadInFlight = false;
    this.downloadedPath = null;
    this.expectedSha512 = null;
    this.announced.clear();
    this.disarmIdleWait();
  }

  setAutoCheck(enabled: boolean): UpdateState {
    this.savePrefs({ autoCheck: enabled });
    if (enabled) this.scheduleNext();
    else this.stopSchedule();
    return this.commit({ autoCheck: enabled });
  }

  setAutoDownload(enabled: boolean): UpdateState {
    this.savePrefs({ autoDownload: enabled });
    return this.commit({ autoDownload: enabled });
  }

  /**
   * 「稍后」。
   *
   * dismiss 状态归 main 持久化，渲染进程不碰 localStorage —— 那份数据
   * 会随着「清除浏览数据」、多窗口、隐私模式各自漂移，而用户的预期是
   * 「我说了稍后，它就该 24 小时别再烦我」。
   */
  dismissVersion(version: string): UpdateState {
    this.savePrefs({
      dismissedVersion: version,
      dismissedUntil: this.now() + DISMISS_TTL_MS,
    });
    return this.commit({ dismissedVersion: version });
  }

  /**
   * 该候选版本此刻是否应该主动弹 banner。
   *
   * 设置页不受此影响：那里始终显示「有 x.y.z 可用」。
   */
  shouldAnnounce(version: string | null = this.state.candidateVersion): boolean {
    if (!version) return false;
    if (this.prefs.dismissedVersion !== version) return true;
    const until = this.prefs.dismissedUntil ?? 0;
    return this.now() >= until;
  }

  private savePrefs(patch: Partial<UpdatePrefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    try {
      this.deps.prefs.save(this.prefs);
    } catch (err) {
      this.deps.logger.warn("update_prefs_save_failed", { error: String(err) });
    }
  }

  // ------------------------------------------------------------ 调度

  /**
   * 主窗口可交互了。30 秒后做第一次检查 —— 不在启动瞬间做，是因为那会儿
   * 主线程正忙着渲染首屏，一次网络请求足以让首帧再晚半秒。
   */
  onWindowReady(): void {
    if (!this.supported() || this.started) return;
    this.started = true;
    this.arm(FIRST_CHECK_DELAY_MS, "startup");
  }

  /**
   * 排下一次静默检查。
   *
   * 成功：4h * (1.10 ~ 1.20)。抖动不是为了好看 —— 没有抖动的话，同一批
   * 装机的用户会在同一秒集体敲发布源。
   * 失败：按 15min → 1h → 4h 退避，成功后清零回基线。
   */
  private scheduleNext(): void {
    if (!this.supported() || !this.prefs.autoCheck) return;
    const delay =
      this.failureStreak > 0
        ? BACKOFF_MS[Math.min(this.failureStreak, BACKOFF_MS.length) - 1]
        : CHECK_INTERVAL_MS * (1 + 0.1 + this.random() * 0.1);
    this.arm(delay, "auto");
  }

  private arm(delay: number, source: UpdateCheckSource): void {
    this.stopSchedule();
    const handle = this.timers.setTimeout(() => {
      this.timer = null;
      void this.checkForUpdates(source);
    }, delay);
    // 定时器不能拖着主进程不让退出：用户点了关闭还要等 4 小时是不可接受的。
    handle.unref?.();
    this.timer = handle;
  }

  private stopSchedule(): void {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 退出前拆干净：定时器、idle 订阅、updater 监听器。 */
  dispose(): void {
    this.stopSchedule();
    this.disarmIdleWait();
    for (const event of UPDATER_EVENTS) this.deps.updater.removeAllListeners(event);
  }

  // ------------------------------------------------------------ 测试可见的内部量

  /** 仅供单测：当前是否有排好的定时器。 */
  hasScheduledCheck(): boolean {
    return this.timer !== null;
  }

  /** 仅供单测与诊断：状态机当前状态字面量。 */
  get status(): UpdateStatus {
    return this.state.status;
  }

  /** 仅供诊断：当前阻断项（不改状态）。 */
  peekBlockers(): UpdateBlocker[] {
    return this.deps.blockers.collectBlockers();
  }
}
