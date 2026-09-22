/**
 * 远程 HTTP + WS 服务（REM-101）—— 唯一对外开网络监听的地方。
 *
 * ## 统一鉴权：一个 authorize() 调用点，覆盖所有受保护入口
 *
 * 审计点名的坑是「只保护 WS 而漏了 HTTP」。本文件用两条结构手段防它：
 *
 *   1. 全部受保护 HTTP 入口（/api、/files、/upload、/events）经**一条**表驱动
 *      的分发路径，那条路径上 `authorize()` 只出现一次——没有任何一个 handler
 *      能绕过它自己接管请求。
 *   2. WS 升级是另一个独立入口，它的 handler 第一步同样是 `authorize()`。
 *
 * 因此「每个入口都过统一鉴权」在源码上是可数的：`authorize(` 恰两处（HTTP 分发
 * + WS 升级），别处一个都没有。remote-server.spec 钉死这一点。
 *
 * ## 默认对外零暴露
 *
 * `start("loopback")` 绑 127.0.0.1，本机以外不可达；LAN 由 `start("lan")`（绑
 * 0.0.0.0）显式开启。默认状态是**不监听**（enabled=false）——连 loopback 都不开。
 *
 * ## 静态壳与 /pair 是唯二免 token 的入口，但仍过 origin/限速/尺寸/审计
 *
 * PWA 应用壳（HTML/JS）本身不是机密，配对入口更不可能要 token（它就是来换
 * token 的）。但「免 token」不等于「免校验」：这两类入口仍走 `guardPublic()`
 * 的尺寸 + 限速 + origin + 审计。数据入口（会话 / prompt / 文件 / 上传）一律要
 * 有效设备 token + scope，未配对访问其中任何一个都是 401/403。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { networkInterfaces } from "node:os";

import type { RemoteBindScope } from "@pibuddy/contract";

import {
  authorize,
  parseBearer,
  parseWsToken,
  RemoteRateLimiter,
  WS_SUBPROTOCOL,
  type AuthDeps,
  type AuthResult,
} from "./remote-auth.js";
import type { RemoteBackend } from "./remote-backend.js";
import { hashSecret, type RemoteRegistry } from "./device-registry.js";
import { consumePairing } from "./remote-pairing.js";
import { computeAcceptKey, RemoteWsConnection, RemoteWsHub } from "./remote-ws.js";
import { serveAsset } from "./pwa-assets/asset-server.js";

/** 默认端口。被占用时向后探几个。 */
const DEFAULT_PORT = 8787;
const PORT_TRIES = 8;

const MAX_BODY_DEFAULT = 1_048_576; // 1 MB
const MAX_BODY_TEXT = 262_144; // 256 KB（prompt / upload 文本）
const MAX_BODY_PAIR = 8_192; // 8 KB

export interface RemoteServerLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

interface ListenState {
  server: Server;
  host: string;
  port: number;
  bindScope: RemoteBindScope;
}

/**
 * 一条上传占位（v1）：远程 `/upload` 收到的文本被暂存在内存里，供随后的
 * `/api/prompt` 引用。真正的附件落盘 / 多模态在后续版本；v1 要立起来的是
 * 「upload 这个入口同样过统一鉴权」这条不变量。
 */
interface Upload {
  id: string;
  text: string;
  at: number;
}

export class RemoteServer {
  private listen: ListenState | null = null;
  private readonly hub = new RemoteWsHub();
  private readonly limiter = new RemoteRateLimiter(10_000, 120);
  private readonly uploads = new Map<string, Upload>();
  private pushTimer: NodeJS.Timeout | null = null;
  /** SSE 也必须保留设备归属，设备撤销时才能与 WS 一起立即断开。 */
  private readonly sseClients = new Map<ServerResponse, string>();

  constructor(
    private readonly registry: RemoteRegistry,
    private readonly backend: RemoteBackend,
    private readonly logger: RemoteServerLogger
  ) {}

  isListening(): boolean {
    return this.listen !== null;
  }
  address(): string | null {
    if (!this.listen) return null;
    return `${this.listen.host}:${this.listen.port}`;
  }
  port(): number | null {
    return this.listen?.port ?? null;
  }
  activeBindScope(): RemoteBindScope | null {
    return this.listen?.bindScope ?? null;
  }
  wsHub(): RemoteWsHub {
    return this.hub;
  }

  // ---------------------------------------------------------------- 生命周期

  async start(bindScope: RemoteBindScope): Promise<void> {
    if (this.listen) await this.stop();
    const host = bindScope === "lan" ? "0.0.0.0" : "127.0.0.1";
    const server = createServer((req, res) => this.handleHttp(req, res));
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));
    server.on("clientError", (_err, socket) => {
      try {
        (socket as Socket).destroy();
      } catch {
        /* ignore */
      }
    });

    const port = await this.listenOnFreePort(server, host);
    this.listen = { server, host, port, bindScope };
    this.startPushLoop();
    this.registry.audit("server_started", `${host}:${port} (${bindScope})`, Date.now());
    this.logger.info("remote_server_started", { host, port, bindScope });
  }

  private listenOnFreePort(server: Server, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryListen = (): void => {
        const port = DEFAULT_PORT + attempt;
        const onError = (err: NodeJS.ErrnoException): void => {
          server.removeListener("listening", onListening);
          if (err.code === "EADDRINUSE" && attempt < PORT_TRIES - 1) {
            attempt++;
            tryListen();
          } else {
            reject(err);
          }
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          resolve(port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      };
      tryListen();
    });
  }

  async stop(): Promise<void> {
    this.stopPushLoop();
    this.hub.dropAll();
    for (const res of [...this.sseClients.keys()]) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    const state = this.listen;
    this.listen = null;
    if (!state) return;
    await new Promise<void>((resolve) => {
      state.server.close(() => resolve());
    });
    this.registry.audit("server_stopped", "", Date.now());
    this.logger.info("remote_server_stopped", {});
  }

  /** 撤销 / 轮换某设备后，立即断开它的活跃连接。 */
  dropDevice(deviceId: string): void {
    this.hub.dropDevice(deviceId);
    for (const [res, ownerDeviceId] of [...this.sseClients]) {
      if (ownerDeviceId !== deviceId) continue;
      this.sseClients.delete(res);
      try {
        res.end();
      } catch {
        /* 已断，忽略 */
      }
    }
  }

  // ---------------------------------------------------------------- 鉴权依赖

  private allowedOrigins(): string[] {
    const port = this.listen?.port;
    if (port === undefined) return [];
    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    if (this.listen?.bindScope === "lan") {
      for (const list of Object.values(networkInterfaces())) {
        for (const ni of list ?? []) {
          if (ni.family === "IPv4" && !ni.internal) origins.push(`http://${ni.address}:${port}`);
        }
      }
    }
    return origins;
  }

  private authDeps(): AuthDeps {
    return {
      pepper: () => this.registry.pepper(),
      deviceByTokenHash: (hash) => {
        const d = this.registry.deviceByTokenHash(hash);
        if (!d) return null;
        this.registry.touchDevice(d.id, Date.now());
        return { id: d.id, name: d.name, scopes: d.scopes };
      },
      allowedOrigins: () => this.allowedOrigins(),
      rateAllow: (key, now) => this.limiter.allow(key, now),
      hashToken: (pepper, token) => hashSecret(pepper, token),
      now: () => Date.now(),
    };
  }

  // ---------------------------------------------------------------- HTTP

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const remoteAddr = req.socket.remoteAddress ?? "unknown";
    const origin = (req.headers.origin as string | undefined) ?? null;
    const method = (req.method ?? "GET").toUpperCase();

    // ---- 免 token 但仍受 origin/限速/尺寸/审计 约束：静态壳 + 配对
    if (method === "GET" && this.isAssetPath(url.pathname)) {
      if (!this.guardPublic("http", method, origin, remoteAddr, 0)) {
        return this.deny(res, 403, "blocked");
      }
      return this.serveStatic(url.pathname, res);
    }
    if (method === "POST" && url.pathname === "/pair") {
      return this.handlePair(req, res, origin, remoteAddr);
    }

    // ---- 受保护数据入口：统一 authorize（唯一调用点）
    const route = this.matchRoute(method, url.pathname);
    if (!route) return this.deny(res, 404, "not found");

    const maxBytes = route.def.maxBytes ?? MAX_BODY_DEFAULT;
    let body: Buffer;
    try {
      body = await this.readBody(req, maxBytes);
    } catch {
      return this.deny(res, 413, "payload too large");
    }

    const token = parseBearer(req.headers.authorization as string | undefined);
    const auth = authorize(
      {
        entry: route.def.entry,
        method,
        origin,
        token,
        remoteAddr,
        requiredScope: route.def.scope,
        bodyBytes: body.length,
        maxBytes,
      },
      this.authDeps()
    );
    this.registry.audit(
      auth.ok ? "http_ok" : "http_deny",
      `${method} ${url.pathname} ${auth.status} ${auth.ok ? auth.device?.id : auth.reason}`,
      Date.now()
    );
    if (!auth.ok) return this.deny(res, auth.status, auth.reason);

    try {
      await route.def.handler({ url, body, res, deviceId: auth.device!.id });
    } catch (err) {
      this.logger.warn("remote_route_error", { path: url.pathname, error: String(err) });
      this.deny(res, 500, "internal error");
    }
  }

  private isAssetPath(pathname: string): boolean {
    return (
      pathname === "/" ||
      pathname === "/index.html" ||
      pathname === "/pair.html" ||
      pathname === "/app.js" ||
      pathname === "/pair.js" ||
      pathname === "/style.css" ||
      pathname === "/sw.js" ||
      pathname === "/manifest.webmanifest"
    );
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    const asset = serveAsset(pathname);
    if (!asset) return this.deny(res, 404, "not found");
    res.writeHead(200, {
      "content-type": asset.contentType,
      // 应用壳可被 SW 缓存；但服务端不设任何会缓存 API 响应的头
      "cache-control": "no-cache",
      // 收紧：静态壳只连自己的源，禁内联外链
      "content-security-policy":
        "default-src 'self'; connect-src 'self' ws://* wss://*; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(asset.body);
  }

  // ---- /pair：消费 challenge，铸 token（免 token，过 guardPublic）
  private async handlePair(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string | null,
    remoteAddr: string
  ): Promise<void> {
    let body: Buffer;
    try {
      body = await this.readBody(req, MAX_BODY_PAIR);
    } catch {
      return this.deny(res, 413, "payload too large");
    }
    if (!this.guardPublic("http", "POST", origin, remoteAddr, body.length)) {
      this.registry.audit("pair_deny", "origin/rate/size", Date.now());
      return this.deny(res, 403, "blocked");
    }
    let parsed: { code?: unknown; name?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8")) as { code?: unknown; name?: unknown };
    } catch {
      return this.deny(res, 400, "bad json");
    }
    const code = typeof parsed.code === "string" ? parsed.code : "";
    const name = typeof parsed.name === "string" ? parsed.name : "";
    if (!code) return this.deny(res, 400, "missing code");
    const result = consumePairing(this.registry, code, name, Date.now());
    if (!result) return this.deny(res, 401, "invalid or expired code");
    if (result.rotated) this.dropDevice(result.deviceId);
    this.json(res, 200, {
      deviceId: result.deviceId,
      token: result.token, // 唯一一次外发，之后主进程只有 hash
      scopes: result.scopes,
      rotated: result.rotated,
    });
  }

  /** 免 token 入口的公共守卫：尺寸 + 限速 + origin（+ 审计由调用方补）。 */
  private guardPublic(
    entry: "http",
    method: string,
    origin: string | null,
    remoteAddr: string,
    bodyBytes: number
  ): boolean {
    if (bodyBytes > MAX_BODY_PAIR) return false;
    if (!this.limiter.allow(`${remoteAddr}#public`, Date.now())) return false;
    if (origin !== null && origin !== "null" && !this.allowedOrigins().includes(origin)) return false;
    void method;
    return true;
  }

  // ---------------------------------------------------------------- 路由表

  private routeTable: RouteDef[] | null = null;

  private matchRoute(method: string, pathname: string): { def: RouteDef } | null {
    for (const r of this.buildRoutes()) {
      if (r.method !== method) continue;
      if (r.pattern.test(pathname)) return { def: r };
    }
    return null;
  }

  /**
   * 受保护路由表。**每一条都声明它的 scope**——危险入口（权限裁决）挂
   * `permission.approve`（危险 scope），未被 owner 授予的设备到此即 403。
   * handler 绑成实例闭包（而非 prototype 索引），因此都能安全访问私有成员。
   */
  private buildRoutes(): RouteDef[] {
    if (this.routeTable) return this.routeTable;
    this.routeTable = [
      { method: "GET", pattern: /^\/api\/pool$/, entry: "http", scope: "pool.read", handler: (c) => this.routePool(c) },
      {
        method: "GET",
        pattern: /^\/api\/sessions\/[^/]+\/history$/,
        entry: "http",
        scope: "sessions.read",
        handler: (c) => this.routeSessionHistory(c),
      },
      {
        method: "GET",
        pattern: /^\/files\/session\/[^/]+$/,
        entry: "file",
        scope: "sessions.read",
        handler: (c) => this.routeFileSession(c),
      },
      {
        method: "POST",
        pattern: /^\/api\/prompt$/,
        entry: "http",
        scope: "prompt.send",
        maxBytes: MAX_BODY_TEXT,
        handler: (c) => this.routePrompt(c),
      },
      { method: "POST", pattern: /^\/api\/stop$/, entry: "http", scope: "session.stop", handler: (c) => this.routeStop(c) },
      {
        method: "POST",
        pattern: /^\/upload$/,
        entry: "upload",
        scope: "prompt.send",
        maxBytes: MAX_BODY_TEXT,
        handler: (c) => this.routeUpload(c),
      },
      {
        method: "GET",
        pattern: /^\/api\/permission$/,
        entry: "http",
        scope: "permission.read",
        handler: (c) => this.routePermission(c),
      },
      {
        method: "POST",
        pattern: /^\/api\/permission\/decide$/,
        entry: "http",
        scope: "permission.approve", // 危险 scope：默认不授予
        handler: (c) => this.routePermissionDecide(c),
      },
      { method: "GET", pattern: /^\/events$/, entry: "sse", scope: "pool.read", handler: (c) => this.routeEvents(c) },
    ];
    return this.routeTable;
  }

  // ---- 各路由的 handler（都在统一 authorize 之后被调，拿到已鉴权的 deviceId）

  private async routePool(ctx: RouteCtx): Promise<void> {
    this.json(ctx.res, 200, this.backend.poolSnapshot());
  }

  private async routeSessionHistory(ctx: RouteCtx): Promise<void> {
    const match = /^\/api\/sessions\/([^/]+)\/history$/.exec(ctx.url.pathname);
    let sessionId = "";
    try {
      sessionId = decodeURIComponent(match?.[1] ?? "");
    } catch {
      return this.deny(ctx.res, 400, "invalid sessionId");
    }
    if (!sessionId) return this.deny(ctx.res, 400, "invalid sessionId");
    const ws = ctx.url.searchParams.get("ws") ?? "";
    const limit = clampInt(ctx.url.searchParams.get("limit"), 50, 1, 200);
    const page = await this.backend.sessionHistory(sessionId, ws, limit);
    this.json(ctx.res, 200, page);
  }

  private async routeFileSession(ctx: RouteCtx): Promise<void> {
    // raw file 入口：把会话历史作为可下载 JSON 返回（与 /api 同数据源，不同入口类别）
    const sessionId = ctx.url.pathname.split("/").pop() ?? "";
    const ws = ctx.url.searchParams.get("ws") ?? "";
    const page = await this.backend.sessionHistory(sessionId, ws, 200);
    ctx.res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="session-${sessionId}.json"`,
      "cache-control": "no-store",
    });
    ctx.res.end(JSON.stringify(page));
  }

  private async routePrompt(ctx: RouteCtx): Promise<void> {
    const parsed = this.parseJson(ctx.body);
    const text = typeof parsed?.text === "string" ? parsed.text : "";
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
    const uploadId = typeof parsed?.uploadId === "string" ? parsed.uploadId : "";
    let finalText = text;
    if (uploadId) {
      const up = this.uploads.get(uploadId);
      if (up) {
        finalText = `${text}\n\n[uploaded]\n${up.text}`.trim();
        this.uploads.delete(uploadId);
      }
    }
    if (!sessionId) return this.deny(ctx.res, 400, "missing sessionId");
    if (!finalText) return this.deny(ctx.res, 400, "empty prompt");
    const r = this.backend.sendPrompt(sessionId, finalText);
    this.json(ctx.res, r.ok ? 200 : 502, r);
  }

  private async routeStop(ctx: RouteCtx): Promise<void> {
    const parsed = this.parseJson(ctx.body);
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
    if (!sessionId) return this.deny(ctx.res, 400, "missing sessionId");
    this.json(ctx.res, 200, this.backend.stopSession(sessionId));
  }

  private async routeUpload(ctx: RouteCtx): Promise<void> {
    const parsed = this.parseJson(ctx.body);
    const text = typeof parsed?.text === "string" ? parsed.text : "";
    if (!text) return this.deny(ctx.res, 400, "empty upload");
    const id = `up_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.uploads.set(id, { id, text: text.slice(0, MAX_BODY_TEXT), at: Date.now() });
    // 有界：只留最近 20 条未消费上传
    if (this.uploads.size > 20) {
      const oldest = [...this.uploads.values()].sort((a, b) => a.at - b.at)[0];
      if (oldest) this.uploads.delete(oldest.id);
    }
    this.json(ctx.res, 200, { uploadId: id });
  }

  private async routePermission(ctx: RouteCtx): Promise<void> {
    const ws = ctx.url.searchParams.get("ws");
    this.json(ctx.res, 200, this.backend.permissionState(ws && ws.length > 0 ? ws : null));
  }

  private async routePermissionDecide(ctx: RouteCtx): Promise<void> {
    const parsed = this.parseJson(ctx.body);
    const inboxId = typeof parsed?.inboxId === "string" ? parsed.inboxId : "";
    const allow = parsed?.allow === true;
    if (!inboxId) return this.deny(ctx.res, 400, "missing inboxId");
    this.json(ctx.res, 200, await this.backend.decideInbox(inboxId, allow));
  }

  private async routeEvents(ctx: RouteCtx): Promise<void> {
    // SSE 入口：与 WS 同数据（池快照），给不便用 WS 的客户端。
    ctx.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    ctx.res.write(`data: ${JSON.stringify(this.backend.poolSnapshot())}\n\n`);
    this.sseClients.set(ctx.res, ctx.deviceId);
    ctx.res.on("close", () => this.sseClients.delete(ctx.res));
  }

  // ---------------------------------------------------------------- WS 升级

  private handleUpgrade(req: IncomingMessage, socket: Socket, _head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const remoteAddr = socket.remoteAddress ?? "unknown";
    const origin = (req.headers.origin as string | undefined) ?? null;
    const key = req.headers["sec-websocket-key"] as string | undefined;
    const proto = (req.headers["sec-websocket-protocol"] as string | undefined) ?? null;
    const token = parseWsToken(proto);

    // WS 入口的统一鉴权（第二个、也是最后一个 authorize 调用点）
    const auth: AuthResult = authorize(
      {
        entry: "ws",
        method: "GET",
        origin,
        token,
        remoteAddr,
        requiredScope: "pool.read",
        bodyBytes: 0,
        maxBytes: MAX_BODY_DEFAULT,
      },
      this.authDeps()
    );
    this.registry.audit(
      auth.ok ? "ws_ok" : "ws_deny",
      `${url.pathname} ${auth.status} ${auth.ok ? auth.device?.id : auth.reason}`,
      Date.now()
    );
    if (!auth.ok || !key) {
      socket.write(
        `HTTP/1.1 ${auth.status || 401} Unauthorized\r\nConnection: close\r\n\r\n`
      );
      socket.destroy();
      return;
    }

    const accept = computeAcceptKey(key);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        `Sec-WebSocket-Protocol: ${WS_SUBPROTOCOL}\r\n\r\n`
    );

    const conn = new RemoteWsConnection(
      auth.device!.id,
      socket,
      (c, text) => this.onWsMessage(c, text),
      (c) => this.hub.remove(c)
    );
    this.hub.add(conn);
    // 连上即给一份当前快照
    conn.send(JSON.stringify({ type: "pool", snapshot: this.backend.poolSnapshot() }));
  }

  private onWsMessage(conn: RemoteWsConnection, text: string): void {
    // v1 客户端只发 ping-ish 心跳；忽略内容，但按需可扩展为主动拉取。
    if (text === "ping") conn.send(JSON.stringify({ type: "pong", at: Date.now() }));
  }

  // ---------------------------------------------------------------- 推送循环

  private startPushLoop(): void {
    if (this.pushTimer) return;
    this.pushTimer = setInterval(() => {
      if (this.hub.size() === 0 && this.sseClients.size === 0) return;
      const snapshot = this.backend.poolSnapshot();
      const msg = JSON.stringify({ type: "pool", snapshot });
      this.hub.broadcast(msg);
      for (const res of this.sseClients.keys()) {
        try {
          res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        } catch {
          this.sseClients.delete(res);
        }
      }
    }, 2000);
    this.pushTimer.unref?.();
  }

  private stopPushLoop(): void {
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
  }

  // ---------------------------------------------------------------- 工具

  private readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          reject(new Error("too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  private parseJson(body: Buffer): Record<string, unknown> | null {
    try {
      const v = JSON.parse(body.toString("utf8")) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }

  private deny(res: ServerResponse, status: number, reason: string): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: reason }));
  }
}

// ---------------------------------------------------------------- 路由定义

interface RouteCtx {
  url: URL;
  body: Buffer;
  res: ServerResponse;
  deviceId: string;
}

interface RouteDef {
  method: string;
  pattern: RegExp;
  entry: "http" | "file" | "upload" | "sse";
  scope: import("@pibuddy/contract").RemoteScope | null;
  maxBytes?: number;
  handler: (ctx: RouteCtx) => Promise<void>;
}

function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
