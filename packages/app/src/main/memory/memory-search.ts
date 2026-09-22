/**
 * 混合语义检索（MEM-101 第二版）——FTS 命中与向量余弦的加权排序。
 *
 * ## 为什么是「混合」而不是「纯向量」
 *
 * 纯向量检索会漏掉精确词命中（一条正好含查询词的记忆，向量却未必最近），
 * 纯 FTS 又答不了近义（「汽车」查不到「轿车」）。两者各补对方的短板：
 *
 *   score = FTS_WEIGHT · ftsNorm + VEC_WEIGHT · vecNorm
 *
 * FTS 分是命中词数（trigram 子串），向量分是查询向量与记录向量的余弦（负相关
 * 截到 0）。两者各自按本次结果里的最大值归一到 [0,1] 再加权 —— 不归一的话，
 * 一个天生量纲更大的分量会永远压过另一个，「混合」就名不副实。
 *
 * ## embedder 的 id 就是向量空间的身份
 *
 * 检索只在**同 embedder id** 的向量之间算余弦（store 层的 JOIN 已按 model 过滤）。
 * 查询用当前 embedder 现算一个向量，去比库里同 model 的向量；换了 embedder 而
 * 没重嵌时，语义分整体为 0，退化成纯 FTS —— 而不是拿两个不同空间的向量算出
 * 一个看似有意义、实则是噪声的数。
 */
import type {
  KnowledgeHit,
  KnowledgeRecord,
  MemoryEmbedStatus,
  MemoryRecord,
  MemorySearchHit,
} from "@pibuddy/contract";

import { resolveEmbedder, type EmbeddingConfig, type Embedder } from "./memory-embed.js";
import { extractTerms, memoryStore, type MemoryStore } from "./memory-store.js";
import { LOCAL_EMBED_DIM, LOCAL_EMBED_MODEL, cosine } from "./memory-vector.js";
import { meaningfulLexicalOverlap } from "./query-compiler.js";

const FTS_WEIGHT = 0.5;
const VEC_WEIGHT = 0.5;
/**
 * local-hash-v1 has no semantic model: unrelated unit vectors have a
 * per-coordinate collision scale of 1/sqrt(dim). Four such scales is a
 * conservative collision guard, not a claim of semantic relatedness.
 */
const LOCAL_VECTOR_ADMISSION = 4 / Math.sqrt(LOCAL_EMBED_DIM);
/**
 * Provider embeddings may carry synonym meaning with no shared words. Requiring
 * cosine >= 0.5 means the directions agree within 60 degrees before batch
 * normalization can amplify the score. This is only an angular quality floor;
 * model-specific calibration remains future work.
 */
const PROVIDER_VECTOR_ADMISSION = 0.5;
/** 注入一轮最多几条（与 v1 一致）。 */
export const MAX_INJECTED = 8;

function storeOr(store?: MemoryStore): MemoryStore {
  return store ?? memoryStore();
}

/** 从 store 的 meta 配置解出当前 embedder（注入的 fake 覆盖配置，见 memory-embed）。 */
export function activeEmbedder(store?: MemoryStore): Embedder {
  const cfg = storeOr(store).embeddingConfig();
  const config: EmbeddingConfig = {
    backend: cfg.backend,
    ...(cfg.provider ? { provider: cfg.provider } : {}),
    ...(cfg.model ? { model: cfg.model } : {}),
  };
  return resolveEmbedder(config);
}

/** 把一批分数按最大值归一到 [0,1]（最大为 0 时整批为 0）。 */
function normalize(scores: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of scores.values()) if (v > max) max = v;
  const out = new Map<string, number>();
  for (const [k, v] of scores) out.set(k, max > 0 ? v / max : 0);
  return out;
}

function admitsRawVector(
  embedder: Embedder,
  similarity: number,
  query: string,
  content: string
): boolean {
  const isLocalHash = embedder.id === LOCAL_EMBED_MODEL;
  const minimum = isLocalHash ? LOCAL_VECTOR_ADMISSION : PROVIDER_VECTOR_ADMISSION;
  if (similarity < minimum) return false;
  return !isLocalHash || meaningfulLexicalOverlap(query, content) > 0;
}

/**
 * 排序某工作区里与 `text` 最相关的记忆（供 memory:search 与注入共用）。
 *
 * 候选资格与注入一致：未排除、非 sensitive、未过期、作用域匹配（store 层保证）。
 */
export async function rankedMemories(
  store: MemoryStore,
  workspaceId: string,
  text: string,
  limit: number
): Promise<MemorySearchHit[]> {
  const terms = extractTerms(text);
  const embedder = activeEmbedder(store);

  // —— FTS 分 —— 候选生成仍复用 FTS，准入按完整实词重新计分。
  const ftsRaw = new Map<string, number>();
  const records = new Map<string, MemoryRecord>();
  for (const cand of store.injectionCandidates(workspaceId, terms, 500)) {
    const overlap = meaningfulLexicalOverlap(text, cand.content);
    if (overlap <= 0) continue;
    ftsRaw.set(cand.id, overlap);
    records.set(cand.id, cand);
  }

  // —— 向量分 —— 查询向量与库中同 model 向量的余弦
  const vecRaw = new Map<string, number>();
  const vectors = store.eligibleMemoryVectors(workspaceId, embedder.id);
  if (vectors.length > 0) {
    const [queryVec] = await embedder.embed([text]);
    if (queryVec) {
      for (const { record, vec } of vectors) {
        const sim = Math.max(0, cosine(queryVec, vec));
        if (admitsRawVector(embedder, sim, text, record.content)) {
          vecRaw.set(record.id, sim);
          if (!records.has(record.id)) records.set(record.id, record);
        }
      }
    }
  }

  const ftsN = normalize(ftsRaw);
  const vecN = normalize(vecRaw);
  const hits: MemorySearchHit[] = [];
  for (const [id, record] of records) {
    const f = ftsN.get(id) ?? 0;
    const v = vecN.get(id) ?? 0;
    const score = FTS_WEIGHT * f + VEC_WEIGHT * v;
    if (score <= 0) continue;
    hits.push({ record, score, ftsScore: f, vectorScore: v });
  }
  hits.sort((a, b) => b.score - a.score || b.record.confidence - a.record.confidence);
  return hits.slice(0, limit);
}

/** memory:search 的实现。 */
export async function searchMemories(
  workspaceId: string,
  query: string,
  scope: MemoryRecord["scope"] | undefined,
  limit: number,
  store?: MemoryStore
): Promise<{ items: MemorySearchHit[]; backend: string }> {
  const s = storeOr(store);
  let items = await rankedMemories(s, workspaceId, query, limit);
  if (scope) items = items.filter((h) => h.record.scope === scope);
  return { items, backend: activeEmbedder(s).id };
}

/** knowledge:kb-search 的实现（命中带来源引用）。 */
export async function searchKnowledge(
  workspaceId: string,
  query: string,
  limit: number,
  store?: MemoryStore
): Promise<{ items: KnowledgeHit[]; backend: string }> {
  const s = storeOr(store);
  const terms = extractTerms(query);
  const embedder = activeEmbedder(s);

  const ftsRaw = new Map<string, number>();
  const records = new Map<string, KnowledgeRecord>();
  for (const [id, { record }] of s.knowledgeFtsHits(workspaceId, terms)) {
    const overlap = meaningfulLexicalOverlap(query, record.content);
    if (overlap <= 0) continue;
    ftsRaw.set(id, overlap);
    records.set(id, record);
  }

  const vecRaw = new Map<string, number>();
  const vectors = s.knowledgeVectors(workspaceId, embedder.id);
  if (vectors.length > 0) {
    const [queryVec] = await embedder.embed([query]);
    if (queryVec) {
      for (const { record, vec } of vectors) {
        const sim = Math.max(0, cosine(queryVec, vec));
        if (admitsRawVector(embedder, sim, query, record.content)) {
          vecRaw.set(record.id, sim);
          if (!records.has(record.id)) records.set(record.id, record);
        }
      }
    }
  }

  const ftsN = normalize(ftsRaw);
  const vecN = normalize(vecRaw);
  const items: KnowledgeHit[] = [];
  for (const [id, record] of records) {
    const f = ftsN.get(id) ?? 0;
    const v = vecN.get(id) ?? 0;
    const score = FTS_WEIGHT * f + VEC_WEIGHT * v;
    if (score <= 0) continue;
    items.push({
      record,
      score,
      ftsScore: f,
      vectorScore: v,
      citation: {
        sourceKind: record.sourceKind,
        sourceRef: record.sourceRef,
        sourceTurnId: record.sourceTurnId,
      },
    });
  }
  items.sort((a, b) => b.score - a.score);
  return { items: items.slice(0, limit), backend: embedder.id };
}

/**
 * 为一条记忆 / 知识补算并写入向量（保存 / 抽取 / 知识新增后调用）。
 *
 * 失败**不抛**（Provider 可能不可达）：向量缺失只让语义检索退化成 FTS，不该让
 * 「保存记忆」这条主动作跟着失败。返回是否成功嵌入，供调用方按需上报。
 */
export async function embedMemory(
  store: MemoryStore,
  refId: string,
  workspaceId: string,
  scope: MemoryRecord["scope"],
  text: string
): Promise<boolean> {
  try {
    const embedder = activeEmbedder(store);
    const [vec] = await embedder.embed([text]);
    if (!vec) return false;
    store.upsertEmbedding("memory", refId, workspaceId, scope, embedder.id, vec);
    return true;
  } catch {
    return false;
  }
}

export async function embedKnowledge(
  store: MemoryStore,
  refId: string,
  workspaceId: string,
  text: string
): Promise<boolean> {
  try {
    const embedder = activeEmbedder(store);
    const [vec] = await embedder.embed([text]);
    if (!vec) return false;
    store.upsertEmbedding("knowledge", refId, workspaceId, "workspace", embedder.id, vec);
    return true;
  } catch {
    return false;
  }
}

/**
 * 为缺向量 / 换了 embedder 的记录批量重嵌（v1 迁移上来的记录靠它拿到语义检索能力）。
 *
 * 一律**覆盖式**重算并写入当前 embedder 的向量：换后端时旧向量作废，重嵌把它们
 * 换成新空间的向量。返回补了多少条。
 */
export async function reembedWorkspace(
  store: MemoryStore,
  workspaceId: string
): Promise<{ embeddedMemories: number; embeddedKnowledge: number }> {
  const embedder = activeEmbedder(store);
  let embeddedMemories = 0;
  let embeddedKnowledge = 0;

  const mems = store.visibleMemoriesForEmbedding(workspaceId);
  if (mems.length > 0) {
    const vecs = await embedder.embed(mems.map((m) => m.content));
    for (let i = 0; i < mems.length; i++) {
      const vec = vecs[i];
      const m = mems[i]!;
      if (!vec) continue;
      store.upsertEmbedding("memory", m.id, workspaceId, m.scope, embedder.id, vec);
      embeddedMemories++;
    }
  }

  const docs = store.knowledgeForEmbedding(workspaceId);
  if (docs.length > 0) {
    const vecs = await embedder.embed(docs.map((d) => d.content));
    for (let i = 0; i < docs.length; i++) {
      const vec = vecs[i];
      const d = docs[i]!;
      if (!vec) continue;
      store.upsertEmbedding("knowledge", d.id, workspaceId, "workspace", embedder.id, vec);
      embeddedKnowledge++;
    }
  }

  return { embeddedMemories, embeddedKnowledge };
}

/** embed-status 的实现。 */
export function embedStatus(workspaceId: string, store?: MemoryStore): MemoryEmbedStatus {
  const s = storeOr(store);
  const cfg = s.embeddingConfig();
  const embedder = activeEmbedder(s);
  const mem = s.memoryEmbedCounts(workspaceId, embedder.id);
  const kb = s.knowledgeEmbedCounts(workspaceId, embedder.id);
  return {
    backend: cfg.backend,
    provider: cfg.provider,
    model: embedder.id,
    dim: embedder.dim,
    embeddedMemories: mem.embedded,
    totalMemories: mem.total,
    embeddedKnowledge: kb.embedded,
    totalKnowledge: kb.total,
  };
}
