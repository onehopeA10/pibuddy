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

  /**
   * trust 请求的代际。**过期响应必须被丢弃，不能覆盖全局状态。**
   *
   * 真实时序：用户从项目 A 切到项目 B，AppShell 的 watch 因此发了两次
   * describeTrust。A 的目录在网络盘上，它的响应比 B 晚回来 —— 后到的 A
   * 覆盖了 trustState，对话框里列的是 A 的资源，而 store.workspaceId 已经
   * 是 B。用户点「信任」，决定就写给了 B：**A 的资源提示，把信任决定写给
   * 了 B 项目**。trust.json 是与终端 pi 共享的文件，这条错误的记录会一直
   * 留在那儿。
   *
   * 口径与 main/pi-supervisor.ts 的 runtime generation 相同：发起时取一个
   * 代际，回来时比一次，不是当前代际就整个丢掉。单靠比对 workspaceId 不
   * 够 —— 两次请求可能都合法，只是顺序反了。
   */
  let trustSeq = 0;
  /** scan 同理：晚到的 A 的扫描结果会把 B 的列表和 trust 一起冲掉。 */
  let scanSeq = 0;

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
    const seq = ++scanSeq;
    loading.value = true;
    lastError.value = "";
    try {
      const result = await window.piBuddy.piResources.scan(workspaceId);
      if (seq !== scanSeq) return; // 期间又切了工作目录：这份结果已经过期
      scan.value = result;
      trustState.value = result.trust;
    } catch (err) {
      if (seq === scanSeq) lastError.value = (err as Error).message;
    } finally {
      if (seq === scanSeq) loading.value = false;
    }
  }

  async function setEnabled(
    workspaceId: string,
    id: string,
    enabled: boolean
  ): Promise<void> {
    const seq = ++scanSeq;
    try {
      const result = await window.piBuddy.piResources.setEnabled(workspaceId, id, enabled);
      if (seq !== scanSeq) return; // 期间又切了工作目录
      scan.value = result;
    } catch (err) {
      if (seq === scanSeq) lastError.value = (err as Error).message;
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

  /**
   * 把一份 trust 态落进 store。
   *
   * `scan` 只在它本来就属于同一个 workspace 时才被就地更新 —— 否则会把
   * B 项目的扫描结果配上 A 项目的 trust，界面上两半来自不同项目。
   */
  function applyTrust(workspaceId: string, state: ProjectTrustState): void {
    trustState.value = state;
    if (scan.value && scan.value.trust.workspaceId === workspaceId) {
      scan.value = { ...scan.value, trust: state };
    }
  }

  /** 启动时问一次：这个项目里有需要信任才会加载的资源吗？ */
  async function describeTrust(workspaceId: string): Promise<ProjectTrustState | null> {
    if (!workspaceId) return null;
    const seq = ++trustSeq;
    try {
      const state = await window.piBuddy.piResources.trust.describe(workspaceId);
      // 过期响应：期间又发过一次 describe / decide（多半是切了工作目录）。
      // 丢掉它 —— 覆盖下去的话，弹窗里列的是这个项目的资源，而提交时用的
      // 是当前项目，用户会把决定做给另一个项目。
      if (seq !== trustSeq) return null;
      // 主进程回的 state 自带 workspaceId（trust-store.describeTrust 原样回填）。
      // 对不上说明这份响应根本不是这次请求的，同样丢掉。
      if (state.workspaceId !== workspaceId) return null;
      applyTrust(workspaceId, state);
      trustOpen.value = state.needsPrompt;
      return state;
    } catch (err) {
      if (seq === trustSeq) lastError.value = (err as Error).message;
      return null;
    }
  }

  async function decideTrust(
    workspaceId: string,
    decision: "allow" | "deny",
    remember: boolean
  ): Promise<ProjectTrustState | null> {
    // 提交前再校验一次：对话框上显示的是哪个项目的资源，就只能给哪个项目
    // 做决定。remember 会写进 pi 的 trust.json（与终端共享的文件），写错
    // 目录之后没有任何地方会提示，用户下次在终端里跑 pi 才会撞上。
    const shown = trustState.value;
    if (!workspaceId || !shown || shown.workspaceId !== workspaceId) {
      trustOpen.value = false;
      lastError.value = "工作目录已经切换，这次信任决定没有提交。请在需要确认的项目里重新选择。";
      return null;
    }
    const seq = ++trustSeq;
    try {
      const state = await window.piBuddy.piResources.trust.decide(
        workspaceId,
        decision,
        remember
      );
      if (seq !== trustSeq) return null;
      if (state.workspaceId !== workspaceId) return null;
      applyTrust(workspaceId, state);
      trustOpen.value = false;
      return state;
    } catch (err) {
      if (seq !== trustSeq) return null;
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
