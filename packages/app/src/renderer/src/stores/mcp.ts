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
import type {
  McpConnectionResult,
  McpListResult,
  McpScope,
  McpServerDescriptor,
  McpServerInput,
} from "@contract";

export const useMcpStore = defineStore("mcp", () => {
  const loading = ref(false);
  const servers = ref<McpServerDescriptor[]>([]);
  const scanErrors = ref<string[]>([]);
  const lastError = ref("");
  /** 正在测试 / 启停的服务器 id（驱动按钮 loading） */
  const busyId = ref("");
  /** id → 最近一次连接测试 / 启动结果 */
  const results = ref<Record<string, McpConnectionResult>>({});

  /** 晚到的响应必须丢弃：切工作目录后旧列表不能覆盖新列表。 */
  let seq = 0;

  function applyList(result: McpListResult): void {
    servers.value = result.servers;
    scanErrors.value = result.errors;
  }

  async function refresh(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    const my = ++seq;
    loading.value = true;
    lastError.value = "";
    try {
      const result = await window.piBuddy.mcp.list(workspaceId);
      if (my !== seq) return;
      applyList(result);
    } catch (err) {
      if (my === seq) lastError.value = (err as Error).message;
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  async function save(
    workspaceId: string,
    scope: McpScope,
    config: McpServerInput
  ): Promise<boolean> {
    const my = ++seq;
    try {
      const result = await window.piBuddy.mcp.save(workspaceId, scope, config);
      if (my !== seq) return false;
      applyList(result);
      return true;
    } catch (err) {
      if (my === seq) lastError.value = (err as Error).message;
      return false;
    }
  }

  async function remove(workspaceId: string, scope: McpScope, name: string): Promise<void> {
    const my = ++seq;
    try {
      const result = await window.piBuddy.mcp.remove(workspaceId, scope, name);
      if (my !== seq) return;
      applyList(result);
    } catch (err) {
      if (my === seq) lastError.value = (err as Error).message;
    }
  }

  async function test(workspaceId: string, id: string): Promise<void> {
    busyId.value = id;
    try {
      const result = await window.piBuddy.mcp.test(workspaceId, id);
      results.value = { ...results.value, [id]: result };
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      busyId.value = "";
    }
  }

  async function start(workspaceId: string, id: string): Promise<void> {
    busyId.value = id;
    try {
      const result = await window.piBuddy.mcp.start(workspaceId, id);
      results.value = { ...results.value, [id]: result };
      await refresh(workspaceId);
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      busyId.value = "";
    }
  }

  async function stop(workspaceId: string, id: string): Promise<void> {
    busyId.value = id;
    try {
      const result = await window.piBuddy.mcp.stop(workspaceId, id);
      applyList(result);
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      busyId.value = "";
    }
  }

  return {
    loading,
    servers,
    scanErrors,
    lastError,
    busyId,
    results,
    refresh,
    save,
    remove,
    test,
    start,
    stop,
  };
});
