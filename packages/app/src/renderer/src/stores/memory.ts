/**
 * 长期记忆的渲染侧状态（MEM-101 第一版）。
 *
 * 这里没有任何绝对路径，也没有「注入文本」这类字段：渲染进程能做的只是
 * 保存 / 检索 / 编辑 / 合并 / 排除 / 删除 / 导出，以及看证据、看命中、开关注入。
 * 注入本身完全发生在主进程的 pi:prompt 钩子里，渲染进程既触发不了也旁路不了。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { MemoryHit, MemoryRecord, MemoryScope, MemoryType } from "@contract";

export const useMemoryStore = defineStore("memory", () => {
  const items = shallowRef<MemoryRecord[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const panelOpen = ref(false);
  const lastError = ref("");

  const query = ref("");
  const scopeFilter = ref<MemoryScope | "">("");
  const includeExcluded = ref(false);

  const injectionEnabled = ref(true);
  const globalInjectionEnabled = ref(true);

  const hits = shallowRef<MemoryHit[]>([]);
  /** 合并用的多选集合。 */
  const selected = ref<Set<string>>(new Set());
  /** 当前展开证据的记忆 id → 证据文本。 */
  const evidence = ref<{ id: string; found: boolean; sessionName: string | null; text: string } | null>(
    null
  );

  const selectedCount = computed(() => selected.value.size);

  async function refresh(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    loading.value = true;
    try {
      const result = await window.piBuddy.memory.query({
        workspaceId,
        query: query.value || undefined,
        scope: scopeFilter.value || undefined,
        includeExcluded: includeExcluded.value,
      });
      items.value = result.items;
      total.value = result.total;
      injectionEnabled.value = result.injectionEnabled;
      globalInjectionEnabled.value = result.globalInjectionEnabled;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** 单条动作公共外壳：失败留下原因，成功后刷新。 */
  async function mutate(
    workspaceId: string,
    action: () => Promise<{ ok: boolean; message?: string }>
  ): Promise<boolean> {
    try {
      const result = await action();
      if (!result.ok) {
        lastError.value = result.message ?? "操作没有成功";
        return false;
      }
      await refresh(workspaceId);
      return true;
    } catch (err) {
      lastError.value = (err as Error).message;
      return false;
    }
  }

  function save(
    workspaceId: string,
    input: {
      content: string;
      type: MemoryType;
      scope: MemoryScope;
      sourceSessionId?: string;
      sourceTurnId?: string;
    }
  ): Promise<boolean> {
    return mutate(workspaceId, () => window.piBuddy.memory.save({ workspaceId, ...input }));
  }

  function update(
    workspaceId: string,
    req: {
      id: string;
      content?: string;
      type?: MemoryType;
      scope?: MemoryScope;
      excluded?: boolean;
      expiry?: number | null;
    }
  ): Promise<boolean> {
    return mutate(workspaceId, () => window.piBuddy.memory.update(req));
  }

  function remove(workspaceId: string, id: string): Promise<boolean> {
    selected.value.delete(id);
    return mutate(workspaceId, () => window.piBuddy.memory.delete(id));
  }

  async function mergeSelected(workspaceId: string, content: string): Promise<boolean> {
    const ids = [...selected.value];
    if (ids.length < 2) {
      lastError.value = "至少选两条才能合并";
      return false;
    }
    const ok = await mutate(workspaceId, () => window.piBuddy.memory.merge(workspaceId, ids, content));
    if (ok) selected.value = new Set();
    return ok;
  }

  function toggleSelect(id: string): void {
    const next = new Set(selected.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected.value = next;
  }

  async function loadHits(workspaceId: string): Promise<void> {
    try {
      hits.value = (await window.piBuddy.memory.hits(workspaceId)).hits;
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  async function loadEvidence(id: string): Promise<void> {
    if (evidence.value?.id === id) {
      evidence.value = null;
      return;
    }
    try {
      const result = await window.piBuddy.memory.evidence(id);
      evidence.value = { id, ...result };
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  async function exportAll(workspaceId: string): Promise<string> {
    try {
      const result = await window.piBuddy.memory.export(workspaceId);
      return result.content;
    } catch (err) {
      lastError.value = (err as Error).message;
      return "";
    }
  }

  async function setInjection(
    workspaceId: string,
    target: "workspace" | "global",
    enabled: boolean
  ): Promise<void> {
    try {
      const state = await window.piBuddy.memory.setInjection(workspaceId, target, enabled);
      injectionEnabled.value = state.injectionEnabled;
      globalInjectionEnabled.value = state.globalInjectionEnabled;
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  return {
    items,
    total,
    loading,
    panelOpen,
    lastError,
    query,
    scopeFilter,
    includeExcluded,
    injectionEnabled,
    globalInjectionEnabled,
    hits,
    selected,
    selectedCount,
    evidence,
    refresh,
    save,
    update,
    remove,
    mergeSelected,
    toggleSelect,
    loadHits,
    loadEvidence,
    exportAll,
    setInjection,
  };
});
