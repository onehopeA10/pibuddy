/**
 * Pi 资源中心与 project trust 的渲染侧状态（EXT-102）。
 *
 * 这个 store 只做三件事：持有主进程给的**权威快照**、把用户动作转成一次
 * IPC、把结果换成新快照。它自己**不推断**列表变成了什么样 —— 每一个动作
 * 通道都返回完整的 scan 结果，正是为了消灭「开关拨了但列表没变」这类
 * 只能靠肉眼发现的不一致。
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { PiResource, PiResourceScanResult, ProjectTrustState } from "@contract";

export const usePiResourcesStore = defineStore("piResources", () => {
  const loading = ref(false);
  const scan = ref<PiResourceScanResult | null>(null);
  const lastError = ref("");
  const panelOpen = ref(false);
  /** trust 对话框是否显示。needsPrompt 为真时由 AppShell 打开 */
  const trustOpen = ref(false);
  const busySpec = ref("");
  /**
   * trust 态**独立持有**，不挂在 scan 结果下。
   *
   * 真机上抓到的回归：启动时先问 trust（此时还没扫过资源，scan 为 null），
   * 若把 trust 只写进 `scan.value.trust`，那次写入会被 `if (scan.value)`
   * 整个跳过 —— 对话框照常弹出（needsPrompt 是从返回值直接读的），但里面
   * 那份「将要加载的 project resources」永远是空的，用户看到的是
   * 「（没有检测到需要信任的项目资源）那你问我干嘛）」。
   * typecheck / 单测 / 构建三样全绿，只有真机能发现。
   */
  const trustState = ref<ProjectTrustState | null>(null);

  const resources = computed<PiResource[]>(() => scan.value?.resources ?? []);
  const trust = computed<ProjectTrustState | null>(() => trustState.value ?? scan.value?.trust ?? null);
  const scanErrors = computed(() => scan.value?.errors ?? []);
  const mcpNote = computed(() => scan.value?.mcp.note ?? "");

  /** 按 kind 分组，界面按「技能 / 扩展 / 包 / 提示词 / 主题」分区展示。 */
  const byKind = computed(() => {
    const map = new Map<PiResource["kind"], PiResource[]>();
    for (const r of resources.value) {
      const list = map.get(r.kind) ?? [];
      list.push(r);
      map.set(r.kind, list);
    }
    return map;
  });

  async function refresh(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    loading.value = true;
    lastError.value = "";
    try {
      scan.value = await window.piBuddy.piResources.scan(workspaceId);
      trustState.value = scan.value.trust;
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function setEnabled(
    workspaceId: string,
    id: string,
    enabled: boolean
  ): Promise<void> {
    try {
      scan.value = await window.piBuddy.piResources.setEnabled(workspaceId, id, enabled);
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  /**
   * 安装 / 卸载。
   *
   * 入参是包规格字符串，不是命令行；真正的子进程执行只发生在主进程，
   * 子命令白名单与 shell 元字符校验都在那边。这里连拼命令的机会都没有。
   */
  async function install(
    workspaceId: string,
    spec: string,
    scope: "user" | "project"
  ): Promise<{ ok: boolean; output: string; reason?: string }> {
    busySpec.value = spec;
    try {
      const result = await window.piBuddy.piResources.install(workspaceId, spec, scope);
      if (result.ok) await refresh(workspaceId);
      else lastError.value = result.output || result.reason || "安装失败";
      return result;
    } catch (err) {
      lastError.value = (err as Error).message;
      return { ok: false, output: lastError.value, reason: "ipc-failed" };
    } finally {
      busySpec.value = "";
    }
  }

  async function remove(
    workspaceId: string,
    spec: string,
    scope: "user" | "project"
  ): Promise<{ ok: boolean; output: string; reason?: string }> {
    busySpec.value = spec;
    try {
      const result = await window.piBuddy.piResources.remove(workspaceId, spec, scope);
      if (result.ok) await refresh(workspaceId);
      else lastError.value = result.output || result.reason || "卸载失败";
      return result;
    } catch (err) {
      lastError.value = (err as Error).message;
      return { ok: false, output: lastError.value, reason: "ipc-failed" };
    } finally {
      busySpec.value = "";
    }
  }

  async function openDir(workspaceId: string, id: string): Promise<void> {
    try {
      await window.piBuddy.piResources.openDir(workspaceId, id);
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  /** 启动时问一次：这个项目里有需要信任才会加载的资源吗？ */
  async function describeTrust(workspaceId: string): Promise<ProjectTrustState | null> {
    if (!workspaceId) return null;
    try {
      const state = await window.piBuddy.piResources.trust.describe(workspaceId);
      trustState.value = state;
      if (scan.value) scan.value = { ...scan.value, trust: state };
      trustOpen.value = state.needsPrompt;
      return state;
    } catch (err) {
      lastError.value = (err as Error).message;
      return null;
    }
  }

  async function decideTrust(
    workspaceId: string,
    decision: "allow" | "deny",
    remember: boolean
  ): Promise<ProjectTrustState | null> {
    try {
      const state = await window.piBuddy.piResources.trust.decide(
        workspaceId,
        decision,
        remember
      );
      trustState.value = state;
      if (scan.value) scan.value = { ...scan.value, trust: state };
      trustOpen.value = false;
      return state;
    } catch (err) {
      lastError.value = (err as Error).message;
      trustOpen.value = false;
      return null;
    }
  }

  return {
    loading,
    scan,
    trustState,
    lastError,
    panelOpen,
    trustOpen,
    busySpec,
    resources,
    trust,
    scanErrors,
    mcpNote,
    byKind,
    refresh,
    setEnabled,
    install,
    remove,
    openDir,
    describeTrust,
    decideTrust,
  };
});
