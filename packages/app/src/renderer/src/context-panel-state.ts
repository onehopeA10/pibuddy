/**
 * 任务上下文面板开合状态的持久化。
 *
 * 面板有三态：关闭 / 展开 / 收成侧条。用户点过一次之后，这个选择就该被
 * 记住 —— 无论是下一轮任务开始、切会话，还是重启应用。此前它是两个内存
 * ref，且 streaming 一开始就强制展开，用户关掉的面板每跑一个任务就又弹出来。
 *
 * 用 localStorage 而不是走 settings：这是纯界面布局偏好，与主进程无关，
 * 和 theme.ts 的首帧缓存同一口径。读不到（首次使用）返回 null，让调用方
 * 保留「第一次跑任务时自动展开一下」的引导行为；一旦用户做过选择就不再干预。
 */

export const CONTEXT_PANEL_MODES = ["closed", "expanded", "collapsed"] as const;
export type ContextPanelMode = (typeof CONTEXT_PANEL_MODES)[number];

const STORAGE_KEY = "pibuddy.contextPanel";

export function isContextPanelMode(value: unknown): value is ContextPanelMode {
  return (CONTEXT_PANEL_MODES as readonly unknown[]).includes(value);
}

/** 用户上次的选择；从未选过或值不合法时为 null。 */
export function readContextPanelMode(storage: Pick<Storage, "getItem"> | null = safeStorage()): ContextPanelMode | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return isContextPanelMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 记住用户的选择。写失败（隐私模式 / 配额满）只影响下次恢复，不抛。 */
export function writeContextPanelMode(
  mode: ContextPanelMode,
  storage: Pick<Storage, "setItem"> | null = safeStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, mode);
  } catch {
    // 持久化失败不影响当前会话内的状态
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
