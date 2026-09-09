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
import { currentProjectTrust } from "../pi-resources/project-trust.js";
import { connectStdio, terminateStdioChild } from "./mcp-client.js";
import {
  findServer,
  resolveServers,
  toDescriptor,
  type ResolvedMcpServer,
} from "./mcp-config.js";

interface ProcessSlot {
  workspaceId: string;
  scope: ResolvedMcpServer["scope"];
  name: string;
  child: ChildProcess | null;
  startingChild: ChildProcess | null;
  starting: Promise<McpConnectionResult> | null;
  stopRequested: boolean;
}

/** serverId → 单一生命周期槽；同一 id 不允许并发派生多个 child。 */
const processSlots = new Map<string, ProcessSlot>();
/** 连接测试同样会 spawn；握手期间必须能按工作区撤销并被全局 teardown 回收。 */
const probeChildren = new Map<ChildProcess, string>();
let lifecycleEpoch = 0;
/** 工作区项目信任撤销代际：撤销时推进，未登记的启动/探测据此作废。 */
const trustRevokeEpoch = new Map<string, number>();

function currentTrustEpoch(workspaceId: string): number {
  return trustRevokeEpoch.get(workspaceId) ?? 0;
}

function bumpTrustEpoch(workspaceId: string): number {
  const next = currentTrustEpoch(workspaceId) + 1;
  trustRevokeEpoch.set(workspaceId, next);
  return next;
}

function killWorkspaceProbes(workspaceId: string): void {
  for (const [child, owner] of probeChildren) {
    if (owner !== workspaceId) continue;
    killChild(child);
    probeChildren.delete(child);
  }
}

/** 主进程已拥有该工作区的启动生命周期时，停止不再消耗新的执行授权。 */
export function isOwnedMcpProcess(workspaceId: string, id: string): boolean {
  const slot = processSlots.get(id);
  return Boolean(
    slot &&
      slot.workspaceId === workspaceId &&
      (slot.child || slot.startingChild || slot.starting)
  );
}

function killChild(child: ChildProcess): void {
  terminateStdioChild(child);
}

async function stopProcess(id: string): Promise<void> {
  const slot = processSlots.get(id);
  if (!slot) return;
  slot.stopRequested = true;
  if (slot.startingChild) {
    const child = slot.startingChild;
    slot.startingChild = null;
    killChild(child);
  }
  if (slot.child) {
    const child = slot.child;
    slot.child = null;
    killChild(child);
  }
  const starting = slot.starting;
  if (starting) await starting.catch(() => undefined);
  if (slot.startingChild) {
    const child = slot.startingChild;
    slot.startingChild = null;
    killChild(child);
  }
  if (slot.child) {
    const child = slot.child;
    slot.child = null;
    killChild(child);
  }
  if (
    processSlots.get(id) === slot &&
    slot.starting === null &&
    slot.startingChild === null &&
    slot.child === null
  ) {
    processSlots.delete(id);
  }
}

/** 仅供单测：回收并清掉全部生命周期槽。 */
export function __resetMcpRunning(): void {
  disposeMcpResources();
}

/** 枚举全部服务器，附带进程状态，并回收已不在当前配置里的旧进程。 */
export async function listServers(workspaceId: string): Promise<McpListResult> {
  const { servers, errors } = await resolveServers(workspaceId);
  const currentIds = new Set(servers.map((server) => server.id));
  const trust = await currentProjectTrust(workspaceId);
  const staleIds = [...processSlots.entries()]
    .filter(([, slot]) => slot.workspaceId === workspaceId)
    .filter(
      ([id, slot]) =>
        !currentIds.has(id) || (slot.scope === "project" && trust.effective !== "allow")
    )
    .map(([id]) => id);
  await Promise.all(staleIds.map((id) => stopProcess(id)));
  return {
    servers: servers.map((server) => toDescriptor(server, processSlots.get(server.id)?.child != null)),
    errors,
    scannedAt: Date.now(),
  };
}

/** 连接测试：真的连一次，握手完就回收进程。 */
export async function testServer(workspaceId: string, id: string): Promise<McpConnectionResult> {
  const epoch = lifecycleEpoch;
  const trustEpoch = currentTrustEpoch(workspaceId);
  const server = await findServer(workspaceId, id);
  if (!server) return notFound(id);
  if (epoch !== lifecycleEpoch) return lifecycleStopped(server);
  if (server.config.transport !== "stdio") return httpNotImplemented(server);
  const trustFailure = await projectTrustFailure(workspaceId, server);
  if (trustFailure) return trustFailure;
  if (epoch !== lifecycleEpoch) return lifecycleStopped(server);
  if (trustEpoch !== currentTrustEpoch(workspaceId)) {
    return projectTrustDenied(server);
  }

  let spawned: ChildProcess | null = null;
  try {
    const { probe } = await connectStdio(server.config, {
      keepAlive: false,
      onSpawn: (child) => {
        spawned = child;
        if (epoch !== lifecycleEpoch || trustEpoch !== currentTrustEpoch(workspaceId)) {
          killChild(child);
          return;
        }
        probeChildren.set(child, workspaceId);
      },
    });
    return buildResult(server, probe, false);
  } finally {
    if (spawned) probeChildren.delete(spawned);
  }
}

/** 启动：同一 id 共用一个 in-flight promise，避免并发 spawn。 */
export async function startServer(workspaceId: string, id: string): Promise<McpConnectionResult> {
  const epoch = lifecycleEpoch;
  const trustEpoch = currentTrustEpoch(workspaceId);
  const server = await findServer(workspaceId, id);
  if (!server) return notFound(id);
  if (epoch !== lifecycleEpoch) return lifecycleStopped(server);
  if (server.config.transport !== "stdio") return httpNotImplemented(server);
  const trustFailure = await projectTrustFailure(workspaceId, server);
  if (trustFailure) return trustFailure;
  if (epoch !== lifecycleEpoch) return lifecycleStopped(server);
  if (trustEpoch !== currentTrustEpoch(workspaceId)) {
    return projectTrustDenied(server);
  }

  const existing = processSlots.get(id);
  if (existing?.starting) return existing.starting;
  if (existing?.child) return alreadyRunning(server);

  const slot: ProcessSlot =
    existing ?? {
      workspaceId,
      scope: server.scope,
      name: server.config.name,
      child: null,
      startingChild: null,
      starting: null,
      stopRequested: false,
    };
  slot.workspaceId = workspaceId;
  slot.scope = server.scope;
  slot.name = server.config.name;
  slot.stopRequested = false;
  processSlots.set(id, slot);

  const starting = (async (): Promise<McpConnectionResult> => {
    const { child, probe } = await connectStdio(server.config, {
      keepAlive: true,
      onSpawn: (spawned) => {
        if (
          epoch !== lifecycleEpoch ||
          trustEpoch !== currentTrustEpoch(workspaceId) ||
          slot.stopRequested ||
          processSlots.get(id) !== slot
        ) {
          killChild(spawned);
          return;
        }
        slot.startingChild = spawned;
      },
    });
    if (child && slot.startingChild === child) slot.startingChild = null;
    if (!child) return buildResult(server, probe, false);
    if (
      epoch !== lifecycleEpoch ||
      trustEpoch !== currentTrustEpoch(workspaceId) ||
      slot.stopRequested ||
      processSlots.get(id) !== slot
    ) {
      killChild(child);
      return buildResult(
        server,
        { ...probe, diagnostics: [...probe.diagnostics, "启动期间收到停止请求，进程已回收"] },
        false
      );
    }
    slot.child = child;
    child.on("exit", () => {
      if (slot.child === child) slot.child = null;
      if (slot.starting === null && slot.child === null && processSlots.get(id) === slot) {
        processSlots.delete(id);
      }
    });
    return buildResult(server, probe, true);
  })();
  slot.starting = starting;
  try {
    return await starting;
  } finally {
    if (slot.starting === starting) slot.starting = null;
    if (slot.startingChild) {
      const child = slot.startingChild;
      slot.startingChild = null;
      killChild(child);
    }
    if (
      slot.child === null &&
      slot.startingChild === null &&
      processSlots.get(id) === slot
    ) {
      processSlots.delete(id);
    }
  }
}

/** 停止：包括正在握手但尚未登记 child 的启动。 */
export async function stopServer(workspaceId: string, id: string): Promise<McpListResult> {
  const slot = processSlots.get(id);
  if (slot && slot.workspaceId !== workspaceId) {
    throw new Error(`MCP_SERVER_WORKSPACE_MISMATCH: ${id}`);
  }
  await stopProcess(id);
  return listServers(workspaceId);
}

/** project trust 被撤销时，只回收该工作区的 project MCP，user 级不受影响。 */
export async function stopProjectServers(workspaceId: string): Promise<void> {
  bumpTrustEpoch(workspaceId);
  killWorkspaceProbes(workspaceId);
  const ids = [...processSlots.entries()]
    .filter(([, slot]) => slot.workspaceId === workspaceId && slot.scope === "project")
    .map(([id]) => id);
  await Promise.all(ids.map((id) => stopProcess(id)));
}

/** 配置 save/remove 前按逻辑身份回收旧 id，包括配置变更后已不可见的进程。 */
export async function stopServersByRef(
  workspaceId: string,
  scope: ResolvedMcpServer["scope"],
  name: string
): Promise<void> {
  const ids = [...processSlots.entries()]
    .filter(([, slot]) =>
      slot.workspaceId === workspaceId && slot.scope === scope && slot.name === name
    )
    .map(([id]) => id);
  await Promise.all(ids.map((id) => stopProcess(id)));
}

/** 拆卸：活 child 立即 kill；in-flight start 会在返回时看到 stopRequested 并回收。 */
export function disposeMcpResources(): void {
  lifecycleEpoch += 1;
  for (const slot of processSlots.values()) {
    slot.stopRequested = true;
    if (slot.startingChild) {
      const child = slot.startingChild;
      slot.startingChild = null;
      killChild(child);
    }
    if (slot.child) {
      const child = slot.child;
      slot.child = null;
      killChild(child);
    }
  }
  for (const child of probeChildren.keys()) killChild(child);
  probeChildren.clear();
  processSlots.clear();
  trustRevokeEpoch.clear();
}

// ---------------------------------------------------------------- 结果构造

function lifecycleStopped(server: ResolvedMcpServer): McpConnectionResult {
  return buildResult(
    server,
    {
      ok: false,
      serverInfo: null,
      protocolVersion: null,
      tools: [],
      diagnostics: ["MCP 能力已停用，本次尚未启动任何进程"],
    },
    false
  );
}

function alreadyRunning(server: ResolvedMcpServer): McpConnectionResult {
  return {
    ok: true,
    serverId: server.id,
    serverName: server.config.name,
    serverInfo: null,
    protocolVersion: null,
    tools: [],
    diagnostics: ["该服务器已在运行"],
    oauth: oauthStatus(server),
    running: true,
  };
}

function projectTrustDenied(server: ResolvedMcpServer): McpConnectionResult {
  return {
    ok: false,
    serverId: server.id,
    serverName: server.config.name,
    serverInfo: null,
    protocolVersion: null,
    tools: [],
    diagnostics: ["项目 MCP 配置尚未受信，未启动任何本机进程"],
    oauth: oauthStatus(server),
    running: false,
  };
}

async function projectTrustFailure(
  workspaceId: string,
  server: ResolvedMcpServer
): Promise<McpConnectionResult | null> {
  if (server.scope !== "project") return null;
  const trust = await currentProjectTrust(workspaceId);
  if (trust.effective === "allow") return null;
  return projectTrustDenied(server);
}

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
