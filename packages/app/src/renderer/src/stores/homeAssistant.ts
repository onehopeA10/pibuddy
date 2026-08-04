/**
 * 智能家居设置区块的渲染侧状态（home.assistant / 智能家居 Phase B）。
 *
 * ## 这个 store 只做四件事
 *
 * 配置快照的读取缓存、保存（host/port/token）、授权（把用户选择交给
 * permission:decide——真正的确认在主进程原生框）、测试连接。**没有**任何
 * 控制设备的动作：控制是 pi 回路内工具，在会话里由 agent 调用。
 *
 * 保存与授权是两步（一次「保存并授权」点击顺序做完）：配置落盘成功但用户
 * 在原生框上点了取消时，界面如实显示「已配置、未授权」，不回滚配置——
 * 用户随时可以只点「重新授权」。
 */
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { HaConfigState, HaStatusResult, HaTestConnectionResult } from "@contract";

export const useHomeAssistantStore = defineStore("homeAssistant", () => {
  const config = shallowRef<HaConfigState | null>(null);
  const status = shallowRef<HaStatusResult | null>(null);
  const busy = ref(false);
  const testing = ref(false);
  const lastError = ref("");
  const testResult = shallowRef<HaTestConnectionResult | null>(null);

  async function refresh(workspaceId: string): Promise<void> {
    try {
      const [configResult, statusResult] = await Promise.all([
        window.piBuddy.home.configGet(workspaceId),
        window.piBuddy.home.status(workspaceId),
      ]);
      config.value = configResult;
      status.value = statusResult;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  /**
   * 保存端点与（可选）token，然后发起授权。授权 = permission:decide 的
   * allow-workspace 档——network.local 属危险权限，主进程会弹原生确认框；
   * 用户取消时授权不落，配置保留。返回「授权是否已生效」。
   */
  async function saveAndAuthorize(
    workspaceId: string,
    host: string,
    port: number,
    token: string
  ): Promise<boolean> {
    busy.value = true;
    try {
      config.value = await window.piBuddy.home.configSet(workspaceId, host, port, token);
      const endpoint = `${config.value.host}:${config.value.port}`;
      await window.piBuddy.permission.decide({
        capabilityId: "home.assistant",
        permission: "network.local",
        resource: endpoint,
        disposition: "allow-workspace",
        workspaceId,
      });
      await refresh(workspaceId);
      lastError.value = "";
      return config.value?.authorized ?? false;
    } catch (err) {
      lastError.value = (err as Error).message;
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function testConnection(workspaceId: string): Promise<void> {
    testing.value = true;
    testResult.value = null;
    try {
      testResult.value = await window.piBuddy.home.testConnection(workspaceId);
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      testing.value = false;
    }
  }

  return {
    config,
    status,
    busy,
    testing,
    lastError,
    testResult,
    refresh,
    saveAndAuthorize,
    testConnection,
  };
});
