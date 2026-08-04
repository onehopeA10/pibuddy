/**
 * 纯 JS 的 WebSocket 服务端（RFC 6455）—— 只用 node 内置 crypto，不引任何原生
 * 模块（`ws` 的可选原生 bufferutil 也不引；白名单只有 node-pty）。
 *
 * ## 为什么手写而不是引 ws
 *
 * v1 的 WS 用途很窄：服务端**单向推**池快照 / 通知，客户端偶尔发 ping / close。
 * 手写一份文本帧编解码 + 握手（约 150 行）换来的是「零新依赖、过 check-pure-js-deps
 * 无忧、行为完全在自己掌控里」，比引一个带可选原生依赖的库再去禁用它更干净。
 *
 * ## 鉴权不在本文件
 *
 * 握手的鉴权（token / origin / 限速）在 remote-server.ts 的 upgrade 处理里、经
 * 统一 `authorize()`（remote-auth.ts）判完之后，才调用本文件的 `acceptUpgrade`。
 * 本文件只管协议帧，不管「谁能连」——那是审计点名过的坑，必须收在统一中间件里。
 */
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

/** RFC 6455 固定 magic GUID。 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Sec-WebSocket-Accept = base64(sha1(key + GUID))。 */
export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

/** 服务端 → 客户端文本帧（FIN=1，opcode=0x1，**不掩码**）。 */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  return encodeFrame(0x1, payload);
}

/** 关闭帧（opcode=0x8，带状态码）。 */
export function encodeCloseFrame(code = 1000): Buffer {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code, 0);
  return encodeFrame(0x8, body);
}

/** pong 帧（opcode=0xA），回应客户端 ping。 */
export function encodePong(payload: Buffer): Buffer {
  return encodeFrame(0xa, payload);
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export interface DecodedFrame {
  opcode: number;
  payload: Buffer;
}

/**
 * 从累积缓冲里解出尽可能多的完整帧（客户端帧**必然掩码**，否则违反 RFC，丢弃）。
 * 返回解出的帧 + 剩余未成帧的字节。**只处理未分片的单帧**（v1 客户端不发大消息）。
 */
export function decodeFrames(buffer: Buffer): { frames: DecodedFrame[]; rest: Buffer } {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
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
    // 客户端帧必须掩码
    if (!masked) {
      // 违反协议：跳过整个缓冲，交回空 rest（连接层会关掉）
      return { frames, rest: Buffer.alloc(0) };
    }
    if (cursor + 4 + len > buffer.length) break; // 帧还没收全
    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buffer[cursor + i] ^ mask[i & 3];
    cursor += len;
    frames.push({ opcode, payload });
    offset = cursor;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** 一条活跃 WS 连接。 */
export class RemoteWsConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    readonly deviceId: string,
    private readonly socket: Socket,
    private readonly onText: (conn: RemoteWsConnection, text: string) => void,
    private readonly onClose: (conn: RemoteWsConnection) => void
  ) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        this.close(1000);
        return;
      }
      if (frame.opcode === 0x9) {
        this.rawWrite(encodePong(frame.payload));
        continue;
      }
      if (frame.opcode === 0x1) {
        this.onText(this, frame.payload.toString("utf8"));
      }
    }
  }

  private rawWrite(buf: Buffer): void {
    if (this.closed) return;
    try {
      this.socket.write(buf);
    } catch {
      this.handleClose();
    }
  }

  send(text: string): void {
    this.rawWrite(encodeTextFrame(text));
  }

  close(code = 1000): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeCloseFrame(code));
    } catch {
      /* 已断，忽略 */
    }
    this.socket.destroy();
    this.handleClose();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }
}

/**
 * 全部活跃连接的登记处：广播、按设备定位、断开（撤销 / 关服务时立即清）。
 */
export class RemoteWsHub {
  private readonly conns = new Set<RemoteWsConnection>();

  add(conn: RemoteWsConnection): void {
    this.conns.add(conn);
  }
  remove(conn: RemoteWsConnection): void {
    this.conns.delete(conn);
  }
  size(): number {
    return this.conns.size;
  }
  /** 某设备是否有活跃连接。 */
  hasDevice(deviceId: string): boolean {
    for (const c of this.conns) if (c.deviceId === deviceId) return true;
    return false;
  }
  broadcast(text: string): void {
    for (const c of this.conns) c.send(text);
  }
  /** 断开某设备的全部连接（撤销 / 轮换后立即失效）。 */
  dropDevice(deviceId: string, code = 4001): void {
    for (const c of [...this.conns]) if (c.deviceId === deviceId) c.close(code);
  }
  /** 断开全部（关服务）。 */
  dropAll(code = 1001): void {
    for (const c of [...this.conns]) c.close(code);
    this.conns.clear();
  }
}
