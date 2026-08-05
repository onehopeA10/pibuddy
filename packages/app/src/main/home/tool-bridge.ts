/**
 * tool bridge（home.assistant / 智能家居 Phase B）：pi 回路内工具的唯一执行通道。
 *
 * ## 为什么要有这座桥
 *
 * extension 跑在 pi 子进程里，不得自己 fetch（那会绕开出站守卫——fetch/socket
 * census 只钉得住主进程）。桥的两端：extension 侧只会「连管道、发一行 JSON、
 * 收一行 JSON」；执行全部在主进程侧——验 token → 按 manifest.tools[].permissions
 * evaluate →（经 safeLocalFetch / 缓存查询）执行 → 回包。
 *
 * ## 入站 listener，不触 socket census
 *
 * socket census（local-outbound-boundary.spec ①）钉的是**出站**原语
 * `net.connect / tls.connect / http(s).request / new WebSocket`；本文件只有
 * `net.createServer`（入站监听），不在特征集里——这不是钻空子：census 防的
 * 是「绕开两个出站守卫打出去」，监听一个本机管道打不出去任何东西。
 *
 * ## 管道与凭证
 *
 * Windows 用命名管道 `\\.\pipe\pibuddy-home-<random>`（本机、本用户可见）；
 * 非 Windows 用 tmpdir 下的 unix socket。名字带随机段 + 每次启动随机生成的
 * 一次性 token（进程内存态，不落盘、不进日志），两层合起来挡住「本机其它
 * 进程猜到管道名就能调用」。协议是 JSON 行：
 *
 *     请求  {id, token, tool, args, cwd} + "\n"
 *     响应  {id, ok:true, result} | {id, ok:false, error} + "\n"
 *
 * 单请求超时 10s；单行上限 256KB；错误消息不含 token / 端点地址（执行器
 * 内部的 safeLocalFetch 已脱敏）。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { HOME_BRIDGE_ENV_PATH, HOME_BRIDGE_ENV_TOKEN } from "@pibuddy/contract";

import { guardBridgeToolResult } from "../tool-archive/bridge-guard.js";

/** 单个工具调用的执行上限。 */
export const HOME_BRIDGE_TIMEOUT_MS = 10000;
/** 单行请求的字节上限（工具入参都是小 JSON，256KB 已经宽裕）。 */
export const HOME_BRIDGE_MAX_LINE_BYTES = 256 * 1024;

/** 执行面：由 home-ipc 注入（评估权限 + 调 HomeAssistantService）。 */
export type HomeBridgeExecutor = (
  tool: string,
  args: unknown,
  cwd: string | null
) => Promise<unknown>;

// ---------------------------------------------------------------- 跨包工具注册
//
// 【追加（home.automation）——合并风险点】桥仍归 home.assistant 所有；上层家居
// 包（首个使用方 home.automation 的 manage_rule）把自己的工具 handler 挂进这张
// 模块级表：activate 时挂、deactivate 时摘（传 null）。请求按工具名先查这张表，
// 查不到才落回桥自建时注入的执行面——基座自己的 3 个工具路径零改动。凭证与
// 超时与基座工具完全同一道闸（同一个 token、同一个 onLine）。若与其它并行
// 分支冲突，本段 + onLine 里的一行 resolve 是仅有的两处改动。

const crossPackageTools = new Map<string, HomeBridgeExecutor>();

/** 注册 / 注销（handler 传 null）一个跨包 bridge 工具。 */
export function registerBridgeTool(toolName: string, handler: HomeBridgeExecutor | null): void {
  if (handler === null) crossPackageTools.delete(toolName);
  else crossPackageTools.set(toolName, handler);
}

// -------------------------------------------------------------- 派发闸（T1/T2）
//
// 【追加（T1/T2 接线）——合并风险点】桥的派发路径上唯一的接缝：装上之后，
// 每次工具执行被夹在 T1（派发事实）与 T2（结算事实）之间，中间还挂着循环闸
// 与参数违规回执。**不装时行为一字不变**（下面那行 `guard ? ... : call()`）。
// 闸的实现不在本文件（它要解 cwd→workspaceId、要持有账本），本文件只认这个
// 函数形状。若与其它并行分支冲突，本段 + onLine 里那三行是仅有的两处改动。

/**
 * 夹逼一次工具执行。**必须**在 impl 之前落 T1、之后落 T2，且 T1 失败时直接
 * 抛（绝不 catch 成 `{ok:false}` 结果——那样 impl 仍会在某条路径上跑，产生一次
 * 没有 dispatch 事实的副作用）。
 */
export type HomeBridgeDispatchGuard = <T>(
  request: { tool: string; args: unknown; cwd: string | null; requestId: string | number | null },
  impl: () => Promise<T>
) => Promise<T>;

let dispatchGuard: HomeBridgeDispatchGuard | null = null;

/** 装 / 卸（传 null）派发闸。卸掉后桥回到零夹逼的原行为。 */
export function setBridgeDispatchGuard(guard: HomeBridgeDispatchGuard | null): void {
  dispatchGuard = guard;
}

function newPipePath(): string {
  const rand = randomBytes(8).toString("hex");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pibuddy-home-${rand}`
    : path.join(os.tmpdir(), `pibuddy-home-${rand}.sock`);
}

interface BridgeRequest {
  id?: unknown;
  token?: unknown;
  tool?: unknown;
  args?: unknown;
  cwd?: unknown;
}

export class HomeToolBridge {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  /** 一次性随机凭证：bridge 每次启动重新生成，经 env 注入 pi 子进程。 */
  private readonly token = randomBytes(24).toString("hex");
  private pipePathValue: string | null = null;

  constructor(private readonly execute: HomeBridgeExecutor) {}

  /** 监听地址；未启动为 null。 */
  pipePath(): string | null {
    return this.pipePathValue;
  }

  /** 注入 pi 子进程的环境变量。未启动返回空对象（= 不注入）。 */
  env(): Record<string, string> {
    if (this.pipePathValue === null) return {};
    return {
      [HOME_BRIDGE_ENV_PATH]: this.pipePathValue,
      [HOME_BRIDGE_ENV_TOKEN]: this.token,
    };
  }

  async start(): Promise<string> {
    if (this.server) return this.pipePathValue!;
    const pipePath = newPipePath();
    const server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipePath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // 监听不该独自撑着进程不退出（与心跳定时器同一取舍）。
    server.unref();
    this.server = server;
    this.pipePathValue = pipePath;
    return pipePath;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.pipePathValue = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** 仅供单测：拿到当前 token（生产路径只经 env() 出去）。 */
  __token(): string {
    return this.token;
  }

  // ---------------------------------------------------------------- 连接

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > HOME_BRIDGE_MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() !== "") void this.onLine(socket, line);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async onLine(socket: net.Socket, line: string): Promise<void> {
    let req: BridgeRequest;
    try {
      req = JSON.parse(line) as BridgeRequest;
    } catch {
      this.reply(socket, { id: null, ok: false, error: "请求不是合法 JSON" });
      return;
    }
    const id = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;

    // 凭证：定长比较，长度不等直接拒（timingSafeEqual 要求等长）。
    const given = typeof req.token === "string" ? req.token : "";
    const expected = Buffer.from(this.token, "utf8");
    const actual = Buffer.from(given, "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      this.reply(socket, { id, ok: false, error: "bridge token 校验失败" });
      return;
    }

    if (typeof req.tool !== "string" || req.tool === "") {
      this.reply(socket, { id, ok: false, error: "缺少 tool 字段" });
      return;
    }
    const cwd = typeof req.cwd === "string" && req.cwd !== "" ? req.cwd : null;
    // 【追加（T1/T2 接线）】定住工具名：下面的执行被包进闭包后，对 req.tool
    // 这个可变属性的类型收窄不再成立。
    const tool: string = req.tool;

    let timedOut = false;
    let cancelTimer: (() => void) | null = null;
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`工具执行超时（${HOME_BRIDGE_TIMEOUT_MS / 1000}s）`));
      }, HOME_BRIDGE_TIMEOUT_MS);
      timer.unref();
      cancelTimer = () => clearTimeout(timer);
    });
    try {
      // 【追加（home.automation）】跨包工具先查注册表，查不到落回基座执行面。
      const handler = crossPackageTools.get(tool) ?? this.execute;
      // 【追加（T1/T2 接线）】装了派发闸就走夹逼路径；没装则与从前逐字一致。
      const call = (): Promise<unknown> => Promise.race([handler(tool, req.args, cwd), timeout]);
      const guard = dispatchGuard;
      const result = await (guard
        ? guard({ tool, args: req.args, cwd, requestId: id }, call)
        : call());
      // 【追加（tool-archive）】回包路径上唯一的一处改动：超阈值的结果先完整落
      // 归档（文件旁路，不受 256KB 限制），回包换成带 ref 的占位符；未超阈值或
      // 归档失败一律原样回原文。guardBridgeToolResult 承诺永不抛——否则外面这层
      // catch 会把一次成功的调用改写成 {ok:false}。
      //
      // 两道闸的次序是契约：派发闸夹的是「副作用发生没发生」，回包闸改的只是
      // 「回给模型的表示」。反过来先剪枝再 T2，账本里落的就不是真实结果了。
      if (!timedOut) {
        this.reply(socket, {
          id,
          ok: true,
          result: await guardBridgeToolResult(tool, cwd, result),
        });
      }
    } catch (err) {
      this.reply(socket, {
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      (cancelTimer as (() => void) | null)?.();
    }
  }

  private reply(socket: net.Socket, payload: Record<string, unknown>): void {
    if (socket.destroyed) return;
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
    } catch {
      socket.destroy();
    }
  }
}
