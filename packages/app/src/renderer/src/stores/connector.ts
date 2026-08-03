/**
 * 连接器能力的渲染侧状态（connector.webhook / CON-101）。
 *
 * 渲染进程只做两件事：**把连接器列表与状态画出来**、**把用户 / Agent 的意图
 * 交给主进程**。真正的出站、凭证保管、是否放行都在主进程——因此这里没有任何
 * 「直接往外发」的能力，也从不持有完整 webhook URL（列表里只有 domain +
 * configured + last4）。
 *
 * 出站被「该 workspace 未授权访问这个域名」挡下时（errorCode === "permission"），
 * 本 store 唤起权限裁决弹窗（复用 permission store），用户授权 `network:<domain>`
 * 后重试即可——与 git store 遇到 process.git 未授权时的做法同构。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { ConnectorResult, ConnectorView } from "@contract";

import { usePermissionStore } from "./permission";

export const useConnectorStore = defineStore("connector", () => {
  const connectors = shallowRef<ConnectorView[]>([]);
  const busy = ref(false);
  const lastError = ref("");
  const lastResult = ref<ConnectorResult | null>(null);

  const hasAny = computed(() => connectors.value.length > 0);

  async function refresh(): Promise<void> {
    busy.value = true;
    try {
      connectors.value = await window.piBuddy.connector.list();
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error)?.message ?? String(err);
    } finally {
      busy.value = false;
    }
  }

  async function run(action: () => Promise<ConnectorView[]>): Promise<boolean> {
    busy.value = true;
    try {
      connectors.value = await action();
      lastError.value = "";
      return true;
    } catch (err) {
      lastError.value = (err as Error)?.message ?? String(err);
      return false;
    } finally {
      busy.value = false;
    }
  }

  const create = (displayName: string, url: string) =>
    run(() => window.piBuddy.connector.create(displayName, url));
  const update = (id: string, patch: { displayName?: string; url?: string }) =>
    run(() => window.piBuddy.connector.update(id, patch));
  const remove = (id: string) => run(() => window.piBuddy.connector.remove(id));
  const setEnabled = (id: string, enabled: boolean) =>
    run(() => window.piBuddy.connector.setEnabled(id, enabled));

  /** 出站结果收口：被权限挡下则唤起裁决弹窗，其余只记结果。 */
  function handleResult(connectorId: string, result: ConnectorResult): ConnectorResult {
    lastResult.value = result;
    if (result.errorCode === "permission") {
      const c = connectors.value.find((x) => x.id === connectorId);
      if (c) {
        usePermissionStore().request({
          capabilityId: "connector.webhook",
          permission: `network:${c.domain}`,
          resource: null,
        });
      }
    }
    return result;
  }

  async function test(connectorId: string, workspaceId: string): Promise<ConnectorResult> {
    busy.value = true;
    try {
      return handleResult(connectorId, await window.piBuddy.connector.test(connectorId, workspaceId));
    } finally {
      busy.value = false;
    }
  }

  async function send(
    connectorId: string,
    workspaceId: string,
    text: string
  ): Promise<ConnectorResult> {
    busy.value = true;
    try {
      return handleResult(
        connectorId,
        await window.piBuddy.connector.send(connectorId, workspaceId, text)
      );
    } finally {
      busy.value = false;
    }
  }

  return {
    connectors,
    busy,
    lastError,
    lastResult,
    hasAny,
    refresh,
    create,
    update,
    remove,
    setEnabled,
    test,
    send,
  };
});
