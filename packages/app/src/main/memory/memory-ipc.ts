/**
 * 长期记忆的 IPC handler（MEM-101 第一版）——**恰 9 条通道**。
 *
 * 入参一律是不透明的 workspaceId / memory id：记忆按 capabilityId + workspaceId
 * 分区，渲染进程既够不着别的工作区的记忆，也表达不出「注入一段任意上下文」。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 * 注册与否由 CapabilityRegistry 的解析结果决定（能力未启用时这个函数一次都不
 * 被调用），因此这里没有、也不需要任何 feature gate 的 if。
 */
import {
  CHANNELS,
  memoryExportRequestSchema,
  memoryHitsRequestSchema,
  memoryIdRequestSchema,
  memoryMergeRequestSchema,
  memoryQueryRequestSchema,
  memorySaveRequestSchema,
  memorySetInjectionRequestSchema,
  memoryUpdateRequestSchema,
  type MemoryEvidenceResult,
  type MemoryExportResult,
  type MemoryHitsResult,
  type MemoryInjectionState,
  type MemoryMutationResult,
  type MemoryQueryResult,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { readEvidence } from "./memory-evidence.js";
import { clearHitsForMemory, disposeMemoryInject, memoryHitsFor } from "./memory-inject.js";
import { closeMemoryStore, memoryStore } from "./memory-store.js";

function injectionState(workspaceId: string): MemoryInjectionState {
  const store = memoryStore();
  return {
    injectionEnabled: store.workspaceInjectionEnabled(workspaceId),
    globalInjectionEnabled: store.globalInjectionEnabled(),
  };
}

export function registerMemoryIpc(): void {
  registerHandler(CHANNELS.memoryQuery, memoryQueryRequestSchema, (req): MemoryQueryResult => {
    const store = memoryStore();
    const items = store.query(req);
    return {
      items,
      total: items.length,
      ...injectionState(req.workspaceId),
    };
  });

  registerHandler(CHANNELS.memorySave, memorySaveRequestSchema, (req): MemoryMutationResult => {
    const outcome = memoryStore().save({
      workspaceId: req.workspaceId,
      content: req.content,
      type: req.type,
      scope: req.scope,
      sourceSessionId: req.sourceSessionId ?? null,
      sourceTurnId: req.sourceTurnId ?? null,
      confidence: req.confidence,
      expiry: req.expiry ?? null,
      sensitivity: req.sensitivity,
    });
    return { ok: outcome.ok, record: outcome.record, ...(outcome.message ? { message: outcome.message } : {}) };
  });

  registerHandler(CHANNELS.memoryUpdate, memoryUpdateRequestSchema, (req): MemoryMutationResult => {
    const { id, ...patch } = req;
    const outcome = memoryStore().update(id, patch);
    return { ok: outcome.ok, record: outcome.record, ...(outcome.message ? { message: outcome.message } : {}) };
  });

  registerHandler(CHANNELS.memoryMerge, memoryMergeRequestSchema, (req): MemoryMutationResult => {
    // 合并会删掉被并入的几条：把它们的命中记录也一并抹掉，隐私视图不该
    // 留着已经不存在的记忆的摘要。
    for (const id of req.ids) clearHitsForMemory(id);
    const outcome = memoryStore().merge(req.workspaceId, req.ids, req.content);
    return { ok: outcome.ok, record: outcome.record, ...(outcome.message ? { message: outcome.message } : {}) };
  });

  registerHandler(CHANNELS.memoryDelete, memoryIdRequestSchema, (req): MemoryMutationResult => {
    // 顺序无所谓，但两处都要清：主表 + FTS 在 store.delete 里，命中 cache 在这里。
    // 「删除后不再检索 / 不再注入 / 命中里也没有」这三件一起成立，才是真的删掉了。
    const result = memoryStore().delete(req.id);
    clearHitsForMemory(req.id);
    return result.ok
      ? { ok: true, record: null }
      : { ok: false, record: null, message: "记忆不存在" };
  });

  registerHandler(CHANNELS.memoryExport, memoryExportRequestSchema, (req): MemoryExportResult => {
    const items = memoryStore().exportAll(req.workspaceId, req.scope);
    return {
      content: JSON.stringify({ version: 1, exportedAt: Date.now(), memories: items }, null, 2),
      format: "json",
      count: items.length,
    };
  });

  registerHandler(CHANNELS.memoryEvidence, memoryIdRequestSchema, (req): Promise<MemoryEvidenceResult> =>
    readEvidence(req.id)
  );

  registerHandler(CHANNELS.memoryHits, memoryHitsRequestSchema, (req): MemoryHitsResult => ({
    hits: memoryHitsFor(req.workspaceId),
  }));

  registerHandler(
    CHANNELS.memorySetInjection,
    memorySetInjectionRequestSchema,
    (req): MemoryInjectionState => {
      memoryStore().setInjection(req.workspaceId, req.target, req.enabled);
      return injectionState(req.workspaceId);
    }
  );
}

/**
 * 拆卸本能力的运行期资源（ADR-0002 D4 规则 4）。
 *
 * 命中 cache（memory-inject）+ sqlite 句柄（memory-store）。**memory.db 里的
 * 记忆一条不动** —— 规则 5：卸载与删数据是两个动作。禁用后再启用，用户应
 * 原样看到之前保存的一切。
 */
export function disposeMemoryResources(): void {
  disposeMemoryInject();
  closeMemoryStore();
}
