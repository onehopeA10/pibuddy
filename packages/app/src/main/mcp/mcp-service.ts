/**
 * MCP 服务器管理的编排层：枚举 / 连接测试 / 启停，以及活进程登记与拆卸。
 *
 * 本模块**持有活着的 stdio 子进程**（start 后），因此 manifest 的
 * `runtime.teardown` 含 `child-process`，禁用 / 退出时 `disposeMcpResources`
 * 逐个 kill —— 否则「关掉 MCP 能力」之后那些服务器进程会一直挂在任务
 * 管理器里，是那种看不见的泄漏（FEAT-mcp.md / ADR D4 规则 4）。
 */
import type { ChildProcess } from "node:child_process";

import {
  MCP_HTTP_TEST_NOT_IMPLEMENTED_NOTE,
  MCP_OAUTH_NOT_IMPLEMENTED_NOTE,
  type McpConnectionResult,
  type McpListResult,
} from "@pibuddy/contract";

import { redactSecrets } from "../logger-redact.js";
import { connectStdio } from "./mcp-client.js";
import {
  findServer,
  resolveServers,
  toDescriptor,
  type ResolvedMcpServer,
} from "./mcp-config.js";

/**
 * 活进程表：serverId → 子进程。
 *
 * 键是 `${scope}:${name}` 派生的稳定 id，因此重命名 / 改配置后再 start 会被
 * 视为另一台服务器，旧进程仍能被 stop —— 与「按 name 覆盖配置」是两条正交
 * 的轴。
 */
const running = new Map<string, ChildProcess>();

/** 仅供单测：清掉活进程登记（不 kill，测试自己造的是假 child）。 */
export function __resetMcpRunning(): void {
  running.clear();
}

/** 枚举全部服务器，附带 main 侧的活进程状态。 */
export async function listServers(workspaceId: string): Promise<McpListResult> {
  const { servers, errors } = await resolveServers(workspaceId);
  return {
    servers: servers.map((s) => toDescriptor(s, running.has(s.id))),
    errors,
    scannedAt: Date.now(),
  };
}

/** 连接测试：真的连一次，握手完就回收进程。 */
export async function testServer(workspaceId: string, id: string): Promise<McpConnectionResult> {
  const server = await findServer(workspaceId, id);
  if (!server) return notFound(id);
  if (server.config.transport !== "stdio") return httpNotImplemented(server);

  const { probe } = await connectStdio(server.config, { keepAlive: false });
  return buildResult(server, probe, false);
}

/** 启动：握手成功则保留活进程，登记进 running 表。 */
export async function startServer(workspaceId: string, id: string): Promise<McpConnectionResult> {
  const server = await findServer(workspaceId, id);
  if (!server) return notFound(id);
  if (server.config.transport !== "stdio") return httpNotImplemented(server);

  const existing = running.get(id);
  if (existing) {
    // 已经在跑：不重复 spawn，回一份「已在运行」的结果（工具列表这次不重取）。
    return {
      ok: true,
      serverId: id,
      serverName: server.config.name,
      serverInfo: null,
      protocolVersion: null,
      tools: [],
      diagnostics: ["该服务器已在运行"],
      oauth: oauthStatus(server),
      running: true,
    };
  }

  const { child, probe } = await connectStdio(server.config, { keepAlive: true });
  if (child) {
    running.set(id, child);
    // 进程自行退出（崩溃 / 被外部杀）时从表里摘掉，别让 list 一直显示 running。
    child.on("exit", () => {
      if (running.get(id) === child) running.delete(id);
    });
  }
  return buildResult(server, probe, child !== null);
}

/** 停止：kill 活进程，返回刷新后的列表。 */
export async function stopServer(workspaceId: string, id: string): Promise<McpListResult> {
  const child = running.get(id);
  if (child) {
    running.delete(id);
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
  return listServers(workspaceId);
}

/** 拆卸：kill 全部活进程（D4 规则 4）。数据（配置文件）一个字节不动。 */
export function disposeMcpResources(): void {
  for (const child of running.values()) {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
  running.clear();
}

// ---------------------------------------------------------------- 结果构造

function buildResult(
  server: ResolvedMcpServer,
  probe: { ok: boolean; serverInfo: { name: string; version: string } | null; protocolVersion: string | null; tools: { name: string; description: string }[]; diagnostics: string[] },
  isRunning: boolean
): McpConnectionResult {
  return {
    ok: probe.ok,
    serverId: server.id,
    serverName: server.config.name,
    serverInfo: probe.serverInfo,
    protocolVersion: probe.protocolVersion,
    tools: probe.tools,
    // 诊断可能夹带 stderr 里的密钥形态串，落到界面前先脱敏。
    diagnostics: (redactSecrets(probe.diagnostics) as string[]) ?? probe.diagnostics,
    oauth: oauthStatus(server),
    running: isRunning,
  };
}

function oauthStatus(server: ResolvedMcpServer): McpConnectionResult["oauth"] {
  return { required: server.config.oauth, note: MCP_OAUTH_NOT_IMPLEMENTED_NOTE };
}

function httpNotImplemented(server: ResolvedMcpServer): McpConnectionResult {
  return {
    ok: false,
    serverId: server.id,
    serverName: server.config.name,
    serverInfo: null,
    protocolVersion: null,
    tools: [],
    diagnostics: [MCP_HTTP_TEST_NOT_IMPLEMENTED_NOTE],
    oauth: oauthStatus(server),
    running: false,
  };
}

function notFound(id: string): McpConnectionResult {
  return {
    ok: false,
    serverId: id,
    serverName: "",
    serverInfo: null,
    protocolVersion: null,
    tools: [],
    diagnostics: [`未找到该 MCP 服务器（id=${id}），可能配置已被外部改动，请刷新`],
    oauth: { required: false, note: MCP_OAUTH_NOT_IMPLEMENTED_NOTE },
    running: false,
  };
}
