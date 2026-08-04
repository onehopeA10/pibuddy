import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Provider 嵌入的**契约测试**（FEAT-memory-v2.md §5「未能真机端到端验证的两环」
 * 之一）：本环境无 embedding 凭据，无法真的连 OpenAI。这里把 safeFetch 与 auth
 * 用替身钉死，验证「一旦接上真实凭据，请求 / 响应的形状是对的」——URL、鉴权头、
 * 请求体 `{model,input}`、响应 `data[].embedding` 的解析、归一、以及各错误码。
 *
 * ## 为什么用替身而不是真连
 *
 * safeFetch 是全仓唯一出站原语，真连会做 DNS + 公网校验并真的打 OpenAI。契约
 * 测试要的是**形状**不是**连通**，故 vi.mock 掉 safeFetch（拦下请求、喂回一个
 * 罐装 OpenAI 响应）。真机连通留待有凭据的环境，逻辑由此测钉死。
 *
 * ## 可证伪
 *
 * 断言的是具体的请求体字段与解析结果，不是「safeFetch 被调用过」。把 embed 的
 * 请求体形状写错（如漏掉 model）、或把响应字段名读错（embedding→vector），断言
 * 立刻不等而变红。
 */

const safeFetch = vi.fn();
const readAuthFile = vi.fn();

vi.mock("../src/main/net/outbound-guard.js", () => ({ safeFetch }));
vi.mock("../src/main/providers/auth-store.js", () => ({ readAuthFile }));

const {
  providerEmbedder,
  localEmbedder,
  resolveEmbedder,
  __setEmbedder,
  disposeEmbedder,
  EMBED_PROVIDERS,
} = await import("../src/main/memory/memory-embed.js");
const { LOCAL_EMBED_MODEL, LOCAL_EMBED_DIM } = await import("../src/main/memory/memory-vector.js");

function okResponse(embeddings: number[][]) {
  return {
    ok: true,
    status: 200,
    bodyText: JSON.stringify({ data: embeddings.map((embedding) => ({ embedding })) }),
  };
}

beforeEach(() => {
  safeFetch.mockReset();
  readAuthFile.mockReset();
  readAuthFile.mockReturnValue({ openai: { key: "sk-live-abc123" } });
  disposeEmbedder();
});
afterEach(() => {
  disposeEmbedder();
});

describe("providerEmbedder：OpenAI 兼容 /embeddings 的请求形状", () => {
  it("URL / 鉴权头 / 请求体 {model,input} 都对，响应 data[].embedding 归一后返回", async () => {
    safeFetch.mockResolvedValue(okResponse([[3, 4], [0, 5]]));
    const emb = providerEmbedder("openai");
    const vecs = await emb.embed(["猫", "狗"]);

    // —— 请求形状 ——
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = safeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-live-abc123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      model: EMBED_PROVIDERS.openai.model,
      input: ["猫", "狗"],
    });

    // —— 响应解析 + 归一 ——
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toBeInstanceOf(Float32Array);
    // [3,4] → L2 归一 → [0.6,0.8]
    expect(vecs[0][0]).toBeCloseTo(0.6, 5);
    expect(vecs[0][1]).toBeCloseTo(0.8, 5);
    const norm = Math.hypot(...vecs[1]);
    expect(norm).toBeCloseTo(1, 5);
  });

  it("embedder id 带 provider:model —— 检索只比同 id 的向量", () => {
    const emb = providerEmbedder("openai", "text-embedding-3-large");
    expect(emb.id).toBe("openai:text-embedding-3-large");
  });

  it("缺省 model 用该 Provider 的默认嵌入模型", async () => {
    readAuthFile.mockReturnValue({ mistral: { key: "ml-live-xyz" } });
    safeFetch.mockResolvedValue(okResponse([[1, 0]]));
    await providerEmbedder("mistral").embed(["x"]);
    const [, init] = safeFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe(EMBED_PROVIDERS.mistral.model);
  });
});

describe("providerEmbedder：错误路径只暴露状态码 / 分类，不回显上游正文", () => {
  it("非 200 → MEMORY_EMBED_HTTP_<status>（不带响应正文）", async () => {
    safeFetch.mockResolvedValue({ ok: false, status: 429, bodyText: "rate limited: key sk-live-abc123" });
    await expect(providerEmbedder("openai").embed(["x"])).rejects.toThrow("MEMORY_EMBED_HTTP_429");
    // 抛错信息里绝不能带上游正文（可能回显 key）
    await expect(providerEmbedder("openai").embed(["x"])).rejects.not.toThrow(/sk-live/);
  });

  it("条数不匹配 → MEMORY_EMBED_COUNT_MISMATCH", async () => {
    safeFetch.mockResolvedValue(okResponse([[1, 2]])); // 求 2 条只回 1 条
    await expect(providerEmbedder("openai").embed(["a", "b"])).rejects.toThrow(
      "MEMORY_EMBED_COUNT_MISMATCH"
    );
  });

  it("无可用字面量 key → MEMORY_EMBED_NO_KEY，且不发任何请求", async () => {
    readAuthFile.mockReturnValue({}); // 没配 openai
    await expect(providerEmbedder("openai").embed(["x"])).rejects.toThrow("MEMORY_EMBED_NO_KEY");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("key 是 $ENV / !cmd 间接引用（非字面量）→ 同样 NO_KEY（不解引用外泄）", async () => {
    readAuthFile.mockReturnValue({ openai: { key: "$OPENAI_KEY" } });
    await expect(providerEmbedder("openai").embed(["x"])).rejects.toThrow("MEMORY_EMBED_NO_KEY");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("目录外 / 无兼容端点的 Provider → 构造即 MEMORY_EMBED_PROVIDER_UNSUPPORTED", () => {
    expect(() => providerEmbedder("anthropic")).toThrow("MEMORY_EMBED_PROVIDER_UNSUPPORTED");
  });
});

describe("resolveEmbedder：fake / real / 本地三态切换干净", () => {
  it("backend=local → 本地哈希 embedder（离线、无凭据、确定维度）", () => {
    const emb = resolveEmbedder({ backend: "local" });
    expect(emb.id).toBe(LOCAL_EMBED_MODEL);
    expect(emb.dim).toBe(LOCAL_EMBED_DIM);
  });

  it("backend=provider → Provider embedder（id 带 provider:model）", () => {
    const emb = resolveEmbedder({ backend: "provider", provider: "openai" });
    expect(emb.id).toBe(`openai:${EMBED_PROVIDERS.openai.model}`);
  });

  it("__setEmbedder 注入覆盖一切配置（单测 / 概念替身用），传 null 恢复", () => {
    const fake = { id: "fake-emb", dim: 4, embed: async () => [] };
    __setEmbedder(fake);
    expect(resolveEmbedder({ backend: "provider", provider: "openai" })).toBe(fake);
    expect(resolveEmbedder({ backend: "local" })).toBe(fake);
    __setEmbedder(null);
    expect(resolveEmbedder({ backend: "local" }).id).toBe(LOCAL_EMBED_MODEL);
  });

  it("localEmbedder 对同一文本确定性输出（可复现，单测能钉死时序的前提）", async () => {
    const emb = localEmbedder();
    const [a] = await emb.embed(["稳定输入"]);
    const [b] = await emb.embed(["稳定输入"]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
