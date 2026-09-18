/**
 * 审批模式（`pi:set-approval-mode`）的主进程侧逻辑。
 *
 * ## 模式归谁管
 *
 * 「工具调用前问不问用户」不是 pi 内核的概念，而是 pi 侧权限扩展
 * （pi-maestro-flow 的 permissions 模块）的：它读 `<工作目录>/.pi/settings.local.json`
 * 里的 `permissions.defaultMode`，并把当前模式以 `approval-mode` 这个 key
 * 上报到扩展状态栏（YOLO / `APPROVAL default` …）。它只登记了两条命令：
 * `/permissions yolo` 与 `/permissions reload`，**没有**「切到 default /
 * acceptEdits」的直接命令。
 *
 * 所以切模式的唯一可行路径是两步：先把 `defaultMode` 写进 settings.local.json，
 * 再让扩展 `/permissions reload`。两步都在这里，渲染进程只交一个枚举。
 *
 * ## 为什么不走 `pi:prompt`
 *
 * `pi:prompt` 在发给 pi 之前会拼附件清单、注入长期记忆 —— 一段前置文本就足以
 * 让 `/permissions reload` 不再以 `/` 开头，pi 就会把它当普通提示词发给模型。
 * 这里绕开预处理，直接以原文下发。
 *
 * ## 扩展不在场时
 *
 * 状态栏里没有 `approval-mode` 就说明权限扩展没加载，此时 `/permissions reload`
 * 会作为一条普通提示词进模型，还白白改了一个文件。判据在 `approvalModeFromStatuses`：
 * 返回 null 则 handler 直接拒绝，界面上这个控件也不显示。
 */
import fs from "node:fs";
import path from "node:path";
import { APPROVAL_STATUS_KEY, parseApprovalStatus, type ApprovalMode } from "@pibuddy/contract";
import { writeJsonAtomic } from "../fs-atomic.js";

/** 权限扩展读取的本地设置文件（相对工作目录）。 */
export const APPROVAL_SETTINGS_RELATIVE_PATH = path.join(".pi", "settings.local.json");

/** 让扩展重读设置文件并应用新模式的命令原文。 */
export const APPROVAL_RELOAD_COMMAND = "/permissions reload";

export function approvalSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, APPROVAL_SETTINGS_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取现有设置文件的根对象。文件不存在视为空对象；存在但不是合法 JSON 对象
 * 时抛错 —— 悄悄覆盖会把用户手写的 allow / deny 规则一并抹掉。
 */
function readSettingsRoot(filePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${APPROVAL_SETTINGS_RELATIVE_PATH} 不是合法的 JSON，没有改动它`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${APPROVAL_SETTINGS_RELATIVE_PATH} 的顶层不是对象，没有改动它`);
  }
  return parsed;
}

/**
 * 把 `permissions.defaultMode` 写进工作目录的 settings.local.json，其余字段原样保留。
 * 返回写入的文件绝对路径（供日志）。
 */
export function writeApprovalMode(workspaceRoot: string, mode: ApprovalMode): string {
  const filePath = approvalSettingsPath(workspaceRoot);
  const root = readSettingsRoot(filePath);
  const permissions = isRecord(root.permissions) ? root.permissions : {};
  permissions.defaultMode = mode;
  root.permissions = permissions;
  writeJsonAtomic(filePath, root);
  return filePath;
}

/**
 * 从扩展状态快照里找审批模式。
 *
 * 返回 null 表示「权限扩展根本不在场」（没有 approval-mode 这条状态）；
 * undefined 表示「在场但当前读不出模式」（比如处于 plan 模式时扩展把它藏了）。
 */
export function approvalModeFromStatuses(
  statuses: readonly { key: string; text: string }[]
): ApprovalMode | undefined | null {
  const status = statuses.find((s) => s.key === APPROVAL_STATUS_KEY);
  if (!status) return null;
  return parseApprovalStatus(status.text);
}
