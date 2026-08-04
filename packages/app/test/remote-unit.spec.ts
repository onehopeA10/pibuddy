import { describe, expect, it } from "vitest";

/**
 * 远程能力的纯单元判据（无 electron / 无网络）：
 *   - WS 帧编解码（RFC 6455）自洽：编出来的能解回去，客户端未掩码帧被拒；
 *   - 统一 authorize() 五道闸的**顺序与默认拒绝**：缺 token 拒、超尺寸拒、
 *     origin 不符拒、scope 不足拒，全绿的路径才放行。
 */
import {
  computeAcceptKey,
  decodeFrames,
  encodeTextFrame,
} from "../src/main/remote/remote-ws.js";
import {
  authorize,
  parseBearer,
  parseWsToken,
  RemoteRateLimiter,
  WS_SUBPROTOCOL,
  type AuthDeps,
} from "../src/main/remote/remote-auth.js";

/** 造一条**掩码**的客户端文本帧（客户端帧必须掩码）。 */
function maskedClientFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  return Buffer.concat([header, mask, masked]);
}

describe("WS 帧编解码（RFC 6455）", () => {
  it("computeAcceptKey 对 RFC 样例 key 给出规范值", () => {
    // RFC 6455 §1.3 的经典样例
    expect(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("客户端掩码帧能被 decodeFrames 解回原文", () => {
    const { frames, rest } = decodeFrames(maskedClientFrame("ping"));
    expect(frames.length).toBe(1);
    expect(frames[0].opcode).toBe(0x1);
    expect(frames[0].payload.toString("utf8")).toBe("ping");
    expect(rest.length).toBe(0);
  });

  it("未掩码的客户端帧被拒（违反 RFC，丢弃缓冲）", () => {
    const server = encodeTextFrame("hi"); // 服务端帧不掩码
    const { frames, rest } = decodeFrames(server);
    expect(frames).toEqual([]);
    expect(rest.length).toBe(0);
  });

  it("半截帧不误解：不足一帧时返回空 frames + 原样 rest", () => {
    const full = maskedClientFrame("hello");
    const partial = full.subarray(0, 4);
    const { frames, rest } = decodeFrames(partial);
    expect(frames).toEqual([]);
    expect(rest.length).toBe(partial.length);
  });
});

describe("token 解析", () => {
  it("parseBearer 取出 Authorization: Bearer 的值", () => {
    expect(parseBearer("Bearer abc.def")).toBe("abc.def");
    expect(parseBearer("bearer xyz")).toBe("xyz");
    expect(parseBearer(null)).toBe(null);
    expect(parseBearer("Basic abc")).toBe(null);
  });
  it("parseWsToken 从副协议里取 token（紧跟 pibuddy.remote 之后）", () => {
    expect(parseWsToken(`${WS_SUBPROTOCOL}, mytoken`)).toBe("mytoken");
    expect(parseWsToken("other, x")).toBe(null);
    expect(parseWsToken(null)).toBe(null);
  });
});

describe("统一 authorize() 五道闸：默认拒绝", () => {
  const device = { id: "d1", name: "n", scopes: ["pool.read"] as any };
  const deps: AuthDeps = {
    pepper: () => "pep",
    deviceByTokenHash: (h) => (h === "hash:good" ? device : null),
    allowedOrigins: () => ["http://127.0.0.1:8787"],
    rateAllow: () => true,
    hashToken: (_p, t) => `hash:${t}`,
    now: () => 1000,
  };
  const base = {
    entry: "http" as const,
    method: "GET",
    origin: null,
    token: "good",
    remoteAddr: "1.2.3.4",
    requiredScope: "pool.read" as any,
    bodyBytes: 0,
    maxBytes: 1000,
  };

  it("全绿路径放行", () => {
    expect(authorize(base, deps).ok).toBe(true);
  });
  it("超尺寸 → 413", () => {
    expect(authorize({ ...base, bodyBytes: 2000 }, deps).status).toBe(413);
  });
  it("缺 token → 401", () => {
    expect(authorize({ ...base, token: null }, deps).status).toBe(401);
  });
  it("未知 token → 401", () => {
    expect(authorize({ ...base, token: "bad" }, deps).status).toBe(401);
  });
  it("scope 不足 → 403", () => {
    expect(authorize({ ...base, requiredScope: "permission.approve" as any }, deps).status).toBe(403);
  });
  it("不允许的 Origin → 403", () => {
    expect(authorize({ ...base, origin: "http://evil.test" }, deps).status).toBe(403);
  });
  it("允许的 Origin 放行", () => {
    expect(authorize({ ...base, origin: "http://127.0.0.1:8787" }, deps).ok).toBe(true);
  });
  it("限流命中 → 429", () => {
    expect(authorize(base, { ...deps, rateAllow: () => false }).status).toBe(429);
  });
});

describe("RemoteRateLimiter 滑动窗口", () => {
  it("窗口内超额即拒，过窗恢复", () => {
    const rl = new RemoteRateLimiter(1000, 2);
    expect(rl.allow("k", 0)).toBe(true);
    expect(rl.allow("k", 10)).toBe(true);
    expect(rl.allow("k", 20)).toBe(false); // 第三次超额
    expect(rl.allow("k", 1100)).toBe(true); // 过窗
  });
});
