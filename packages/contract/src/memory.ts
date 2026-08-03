/**
 * 长期记忆的契约（MEM-101 第一版，能力包 `common.memory`）。
 *
 * ## 这个文件在回答什么
 *
 * 「一条被记住的事实对外长什么样」，以及渲染进程可以对记忆库发起哪些窄意图：
 * 保存 / 检索 / 编辑 / 合并 / 删除 / 导出 / 看原始证据 / 看注入命中 / 开关注入。
 * 全部经 9 条具名通道，没有一条能表达「注入一段任意上下文」——注入内容只来自
 * 用户显式保存过、且未被排除 / 未过敏感判定的记录。
 *
 * ## 为什么第一版只有「用户显式保存」
 *
 * 模型推断出来的「事实」必须保留来源与置信度，**不能把一次总结当成不可更正的
 * 真相**。自动抽取一旦上线，一条抽错的记忆会在之后每一轮里被反复注入、越描越黑，
 * 而用户没有任何一处能看见它、改它、删它。因此本版先只做用户显式保存这条能被
 * 完整审计（查看 / 编辑 / 合并 / 排除 / 删除 / 导出）的路径；`origin` 字段留着
 * `inferred` 的位置，但本版恒为 `user`。语义检索（embeddings）同理留给第二阶段。
 *
 * ## 为什么不外发 workspaceId 之外的分区键
 *
 * 记忆按 `capabilityId + workspaceId` 分区（ADR-0002 D4 规则 3）。渲染进程本来
 * 就持有那个不透明 workspaceId（sha256(canonical realpath)），因此查询按它过滤；
 * 记录视图里不再重复它，也不含任何绝对路径 —— 真实位置只活在主进程。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

/**
 * 记忆自有数据表的代际。改 DDL 必须 +1 并在 migrate() 里补分支。
 *
 * v1 → v2：新增语义检索的 `embeddings` 表、知识库的 `knowledge` / `knowledge_fts`
 * 表。迁移**只加表、不动 v1 已存的 memories/FTS/meta 一个字节**，老用户升级上来
 * 之前显式保存的记忆一条不丢；语义检索所需的向量按需补算（memory:reembed）。
 */
export const MEMORY_DATA_SCHEMA_VERSION = 2;

/**
 * 记忆的类别。
 *
 *   fact         客观事实（「后端用 PostgreSQL」）
 *   preference   用户偏好（「回复用中文」「不要加表情」）
 *   instruction  长期指令（「提交信息用中文，格式 类型: 描述」）
 *   context      背景上下文（「这个项目是给财务团队做的」）
 *
 * 分类只影响展示与筛选，不影响注入资格——注入资格由 excluded / sensitivity /
 * expiry 决定。
 */
export const MEMORY_TYPES = ["fact", "preference", "instruction", "context"] as const;
export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

/**
 * 记忆的作用域。
 *
 *   workspace  只在保存它的那个工作区注入
 *   global     在任何工作区都可注入
 *
 * 与「记录存在哪」无关：无论哪种作用域，记录都带着它被保存时的 origin workspace，
 * 「原始证据」正是靠那个 workspace 把 sourceSessionId 解回会话文件的。
 */
export const memoryScopeSchema = z.enum(["workspace", "global"]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

/**
 * 敏感度。
 *
 * `sensitive` 的记录**默认不注入**（即便未被显式排除），且它的正文不进注入命中
 * 记录、不进日志。secret 一律在保存入口就被挡下，根本不落库（见主进程
 * memory-store 的 classifyContent）——`sensitive` 留给「不是密钥、但用户不希望
 * 它被顺手塞进提示词」的那类内容。
 */
export const memorySensitivitySchema = z.enum(["normal", "sensitive"]);
export type MemorySensitivity = z.infer<typeof memorySensitivitySchema>;

/**
 * 来源。
 *
 * 本版恒为 `user`（只做显式保存）。留着 `inferred` 是为了让第二阶段的自动抽取
 * 一上来就带着「这是推断的，可能是错的」这条元信息，而不是把总结伪装成事实。
 */
export const memoryOriginSchema = z.enum(["user", "inferred"]);
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;

/**
 * 一条记忆的渲染侧视图。
 *
 * 不含 workspaceId（渲染进程查询时自带）与任何绝对路径。`confidence` 与 `origin`
 * 一起回答「这条有多可信、从哪来」——用户据此决定要不要采信、要不要改。
 */
export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  type: memoryTypeSchema,
  scope: memoryScopeSchema,
  origin: memoryOriginSchema,
  /** 0~1。用户显式保存默认 1；第二阶段的推断记忆会带一个更低的值 */
  confidence: z.number().min(0).max(1),
  sensitivity: memorySensitivitySchema,
  /** 被用户排除：保留记录与证据，但不再参与注入 */
  excluded: z.boolean(),
  /** 来源会话（不透明 id）；用户直接手写、无来源时为 null */
  sourceSessionId: z.string().nullable(),
  /** 来源会话里的具体一轮（entry id）；无则为 null */
  sourceTurnId: z.string().nullable(),
  created: z.number(),
  updated: z.number(),
  /** 过期时刻（Unix ms）；到期后不再注入，也不在默认视图里显示。null = 永不过期 */
  expiry: z.number().nullable(),
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

// ---------------------------------------------------------------- 请求 / 返回

/**
 * 保存一条记忆（用户显式动作）。
 *
 * secret 检测在主进程入口做，命中直接拒绝（`ok:false`），不落库、不返回记录 ——
 * 「默认不进 memory」这句话的落地点就在那里，而不是靠调用方自觉。
 */
export const memorySaveRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    content: z.string().min(1),
    type: memoryTypeSchema,
    scope: memoryScopeSchema,
    sourceSessionId: z.string().optional(),
    sourceTurnId: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    expiry: z.number().nullable().optional(),
    sensitivity: memorySensitivitySchema.optional(),
  })
  .strict();
export type MemorySaveRequest = z.infer<typeof memorySaveRequestSchema>;

export const memoryQueryRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** FTS 检索词；空则列全部 */
    query: z.string().optional(),
    scope: memoryScopeSchema.optional(),
    /** true = 连同被排除的一起返回（管理视图）；默认只看未排除的 */
    includeExcluded: z.boolean().optional(),
  })
  .strict();
export type MemoryQueryRequest = z.infer<typeof memoryQueryRequestSchema>;

export const memoryQueryResultSchema = z.object({
  items: z.array(memoryRecordSchema),
  total: z.number().int().nonnegative(),
  /** 当前工作区的注入开关 */
  injectionEnabled: z.boolean(),
  /** 全局注入总开关（关掉它 = 任何工作区都不注入） */
  globalInjectionEnabled: z.boolean(),
});
export type MemoryQueryResult = z.infer<typeof memoryQueryResultSchema>;

/**
 * 编辑一条记忆。只带要改的字段。
 *
 * 编辑正文会重跑一次 secret 检测：一条本来干净的记忆被改成含密钥的内容，
 * 同样必须被挡下（`ok:false`），否则 secret 就从编辑这条旁路进来了。
 */
export const memoryUpdateRequestSchema = z
  .object({
    id: z.string().min(1),
    content: z.string().min(1).optional(),
    type: memoryTypeSchema.optional(),
    scope: memoryScopeSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    expiry: z.number().nullable().optional(),
    sensitivity: memorySensitivitySchema.optional(),
    /** 排除 / 恢复 */
    excluded: z.boolean().optional(),
  })
  .strict();
export type MemoryUpdateRequest = z.infer<typeof memoryUpdateRequestSchema>;

/**
 * 把多条记忆合并成一条。
 *
 * 合并后原来的若干条被删除（连同它们在 FTS 里的行），新的一条带用户给定的正文。
 * 这是「三条零散的偏好其实是一件事」时的整理动作 —— 留着重复的记忆只会让同一
 * 意图被反复注入。
 */
export const memoryMergeRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    ids: z.array(z.string().min(1)).min(2),
    content: z.string().min(1),
  })
  .strict();
export type MemoryMergeRequest = z.infer<typeof memoryMergeRequestSchema>;

/** 按 id 定位一条记忆（删除 / 看证据共用）。 */
export const memoryIdRequestSchema = z.object({ id: z.string().min(1) }).strict();
export type MemoryIdRequest = z.infer<typeof memoryIdRequestSchema>;

/** 单条动作的统一返回：权威快照 + 失败原因。 */
export const memoryMutationResultSchema = z.object({
  ok: z.boolean(),
  record: memoryRecordSchema.nullable(),
  message: z.string().optional(),
});
export type MemoryMutationResult = z.infer<typeof memoryMutationResultSchema>;

export const memoryExportRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    scope: memoryScopeSchema.optional(),
  })
  .strict();
export type MemoryExportRequest = z.infer<typeof memoryExportRequestSchema>;

/**
 * 导出结果：一段 JSON 文本，由渲染进程交给下载 / 复制。
 *
 * **不经主进程写盘**（因此本能力不申请 workspace.write）：导出是让用户把自己的
 * 记忆带走，落到哪由用户在浏览器侧决定，主进程不必也不该替他选一个磁盘位置。
 */
export const memoryExportResultSchema = z.object({
  content: z.string(),
  format: z.literal("json"),
  count: z.number().int().nonnegative(),
});
export type MemoryExportResult = z.infer<typeof memoryExportResultSchema>;

/**
 * 原始证据：把一条记忆的来源会话轮次原文取回来。
 *
 * 「模型推断的事实要保留来源」这条要求的用户出口就是它——用户点开一条记忆，
 * 能看到它到底是从哪一句话里来的，据此判断要不要采信。读会话文件是本能力唯一
 * 真正的 `workspace.read`。取不到（无来源 / 文件已删 / 找不到那一轮）时
 * `found:false`，绝不编造。
 */
export const memoryEvidenceResultSchema = z.object({
  found: z.boolean(),
  sessionName: z.string().nullable(),
  text: z.string(),
});
export type MemoryEvidenceResult = z.infer<typeof memoryEvidenceResultSchema>;

/**
 * 一条注入命中记录（调试 / 隐私视图）。
 *
 * `preview` 是脱敏后的短摘要，**绝不是正文全文**：命中记录本身若原样存正文，
 * 就等于在日志之外又开了一处敏感内容的落点。sensitive 记录根本不参与注入，
 * 因此也不会出现在这里。
 */
export const memoryHitSchema = z.object({
  id: z.string(),
  type: memoryTypeSchema,
  scope: memoryScopeSchema,
  preview: z.string(),
  at: z.number(),
});
export type MemoryHit = z.infer<typeof memoryHitSchema>;

export const memoryHitsRequestSchema = z.object({ workspaceId: z.string().min(1) }).strict();
export const memoryHitsResultSchema = z.object({ hits: z.array(memoryHitSchema) });
export type MemoryHitsResult = z.infer<typeof memoryHitsResultSchema>;

/**
 * 开关注入。
 *
 *   target: "workspace"  只关当前工作区（其它工作区照旧）
 *   target: "global"     全局总开关（关掉它 = 所有工作区都不注入）
 *
 * 关闭注入**不删任何记忆**：记录、证据、命中历史都还在，只是暂时不再被塞进
 * 提示词。这与「删除」是两个动作。
 */
export const memorySetInjectionRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    target: z.enum(["workspace", "global"]),
    enabled: z.boolean(),
  })
  .strict();
export type MemorySetInjectionRequest = z.infer<typeof memorySetInjectionRequestSchema>;

export const memoryInjectionStateSchema = z.object({
  injectionEnabled: z.boolean(),
  globalInjectionEnabled: z.boolean(),
});
export type MemoryInjectionState = z.infer<typeof memoryInjectionStateSchema>;

// ================================================================
//  第二版：语义检索 + 知识库 + 有限抽取（MEM-101 v2）
// ================================================================

/**
 * 混合语义检索（memory:search）。
 *
 * 与 memory:query 的区别：query 是**管理视图**的 FTS 过滤（列出、按子串筛）；
 * search 是**相关度检索**——FTS 命中与向量余弦混合打分排序，回答「和这句话最相关的
 * 记忆是哪几条」。空 query 无意义，因此 query 必填非空。
 */
export const memorySearchRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    query: z.string().min(1),
    scope: memoryScopeSchema.optional(),
    /** 返回条数上限；缺省由主进程定（当前 8） */
    limit: z.number().int().positive().max(50).optional(),
  })
  .strict();
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>;

/**
 * 一条检索命中：记录本体 + 分数分解。
 *
 * `ftsScore` / `vectorScore` 分别是词命中与向量余弦的归一分，`score` 是二者的
 * 加权和。分解出来是为了让「为什么这条排在前面」可解释、可调试，而不是一个
 * 黑箱数字。
 */
export const memorySearchHitSchema = z.object({
  record: memoryRecordSchema,
  score: z.number(),
  ftsScore: z.number(),
  vectorScore: z.number(),
});
export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>;

export const memorySearchResultSchema = z.object({
  items: z.array(memorySearchHitSchema),
  /** 本次检索用的 embedder 后端（local / provider / fake），供 UI 如实标注 */
  backend: z.string(),
});
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;

/**
 * 嵌入状态（memory:embed-status）。
 *
 * `embeddedMemories < totalMemories` 说明有记录还没向量（多半是 v1 迁移上来的 /
 * 换了 embedder），UI 据此提示「重嵌以启用语义检索」。
 */
export const memoryEmbedStatusSchema = z.object({
  backend: z.enum(["local", "provider"]),
  provider: z.string().nullable(),
  model: z.string(),
  dim: z.number().int().nonnegative(),
  embeddedMemories: z.number().int().nonnegative(),
  totalMemories: z.number().int().nonnegative(),
  embeddedKnowledge: z.number().int().nonnegative(),
  totalKnowledge: z.number().int().nonnegative(),
});
export type MemoryEmbedStatus = z.infer<typeof memoryEmbedStatusSchema>;

/** 嵌入后端配置。切后端会让旧向量作废，因此附一次「已触发重嵌」的结果。 */
export const memoryEmbedConfigSchema = z
  .object({
    backend: z.enum(["local", "provider"]),
    provider: z.string().optional(),
    model: z.string().optional(),
  })
  .strict();
export type MemoryEmbedConfig = z.infer<typeof memoryEmbedConfigSchema>;

/**
 * 重嵌请求（memory:reembed）。
 *
 * 可选切换后端；不带 config 时用当前后端为缺向量的记录补算。返回补了多少条。
 */
export const memoryReembedRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    config: memoryEmbedConfigSchema.optional(),
  })
  .strict();
export type MemoryReembedRequest = z.infer<typeof memoryReembedRequestSchema>;

export const memoryReembedResultSchema = z.object({
  ok: z.boolean(),
  embeddedMemories: z.number().int().nonnegative(),
  embeddedKnowledge: z.number().int().nonnegative(),
  status: memoryEmbedStatusSchema,
  message: z.string().optional(),
});
export type MemoryReembedResult = z.infer<typeof memoryReembedResultSchema>;

/**
 * 从一段会话抽候选事实（memory:extract）。
 *
 * ADR 红线：**不能把总结当不可更正真相**。因此抽取出来的每一条：
 *   - `origin` 恒为 `inferred`（明确「这是推断的，可能是错的」）；
 *   - `confidence` < 1（默认 0.5）；
 *   - 保留 `sourceSessionId` / `sourceTurnId`，用户能点开看原文（memory:evidence）；
 *   - 落库即可查、可编辑、可删除——与用户显式保存的记忆走同一套审计通道。
 *
 * 抽取**不自动注入**：候选默认 `excluded: true`，等用户在面板里逐条确认（取消排除）
 * 才进注入候选。一条抽错的事实因此不会在用户没看见时就被反复塞进提示词。
 */
export const memoryExtractRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceSessionId: z.string().min(1),
    /** 最多抽几条 */
    limit: z.number().int().positive().max(20).optional(),
  })
  .strict();
export type MemoryExtractRequest = z.infer<typeof memoryExtractRequestSchema>;

export const memoryExtractResultSchema = z.object({
  /** 已落库的候选（origin=inferred, excluded=true），供面板逐条确认 */
  candidates: z.array(memoryRecordSchema),
  /** 扫描到的会话轮次数（供 UI 说明「从 N 轮里抽出 M 条」） */
  scannedTurns: z.number().int().nonnegative(),
});
export type MemoryExtractResult = z.infer<typeof memoryExtractResultSchema>;

// ---------------------------------------------------------------- 知识库

/**
 * 知识片段的来源。
 *
 *   session   来自某会话某一轮（sourceRef=sessionId, sourceTurnId=轮次）
 *   file      来自某文件（sourceRef=相对路径）
 *   manual    用户手工录入（无来源）
 *
 * 来源是知识库与「一段无从核对的文本」的区别：检索命中时把它一并回给用户，
 * 「这条知识出自哪」始终可追溯。
 */
export const knowledgeSourceKindSchema = z.enum(["session", "file", "manual"]);
export type KnowledgeSourceKind = z.infer<typeof knowledgeSourceKindSchema>;

export const knowledgeRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  content: z.string(),
  sourceKind: knowledgeSourceKindSchema,
  /** 来源坐标：会话 id / 文件相对路径；manual 为 null */
  sourceRef: z.string().nullable(),
  sourceTurnId: z.string().nullable(),
  created: z.number(),
  updated: z.number(),
});
export type KnowledgeRecord = z.infer<typeof knowledgeRecordSchema>;

export const knowledgeAddRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    title: z.string().min(1),
    content: z.string().min(1),
    sourceKind: knowledgeSourceKindSchema,
    sourceRef: z.string().optional(),
    sourceTurnId: z.string().optional(),
  })
  .strict();
export type KnowledgeAddRequest = z.infer<typeof knowledgeAddRequestSchema>;

/** 单条知识动作的统一返回。 */
export const knowledgeMutationResultSchema = z.object({
  ok: z.boolean(),
  record: knowledgeRecordSchema.nullable(),
  message: z.string().optional(),
});
export type KnowledgeMutationResult = z.infer<typeof knowledgeMutationResultSchema>;

export const knowledgeSearchRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    query: z.string().min(1),
    limit: z.number().int().positive().max(50).optional(),
  })
  .strict();
export type KnowledgeSearchRequest = z.infer<typeof knowledgeSearchRequestSchema>;

/** 一条知识命中：记录 + 分数 + 引用（来源三元组，UI 直接展示「出自哪」）。 */
export const knowledgeHitSchema = z.object({
  record: knowledgeRecordSchema,
  score: z.number(),
  ftsScore: z.number(),
  vectorScore: z.number(),
  citation: z.object({
    sourceKind: knowledgeSourceKindSchema,
    sourceRef: z.string().nullable(),
    sourceTurnId: z.string().nullable(),
  }),
});
export type KnowledgeHit = z.infer<typeof knowledgeHitSchema>;

export const knowledgeSearchResultSchema = z.object({
  items: z.array(knowledgeHitSchema),
  backend: z.string(),
});
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;

export const knowledgeListRequestSchema = z
  .object({ workspaceId: z.string().min(1) })
  .strict();
export type KnowledgeListRequest = z.infer<typeof knowledgeListRequestSchema>;

export const knowledgeListResultSchema = z.object({
  items: z.array(knowledgeRecordSchema),
  total: z.number().int().nonnegative(),
});
export type KnowledgeListResult = z.infer<typeof knowledgeListResultSchema>;

export const knowledgeIdRequestSchema = z.object({ id: z.string().min(1) }).strict();
export type KnowledgeIdRequest = z.infer<typeof knowledgeIdRequestSchema>;

export const knowledgeGetResultSchema = z.object({
  record: knowledgeRecordSchema.nullable(),
});
export type KnowledgeGetResult = z.infer<typeof knowledgeGetResultSchema>;

// ---------- 通道契约分片（ADR-0002：各分片各自声明，宿主合并时封口） ----------
//
// 分片 id 是 capabilityId 的第二段（`common.memory` → `memory`）：drift test 据它
// 把「清单声明的通道」和「分片声明的契约键」对账，两者对不上即变红。
export const memoryContractShard = defineContractShard("memory", {
  [CHANNELS.memoryQuery]: {
    request: memoryQueryRequestSchema,
    response: memoryQueryResultSchema,
  },
  [CHANNELS.memorySave]: {
    request: memorySaveRequestSchema,
    response: memoryMutationResultSchema,
  },
  [CHANNELS.memoryUpdate]: {
    request: memoryUpdateRequestSchema,
    response: memoryMutationResultSchema,
  },
  [CHANNELS.memoryMerge]: {
    request: memoryMergeRequestSchema,
    response: memoryMutationResultSchema,
  },
  [CHANNELS.memoryDelete]: {
    request: memoryIdRequestSchema,
    response: memoryMutationResultSchema,
  },
  [CHANNELS.memoryExport]: {
    request: memoryExportRequestSchema,
    response: memoryExportResultSchema,
  },
  [CHANNELS.memoryEvidence]: {
    request: memoryIdRequestSchema,
    response: memoryEvidenceResultSchema,
  },
  [CHANNELS.memoryHits]: {
    request: memoryHitsRequestSchema,
    response: memoryHitsResultSchema,
  },
  [CHANNELS.memorySetInjection]: {
    request: memorySetInjectionRequestSchema,
    response: memoryInjectionStateSchema,
  },
  // ---- v2：语义检索 + 知识库 + 抽取 ----
  [CHANNELS.memorySearch]: {
    request: memorySearchRequestSchema,
    response: memorySearchResultSchema,
  },
  [CHANNELS.memoryEmbedStatus]: {
    request: memoryHitsRequestSchema,
    response: memoryEmbedStatusSchema,
  },
  [CHANNELS.memoryReembed]: {
    request: memoryReembedRequestSchema,
    response: memoryReembedResultSchema,
  },
  [CHANNELS.memoryExtract]: {
    request: memoryExtractRequestSchema,
    response: memoryExtractResultSchema,
  },
  [CHANNELS.memoryKnowledgeAdd]: {
    request: knowledgeAddRequestSchema,
    response: knowledgeMutationResultSchema,
  },
  [CHANNELS.memoryKnowledgeSearch]: {
    request: knowledgeSearchRequestSchema,
    response: knowledgeSearchResultSchema,
  },
  [CHANNELS.memoryKnowledgeList]: {
    request: knowledgeListRequestSchema,
    response: knowledgeListResultSchema,
  },
  [CHANNELS.memoryKnowledgeGet]: {
    request: knowledgeIdRequestSchema,
    response: knowledgeGetResultSchema,
  },
  [CHANNELS.memoryKnowledgeDelete]: {
    request: knowledgeIdRequestSchema,
    response: knowledgeMutationResultSchema,
  },
});
