import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_RESPONSE_BYTES,
  OUTBOUND_BLOCKED,
  __setOutboundDeps,
  assertPublicAddress,
  normalizeEndpointUrl,
  parseNumericIpForms,
  safeFetch,
} from "../src/main/net/outbound-guard.js";

/**
 * SEC-004 / CT-08：出站请求的 SSRF 阻断清单。
 *
 * 这份清单不是穷举矩阵，而是**每一类绕过手法各留一条**：只要少拦一类，
 * 渲染进程就能把 Bearer token 送到那一类地址上去。
 */

/** 域名 → 地址的桩表。没列出来的域名一律解析成公网地址。 */
const STUB_DNS: Record<string, string[]> = {
  localhost: ["127.0.0.1"],
  "metadata.google.internal": ["169.254.169.254"],
  // DNS rebinding：一个看起来完全正常的公网域名，解析结果落在 10/8
  "rebind.example.com": ["10.0.0.1"],
  "stt.example.com": ["93.184.216.34"],
  "api.example.com": ["93.184.216.34"],
  "evil.example.com": ["93.184.216.34"],
};

function stubDns(): void {
  __setOutboundDeps({
    lookup: async (hostname) => {
      const addresses = STUB_DNS[hostname] ?? ["93.184.216.34"];
      return addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));
    },
  });
}

afterEach(() => {
  __setOutboundDeps({ lookup: null, fetch: null });
});

/** 走完整条判定链（协议 + 地址），与 endpoints.ts 保存端点时的路径一致。 */
async function guard(raw: string): Promise<void> {
  const url = normalizeEndpointUrl(raw);
  await assertPublicAddress(new URL(url).hostname);
}

describe("SSRF 阻断清单（17 项）", () => {
  const BLOCKED = [
    ["非 https 协议", "http://api.example.com/"],
    ["localhost 域名", "https://localhost/"],
    ["IPv4 环回", "https://127.0.0.1/"],
    ["环回简写", "https://127.1/"],
    ["未指定地址", "https://0.0.0.0/"],
    ["32 位十进制 IP", "https://2130706433/"],
    ["八进制 IP", "https://0177.0.0.1/"],
    ["十六进制 IP", "https://0x7f000001/"],
    ["IPv6 环回", "https://[::1]/"],
    ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/"],
    ["RFC1918 10/8", "https://10.0.0.5/"],
    ["RFC1918 172.16/12", "https://172.16.0.1/"],
    ["RFC1918 192.168/16", "https://192.168.1.1/"],
    ["CGNAT 100.64/10", "https://100.64.0.1/"],
    ["云元数据地址", "https://169.254.169.254/"],
    ["云元数据域名", "https://metadata.google.internal/"],
    ["DNS rebinding（公网域名解析到内网）", "https://rebind.example.com/"],
  ] as const;

  it("清单恰好 17 项", () => {
    expect(BLOCKED.length).toBe(17);
  });

  for (const [label, input] of BLOCKED) {
    it(`阻断：${label} — ${input}`, async () => {
      stubDns();
      await expect(guard(input)).rejects.toThrow(OUTBOUND_BLOCKED);
    });
  }

  it("正常的公网 https 端点放行", async () => {
    stubDns();
    await expect(guard("https://stt.example.com/v1")).resolves.toBeUndefined();
  });

  it("非 https 的拒绝理由里点名 HTTPS（界面要能照着改）", async () => {
    stubDns();
    await expect(guard("http://api.example.com/v1")).rejects.toThrow(/HTTPS/);
  });

  it("内网的拒绝理由里出现「内网」二字", async () => {
    stubDns();
    await expect(guard("https://169.254.169.254/v1")).rejects.toThrow(/内网/);
  });
});

describe("parseNumericIpForms", () => {
  it("四类数字写法都折成 127.0.0.1", () => {
    expect(parseNumericIpForms("2130706433")).toBe("127.0.0.1");
    expect(parseNumericIpForms("0x7f000001")).toBe("127.0.0.1");
    expect(parseNumericIpForms("0177.0.0.1")).toBe("127.0.0.1");
    expect(parseNumericIpForms("127.1")).toBe("127.0.0.1");
  });

  it("普通域名不是数字形态", () => {
    expect(parseNumericIpForms("api.example.com")).toBeNull();
  });
});

describe("normalizeEndpointUrl", () => {
  it("剥掉 URL 里的用户名密码（否则会变成第二条凭据通道）", () => {
    const url = normalizeEndpointUrl("https://user:pass@stt.example.com/v1");
    expect(url).not.toContain("user");
    expect(url).not.toContain("pass");
    expect(url.startsWith("https://stt.example.com/v1")).toBe(true);
  });

  it("host 转小写", () => {
    expect(normalizeEndpointUrl("https://STT.Example.COM/v1")).toContain(
      "stt.example.com"
    );
  });

  it("默认仍拒绝 http；provider 探测显式放开后才放行", () => {
    expect(() => normalizeEndpointUrl("http://api.example.com/v1")).toThrow(/HTTPS/);
    expect(normalizeEndpointUrl("http://api.example.com/v1", { allowHttp: true })).toBe(
      "http://api.example.com/v1"
    );
  });
});

// ---------------------------------------------------------------- safeFetch

const JSON_HEADERS = { "content-type": "application/json" };
const SECRET_URL = "https://stt.example.com/v1/audio/transcriptions";

describe("safeFetch", () => {
  it("302 指向云元数据地址时抛 OUTBOUND_BLOCKED，而不是跟过去", async () => {
    stubDns();
    const visited: string[] = [];
    __setOutboundDeps({
      fetch: async (url) => {
        visited.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      },
    });

    await expect(safeFetch(SECRET_URL)).rejects.toThrow(OUTBOUND_BLOCKED);
    // 只发出了第一跳，元数据端点一次都没被请求
    expect(visited).toEqual([SECRET_URL]);
  });

  it("响应体超过 MAX_RESPONSE_BYTES 时抛错", async () => {
    stubDns();
    const huge = "x".repeat(MAX_RESPONSE_BYTES + 1024);
    __setOutboundDeps({
      fetch: async () => new Response(huge, { status: 200, headers: JSON_HEADERS }),
    });

    await expect(safeFetch(SECRET_URL)).rejects.toThrow(/超过上限/);
  });

  it("content-type 为 text/html 时抛错", async () => {
    stubDns();
    __setOutboundDeps({
      fetch: async () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    await expect(safeFetch(SECRET_URL)).rejects.toThrow(/响应类型不受支持/);
  });

  it("错误消息不含完整 URL、不含 Authorization、不含密钥", async () => {
    stubDns();
    __setOutboundDeps({
      fetch: async () => {
        throw new Error(`fetch failed for ${SECRET_URL} with Authorization: Bearer sk-live-XYZ`);
      },
    });

    const err = await safeFetch(SECRET_URL, {
      headers: { Authorization: "Bearer sk-live-XYZ" },
    }).then(
      () => null,
      (e: Error) => e
    );

    expect(err).toBeInstanceOf(Error);
    const message = err!.message;
    expect(message).not.toContain(SECRET_URL);
    expect(message).not.toContain("Authorization");
    expect(message).not.toContain("sk-live-XYZ");
  });

  it("正常 JSON 响应原样返回，且请求用的是 redirect: manual", async () => {
    stubDns();
    let seenRedirect: string | undefined;
    __setOutboundDeps({
      fetch: async (_url, init) => {
        seenRedirect = init.redirect;
        return new Response(JSON.stringify({ text: "你好" }), {
          status: 200,
          headers: JSON_HEADERS,
        });
      },
    });

    const result = await safeFetch(SECRET_URL);
    expect(seenRedirect).toBe("manual");
    expect(JSON.parse(result.bodyText)).toEqual({ text: "你好" });
  });

  it("跨源重定向时丢掉 Authorization 头（不把密钥交给下一台主机）", async () => {
    stubDns();
    const sentAuth: (string | undefined)[] = [];
    let hop = 0;
    __setOutboundDeps({
      fetch: async (_url, init) => {
        sentAuth.push((init.headers as Record<string, string>).Authorization);
        if (hop++ === 0) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.com/v1" },
          });
        }
        return new Response("{}", { status: 200, headers: JSON_HEADERS });
      },
    });

    await safeFetch(SECRET_URL, { headers: { Authorization: "Bearer sk-live-XYZ" } });
    expect(sentAuth[0]).toBe("Bearer sk-live-XYZ");
    expect(sentAuth[1]).toBeUndefined();
  });
});
