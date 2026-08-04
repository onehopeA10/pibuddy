/**
 * local 车道的 WebSocket **客户端**（RFC 6455，客户端方向）——只用 node 内置
 * net / tls / crypto，零新依赖（与 remote-ws.ts 手写服务端同一取舍：约 200 行
 * 换「过 check-pure-js-deps 无忧、行为完全在自己掌控里」）。
 *
 * ## 为什么不复用 remote-ws.ts
 *
 * 那份是**服务端方向**：发送不掩码、接收必须掩码、只处理未分片单帧。客户端
 * 方向恰好全反（RFC 6455 §5.3：客户端→服务端必掩码，服务端→客户端必不掩码），
 * 帧码复用不了；风格照抄它——帧编解码是纯函数、连接对象只管协议、鉴权在外。
 *
 * ## 准入在外、协议在内
 *
 * 唯一入口 `openLocalWebSocket` 的第一个参数是 `AuthorizedLocalEndpoint`
 * （outbound-local-guard 的 brand type），即连接目标必然已过 manifest 上界与
 * PermissionEngine 授权两道关；本文件在连接前再做同一份地址断言
 * （assertLocalPrivateAddress），与 safeLocalFetch 的第 ③ 步一致。
 *
 * ## 协议级心跳
 *
 * 每 30s 发一个 ping，10s 内没等到 pong 判死（HA 的长连接会在网络切换 / 休眠
 * 后静默半死，TCP 层看不出来）。**重连策略刻意不在本层**：连接死了就 emit
 * close 完事——什么时候重连、退避多久、要不要换端点，是上层会话按自身生命
 * 周期决定的事，收在这里会把「协议客户端」和「会话策略」焊死在一起。
 */
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { Socket } from "node:net";

import { OutboundBlockedError } from "./outbound-guard.js";
import {
  LOCAL_CONNECT_TIMEOUT_MS,
  assertLocalPrivateAddress,
  type AuthorizedLocalEndpoint,
} from "./outbound-local-guard.js";

/** 单条消息（分片重组后）的上限：1MB。HA 的事件流单条撑死几十 KB。 */
export const MAX_WS_MESSAGE_BYTES = 1024 * 1024;
/** 握手响应头的累计上限。 */
export const MAX_HANDSHAKE_BYTES = 16 * 1024;
/** 协议级心跳：每 30s ping 一次。 */
export const WS_PING_INTERVAL_MS = 30000;
/** ping 后 10s 未见 pong 判死。 */
export const WS_PONG_TIMEOUT_MS = 10000;

/** RFC 6455 固定 magic GUID（与 remote-ws.ts:21 同值，自持避免跨向依赖）。 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Sec-WebSocket-Accept = base64(sha1(key + GUID))。 */
function acceptKeyFor(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

// ------------------------------------------------------------------ 帧编解码

/**
 * 客户端 → 服务端帧：**必掩码**（RFC 6455 §5.3），掩码键 crypto.randomBytes(4)。
 */
export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([header, mask, masked]);
}

export interface ServerFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/**
 * 从累积缓冲里解出尽可能多的完整**服务端帧**（必不掩码，掩码即协议违例）。
 * 返回帧 + 剩余字节 + 违例说明（非 null 时连接层必须关掉）。
 */
export function decodeServerFrames(buffer: Buffer): {
  frames: ServerFrame[];
  rest: Buffer;
  violation: string | null;
} {
  const frames: ServerFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset]!;
    const b1 = buffer[offset + 1]!;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (cursor + 2 > buffer.length) break;
      len = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (cursor + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    // 服务端帧掩码 = 违反 RFC 6455 §5.3，直接判死（镜像 remote-ws 对客户端
    // 不掩码的处理）。
    if (masked) return { frames, rest: Buffer.alloc(0), violation: "服务端帧不得掩码" };
    // 单帧就超上限的不必等重组。
    if (len > MAX_WS_MESSAGE_BYTES) {
      return { frames, rest: Buffer.alloc(0), violation: "单帧超过消息上限" };
    }
    if (cursor + len > buffer.length) break; // 帧还没收全
    frames.push({ fin, opcode, payload: buffer.subarray(cursor, cursor + len) });
    offset = cursor + len;
  }
  return { frames, rest: buffer.subarray(offset), violation: null };
}

// ------------------------------------------------------------------ 连接对象

export interface LocalWsEvents {
  message: (text: string) => void;
  close: () => void;
  error: (err: Error) => void;
}

export interface LocalWsConnection {
  send(text: string): void;
  close(code?: number): void;
  on<K extends keyof LocalWsEvents>(event: K, handler: LocalWsEvents[K]): void;
}

interface Fragment {
  opcode: number;
  parts: Buffer[];
  total: number;
}

class LocalWsClient implements LocalWsConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private fragment: Fragment | null = null;
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongDeadline: NodeJS.Timeout | null = null;
  private readonly handlers: { [K in keyof LocalWsEvents]: LocalWsEvents[K][] } = {
    message: [],
    close: [],
    error: [],
  };

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.fail("连接错误"));
    // 握手层交接前把流 pause 掉了（防止两次挂 data 监听之间丢字节），
    // 监听就位后在这里恢复。**推迟一个事件循环相位（setImmediate）**：调用方
    // 是在 `await openLocalWebSocket(...)` 的微任务续体里拿到连接对象再挂
    // message 监听的，而 resume 的 flow 经 nextTick 触发、会插在两个微任务
    // 之间——服务端把握手响应与首帧写在同一 TCP 段时（HA 的 auth_required
    // 就常与 101 同段到达），首帧会在监听挂上之前被消费掉，表现为偶发丢帧。
    // 推迟到 setImmediate 相位保证调用方的监听先就位。
    setImmediate(() => socket.resume());
    // 协议级心跳：TCP 不报「对端半死」，ping/pong 才报。unref：心跳不该
    // 独自撑着进程不退出。
    this.pingTimer = setInterval(() => this.heartbeat(), WS_PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  on<K extends keyof LocalWsEvents>(event: K, handler: LocalWsEvents[K]): void {
    this.handlers[event].push(handler);
  }

  send(text: string): void {
    const payload = Buffer.from(text, "utf8");
    if (payload.length > MAX_WS_MESSAGE_BYTES) {
      throw new Error("LOCAL_WS_MESSAGE_TOO_LARGE: 单条消息超过 1MB 上限");
    }
    this.rawWrite(encodeClientFrame(0x1, payload));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.rawWrite(encodeClientFrame(0x8, body));
    // end 而不是 destroy：flush 完 close 帧再发 FIN，对端才收得到帧；
    // destroy 会把还在缓冲里的 close 帧直接丢掉。
    this.socket.end();
    this.handleClose();
  }

  // ---------------------------------------------------------------- 内部

  private heartbeat(): void {
    if (this.closed) return;
    this.rawWrite(encodeClientFrame(0x9, Buffer.from("hb")));
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    this.pongDeadline = setTimeout(() => this.fail("心跳超时（10s 无 pong）"), WS_PONG_TIMEOUT_MS);
    this.pongDeadline.unref();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest, violation } = decodeServerFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (this.closed) return;
      this.handleFrame(frame);
    }
    if (violation !== null) this.fail(violation);
  }

  private handleFrame(frame: ServerFrame): void {
    const { fin, opcode, payload } = frame;
    // 控制帧（>= 0x8）不参与分片。
    if (opcode === 0x8) {
      // 对端要关：按协议回一个 close 再断（回不出去也无所谓，反正要断了）。
      this.rawWrite(encodeClientFrame(0x8, payload.subarray(0, 2)));
      this.socket.destroy();
      this.handleClose();
      return;
    }
    if (opcode === 0x9) {
      this.rawWrite(encodeClientFrame(0xa, Buffer.from(payload)));
      return;
    }
    if (opcode === 0xa) {
      if (this.pongDeadline) {
        clearTimeout(this.pongDeadline);
        this.pongDeadline = null;
      }
      return;
    }
    if (opcode === 0x2) {
      // v1 只谈 JSON 文本（HA 的 WebSocket API 就是 JSON 文本帧）。
      this.fail("不支持二进制帧");
      return;
    }
    if (opcode === 0x1) {
      if (fin) {
        this.emitMessage(payload);
        return;
      }
      this.fragment = { opcode, parts: [Buffer.from(payload)], total: payload.length };
      return;
    }
    if (opcode === 0x0) {
      if (this.fragment === null) {
        this.fail("孤立的续帧");
        return;
      }
      this.fragment.total += payload.length;
      if (this.fragment.total > MAX_WS_MESSAGE_BYTES) {
        this.fail("分片重组超过 1MB 上限");
        return;
      }
      this.fragment.parts.push(Buffer.from(payload));
      if (fin) {
        const whole = Buffer.concat(this.fragment.parts);
        this.fragment = null;
        this.emitMessage(whole);
      }
    }
    // 其余 opcode：忽略（保留帧）。
  }

  private emitMessage(payload: Buffer): void {
    const text = payload.toString("utf8");
    for (const fn of this.handlers.message) fn(text);
  }

  private rawWrite(buf: Buffer): void {
    if (this.closed) return;
    try {
      this.socket.write(buf);
    } catch {
      this.fail("写入失败");
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    const err = new Error(`LOCAL_WS_FAILED: ${reason}`);
    for (const fn of this.handlers.error) fn(err);
    this.socket.destroy();
    this.handleClose();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    for (const fn of this.handlers.close) fn();
  }
}

// ------------------------------------------------------------------ 入口

export interface OpenLocalWebSocketOptions {
  /** true 走 tls.connect（系统信任链，不做自签证书例外）；默认明文 ws。 */
  tls?: boolean;
}

/**
 * 打开一条到已授权本地端点的 WS 连接。
 *
 * 流程：地址断言（同 safeLocalFetch 第 ③ 步）→ net/tls.connect（3s 连接超时）
 * → HTTP/1.1 Upgrade（随机 Sec-WebSocket-Key）→ 校验 Sec-WebSocket-Accept →
 * 返回连接对象。任何一步失败都 destroy socket 并 reject。
 */
export async function openLocalWebSocket(
  endpoint: AuthorizedLocalEndpoint,
  path: string,
  options: OpenLocalWebSocketOptions = {}
): Promise<LocalWsConnection> {
  // path 直接进 `GET <path> HTTP/1.1` 请求行：必须以 / 开头、只含可见 ASCII
  // （CR / LF / 空格一律拒——否则就是请求头注入）。
  if (!/^\/[!-~]*$/.test(path)) {
    throw new OutboundBlockedError("WS 路径必须以 / 开头且不含空白字符");
  }
  await assertLocalPrivateAddress(endpoint.host);

  const socket = await connectSocket(endpoint, options.tls === true);
  try {
    await handshake(socket, endpoint, path);
  } catch (err) {
    socket.destroy();
    throw err;
  }
  return new LocalWsClient(socket);
}

/** 建 TCP / TLS 连接，3s 超时。 */
function connectSocket(endpoint: AuthorizedLocalEndpoint, useTls: boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket: Socket = useTls
      ? tls.connect({ host: endpoint.host, port: endpoint.port, servername: endpoint.host })
      : net.connect({ host: endpoint.host, port: endpoint.port });
    const readyEvent = useTls ? "secureConnect" : "connect";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("LOCAL_WS_TIMEOUT: 连接超时"));
    }, LOCAL_CONNECT_TIMEOUT_MS);
    socket.once(readyEvent, () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      // 不透传底层错误消息：与 safeLocalFetch 的脱敏口径一致。
      reject(new Error("LOCAL_WS_FAILED: 无法连接本地端点"));
    });
  });
}

/** HTTP/1.1 Upgrade 握手 + Sec-WebSocket-Accept 校验。 */
function handshake(
  socket: Socket,
  endpoint: AuthorizedLocalEndpoint,
  path: string
): Promise<void> {
  const key = randomBytes(16).toString("base64");
  const expected = acceptKeyFor(key);
  const request =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${endpoint.host}:${endpoint.port}\r\n` +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Key: ${key}\r\n` +
    "Sec-WebSocket-Version: 13\r\n" +
    "\r\n";

  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const fail = (reason: string): void => {
      cleanup();
      reject(new Error(`LOCAL_WS_HANDSHAKE_FAILED: ${reason}`));
    };
    const onData = (chunk: Buffer): void => {
      acc = Buffer.concat([acc, chunk]);
      if (acc.length > MAX_HANDSHAKE_BYTES) {
        fail("握手响应超过上限");
        return;
      }
      const headerEnd = acc.indexOf("\r\n\r\n");
      if (headerEnd < 0) return; // 头还没收全
      const head = acc.subarray(0, headerEnd).toString("latin1");
      const lines = head.split("\r\n");
      if (!/^HTTP\/1\.1 101 /.test(lines[0] ?? "")) {
        fail("对端拒绝升级");
        return;
      }
      let accept: string | null = null;
      for (const line of lines.slice(1)) {
        const sep = line.indexOf(":");
        if (sep < 0) continue;
        if (line.slice(0, sep).trim().toLowerCase() === "sec-websocket-accept") {
          accept = line.slice(sep + 1).trim();
        }
      }
      if (accept !== expected) {
        fail("Sec-WebSocket-Accept 校验失败");
        return;
      }
      cleanup();
      // 头之后多收的字节是首批 WS 帧，塞回流里让连接对象照常消费。
      const leftover = acc.subarray(headerEnd + 4);
      if (leftover.length > 0) socket.unshift(Buffer.from(leftover));
      resolve();
    };
    const onError = (): void => fail("握手期间连接断开");
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onError);
      // 摘掉 data 监听不会让流自动停：pause 住，等连接对象把自己的监听
      // 挂好再 resume——否则两次交接之间到达的帧会凭空消失。
      socket.pause();
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onError);
    socket.write(request);
  });
}
