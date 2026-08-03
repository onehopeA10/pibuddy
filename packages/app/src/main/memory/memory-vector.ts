/**
 * 向量原语（MEM-101 第二版）——**纯 JS，零依赖，可在纯 node 下跑**。
 *
 * ## 为什么不引任何向量库
 *
 * `check-pure-js-deps` 闸门会拦下任何带原生扩展的依赖（node-gyp / .node 二进制）：
 * 那类库在打包机上编出来的 ABI 和用户机器上的 Electron 对不上，表现不是构建失败，
 * 而是用户启动时一句 `Module did not self-register`，而 CI 全绿。语义检索的向量
 * 存储与相似度因此一律走纯 JS：向量以 Float32Array 序列化成 BLOB 存进 node:sqlite，
 * 相似度在 JS 里算。记忆库规模（一个人显式保存的记忆 + 少量知识片段）用暴力
 * 余弦足够，不需要 HNSW/IVF 这类要原生实现的近似索引。
 *
 * ## 本地嵌入（hashEmbed）是「无凭据也能真跑」的那条路
 *
 * 语义检索的向量来源有两条：用户已配置的 Provider（memory-embed 里走 safeFetch），
 * 或**本地哈希嵌入**。后者是特征哈希（hashing trick）：把文本切成词 / 中文 n-gram
 * 特征，各自哈希到定长向量的一维上带符号累加，再 L2 归一。它确定性、离线、无凭据，
 * 因此语义检索的**整条管线**（保存 → 嵌入 → 向量命中 → 删除 → 再检索零命中）在没有
 * 任何 API key 的机器上也能端到端跑通、也能被单测钉死。它捕捉的是形近 / 子串 / 共享
 * 词的信号（真正的近义词需要 Provider 嵌入），但架构（混合排序、删除覆盖向量、
 * 代际迁移）是同一套，Provider 嵌入只是把 embedder 换一个实现。
 */

/** 本地哈希嵌入的维度。够区分个人规模的记忆，BLOB 也就 1KB/条。 */
export const LOCAL_EMBED_DIM = 256;

/** 本地哈希嵌入的模型标识。存进每条向量，检索时只比同模型的向量（见 memory-embed）。 */
export const LOCAL_EMBED_MODEL = "local-hash-v1";

/**
 * Float32Array → 可直接写进 sqlite BLOB 的字节。
 *
 * node:sqlite 的 BLOB 收 Uint8Array / Buffer。这里返回底层 buffer 的一个视图，
 * 不额外拷贝。
 */
export function serializeVector(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * sqlite 读回来的 BLOB（Uint8Array）→ Float32Array。
 *
 * 必须**拷贝**成一段零偏移的新 buffer 再包 Float32Array：sqlite 回来的 Uint8Array
 * 的 byteOffset 不保证是 4 的倍数，直接 `new Float32Array(bytes.buffer, bytes.byteOffset)`
 * 会在偏移不对齐时抛 RangeError。`Uint8Array.from` 造一段新的零偏移 buffer。
 */
export function deserializeVector(bytes: Uint8Array): Float32Array {
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/**
 * 余弦相似度。
 *
 * 约定所有存进库的向量都已 L2 归一（见 hashEmbed / memory-embed 的 Provider 分支），
 * 因此这里等价于点积。维度不一致（换了 embedder 且没重嵌）时返回 0，绝不跨维乱算。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** FNV-1a 32 位哈希：确定性、无依赖，用来把一个特征映射到向量的一维。 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // *16777619，用移位组合避免 32 位溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * 从一段文本抽出用于嵌入的特征。
 *
 * 与 memory-store 的 extractTerms 同源但**更细**：英文按单词，中文按 2/3 字滑窗，
 * 好让「PostgreSQL」与「Postgres」这类形近词共享特征、落在相近的向量方向上。
 */
function embedFeatures(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) out.push(`w:${m[0]}`);
  for (const run of text.matchAll(/[一-龥]{1,}/g)) {
    const s = run[0];
    for (let i = 0; i < s.length; i++) {
      if (i < s.length - 1) out.push(`b:${s.slice(i, i + 2)}`);
      if (i < s.length - 2) out.push(`t:${s.slice(i, i + 3)}`);
    }
  }
  return out;
}

/**
 * 本地哈希嵌入：文本 → L2 归一的定长向量。
 *
 * 特征哈希把每个特征哈希到一维、用另一枚哈希定符号（±1）累加，再归一。
 * 全零输入（无可抽特征）返回全零向量——余弦对它恒为 0，天然不命中。
 */
export function hashEmbed(text: string, dim: number = LOCAL_EMBED_DIM): Float32Array {
  const vec = new Float32Array(dim);
  for (const feature of embedFeatures(text)) {
    const h = fnv1a(feature);
    const idx = h % dim;
    const sign = (fnv1a(`s:${feature}`) & 1) === 0 ? 1 : -1;
    vec[idx]! += sign;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i]! /= norm;
  }
  return vec;
}

/** 把任意数值数组（Provider 返回的 embedding）L2 归一成 Float32Array。 */
export function normalizeVector(values: readonly number[]): Float32Array {
  const vec = Float32Array.from(values);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i]! /= norm;
  }
  return vec;
}
