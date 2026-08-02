/**
 * UpdateService 的测试替身。
 *
 * 单独一个文件而不是各测试里各写一份：初始化顺序、single-flight、
 * 监听器计数三条断言必须看的是**同一个** updater 替身，否则「某个测试用的
 * 替身恰好宽松一点」这种事迟早发生。
 *
 * 这里刻意不 import vitest —— 替身自己记账（计数器 + 顺序数组），
 * 断言方式与测试框架解耦。
 */
import type { UpdateBlocker } from "@pibuddy/contract";

import type {
  BlockerSource,
  CancellationTokenLike,
  TimerApi,
  TimerHandle,
  UpdateLogger,
  UpdatePrefs,
  UpdatePrefsStore,
  UpdaterLike,
} from "./update-types.js";
import { DEFAULT_UPDATE_PREFS } from "./update-types.js";

type Listener = (...args: unknown[]) => void;

/**
 * autoUpdater 的替身。
 *
 * 五个策略属性用 getter/setter 记录**赋值顺序** —— 这是唯一能钉死
 * 「allowDowngrade 必须最后赋值」的方式：顺序错了不会有任何编译错误，
 * 也不会有任何运行时报错，只会在某次发布回滚后把用户降级回旧版本。
 */
export class FakeUpdater implements UpdaterLike {
  /** 策略属性的赋值顺序 */
  readonly assigned: string[] = [];
  readonly listeners = new Map<string, Listener[]>();

  checkCalls = 0;
  downloadCalls = 0;
  setFeedCalls = 0;
  quitCalls = 0;
  lastToken: CancellationTokenLike | undefined;

  /** checkForUpdates 被调用时执行（用来模拟 available / error 等回调）。 */
  onCheck: (() => void | Promise<void>) | null = null;
  /** downloadUpdate 被调用时执行。 */
  onDownload: (() => void | Promise<void>) | null = null;

  /** 普通字段，不参与 assigned 顺序记录（它不是更新策略的一部分）。 */
  forceDevUpdateConfig = false;

  private _autoDownload = true;
  private _autoInstallOnAppQuit = true;
  private _channel: string | null = null;
  private _allowPrerelease = false;
  private _allowDowngrade = true;

  get autoDownload(): boolean {
    return this._autoDownload;
  }
  set autoDownload(v: boolean) {
    this.assigned.push("autoDownload");
    this._autoDownload = v;
  }

  get autoInstallOnAppQuit(): boolean {
    return this._autoInstallOnAppQuit;
  }
  set autoInstallOnAppQuit(v: boolean) {
    this.assigned.push("autoInstallOnAppQuit");
    this._autoInstallOnAppQuit = v;
  }

  get channel(): string | null {
    return this._channel;
  }
  set channel(v: string | null) {
    this.assigned.push("channel");
    this._channel = v;
  }

  get allowPrerelease(): boolean {
    return this._allowPrerelease;
  }
  set allowPrerelease(v: boolean) {
    this.assigned.push("allowPrerelease");
    this._allowPrerelease = v;
  }

  get allowDowngrade(): boolean {
    return this._allowDowngrade;
  }
  set allowDowngrade(v: boolean) {
    this.assigned.push("allowDowngrade");
    this._allowDowngrade = v;
  }

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  setFeedURL(): void {
    this.setFeedCalls++;
  }

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls++;
    await this.onCheck?.();
    return null;
  }

  async downloadUpdate(token?: CancellationTokenLike): Promise<unknown> {
    this.downloadCalls++;
    this.lastToken = token;
    await this.onDownload?.();
    return [];
  }

  quitAndInstall(): void {
    this.quitCalls++;
  }

  /** 触发一次 updater 事件。 */
  emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(...args);
  }
}

/**
 * 定时器替身：记录每次排定的延迟，并把 unref 的调用次数记下来。
 *
 * 底层仍然走 globalThis.setTimeout，因此在 `vi.useFakeTimers()` 下
 * `vi.advanceTimersByTimeAsync()` 能真的把回调跑起来 —— 断言的是真实
 * 调度路径，不是一个自己写的假调度器。
 */
export class RecordingTimers implements TimerApi {
  readonly delays: number[] = [];
  unrefCount = 0;

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.delays.push(ms);
    const raw = globalThis.setTimeout(fn, ms);
    return { unref: () => void this.unrefCount++, raw } as TimerHandle & { raw: unknown };
  }

  clearTimeout(handle: TimerHandle): void {
    const raw = (handle as TimerHandle & { raw?: unknown }).raw;
    if (raw) globalThis.clearTimeout(raw as ReturnType<typeof setTimeout>);
  }
}

/** 内存偏好存储。 */
export class MemoryPrefs implements UpdatePrefsStore {
  saved = 0;
  constructor(private prefs: UpdatePrefs = { ...DEFAULT_UPDATE_PREFS }) {}
  load(): UpdatePrefs {
    return { ...this.prefs };
  }
  save(next: UpdatePrefs): void {
    this.saved++;
    this.prefs = { ...next };
  }
  /** 模拟「重启后重新读盘」。 */
  snapshot(): UpdatePrefs {
    return { ...this.prefs };
  }
}

/** 什么都不记的 logger。 */
export const silentLogger: UpdateLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 可编程的阻断源。 */
export class FakeBlockers implements BlockerSource {
  blockers: UpdateBlocker[] = [];
  idleCallbacks: Array<() => void> = [];

  collectBlockers(): UpdateBlocker[] {
    return this.blockers;
  }

  whenIdle(cb: () => void): () => void {
    this.idleCallbacks.push(cb);
    return () => {
      this.idleCallbacks = this.idleCallbacks.filter((c) => c !== cb);
    };
  }

  /** 模拟「任务真的结束了」。 */
  settle(): void {
    this.blockers = [];
    for (const cb of [...this.idleCallbacks]) cb();
    this.idleCallbacks = [];
  }
}

/** 可被 spy 的取消令牌（cancel 挂在原型上，方便 vi.spyOn(prototype)）。 */
export class FakeCancellationToken implements CancellationTokenLike {
  cancel(): void {
    /* 由测试 spy */
  }
}
