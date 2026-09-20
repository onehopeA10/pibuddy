/**
 * 前台对话 runtime 的空闲休眠 / 聚焦唤醒判据。
 *
 * 后台池已经会把非 focused 会话从 background → warm → stopped。
 * 用户正看着的那条对话以前永不回收，开一天就会把 pi 子进程拖死，
 * 下一条消息石沉大海。这里只回答两个问题：现在该不该睡、该不该醒。
 * 真正的 stop / start 仍走 store 里现成的 runtime IPC。
 *
 * 闹钟由调用方用单次 setTimeout 排，禁止 setInterval：合盖之后还醒着的
 * 轮询既耗电，也给不出「两次查询之间刚好崩了」的正确答案。
 */

/** 多久没对话就把前台 pi 停掉。15 分钟与池里 warm→stopped 同一量级。 */
export const CONVERSATION_IDLE_SLEEP_MS = 15 * 60_000;

/** 聚焦 / 探活失败后的最短再试间隔。发送始终立即拉活。 */
export const WAKE_COOLDOWN_MS = 8_000;

export interface RuntimeIdleSnapshot {
  now: number;
  lastConversationAt: number;
  idleSleepMs: number;
  started: boolean;
  streaming: boolean;
  aborting: boolean;
  asleep: boolean;
  waking: boolean;
  pendingUi: boolean;
}

export function nextSleepDelayMs(
  s: Pick<RuntimeIdleSnapshot, "now" | "lastConversationAt" | "idleSleepMs">
): number {
  return Math.max(0, s.lastConversationAt + s.idleSleepMs - s.now);
}

/**
 * 这一拍该不该停进程。
 *
 * 输出中、停止中、扩展弹窗未答、已经在睡或在醒，都不睡。
 */
export function shouldSleepRuntime(s: RuntimeIdleSnapshot): boolean {
  if (
    !s.started ||
    s.streaming ||
    s.aborting ||
    s.asleep ||
    s.waking ||
    s.pendingUi
  ) {
    return false;
  }
  return s.now - s.lastConversationAt >= s.idleSleepMs;
}

/**
 * 忙着的时候闹钟响了：再等一整段空闲，而不是按「上次对话」算出 0 延迟连响。
 * 已经停了或不在跑：不再排闹钟。
 */
export function sleepRetryDelayMs(s: RuntimeIdleSnapshot): number | null {
  if (s.asleep || s.waking || !s.started) return null;
  if (s.streaming || s.aborting || s.pendingUi) return s.idleSleepMs;
  return nextSleepDelayMs(s);
}

export function shouldWakeRuntime(s: {
  asleep: boolean;
  startError: string;
}): boolean {
  return s.asleep || Boolean(s.startError);
}

/**
 * 窗口重新聚焦时要不要拉活。
 *
 * 休眠 / 断连横幅必醒。进程已标成未启动但会话还在（主动停、丢了 exit）
 * 也醒。没有会话则是开机前，不在这里抢 start。
 */
export function shouldWakeOnActivate(s: {
  asleep: boolean;
  started: boolean;
  startError: string;
  hasSession: boolean;
}): boolean {
  if (s.asleep || s.startError) return true;
  return !s.started && s.hasSession;
}

/** prompt / getState / switch_session 撞上已死或正在拆的 runtime 时，主进程抛出的那几类句子。 */
export function isRuntimeGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /运行时不可用|尚未启动|正在停止|phase=|SESSION_UNKNOWN|ENOENT|文件已经不在了|客户端已停止|进程已退出|进程未运行|已拒绝新命令/.test(
    msg
  );
}

export function shouldRetryWake(s: {
  reason: "send" | "focus" | "health";
  now: number;
  lastFailedWakeAt: number;
  cooldownMs: number;
}): boolean {
  if (s.reason === "send") return true;
  if (s.lastFailedWakeAt <= 0) return true;
  return s.now - s.lastFailedWakeAt >= s.cooldownMs;
}
