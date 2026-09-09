import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * SEC-004 扩展 / local-network 受控出站车道的阻断清单与正向路径。
 *
 * 镜像 ssrf.spec.ts 的手法：每一类绕过手法各留一条、钉死清单长度防塌缩。
 * 与公网车道的关系是**并列而非旁路**——这里的放行集合（私网四段）恰好是
 * ssrf.spec 那 17 项里被拦的段的子集，两条车道谁也放不了对方拦的东西。
 *
 * 对拍记录（临时拆掉机制 → 本文件对应用例变红 → 恢复后绿）：
 *   ① 拆掉 safeLocalFetch 的端点逐字比对 → 「端点逐字比对」一组全红；
 *   ② 拆掉 3xx 拒绝 → 「重定向零容忍」一组全红。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-local-lane-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
}));

// 决策层用例需要一个「声明了 network.local 的能力」。本阶段还没有真实的 HA
// 能力包（Phase A 只铺地基），mock 注册表给出一个假声明方；上界机制本身的
// 真流水线判据在 permission-gate.spec，这里只需要一个能过上界的载体。
vi.mock("../src/main/capability/capability-catalog.js", () => ({
  capabilityRegistry: {
    get: (id: string) =>
      id === "connector.home-assistant"
        ? { manifest: { permissions: ["network.local"] } }
        : undefined,
  },
}));

const { OUTBOUND_BLOCKED } = await import("../src/main/net/outbound-guard.js");
const {
  NETWORK_LOCAL_PERMISSION,
  __setLocalOutboundDeps,
  assertLocalPrivateAddress,
  authorizeLocalEndpoint,
  isPrivateLocalIpv4,
  safeLocalFetch,
} = await import("../src/main/net/outbound-local-guard.js");
const { decodeServerFrames, openLocalWebSocket } = await import(
  "../src/main/net/local-ws-client.js"
);
// 服务端方向的帧工具（remote-ws）在这里客串测试用 WS 服务器：它的 decodeFrames
// **只认掩码帧**，因此「服务端能解出我们的帧」本身就证明客户端确实在掩码。
const { computeAcceptKey, decodeFrames, encodePong, encodeTextFrame } = await import(
  "../src/main/remote/remote-ws.js"
);
const { isDangerousPermission, parseLocalEndpointResource } = await import("@pibuddy/contract");
const permStore = await import("../src/main/permission/permission-store.js");

/** 域名 → 地址的桩表。没列出来的域名一律解析成公网地址。 */
const STUB_DNS: Record<string, string[]> = {
  "ha.local": ["192.168.1.10"],
  "public.example.com": ["93.184.216.34"],
  // 一条私网 + 一条公网：只看第一条的话就穿过去了
  "mixed.example.com": ["192.168.1.10", "93.184.216.34"],
  "v6.example.com": ["fd00::1"],
};

function stubDns(): void {
  __setLocalOutboundDeps({
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
  __setLocalOutboundDeps({ lookup: null, fetch: null });
});

/** 全放行的授权依赖：这些用例测的是地址 / 端点判定，不是授权链。 */
const allowAll = {
  isDeclared: () => true,
  evaluate: () => ({ allowed: true, reason: null as string | null }),
};

function endpointOf(host: string, port: number) {
  return authorizeLocalEndpoint("connector.home-assistant", host, port, allowAll);
}

const JSON_HEADERS = { "content-type": "application/json" };

// ---------------------------------------------------------------- 阻断清单

describe("local 车道阻断清单（17 项）", () => {
  const BLOCKED = [
    ["公网 IPv4", "8.8.8.8"],
    ["32 位十进制形态的公网 IP", "134744072"],
    ["公网域名（DNS 解析到公网）", "public.example.com"],
    ["混合解析（私网 + 公网 A 记录）", "mixed.example.com"],
    ["云元数据地址", "169.254.169.254"],
    ["链路本地 169.254/16", "169.254.1.1"],
    ["未指定地址 0.0.0.0", "0.0.0.0"],
    ["0.0.0.0/8 其它地址", "0.1.2.3"],
    ["CGNAT 100.64/10", "100.64.0.1"],
    ["组播 224.0.0.0/3", "224.0.0.1"],
    ["广播 255.255.255.255", "255.255.255.255"],
    ["IPv6 环回", "::1"],
    ["IPv6 链路本地", "fe80::1"],
    ["IPv6 ULA", "fd00::1"],
    ["IPv6 公网", "2001:db8::1"],
    ["IPv4-mapped IPv6（映射的即便是私网也拒：v1 IPv6 全拒）", "::ffff:192.168.1.10"],
    ["域名解析到 IPv6", "v6.example.com"],
  ] as const;

  it("清单恰好 17 项", () => {
    expect(BLOCKED.length).toBe(17);
  });

  for (const [label, host] of BLOCKED) {
    it(`阻断：${label} — ${host}`, async () => {
      stubDns();
      await expect(assertLocalPrivateAddress(host)).rejects.toThrow(OUTBOUND_BLOCKED);
    });
  }

  it("放行侧：私网四段、数字形态归一化、解析到私网的域名", async () => {
    stubDns();
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "192.168.1.10",
      "0177.0.0.1", // 八进制 → 127.0.0.1
      "ha.local", // DNS → 192.168.1.10
    ]) {
      await expect(assertLocalPrivateAddress(host)).resolves.toBeUndefined();
    }
  });

  it("isPrivateLocalIpv4 的放行段恰好四段（白名单方向，漏拦不可能）", () => {
    expect(isPrivateLocalIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateLocalIpv4("127.0.0.1")).toBe(true);
    expect(isPrivateLocalIpv4("172.15.0.1")).toBe(false); // 172.16/12 下界之外
    expect(isPrivateLocalIpv4("172.32.0.1")).toBe(false); // 172.16/12 上界之外
    expect(isPrivateLocalIpv4("192.169.0.1")).toBe(false);
    expect(isPrivateLocalIpv4("不是地址")).toBe(false);
  });
});

// ---------------------------------------------------------------- 端点比对

describe("端点逐字比对（SEC-004：绑定用户确认的 host/port）", () => {
  function record(): string[] {
    const visited: string[] = [];
    __setLocalOutboundDeps({
      fetch: async (url) => {
        visited.push(url);
        return new Response("{}", { status: 200, headers: JSON_HEADERS });
      },
    });
    return visited;
  }

  it("端口不符 → 拒，且一次请求都不发", async () => {
    const visited = record();
    await expect(
      safeLocalFetch(endpointOf("192.168.1.10", 8123), "http://192.168.1.10:9999/api")
    ).rejects.toThrow(OUTBOUND_BLOCKED);
    expect(visited).toEqual([]);
  });

  it("host 不符 → 拒（path 写成完整 URL 也逃不出授权端点）", async () => {
    const visited = record();
    await expect(
      safeLocalFetch(endpointOf("192.168.1.10", 8123), "http://192.168.1.11:8123/api")
    ).rejects.toThrow(OUTBOUND_BLOCKED);
    expect(visited).toEqual([]);
  });

  it("缺省端口按协议补 80 后仍要逐字相等：授权 8123、请求缺省 → 拒", async () => {
    const visited = record();
    await expect(
      safeLocalFetch(endpointOf("192.168.1.10", 8123), "http://192.168.1.10/api")
    ).rejects.toThrow(OUTBOUND_BLOCKED);
    expect(visited).toEqual([]);
  });

  it("授权 80 端口时，缺省端口写法放行（补 80 后相等）", async () => {
    const visited = record();
    const result = await safeLocalFetch(endpointOf("192.168.1.10", 80), "/api");
    expect(result.status).toBe(200);
    expect(visited.length).toBe(1);
  });

  it("协议只认 http/https", async () => {
    const visited = record();
    await expect(
      safeLocalFetch(endpointOf("192.168.1.10", 8123), "ftp://192.168.1.10:8123/x")
    ).rejects.toThrow(OUTBOUND_BLOCKED);
    expect(visited).toEqual([]);
  });

  it("URL 里的用户名密码被剥掉（不留第二条凭据通道）", async () => {
    const visited = record();
    await safeLocalFetch(
      endpointOf("192.168.1.10", 8123),
      "http://user:pass@192.168.1.10:8123/api"
    );
    expect(visited.length).toBe(1);
    expect(visited[0]).not.toContain("user");
    expect(visited[0]).not.toContain("pass");
  });
});

// ---------------------------------------------------------------- 重定向

describe("重定向零容忍（任何 3xx 直接拒，不跟跳）", () => {
  for (const status of [300, 301, 302, 303, 307, 308]) {
    it(`HTTP ${status} → OUTBOUND_BLOCKED，且第二跳一次都不发`, async () => {
      const visited: string[] = [];
      __setLocalOutboundDeps({
        fetch: async (url) => {
          visited.push(url);
          // 刻意带上合法 content-type 与 body：拆掉 3xx 拒绝的话这条响应会被
          // finish 照单全收——对拍据此变红，而不是被 content-type 检查兜住。
          return new Response("{}", {
            status,
            headers: { ...JSON_HEADERS, location: "http://192.168.1.10:8123/elsewhere" },
          });
        },
      });
      // 钉住拒绝理由是「重定向」本身，不接受被别的关口顺手拦下。
      await expect(
        safeLocalFetch(endpointOf("192.168.1.10", 8123), "/api")
      ).rejects.toThrow(/重定向/);
      expect(visited.length).toBe(1);
    });
  }
});

// ---------------------------------------------------------------- 响应约束

describe("响应约束（与公网车道同一口径）", () => {
  it("content-type 非 JSON → 拒", async () => {
    __setLocalOutboundDeps({
      fetch: async () =>
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    await expect(
      safeLocalFetch(endpointOf("192.168.1.10", 8123), "/api")
    ).rejects.toThrow(/响应类型不受支持/);
  });

  it("响应体超过 2MB → 拒", async () => {
    const huge = "x".repeat(2 * 1024 * 1024 + 1024);
    __setLocalOutboundDeps({
      fetch: async () => new Response(huge, { status: 200, headers: JSON_HEADERS }),
    });
    await expect(
      safeLocalFetch(endpointOf("192.168.1.10", 8123), "/api")
    ).rejects.toThrow(/超过上限/);
  });

  it("底层错误被脱敏：不含端点地址", async () => {
    __setLocalOutboundDeps({
      fetch: async () => {
        throw new Error("connect ECONNREFUSED 192.168.1.10:8123 with token abc123");
      },
    });
    const err = await safeLocalFetch(endpointOf("192.168.1.10", 8123), "/api").then(
      () => null,
      (e: Error) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("192.168.1.10");
    expect(err!.message).not.toContain("abc123");
  });
});

// ---------------------------------------------------------------- 授权链

describe("authorizeLocalEndpoint：三道关的前两关", () => {
  it("上界：未声明 network.local 的能力被拒，且授权引擎不被问到", () => {
    const evaluate = vi.fn(() => ({ allowed: true, reason: null }));
    expect(() =>
      authorizeLocalEndpoint("common.preview", "192.168.1.10", 8123, {
        isDeclared: () => false,
        evaluate,
      })
    ).toThrow(OUTBOUND_BLOCKED);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("未获授权 → 拒", () => {
    expect(() =>
      authorizeLocalEndpoint("connector.home-assistant", "192.168.1.10", 8123, {
        isDeclared: () => true,
        evaluate: () => ({ allowed: false, reason: "无适用授权" }),
      })
    ).toThrow(OUTBOUND_BLOCKED);
  });

  it("授权查询绑定的资源就是 host:port 逐字形态", () => {
    const seen: unknown[] = [];
    const endpoint = authorizeLocalEndpoint("connector.home-assistant", "HA.Local", 8123, {
      isDeclared: () => true,
      evaluate: (q) => {
        seen.push(q);
        return { allowed: true, reason: null };
      },
    });
    expect(seen).toEqual([
      {
        capabilityId: "connector.home-assistant",
        permission: NETWORK_LOCAL_PERMISSION,
        resource: "ha.local:8123",
      },
    ]);
    expect(endpoint.host).toBe("ha.local");
    expect(endpoint.port).toBe(8123);
  });

  it("非法端点形态在构造入口就被拒（IPv6 / 端口越界）", () => {
    expect(() => authorizeLocalEndpoint("connector.home-assistant", "::1", 80, allowAll)).toThrow(
      OUTBOUND_BLOCKED
    );
    expect(() =>
      authorizeLocalEndpoint("connector.home-assistant", "192.168.1.10", 0, allowAll)
    ).toThrow(OUTBOUND_BLOCKED);
    expect(() =>
      authorizeLocalEndpoint("connector.home-assistant", "192.168.1.10", 65536, allowAll)
    ).toThrow(OUTBOUND_BLOCKED);
  });
});

// ---------------------------------------------------------------- 资源契约

describe("host:port 资源契约（contract/permission.ts）", () => {
  it("network.local 属危险权限：持久化授权必过主进程原生确认框", () => {
    expect(isDangerousPermission("network.local")).toBe(true);
  });

  it("合法形态解析成 {host, port}，host 小写化", () => {
    expect(parseLocalEndpointResource("192.168.1.10:8123")).toEqual({
      host: "192.168.1.10",
      port: 8123,
    });
    expect(parseLocalEndpointResource("HA.Local:80")).toEqual({ host: "ha.local", port: 80 });
  });

  it("通配 / CIDR / IPv6 / 越界端口全部写不出来", () => {
    for (const bad of [
      "192.168.1.10", // 无端口
      ":8123", // 空 host
      "host:0",
      "host:65536",
      "192.168.1.0/24:80", // CIDR
      "*:80", // 通配
      "[::1]:80", // IPv6
      "host:80:81",
      "",
    ]) {
      expect([bad, parseLocalEndpointResource(bad)]).toEqual([bad, null]);
    }
  });
});

// ---------------------------------------------------------------- 决策层

describe("decidePermission：network.local 通配授权在落库前被挡死", () => {
  const CAP = "connector.home-assistant";
  const decide = (resource: string | null, disposition: "allow-once" | "allow-session") =>
    permStore.decidePermission({
      capabilityId: CAP,
      permission: "network.local",
      resource,
      disposition,
      workspaceId: null,
    });

  it("null-resource（整个内网）→ 拒绝落库并留审计", async () => {
    permStore.__resetPermissionStore();
    const state = await decide(null, "allow-session");
    expect(state.sessionGrants).toEqual([]);
    const denied = state.audit.filter((a) => a.kind === "denied");
    expect(denied.length).toBe(1);
    expect(denied[0]!.detail).toContain("host:port");
  });

  it("资源不是 host:port（CIDR 写法）→ 同样拒", async () => {
    permStore.__resetPermissionStore();
    const state = await decide("192.168.1.0/24", "allow-session");
    expect(state.sessionGrants).toEqual([]);
  });

  it("once 档同样拒：拒绝后引擎对该端点仍判无授权", async () => {
    permStore.__resetPermissionStore();
    await decide(null, "allow-once");
    const decision = permStore.permissionEngine().evaluate({
      capabilityId: CAP,
      permission: "network.local",
      resource: "192.168.1.10:8123",
      workspaceId: null,
    });
    expect(decision.allowed).toBe(false);
  });

  it("绑定具体 host:port 的授权正常落入 session（拒的是通配，不是这条权限）", async () => {
    permStore.__resetPermissionStore();
    const state = await decide("192.168.1.10:8123", "allow-session");
    expect(state.sessionGrants.map((g) => g.resource)).toEqual(["192.168.1.10:8123"]);
    // resource 精确匹配轴（grantCovers）：别的端点不被这条授权覆盖。
    const other = permStore.permissionEngine().evaluate({
      capabilityId: CAP,
      permission: "network.local",
      resource: "192.168.1.11:8123",
      workspaceId: null,
    });
    expect(other.allowed).toBe(false);
  });

  it("上界：未声明 network.local 的能力连 grant 都造不出", async () => {
    permStore.__resetPermissionStore();
    const state = await permStore.decidePermission({
      capabilityId: "common.preview",
      permission: "network.local",
      resource: "192.168.1.10:8123",
      disposition: "allow-session",
      workspaceId: null,
    });
    expect(state.sessionGrants).toEqual([]);
  });
});

// ---------------------------------------------------------------- 正向路径

describe("正向路径：127.0.0.1 起真 http server（授权 → 请求 → JSON 返回）", () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("safeLocalFetch 走通完整链路", async () => {
    const endpoint = endpointOf("127.0.0.1", port);
    const result = await safeLocalFetch(endpoint, "/api/states");
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.bodyText)).toEqual({ ok: true, path: "/api/states" });
  });
});

// ---------------------------------------------------------------- WS 客户端

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: 等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("WS 客户端（RFC 6455 客户端方向）", () => {
  let server: http.Server;
  let port = 0;
  let lastSocket: Socket | null = null;
  let rawFirstFrame: Buffer | null = null;
  const serverSeen: { opcode: number; payload: Buffer }[] = [];
  const upgradedSockets: Socket[] = [];

  beforeAll(async () => {
    server = http.createServer();
    server.on("upgrade", (req, socket) => {
      lastSocket = socket;
      upgradedSockets.push(socket);
      const key = String(req.headers["sec-websocket-key"] ?? "");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`
      );
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        if (rawFirstFrame === null) rawFirstFrame = Buffer.from(chunk);
        buf = Buffer.concat([buf, chunk]);
        // remote-ws 的服务端解码器只认掩码帧：客户端不掩码的话这里什么都解不出。
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const frame of frames) {
          serverSeen.push(frame);
          if (frame.opcode === 0x1) {
            socket.write(encodeTextFrame(`echo:${frame.payload.toString("utf8")}`));
          }
          if (frame.opcode === 0x9) socket.write(encodePong(frame.payload));
          if (frame.opcode === 0x8) socket.destroy();
        }
      });
      socket.on("error", () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    // upgrade 后的 socket 不在连接追踪里，close 前逐个 destroy（见下方
    // Accept 校验用例的同款注释）。
    for (const s of upgradedSockets) s.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("握手 → 掩码文本帧 → 服务端可解 → 回显可收", async () => {
    const conn = await openLocalWebSocket(endpointOf("127.0.0.1", port), "/ws");
    const got = new Promise<string>((resolve) => conn.on("message", resolve));
    conn.send("你好");
    expect(await got).toBe("echo:你好");
    // 客户端帧必掩码（RFC 6455 §5.3）：长度字节的最高位是掩码位。
    expect(rawFirstFrame![1]! & 0x80).toBe(0x80);
    conn.close();
  });

  it("服务端 ping → 客户端自动回掩码 pong", async () => {
    const conn = await openLocalWebSocket(endpointOf("127.0.0.1", port), "/ws");
    serverSeen.length = 0;
    // 服务端方向的 ping：不掩码（0x89 = FIN|ping）。
    lastSocket!.write(Buffer.concat([Buffer.from([0x89, 2]), Buffer.from("hi")]));
    await until(() => serverSeen.some((f) => f.opcode === 0xa));
    const pong = serverSeen.find((f) => f.opcode === 0xa)!;
    expect(pong.payload.toString("utf8")).toBe("hi");
    conn.close();
  });

  it("FIN 分片：文本帧 + 续帧重组成单条消息", async () => {
    const conn = await openLocalWebSocket(endpointOf("127.0.0.1", port), "/ws");
    const got = new Promise<string>((resolve) => conn.on("message", resolve));
    // 服务端方向不掩码：0x01 = 无 FIN 的 text，0x80 = FIN 的 continuation。
    lastSocket!.write(Buffer.concat([Buffer.from([0x01, 3]), Buffer.from("abc")]));
    lastSocket!.write(Buffer.concat([Buffer.from([0x80, 3]), Buffer.from("def")]));
    expect(await got).toBe("abcdef");
    conn.close();
  });

  it("客户端 close → 服务端收到掩码 close 帧", async () => {
    const conn = await openLocalWebSocket(endpointOf("127.0.0.1", port), "/ws");
    serverSeen.length = 0;
    conn.close(1000);
    await until(() => serverSeen.some((f) => f.opcode === 0x8));
  });

  it("Sec-WebSocket-Accept 校验失败 → 握手拒绝", async () => {
    const bad = http.createServer();
    // upgrade 后的 socket 不在 http server 的连接追踪里，closeAllConnections
    // 管不到它——不亲手 destroy 的话 bad.close 的回调永远不来。
    const upgraded: Socket[] = [];
    bad.on("upgrade", (_req, socket) => {
      upgraded.push(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
      );
    });
    await new Promise<void>((resolve) => bad.listen(0, "127.0.0.1", resolve));
    const badPort = (bad.address() as { port: number }).port;
    try {
      await expect(
        openLocalWebSocket(endpointOf("127.0.0.1", badPort), "/ws")
      ).rejects.toThrow(/LOCAL_WS_HANDSHAKE_FAILED/);
    } finally {
      for (const s of upgraded) s.destroy();
      bad.closeAllConnections();
      await new Promise((resolve) => bad.close(resolve));
    }
  });

  it("公网端点即便拿到授权，连接前的地址断言也拦下（纵深防御）", async () => {
    await expect(openLocalWebSocket(endpointOf("8.8.8.8", 80), "/ws")).rejects.toThrow(
      OUTBOUND_BLOCKED
    );
  });

  it("路径写不出请求头注入（CR/LF/空格）也写不出相对路径", async () => {
    const endpoint = endpointOf("127.0.0.1", port);
    await expect(openLocalWebSocket(endpoint, "ws")).rejects.toThrow(OUTBOUND_BLOCKED);
    await expect(
      openLocalWebSocket(endpoint, "/ws HTTP/1.1\r\nX-Evil: 1")
    ).rejects.toThrow(OUTBOUND_BLOCKED);
  });

  it("协议违例在解码层就被判死：服务端帧带掩码 / 单帧超 1MB", () => {
    // 掩码位置 1 的「服务端」帧。
    const masked = Buffer.from([0x81, 0x80 | 2, 1, 2, 3, 4, 0x61, 0x62]);
    expect(decodeServerFrames(masked).violation).not.toBeNull();
    // 头部就声明 2MB 的单帧：不等收全就拒。
    const huge = Buffer.alloc(10);
    huge[0] = 0x81;
    huge[1] = 127;
    huge.writeBigUInt64BE(BigInt(2 * 1024 * 1024), 2);
    expect(decodeServerFrames(huge).violation).not.toBeNull();
  });
});
