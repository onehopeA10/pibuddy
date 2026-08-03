/**
 * `window.piBuddy.memory`（MEM-101 第一版）。
 *
 * 九个方法、九条窄通道：保存 / 检索 / 编辑 / 合并 / 删除 / 导出 / 看证据 /
 * 看命中 / 开关注入。渲染进程能表达的极限就是这九个意图 —— 没有「注入这段
 * 文本」这类入口，注入内容只来自用户显式保存过的记录。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  KnowledgeGetResult,
  KnowledgeListResult,
  KnowledgeMutationResult,
  KnowledgeSearchResult,
  KnowledgeSourceKind,
  MemoryEmbedConfig,
  MemoryEmbedStatus,
  MemoryEvidenceResult,
  MemoryExportResult,
  MemoryExtractResult,
  MemoryHitsResult,
  MemoryInjectionState,
  MemoryMutationResult,
  MemoryQueryRequest,
  MemoryQueryResult,
  MemoryReembedResult,
  MemorySaveRequest,
  MemoryScope,
  MemorySearchResult,
  MemorySensitivity,
  MemoryType,
  MemoryUpdateRequest,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const memory = {
  /** 检索 / 列出某工作区可见的记忆，附当前注入开关。 */
  query: (req: MemoryQueryRequest) => invoke<MemoryQueryResult>(CHANNELS.memoryQuery, req),

  /** 用户显式保存一条记忆。疑似密钥的内容会被主进程挡下（ok:false）。 */
  save: (req: MemorySaveRequest) => invoke<MemoryMutationResult>(CHANNELS.memorySave, req),

  /** 编辑一条记忆（含排除 / 恢复）。 */
  update: (req: MemoryUpdateRequest) => invoke<MemoryMutationResult>(CHANNELS.memoryUpdate, req),

  /** 把多条合并成一条（原来的几条被删除）。 */
  merge: (workspaceId: string, ids: string[], content: string) =>
    invoke<MemoryMutationResult>(CHANNELS.memoryMerge, { workspaceId, ids, content }),

  /** 彻底删除一条：主进程会同时清正文、FTS 与命中记录。 */
  delete: (id: string) => invoke<MemoryMutationResult>(CHANNELS.memoryDelete, { id }),

  /** 导出为 JSON 文本，由渲染进程交给下载 / 复制。 */
  export: (workspaceId: string, scope?: MemoryScope) =>
    invoke<MemoryExportResult>(CHANNELS.memoryExport, { workspaceId, scope }),

  /** 取一条记忆的来源会话轮次原文（查看原始证据）。 */
  evidence: (id: string) => invoke<MemoryEvidenceResult>(CHANNELS.memoryEvidence, { id }),

  /** 注入命中记录（隐私 / 调试视图）：这一轮我被塞了哪些记忆。 */
  hits: (workspaceId: string) => invoke<MemoryHitsResult>(CHANNELS.memoryHits, { workspaceId }),

  /** 开关注入（当前工作区 / 全局），不删任何记忆。 */
  setInjection: (workspaceId: string, target: "workspace" | "global", enabled: boolean) =>
    invoke<MemoryInjectionState>(CHANNELS.memorySetInjection, { workspaceId, target, enabled }),

  // ---- v2：语义检索 + 知识库 + 有限抽取 ----

  /** 混合语义检索（FTS + 向量），按相关度排序。 */
  search: (workspaceId: string, query: string, opts?: { scope?: MemoryScope; limit?: number }) =>
    invoke<MemorySearchResult>(CHANNELS.memorySearch, {
      workspaceId,
      query,
      ...(opts?.scope ? { scope: opts.scope } : {}),
      ...(opts?.limit ? { limit: opts.limit } : {}),
    }),

  /** 嵌入状态：后端 / 模型 / 已嵌入占比。 */
  embedStatus: (workspaceId: string) =>
    invoke<MemoryEmbedStatus>(CHANNELS.memoryEmbedStatus, { workspaceId }),

  /** 重嵌：为缺向量 / 换 embedder 的记录补算（含 v1 迁移上来的），可选切后端。 */
  reembed: (workspaceId: string, config?: MemoryEmbedConfig) =>
    invoke<MemoryReembedResult>(CHANNELS.memoryReembed, {
      workspaceId,
      ...(config ? { config } : {}),
    }),

  /** 从一段会话抽候选事实（origin=inferred，默认排除，等用户确认）。 */
  extract: (workspaceId: string, sourceSessionId: string, limit?: number) =>
    invoke<MemoryExtractResult>(CHANNELS.memoryExtract, {
      workspaceId,
      sourceSessionId,
      ...(limit ? { limit } : {}),
    }),

  /** 知识库：加入一条文档 / 片段（带来源引用）。 */
  knowledgeAdd: (input: {
    workspaceId: string;
    title: string;
    content: string;
    sourceKind: KnowledgeSourceKind;
    sourceRef?: string;
    sourceTurnId?: string;
  }) => invoke<KnowledgeMutationResult>(CHANNELS.memoryKnowledgeAdd, input),

  /** 知识库：混合语义检索，命中带引用。 */
  knowledgeSearch: (workspaceId: string, query: string, limit?: number) =>
    invoke<KnowledgeSearchResult>(CHANNELS.memoryKnowledgeSearch, {
      workspaceId,
      query,
      ...(limit ? { limit } : {}),
    }),

  /** 知识库：列出某工作区的全部片段。 */
  knowledgeList: (workspaceId: string) =>
    invoke<KnowledgeListResult>(CHANNELS.memoryKnowledgeList, { workspaceId }),

  /** 知识库：取一条片段全文与来源。 */
  knowledgeGet: (id: string) => invoke<KnowledgeGetResult>(CHANNELS.memoryKnowledgeGet, { id }),

  /** 知识库：删除一条片段（同时清 FTS + 向量）。 */
  knowledgeDelete: (id: string) =>
    invoke<KnowledgeMutationResult>(CHANNELS.memoryKnowledgeDelete, { id }),
};

// 供渲染侧下拉/表单复用的常量（不额外发通道，只是类型的取值集合）。
export type { MemoryType, MemoryScope, MemorySensitivity };
