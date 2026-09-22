/**
 * 对话工作方式：直接干 / 先看方案。
 *
 * 不新增第二套 planner Agent。只在发给 Pi 的提示词前加一句宿主约束，
 * 用户气泡里看不到这段。批准口令不再加前缀，让同一轮对话能接着动手。
 */

import { isPureGreeting } from "./pure-greeting.js";

export const WORK_MODES = ["act", "plan"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const PLAN_MARKER = "【先看方案】";

export const PLAN_INSTRUCTION =
  "【先看方案】先判断本轮请求与前文的关系，只使用相关背景；独立问题按本轮意图处理，不因旧任务自动继续执行。问候、闲聊、知识问答和只读查询正常处理，不强制生成实施方案。只有请求涉及修改文件或会改变环境的操作时，先写清目标、改动与风险；批准前不要执行这些操作，等用户说「按这个做」再动手。";

const APPROVE_RE = /^(按这个做|按这个方案执行|批准执行|开始做)([。.!！]|$)/;

export function isPlanApprove(message: string): boolean {
  return APPROVE_RE.test(message.trim());
}

export function applyWorkMode(message: string, mode: WorkMode): string {
  if (mode !== "plan") return message;
  if (isPureGreeting(message)) return message;
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
