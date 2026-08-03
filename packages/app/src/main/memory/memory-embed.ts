/**
 * 嵌入来源（MEM-101 第二版）——本地哈希 或 已配置的 Provider。
 *
 * ## 两条来源，一个接口
 *
 * 语义检索需要把文本变成向量。来源有二（ADR-0002 复用「Provider 中心」）：
 *
 *   - **本地哈希嵌入**（默认）：memory-vector 的 hashEmbed，纯 JS、离线、无凭据。
 *     它保证语义检索在任何机器上都能真跑，也是单测能端到端钉死整条时序的前提。
 *   - **Provider 嵌入**：把文本发给用户已配置的 Provider 的 `/embeddings` 端点，
 *     走全仓唯一的出站原语 safeFetch（`main` 下不得有第二处 fetch）。真正的
 *     近义词检索（「汽车」命中「轿车」这类无共享字符的近义）需要它。
 *
 * 两条都实现同一个 `Embedder` 接口（id / dim / embed）。**向量带着产出它的
 * embedder id 存进库**，检索时只比同 id 的向量：本地哈希向量与 Provider 向量
 * 落在不同的空间，混着算余弦是没有意义的数。换 embedder = 重嵌（memory:reembed）。
 *
 * ## Provider 域名是有界的、可如实申报的
 *
 * safeFetch 只放行 HTTPS 公网地址，且 `network:*` 通配被能力权限体系禁止。因此
 * 嵌入**只对目录内、确有 OpenAI 兼容 `/embeddings` 端点的 Provider 开放**
 * （openai / mistral），清单据此逐条申报 `network:<域名>`——权限预览里写的域名
 * 就是真会连的域名，不多不少。自定义端点（任意域名）的嵌入留待权限引擎能表达
 * 「按工作区放行某域名」之后再做，理由与 mcp 缓上 http 连接同源。
 */
import type { PiCredential } from "../providers/auth-store.js";
import { readAuthFile } from "../providers/auth-store.js";
import { KNOWN_PROVIDER_BASE_URLS } from "../providers/provider-catalog.js";
import { safeFetch } from "../net/outbound-guard.js";
import {
  LOCAL_EMBED_DIM,
  LOCAL_EMBED_MODEL,
  hashEmbed,
  normalizeVector,
} from "./memory-vector.js";

/** 一条文本 → 一个已归一向量。批量 embed 摊薄 Provider 往返成本。 */
export interface Embedder {
  /** 模型标识，逐字存进每条向量；检索只比同标识的向量 */
  readonly id: string;
  /** 维度；Provider 端由模型决定，未知时为 0（不参与判定，按实际向量长度对齐） */
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** 嵌入后端配置（存在记忆库 meta 里，全局一份）。 */
export interface EmbeddingConfig {
  backend: "local" | "provider";
  /** backend=provider 时的 Provider id（须在 EMBED_PROVIDERS 里） */
  provider?: string;
  /** backend=provider 时的嵌入模型；缺省用该 Provider 的默认模型 */
  model?: string;
}

/**
 * 有 OpenAI 兼容 `/embeddings` 端点的目录内 Provider。
 *
 * 只列真的能连的：清单的 `network:<域名>` 申报必须与这里逐条对上，否则要么
 * 申报了连不到的域名（误导用户），要么连了没申报的域名（drift 反向对账变红）。
 */
export const EMBED_PROVIDERS: Record<string, { model: string; domain: string }> = {
  openai: { model: "text-embedding-3-small", domain: "api.openai.com" },
  mistral: { model: "mistral-embed", domain: "api.mistral.ai" },
};

/** 本地哈希 embedder：确定性、离线、无凭据。 */
export function localEmbedder(): Embedder {
  return {
    id: LOCAL_EMBED_MODEL,
    dim: LOCAL_EMBED_DIM,
    embed: (texts) => Promise.resolve(texts.map((t) => hashEmbed(t))),
  };
}

/** 从 auth.json 取某 Provider 的字面量 key；不是字面量（$ENV / !cmd）或缺失时返回 null。 */
function literalApiKey(providerId: string): string | null {
  const cred: PiCredential | undefined = readAuthFile()[providerId];
  const key = typeof cred?.key === "string" ? cred.key : "";
  if (key === "" || key.startsWith("$") || key.startsWith("!")) return null;
  return key;
}

/**
 * Provider embedder：把文本发给 `${baseUrl}/embeddings`，出站走 safeFetch。
 *
 * key 缺失 / 非字面量时抛错（而不是静默回落本地）——用户显式选了 Provider 后端，
 * 静默换成本地会让「为什么近义词查不到」无从查起。
 */
export function providerEmbedder(providerId: string, model?: string): Embedder {
  const entry = EMBED_PROVIDERS[providerId];
  if (!entry) throw new Error(`MEMORY_EMBED_PROVIDER_UNSUPPORTED: ${providerId}`);
  const base = KNOWN_PROVIDER_BASE_URLS[providerId];
  if (!base) throw new Error(`MEMORY_EMBED_PROVIDER_NO_BASE: ${providerId}`);
  const useModel = model || entry.model;
  return {
    id: `${providerId}:${useModel}`,
    dim: 0,
    async embed(texts) {
      const apiKey = literalApiKey(providerId);
      if (!apiKey) {
        throw new Error(`MEMORY_EMBED_NO_KEY: ${providerId} 尚未配置可用的 API key`);
      }
      const url = `${base.replace(/\/+$/, "")}/embeddings`;
      const resp = await safeFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: useModel, input: texts }),
      });
      if (!resp.ok) {
        // 只报状态码：上游错误正文里常回显请求头 / key
        throw new Error(`MEMORY_EMBED_HTTP_${resp.status}`);
      }
      const json = JSON.parse(resp.bodyText) as { data?: { embedding?: number[] }[] };
      const rows = json.data ?? [];
      if (rows.length !== texts.length) {
        throw new Error("MEMORY_EMBED_COUNT_MISMATCH");
      }
      return rows.map((r) => normalizeVector(r.embedding ?? []));
    },
  };
}

// ---------------------------------------------------------------- 运行期解析

let injected: Embedder | null = null;
let cached: { key: string; embedder: Embedder } | null = null;

/** 仅供单测：注入一个可控 embedder（近义词映射到相近向量以验证混合排序）。传 null 恢复。 */
export function __setEmbedder(embedder: Embedder | null): void {
  injected = embedder;
  cached = null;
}

function configKey(config: EmbeddingConfig): string {
  return config.backend === "provider"
    ? `provider:${config.provider ?? ""}:${config.model ?? ""}`
    : "local";
}

/**
 * 按配置解出当前 embedder（带缓存，配置不变不重建）。
 *
 * 注入优先：单测里注入的 embedder 覆盖一切配置。
 */
export function resolveEmbedder(config: EmbeddingConfig): Embedder {
  if (injected) return injected;
  const key = configKey(config);
  if (cached && cached.key === key) return cached.embedder;
  const embedder =
    config.backend === "provider" && config.provider
      ? providerEmbedder(config.provider, config.model)
      : localEmbedder();
  cached = { key, embedder };
  return embedder;
}

/** 拆卸：清掉注入与缓存（单测 / 禁用能力）。 */
export function disposeEmbedder(): void {
  injected = null;
  cached = null;
}
