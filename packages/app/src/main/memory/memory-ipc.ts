/**
 * 长期记忆的 IPC handler（MEM-101 第一版 9 条 + 第二版 9 条 = 18 条）。
 *
 * 入参一律是不透明的 workspaceId / memory id：记忆按 capabilityId + workspaceId
 * 分区，渲染进程既够不着别的工作区的记忆，也表达不出「注入一段任意上下文」。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 * 注册与否由 CapabilityRegistry 的解析结果决定（能力未启用时这个函数一次都不
 * 被调用），因此这里没有、也不需要任何 feature gate 的 if。
 *
 * ## 向量与主表始终同步
 *
 * 保存 / 编辑 / 合并后即时（重）嵌入正文，删除时 store 层连向量一并清 —— 语义
 * 检索命中的永远是当下的正文，删掉的永远查不回来（与 FTS 是同一套覆盖承诺）。
 * 嵌入失败不阻断主动作（Provider 可能不可达），只是语义检索退化成 FTS。
 */
import {
  CHANNELS,
  knowledgeAddRequestSchema,
  knowledgeIdRequestSchema,
  knowledgeListRequestSchema,
  knowledgeSearchRequestSchema,
  memoryExportRequestSchema,
  memoryExtractRequestSchema,
  memoryHitsRequestSchema,
  memoryIdRequestSchema,
  memoryMergeRequestSchema,
  memoryQueryRequestSchema,
  memoryReembedRequestSchema,
  memorySaveRequestSchema,
  memorySearchRequestSchema,
  memorySetInjectionRequestSchema,
  memoryUpdateRequestSchema,
  type KnowledgeGetResult,
  type KnowledgeListResult,
  type KnowledgeMutationResult,
  type KnowledgeSearchResult,
  type MemoryEvidenceResult,
  type MemoryExportResult,
  type MemoryExtractResult,
  type MemoryEmbedStatus,
  type MemoryHitsResult,
  type MemoryInjectionState,
  type MemoryMutationResult,
  type MemoryQueryResult,
  type MemoryReembedResult,
  type MemorySearchResult,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { readEvidence } from "./memory-evidence.js";
import { disposeEmbedder } from "./memory-embed.js";
import { extractFromSession } from "./memory-extract.js";
import { clearHitsForMemory, disposeMemoryInject, memoryHitsFor } from "./memory-inject.js";
import {
  embedKnowledge,
  embedMemory,
  embedStatus,
  reembedWorkspace,
  searchKnowledge,
  searchMemories,
} from "./memory-search.js";
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

  registerHandler(CHANNELS.memorySave, memorySaveRequestSchema, async (req): Promise<MemoryMutationResult> => {
    const store = memoryStore();
    const outcome = store.save({
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
    if (outcome.ok && outcome.record) {
      await embedMemory(store, outcome.record.id, req.workspaceId, outcome.record.scope, outcome.record.content);
    }
    return { ok: outcome.ok, record: outcome.record, ...(outcome.message ? { message: outcome.message } : {}) };
  });

  registerHandler(CHANNELS.memoryUpdate, memoryUpdateRequestSchema, async (req): Promise<MemoryMutationResult> => {
    const { id, ...patch } = req;
    const store = memoryStore();
    const outcome = store.update(id, patch);
    // 正文可能变了：重嵌保证向量跟着正文走（upsert 覆盖旧向量）。
    if (outcome.ok && outcome.record && outcome.workspaceId) {
      await embedMemory(store, outcome.record.id, outcome.workspaceId, outcome.record.scope, outcome.record.content);
    }
    return { ok: outcome.ok, record: outcome.record, ...(outcome.message ? { message: outcome.message } : {}) };
  });

  registerHandler(CHANNELS.memoryMerge, memoryMergeRequestSchema, async (req): Promise<MemoryMutationResult> => {
    // 合并会删掉被并入的几条：它们的命中记录（这里）与向量（store.deleteInternal）
    // 都一并清；新的一条随后嵌入。
    for (const id of req.ids) clearHitsForMemory(id);
    const store = memoryStore();
    const outcome = store.merge(req.workspaceId, req.ids, req.content);
    if (outcome.ok && outcome.record) {
      await embedMemory(store, outcome.record.id, req.workspaceId, outcome.record.scope, outcome.record.content);
    }
    return { ok: outcome.ok, record: outcome.record, ...(outcome.message ? { message: outcome.message } : {}) };
  });

  registerHandler(CHANNELS.memoryDelete, memoryIdRequestSchema, (req): MemoryMutationResult => {
    // 三处一起清：主表 + FTS + 向量在 store.delete；命中 cache 在这里。
    const result = memoryStore().delete(req.id);
    clearHitsForMemory(req.id);
    return result.ok ? { ok: true, record: null } : { ok: false, record: null, message: "记忆不存在" };
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

  // ---------------------------------------------------------------- v2

  registerHandler(CHANNELS.memorySearch, memorySearchRequestSchema, (req): Promise<MemorySearchResult> =>
    searchMemories(req.workspaceId, req.query, req.scope, req.limit ?? 8)
  );

  registerHandler(CHANNELS.memoryEmbedStatus, memoryHitsRequestSchema, (req): MemoryEmbedStatus =>
    embedStatus(req.workspaceId)
  );

  registerHandler(CHANNELS.memoryReembed, memoryReembedRequestSchema, async (req): Promise<MemoryReembedResult> => {
    const store = memoryStore();
    if (req.config) store.setEmbeddingConfig(req.config);
    try {
      const counts = await reembedWorkspace(store, req.workspaceId);
      return { ok: true, ...counts, status: embedStatus(req.workspaceId) };
    } catch (err) {
      return {
        ok: false,
        embeddedMemories: 0,
        embeddedKnowledge: 0,
        status: embedStatus(req.workspaceId),
        message: (err as Error).message,
      };
    }
  });

  registerHandler(CHANNELS.memoryExtract, memoryExtractRequestSchema, async (req): Promise<MemoryExtractResult> => {
    const { candidates, scannedTurns } = await extractFromSession(
      req.workspaceId,
      req.sourceSessionId,
      req.limit ?? 8
    );
    return { candidates, scannedTurns };
  });

  registerHandler(CHANNELS.memoryKnowledgeAdd, knowledgeAddRequestSchema, async (req): Promise<KnowledgeMutationResult> => {
    const store = memoryStore();
    const outcome = store.addKnowledge({
      workspaceId: req.workspaceId,
      title: req.title,
      content: req.content,
      sourceKind: req.sourceKind,
      sourceRef: req.sourceRef ?? null,
      sourceTurnId: req.sourceTurnId ?? null,
    });
    if (outcome.ok && outcome.record) {
      await embedKnowledge(store, outcome.record.id, req.workspaceId, outcome.record.content);
    }
    return outcome;
  });

  registerHandler(CHANNELS.memoryKnowledgeSearch, knowledgeSearchRequestSchema, (req): Promise<KnowledgeSearchResult> =>
    searchKnowledge(req.workspaceId, req.query, req.limit ?? 8)
  );

  registerHandler(CHANNELS.memoryKnowledgeList, knowledgeListRequestSchema, (req): KnowledgeListResult => {
    const items = memoryStore().listKnowledge(req.workspaceId);
    return { items, total: items.length };
  });

  registerHandler(CHANNELS.memoryKnowledgeGet, knowledgeIdRequestSchema, (req): KnowledgeGetResult => ({
    record: memoryStore().getKnowledge(req.id),
  }));

  registerHandler(CHANNELS.memoryKnowledgeDelete, knowledgeIdRequestSchema, (req): KnowledgeMutationResult => {
    const result = memoryStore().deleteKnowledge(req.id);
    return result.ok ? { ok: true, record: null } : { ok: false, record: null, message: "知识片段不存在" };
  });
}

/**
 * 拆卸本能力的运行期资源（ADR-0002 D4 规则 4）。
 *
 * 命中 cache（memory-inject）+ embedder 缓存（memory-embed）+ sqlite 句柄
 * （memory-store）。**memory.db 里的记忆、知识、向量一条不动** —— 规则 5：
 * 卸载与删数据是两个动作。禁用后再启用，用户应原样看到之前的一切。
 */
export function disposeMemoryResources(): void {
  disposeMemoryInject();
  disposeEmbedder();
  closeMemoryStore();
}
