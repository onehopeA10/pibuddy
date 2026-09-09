/**
 * 对话工作方式：直接干 / 先看方案。
 *
 * 不新增第二套 planner Agent。只在发给 Pi 的提示词前加一句宿主约束，
 * 用户气泡里看不到这段。批准口令不再加前缀，让同一轮对话能接着动手。
 */

export const WORK_MODES = ["act", "plan"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const PLAN_MARKER = "【先看方案】";

export const PLAN_INSTRUCTION =
  "【先看方案】现在只写实施方案，不要改文件、不要跑会改环境的命令。写清：要达成什么、会动哪些东西、有什么风险。等用户说「按这个做」再动手。";

const APPROVE_RE = /^(按这个做|按这个方案执行|批准执行|开始做)([。.!！]|$)/;

export function isPlanApprove(message: string): boolean {
  return APPROVE_RE.test(message.trim());
}

export function applyWorkMode(message: string, mode: WorkMode): string {
  if (mode !== "plan") return message;
  if (isPlanApprove(message)) return message;
  if (message.includes(PLAN_MARKER)) return message;
  return `${PLAN_INSTRUCTION}\n\n${message}`;
}

/** 历史回放时若 Pi 把前缀回显出来，界面上裁掉。 */
export function stripPlanInstruction(text: string): string {
  if (!text.startsWith(PLAN_MARKER)) return text;
  const split = text.indexOf("\n\n");
  return split === -1 ? text : text.slice(split + 2);
}
