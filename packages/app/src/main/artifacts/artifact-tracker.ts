/**
 * 把「工具正在写一个文件」变成产物库里的一条记录（ART-102 的状态机）。
 *
 * 挂在 tool-watch 的两个时点上，各做一件事：
 *
 *   tool_execution_start  → begin()：插一条 `generating`。**必须在这里**，
 *                           不能等工具跑完 —— 一个要跑 40 秒的导出，用户
 *                           在这 40 秒里看到的应该是「生成中」，而不是
 *                           产物库里什么都没有。
 *   tool_execution_end    → markReady() / markFailed()。失败时**不动磁盘上
 *                           那个写了一半的文件**：它是用户的东西，他有权
 *                           自己决定要不要（ART-102：转换失败不丢原文件）。
 *
 * 任何异常都在这里被吞掉：记账失败绝不能把正在进行的对话打断，
 * 与 tool-watch 自身同一口径。
 */
import type { ArtifactRecord } from "@pibuddy/contract";

import { isCapabilityEnabled } from "../capability/capability-state.js";
import { artifactStore } from "./artifact-store.js";
import { ARTIFACTS_CAPABILITY_ID } from "./artifacts.capability.js";

/** toolCallId → 刚插进去的那条 generating 记录的 id。 */
const inflight = new Map<string, string>();

export interface TrackContext {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  relativePath: string;
}

/**
 * 工具开始写：插一条 generating。已经跟踪过的 toolCallId 直接跳过。
 *
 * FEATURE GATE（ADR-0002 D4 规则 4）：产物库未启用时**一条都不插**，
 * 连带 `trackToolEnd` 因为 inflight 为空而自然空转 —— 于是「禁用产物库」
 * 的含义是「不再产生新记录」，而不是「面板关了但库还在后台长」。
 * 库里已有的产物一条不动（规则 5：卸载与删数据是两个动作）。
 */
export function trackToolStart(ctx: TrackContext): ArtifactRecord | null {
  if (!isCapabilityEnabled(ARTIFACTS_CAPABILITY_ID)) return null;
  if (inflight.has(ctx.toolCallId)) return null;
  try {
    const record = artifactStore().begin({
      workspaceId: ctx.workspaceId,
      relativePath: ctx.relativePath,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolCallId: ctx.toolCallId,
    });
    inflight.set(ctx.toolCallId, record.id);
    return record;
  } catch {
    return null;
  }
}

/** 工具结束：成功置 ready（顺带算 hash），失败置 failed。 */
export function trackToolEnd(toolCallId: string, ok: boolean): ArtifactRecord | null {
  const id = inflight.get(toolCallId);
  if (!id) return null;
  inflight.delete(toolCallId);
  try {
    return ok ? artifactStore().markReady(id) : artifactStore().markFailed(id);
  } catch {
    return null;
  }
}

/** 丢弃全部在途跟踪（禁用能力 / 会话切换 / 单测）。 */
export function disposeArtifactTracking(): void {
  inflight.clear();
}

/** 仅供单测：历史名字，转调 disposeArtifactTracking。 */
export function __resetArtifactTracking(): void {
  disposeArtifactTracking();
}
