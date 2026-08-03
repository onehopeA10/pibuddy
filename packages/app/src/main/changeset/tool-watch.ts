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

import { trackToolEnd, trackToolStart } from "../artifacts/artifact-tracker.js";
import { isCapabilityEnabled } from "../capability/capability-state.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import { changesetStore } from "./changeset-store.js";
import { WORKSPACE_REVIEW_CAPABILITY_ID } from "./workspace-review.capability.js";

/** 参数里可能承载路径的键名。按顺序取第一个是字符串的。 */
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file"];

const WRITE_RE = /write|create|append/i;
const EDIT_RE = /edit|replace|patch|modify|update/i;
const DELETE_RE = /delete|remove|unlink|rm/i;

const EMPTY = Buffer.alloc(0);

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
  beforeBytes: Buffer | null;
}

/** toolCallId → start 时抓到的快照。end 时消费掉。 */
const pending = new Map<string, PendingSnapshot>();

/** 仅供单测：清空未消费的快照。 */
/**
 * 丢弃全部在途快照（禁用能力 / 会话切换 / 单测）。
 *
 * 这张表在 start→end 之间持有**整份文件的字节**，是一块按文件大小增长的
 * 内存 —— 禁用审阅时不清它，等于关掉了面板却留着它的成本。
 */
export function disposeToolWatch(): void {
  pending.clear();
}

/** 仅供单测：历史名字，转调 disposeToolWatch。 */
export function __resetToolWatch(): void {
  disposeToolWatch();
}

export interface ToolWatchContext {
  workspaceId: string;
  sessionId: string;
  /** 一轮对话的标识；用 generation + sessionId 拼出来即可 */
  turnId: string;
}

/**
 * 快照必须是**字节**。
 *
 * 带 "utf8" 读进来的话，被工具改到的 PNG / PDF / XLSX / ZIP 里每一个非法
 * UTF-8 序列都会在这一行变成 U+FFFD，而原字节此后再也取不回来 —— 这份坏
 * 掉的 before 接着会被 record() 写回磁盘。损坏就是从这里开始的。
 */
function readOrNull(abs: string): Buffer | null {
  try {
    return fs.readFileSync(abs);
  } catch (err) {
    // 文件不存在 = 这是一次新建，原样就是空 —— 这不是「抓不到」
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
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
      // FEATURE GATE（ADR-0002 D4 规则 4）：审阅能力未启用时不抓快照。
      // 快照是**整份文件的字节**，而它唯一的消费者是变更面板 —— 面板都不
      // 存在的时候还照抓，就是「禁用了但成本还在」。产物跟踪不受这条影响：
      // 它是另一个能力，自己在 trackToolStart 里门控。
      if (isCapabilityEnabled(WORKSPACE_REVIEW_CAPABILITY_ID)) {
        pending.set(event.toolCallId, {
          relativePath,
          kind,
          beforeBytes: readOrNull(path.resolve(root, relativePath)),
        });
      }
      // 产物库同步插一条 generating（ART-102）。删除类工具不算产物 ——
      // 「做出来的东西」和「删掉的东西」放同一个库里只会互相干扰。
      if (kind !== "delete") {
        trackToolStart({
          workspaceId: ctx.workspaceId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          toolCallId: event.toolCallId,
          relativePath,
        });
      }
      return;
    }

    if (event.type !== "tool_execution_end") return;
    const snapshot = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    // 产物状态先结算：即便下面因为「内容没变」提前 return，产物库里那条
    // generating 也必须落定，否则它会永远停在生成中（ART-102）。
    trackToolEnd(event.toolCallId, !event.isError);
    if (!snapshot) return;
    // 工具自己报错时不登记：磁盘多半没被改过，记一条空变更只会制造噪音
    if (event.isError) return;

    const root = requireWorkspaceRoot(ctx.workspaceId);
    const abs = path.resolve(root, snapshot.relativePath);
    const afterBytes = snapshot.kind === "delete" ? EMPTY : (readOrNull(abs) ?? EMPTY);

    // 内容没变（工具跑了但什么也没改）就不登记。按字节比 —— 字符串比较下
    // 两份不同的坏字节可能都塌成同一串 U+FFFD，真实改动会被判成「没变」。
    if (snapshot.beforeBytes !== null && snapshot.beforeBytes.equals(afterBytes)) return;

    await changesetStore().record({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      kind: snapshot.kind,
      relativePath: snapshot.relativePath,
      beforeBytes: snapshot.beforeBytes,
      afterBytes,
    });
  } catch {
    // 见函数注释：记账失败不打断对话
  }
}
