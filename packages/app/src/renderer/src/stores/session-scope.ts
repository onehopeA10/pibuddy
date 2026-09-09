/**
 * 会话级状态的清空回调表（CT-25）。
 *
 * 「换会话要清哪些东西」是一条语义，不该是散落在 start / newTask 里的手写
 * 字段枚举 —— 每加一块会话级状态就得记得去补一行，漏了就是上一次会话的
 * 工具卡片、扩展弹窗留在新会话里。各 store 自己注册自己的清空动作，
 * 状态归属和清空语义就此解耦。
 *
 * 从 app.ts 抽到独立模块，是为了让 extensionUi store 能注册自己的清空动作
 * 而不与 app store 形成循环 import（app store 反过来要引 extensionUi 的
 * 状态做兼容代理）。app.ts 仍然把这两个函数原样再导出一次，既有引用点
 * 一个都不用改。
 *
 * key 用于去重：store 在测试里会被反复重建，不去重的话注册表里会堆满
 * 指向旧实例的死闭包。
 */
const sessionScopedResets = new Map<string, () => void>();
let anonymousResetSeq = 0;

export function registerSessionScopedReset(
  reset: () => void,
  key = `anonymous:${++anonymousResetSeq}`
): void {
  sessionScopedResets.set(key, reset);
}

/** 依次执行全部已注册的清空回调。 */
export function resetSessionScopedState(opts?: { skip?: readonly string[] }): void {
  const skip = new Set(opts?.skip ?? []);
  for (const [key, reset] of sessionScopedResets) {
    if (skip.has(key)) continue;
    reset();
  }
}

/** 仅供单测：已注册的 key 列表。 */
export function __sessionScopedResetKeys(): string[] {
  return [...sessionScopedResets.keys()];
}
