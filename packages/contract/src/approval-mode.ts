/**
 * 审批模式：pi 侧权限扩展执行工具前问不问用户。
 *
 * 模式本身不是 pi 内核的概念，而是权限扩展（pi-maestro-flow 的 permissions
 * 模块）的：它读工作目录 `.pi/settings.local.json` 里的 `permissions.defaultMode`，
 * 并以 `approval-mode` 这个 key 把当前模式上报到扩展状态栏。本文件是主进程与
 * 渲染进程共用的那部分：枚举、schema、状态文本解析。
 *
 *   - `default`           —— 读类工具直接放行，改文件 / 跑命令先问；
 *   - `acceptEdits`       —— 改文件也直接放行，跑命令仍然问；
 *   - `dontAsk`           —— 不问，未预批的一律拒绝；
 *   - `bypassPermissions` —— 全部放行（扩展状态栏里显示为 YOLO）。
 *
 * 顺序即界面下拉里的顺序：从最保守到最放开。扩展另有一个 `plan` 模式，
 * 它由「先看方案」工作方式接管，不在这里暴露。
 */
import { z } from "zod";

export const APPROVAL_MODES = ["default", "acceptEdits", "dontAsk", "bypassPermissions"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const approvalModeSchema = z.enum(APPROVAL_MODES);

/** 扩展上报模式所用的状态 key（渲染进程存成 `ext:approval-mode`）。 */
export const APPROVAL_STATUS_KEY = "approval-mode";

/**
 * 从扩展状态栏文本解析当前审批模式。
 *
 * 扩展的上报格式：`bypassPermissions` → "YOLO"；其它 → "APPROVAL <mode>"。
 * 处于 plan 模式且非 YOLO 时整条状态被扩展隐藏，这里因而读不到 —— 返回 undefined。
 */
export function parseApprovalStatus(text: string | undefined): ApprovalMode | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed === "YOLO") return "bypassPermissions";
  const match = /^APPROVAL\s+(\S+)$/.exec(trimmed);
  if (!match) return undefined;
  const mode = match[1];
  return (APPROVAL_MODES as readonly string[]).includes(mode) ? (mode as ApprovalMode) : undefined;
}
