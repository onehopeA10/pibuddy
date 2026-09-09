/**
 * MCP 服务器管理的渲染侧状态（能力包 common.mcp）。
 *
 * 与 piResources store 同一条纪律：只持有主进程给的**权威列表**，把用户动作
 * 转成一次 IPC，再用返回的完整列表覆盖本地——不自己推断「删了之后列表长
 * 什么样」。连接测试 / 启动的结果按服务器 id 存一份，供界面展开工具列表与
 * 诊断。
 */
import { ref } from "vue";
import { defineStore } from "pinia";
import {
  MCP_CAPABILITY_ID,
  MCP_PERMISSION,
  mcpConfigResource,
  mcpExecutionFingerprintMaterial,
  type McpConnectionResult,
  type McpListResult,
  type McpScope,
  type McpServerDescriptor,
  type McpServerInput,
} from "@contract";

import { usePermissionStore } from "./permission";

const PERMISSION_DENIED = "IPC_PERMISSION_DENIED";

export interface McpDeniedRequest {
  workspaceId: string;
  capabilityId: string;
  permission: string;
  resource: string;
  command: string | null;
}

function commandLine(command: string | undefined, args: readonly string[]): string | null {
  const head = (command ?? "").trim();
  if (head === "") return null;
  return args.length > 0 ? `${head} ${args.join(" ")}` : head;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const useMcpStore = defineStore("mcp", () => {
  const loading = ref(false);
  const servers = ref<McpServerDescriptor[]>([]);
  const scanErrors = ref<string[]>([]);
  const lastError = ref("");
  /** 正在测试 / 启停的服务器 id（驱动按钮 loading） */
  const busyId = ref("");
  /** id → 最近一次连接测试 / 启动结果 */
  const results = ref<Record<string, McpConnectionResult>>({});
  const permissionDenied = ref(false);
  const deniedNotice = ref("");
  const deniedRequest = ref<McpDeniedRequest | null>(null);
  const activeWorkspaceId = ref("");

  /** 晚到的响应必须丢弃：切工作目录后旧列表不能覆盖新列表。 */
  let seq = 0;
  let refreshSeq = 0;
  let workspaceGeneration = 0;
  let workspaceInitialized = false;

  function setWorkspace(workspaceId: string): void {
    if (workspaceInitialized && activeWorkspaceId.value === workspaceId) return;
    workspaceInitialized = true;
    activeWorkspaceId.value = workspaceId;
    workspaceGeneration += 1;
    seq += 1;
    refreshSeq += 1;
    loading.value = false;
    servers.value = [];
    scanErrors.value = [];
    lastError.value = "";
    busyId.value = "";
    results.value = {};
    clearDenied();
  }

  function captureWorkspace(workspaceId: string): number | null {
    if (!workspaceId) return null;
    if (!workspaceInitialized) setWorkspace(workspaceId);
    return activeWorkspaceId.value === workspaceId ? workspaceGeneration : null;
  }

  function isCurrent(workspaceId: string, generation: number): boolean {
    return activeWorkspaceId.value === workspaceId && workspaceGeneration === generation;
  }

  function applyList(result: McpListResult): void {
    servers.value = result.servers;
    scanErrors.value = result.errors;
  }

  function clearDenied(): void {
    permissionDenied.value = false;
    deniedNotice.value = "";
    deniedRequest.value = null;
  }

  function raisePermission(req: McpDeniedRequest, subject: string, verb: string): void {
    permissionDenied.value = true;
    deniedRequest.value = req;
    const command = req.command === null ? "" : `本机命令 \`${req.command}\``;
    const head =
      req.command === null
        ? `${subject}需要 process.shell 授权，未授权因此${verb}。`
        : `${subject}需要执行${command}，未授权因此${verb}。`;
    const opened = usePermissionStore().request(req);
    deniedNotice.value = opened
      ? `${head}授权只覆盖当前工作区、这台服务器与当前执行配置；配置变化后需要重新授权。`
      : `${head}申请无法安全展示，已拒绝：${usePermissionStore().lastRejectedPrompt}`;
  }

  function handleDenied(
    err: unknown,
    req: McpDeniedRequest,
    subject: string,
    verb: string
  ): boolean {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(PERMISSION_DENIED)) {
      lastError.value = message;
      return false;
    }
    raisePermission(req, subject, verb);
    lastError.value = "";
    return true;
  }

  function authorize(): void {
    const req = deniedRequest.value;
    if (!req) return;
    if (req.workspaceId !== activeWorkspaceId.value) {
      clearDenied();
      return;
    }
    if (!usePermissionStore().request(req)) {
      deniedNotice.value = `这次申请无法安全展示，已拒绝：${usePermissionStore().lastRejectedPrompt}`;
    }
  }

  function openPermissionCenter(): void {
    usePermissionStore().centerOpen = true;
  }

  function runRequestFor(
    workspaceId: string,
    id: string
  ): { req: McpDeniedRequest; name: string } | null {
    const server = servers.value.find((item) => item.id === id);
    if (!server?.runPermissionResource) return null;
    return {
      name: server.name,
      req: {
        workspaceId,
        capabilityId: MCP_CAPABILITY_ID,
        permission: MCP_PERMISSION,
        resource: server.runPermissionResource,
        command: commandLine(server.command, server.args),
      },
    };
  }

  async function refresh(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return;
    const my = ++seq;
    const refresh = ++refreshSeq;
    loading.value = true;
    lastError.value = "";
    try {
      const result = await window.piBuddy.mcp.list(workspaceId);
      if (my !== seq || !isCurrent(workspaceId, generation)) return;
      applyList(result);
    } catch (err) {
      if (my === seq && isCurrent(workspaceId, generation)) {
        lastError.value = (err as Error).message;
      }
    } finally {
      if (refresh === refreshSeq && isCurrent(workspaceId, generation)) loading.value = false;
    }
  }

  async function save(
    workspaceId: string,
    scope: McpScope,
    config: McpServerInput
  ): Promise<boolean> {
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return false;
    const my = ++seq;
    const fingerprint =
      config.transport === "stdio"
        ? await sha256Hex(mcpExecutionFingerprintMaterial(config))
        : null;
    if (my !== seq || !isCurrent(workspaceId, generation)) return false;
    try {
      const result = await window.piBuddy.mcp.save(workspaceId, scope, config);
      if (my !== seq || !isCurrent(workspaceId, generation)) return false;
      applyList(result);
      clearDenied();
      return true;
    } catch (err) {
      if (my !== seq || !isCurrent(workspaceId, generation)) return false;
      if (fingerprint !== null) {
        handleDenied(
          err,
          {
            workspaceId,
            capabilityId: MCP_CAPABILITY_ID,
            permission: MCP_PERMISSION,
            resource: mcpConfigResource(workspaceId, scope, config.name, fingerprint),
            command: commandLine(config.command, config.args),
          },
          `保存 MCP 服务器「${config.name}」`,
          "未保存"
        );
      } else {
        lastError.value = (err as Error).message;
      }
      return false;
    }
  }

  async function remove(workspaceId: string, scope: McpScope, name: string): Promise<void> {
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return;
    const my = ++seq;
    try {
      const result = await window.piBuddy.mcp.remove(workspaceId, scope, name);
      if (my !== seq || !isCurrent(workspaceId, generation)) return;
      applyList(result);
    } catch (err) {
      if (my === seq && isCurrent(workspaceId, generation)) {
        lastError.value = (err as Error).message;
      }
    }
  }

  async function test(workspaceId: string, id: string): Promise<void> {
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return;
    busyId.value = id;
    try {
      const result = await window.piBuddy.mcp.test(workspaceId, id);
      if (!isCurrent(workspaceId, generation)) return;
      results.value = { ...results.value, [id]: result };
      clearDenied();
    } catch (err) {
      if (!isCurrent(workspaceId, generation)) return;
      const target = runRequestFor(workspaceId, id);
      if (target) handleDenied(err, target.req, `测试 MCP 服务器「${target.name}」`, "未测试");
      else lastError.value = (err as Error).message;
    } finally {
      if (isCurrent(workspaceId, generation) && busyId.value === id) busyId.value = "";
    }
  }

  async function start(workspaceId: string, id: string): Promise<void> {
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return;
    busyId.value = id;
    try {
      const result = await window.piBuddy.mcp.start(workspaceId, id);
      if (!isCurrent(workspaceId, generation)) return;
      results.value = { ...results.value, [id]: result };
      clearDenied();
      await refresh(workspaceId);
    } catch (err) {
      if (!isCurrent(workspaceId, generation)) return;
      const target = runRequestFor(workspaceId, id);
      if (target) handleDenied(err, target.req, `MCP 服务器「${target.name}」`, "未启动");
      else lastError.value = (err as Error).message;
    } finally {
      if (isCurrent(workspaceId, generation) && busyId.value === id) busyId.value = "";
    }
  }

  async function stop(workspaceId: string, id: string): Promise<void> {
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return;
    busyId.value = id;
    try {
      const result = await window.piBuddy.mcp.stop(workspaceId, id);
      if (!isCurrent(workspaceId, generation)) return;
      applyList(result);
    } catch (err) {
      if (isCurrent(workspaceId, generation)) lastError.value = (err as Error).message;
    } finally {
      if (isCurrent(workspaceId, generation) && busyId.value === id) busyId.value = "";
    }
  }

  return {
    loading,
    servers,
    scanErrors,
    lastError,
    busyId,
    results,
    permissionDenied,
    deniedNotice,
    deniedRequest,
    activeWorkspaceId,
    setWorkspace,
    refresh,
    save,
    remove,
    test,
    start,
    stop,
    authorize,
    openPermissionCenter,
    clearDenied,
  };
});
