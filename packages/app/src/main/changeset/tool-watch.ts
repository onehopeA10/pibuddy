/**
 * 把 pi 的文件类工具执行转成待审阅变更（FS-102 的数据来源）。
 *
 * ## 为什么必须在 tool_execution_start 就抓快照
 *
 * 工具跑完之后磁盘上只剩「改完的样子」，原样已经没有第二个地方能取到 ——
 * 会话 JSONL 里记的是工具的**参数**，而 edit 类工具的参数是一段 patch，
 * 反推不出改动前的整份文件。start 时抓一次，是唯一能拿到 before 的时机。
 *
 * 抓不到时**不猜**：那条变更标 unverified，批量接受会硬跳过它。用一份
 * 猜出来的 before 去做 hash 比对，等于把冲突检测变成一个恒真的判断。
 *
 * ## 工具名靠特征匹配而不是白名单
 *
 * pi 的工具集是开放的（扩展可以注册自己的），钉死一张白名单意味着任何
 * 新工具的写入都会绕过审阅面板 —— 而那正是这个子系统要防的事。这里按
 * 「名字像写文件 + 参数里有路径」两个特征一起判定，宁可多记一条无害的
 * 变更，也不放过一次没人看见的写入。
 */
import type { AgentEvent } from "@pibuddy/pi-sdk";
import type { ChangesetKind } from "@pibuddy/contract";
import fs from "node:fs";
import path from "node:path";

import { requireWorkspaceRoot } from "../workspace-registry.js";
import { changesetStore } from "./changeset-store.js";

/** 参数里可能承载路径的键名。按顺序取第一个是字符串的。 */
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file"];

const WRITE_RE = /write|create|append/i;
const EDIT_RE = /edit|replace|patch|modify|update/i;
const DELETE_RE = /delete|remove|unlink|rm/i;

/** 工具名 → 变更种类；不像文件写入的返回 null。 */
export function kindForTool(toolName: string): ChangesetKind | null {
  if (DELETE_RE.test(toolName)) return "delete";
  if (EDIT_RE.test(toolName)) return "edit";
  if (WRITE_RE.test(toolName)) return "write";
  return null;
}

/**
 * 从工具参数里取出**相对工作区**的路径。
 *
 * 工具给的可能是绝对路径（pi 的 cwd 就是工作区 root），这里统一折成相对
 * 路径并用 path.relative 复核收容 —— 不是字符串前缀比较：`/work-evil`
 * 以 `/work` 开头，但它显然不在 `/work` 里。
 */
export function relativeFromArgs(
  args: Record<string, unknown>,
  root: string
): string | null {
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || value === "") continue;
    const abs = path.isAbsolute(value) ? value : path.resolve(root, value);
    const rel = path.relative(root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }
  return null;
}

interface PendingSnapshot {
  relativePath: string;
  kind: ChangesetKind;
  /** null = 没能读到原样，成品条目将被标 unverified */
  beforeContent: string | null;
}

/** toolCallId → start 时抓到的快照。end 时消费掉。 */
const pending = new Map<string, PendingSnapshot>();

/** 仅供单测：清空未消费的快照。 */
export function __resetToolWatch(): void {
  pending.clear();
}

export interface ToolWatchContext {
  workspaceId: string;
  sessionId: string;
  /** 一轮对话的标识；用 generation + sessionId 拼出来即可 */
  turnId: string;
}

function readOrNull(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch (err) {
    // 文件不存在 = 这是一次新建，原样就是空 —— 这不是「抓不到」
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    return null;
  }
}

/**
 * 消化一条工具事件。
 *
 * 任何异常都被吞在这里：变更登记失败绝不能把正在进行的对话打断 ——
 * 用户会看到助手无缘无故停下来，而真正的原因是一次记账失败。
 */
export async function observeToolEvent(
  event: AgentEvent,
  ctx: ToolWatchContext
): Promise<void> {
  try {
    if (event.type === "tool_execution_start") {
      const kind = kindForTool(event.toolName);
      if (!kind) return;
      const root = requireWorkspaceRoot(ctx.workspaceId);
      const relativePath = relativeFromArgs(event.args ?? {}, root);
      if (!relativePath) return;
      pending.set(event.toolCallId, {
        relativePath,
        kind,
        beforeContent: readOrNull(path.resolve(root, relativePath)),
      });
      return;
    }

    if (event.type !== "tool_execution_end") return;
    const snapshot = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!snapshot) return;
    // 工具自己报错时不登记：磁盘多半没被改过，记一条空变更只会制造噪音
    if (event.isError) return;

    const root = requireWorkspaceRoot(ctx.workspaceId);
    const abs = path.resolve(root, snapshot.relativePath);
    const afterContent = snapshot.kind === "delete" ? "" : (readOrNull(abs) ?? "");

    // 内容没变（工具跑了但什么也没改）就不登记
    if (snapshot.beforeContent !== null && snapshot.beforeContent === afterContent) return;

    await changesetStore().record({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      kind: snapshot.kind,
      relativePath: snapshot.relativePath,
      beforeContent: snapshot.beforeContent,
      afterContent,
    });
  } catch {
    // 见函数注释：记账失败不打断对话
  }
}
