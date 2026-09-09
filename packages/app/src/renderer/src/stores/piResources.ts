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
import {
  PI_RESOURCES_CAPABILITY_ID,
  PI_RESOURCES_PERMISSION,
  piPackagePermissionResource,
  type PiResource,
  type PiResourceScanResult,
  type ProjectTrustState,
} from "@contract";

import { usePermissionStore } from "./permission";

const PERMISSION_DENIED = "IPC_PERMISSION_DENIED";

interface PiResourcesDeniedRequest {
  workspaceId: string;
  capabilityId: string;
  permission: string;
  resource: string;
  command: string;
  action: "install" | "remove";
  scope: "user" | "project";
  spec: string;
}

export const usePiResourcesStore = defineStore("piResources", () => {
  const loading = ref(false);
  const scan = ref<PiResourceScanResult | null>(null);
  const lastError = ref("");
  const panelOpen = ref(false);
  /** trust 对话框是否显示。needsPrompt 为真时由 AppShell 打开 */
  const trustOpen = ref(false);
  const trustDeciding = ref(false);
  const busySpec = ref("");
  const permissionDenied = ref(false);
  const deniedNotice = ref("");
  const deniedRequest = ref<PiResourcesDeniedRequest | null>(null);
  const activeWorkspaceId = ref("");
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
  let refreshSeq = 0;
  let workspaceGeneration = 0;
  let workspaceInitialized = false;

  function setWorkspace(workspaceId: string): void {
    if (workspaceInitialized && activeWorkspaceId.value === workspaceId) return;
    workspaceInitialized = true;
    activeWorkspaceId.value = workspaceId;
    workspaceGeneration += 1;
    trustSeq += 1;
    scanSeq += 1;
    refreshSeq += 1;
    loading.value = false;
    scan.value = null;
    trustState.value = null;
    lastError.value = "";
    trustOpen.value = false;
    trustDeciding.value = false;
    busySpec.value = "";
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

  function workspaceChangedResult(): { ok: false; output: string; reason: string } {
    return {
      ok: false,
      output: "工作目录已经切换，旧操作的返回结果已忽略。",
      reason: "workspace-changed",
    };
  }

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
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return;
    const seq = ++scanSeq;
    const refresh = ++refreshSeq;
    loading.value = true;
    lastError.value = "";
    try {
      const result = await window.piBuddy.piResources.scan(workspaceId);
      if (seq !== scanSeq || !isCurrent(workspaceId, generation)) return;
      scan.value = result;
      trustState.value = result.trust;
    } catch (err) {
      if (seq === scanSeq && isCurrent(workspaceId, generation)) {
        lastError.value = (err as Error).message;
      }
    } finally {
      if (refresh === refreshSeq && isCurrent(workspaceId, generation)) loading.value = false;
    }
  }

  async function setEnabled(
    workspaceId: string,
    id: string,
    enabled: boolean
  ): Promise<void> {
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return;
    const seq = ++scanSeq;
    try {
      const result = await window.piBuddy.piResources.setEnabled(workspaceId, id, enabled);
      if (seq !== scanSeq || !isCurrent(workspaceId, generation)) return;
      scan.value = result;
      trustState.value = result.trust;
    } catch (err) {
      if (seq === scanSeq && isCurrent(workspaceId, generation)) {
        lastError.value = (err as Error).message;
      }
    }
  }

  function clearDenied(): void {
    permissionDenied.value = false;
    deniedNotice.value = "";
    deniedRequest.value = null;
  }

  function permissionRequest(
    action: "install" | "remove",
    workspaceId: string,
    spec: string,
    scope: "user" | "project"
  ): PiResourcesDeniedRequest {
    const localFlag = scope === "project" ? " -l" : "";
    return {
      workspaceId,
      capabilityId: PI_RESOURCES_CAPABILITY_ID,
      permission: PI_RESOURCES_PERMISSION,
      resource: piPackagePermissionResource(action, scope, workspaceId, spec),
      command: `pi ${action} ${spec}${localFlag}`,
      action,
      scope,
      spec,
    };
  }

  function raisePermission(req: PiResourcesDeniedRequest): void {
    permissionDenied.value = true;
    deniedRequest.value = req;
    const verb = req.action === "install" ? "安装" : "卸载";
    const where = req.scope === "project" ? "当前项目" : "用户级环境";
    const opened = usePermissionStore().request(req);
    deniedNotice.value = opened
      ? `${verb}包「${req.spec}」会在本机启动 pi 包管理进程；未授权，因此没有执行。` +
        `请在权限申请中选择一档，授权范围只覆盖这次${verb}、${where}与当前工作区，然后重试。`
      : `这次${verb}申请无法安全展示，已拒绝：${usePermissionStore().lastRejectedPrompt}`;
  }

  function handlePermissionDenied(err: unknown, req: PiResourcesDeniedRequest): boolean {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(PERMISSION_DENIED)) return false;
    raisePermission(req);
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
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return workspaceChangedResult();
    busySpec.value = spec;
    try {
      const result = await window.piBuddy.piResources.install(workspaceId, spec, scope);
      if (!isCurrent(workspaceId, generation)) return workspaceChangedResult();
      if (result.ok) {
        clearDenied();
        await refresh(workspaceId);
        if (!isCurrent(workspaceId, generation)) return workspaceChangedResult();
      } else lastError.value = result.output || result.reason || "安装失败";
      return result;
    } catch (err) {
      if (!isCurrent(workspaceId, generation)) return workspaceChangedResult();
      const req = permissionRequest("install", workspaceId, spec, scope);
      if (handlePermissionDenied(err, req)) {
        return { ok: false, output: deniedNotice.value, reason: "permission-denied" };
      }
      lastError.value = (err as Error).message;
      return { ok: false, output: lastError.value, reason: "ipc-failed" };
    } finally {
      if (isCurrent(workspaceId, generation) && busySpec.value === spec) busySpec.value = "";
    }
  }

  async function remove(
    workspaceId: string,
    spec: string,
    scope: "user" | "project"
  ): Promise<{ ok: boolean; output: string; reason?: string }> {
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return workspaceChangedResult();
    busySpec.value = spec;
    try {
      const result = await window.piBuddy.piResources.remove(workspaceId, spec, scope);
      if (!isCurrent(workspaceId, generation)) return workspaceChangedResult();
      if (result.ok) {
        clearDenied();
        await refresh(workspaceId);
        if (!isCurrent(workspaceId, generation)) return workspaceChangedResult();
      } else lastError.value = result.output || result.reason || "卸载失败";
      return result;
    } catch (err) {
      if (!isCurrent(workspaceId, generation)) return workspaceChangedResult();
      const req = permissionRequest("remove", workspaceId, spec, scope);
      if (handlePermissionDenied(err, req)) {
        return { ok: false, output: deniedNotice.value, reason: "permission-denied" };
      }
      lastError.value = (err as Error).message;
      return { ok: false, output: lastError.value, reason: "ipc-failed" };
    } finally {
      if (isCurrent(workspaceId, generation) && busySpec.value === spec) busySpec.value = "";
    }
  }

  async function openDir(workspaceId: string, id: string): Promise<void> {
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return;
    try {
      await window.piBuddy.piResources.openDir(workspaceId, id);
    } catch (err) {
      if (isCurrent(workspaceId, generation)) lastError.value = (err as Error).message;
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
    const generation = captureWorkspace(workspaceId);
    if (generation === null) return null;
    const seq = ++trustSeq;
    try {
      const state = await window.piBuddy.piResources.trust.describe(workspaceId);
      // 过期响应：期间又发过一次 describe / decide（多半是切了工作目录）。
      // 丢掉它 —— 覆盖下去的话，弹窗里列的是这个项目的资源，而提交时用的
      // 是当前项目，用户会把决定做给另一个项目。
      if (seq !== trustSeq || !isCurrent(workspaceId, generation)) return null;
      // 主进程回的 state 自带 workspaceId（trust-store.describeTrust 原样回填）。
      // 对不上说明这份响应根本不是这次请求的，同样丢掉。
      if (state.workspaceId !== workspaceId) return null;
      applyTrust(workspaceId, state);
      trustOpen.value = state.needsPrompt;
      return state;
    } catch (err) {
      if (seq === trustSeq && isCurrent(workspaceId, generation)) {
        lastError.value = (err as Error).message;
      }
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
    if (trustDeciding.value) return null;
    const generation = captureWorkspace(workspaceId);
    const shown = trustState.value;
    if (generation === null || !shown || shown.workspaceId !== workspaceId) {
      trustOpen.value = false;
      lastError.value = "工作目录已经切换，这次信任决定没有提交。请在需要确认的项目里重新选择。";
      return null;
    }
    const seq = ++trustSeq;
    trustDeciding.value = true;
    try {
      const state = await window.piBuddy.piResources.trust.decide(
        workspaceId,
        decision,
        remember
      );
      if (seq !== trustSeq || !isCurrent(workspaceId, generation)) return null;
      if (state.workspaceId !== workspaceId) return null;
      applyTrust(workspaceId, state);
      trustOpen.value = false;
      return state;
    } catch (err) {
      if (seq !== trustSeq || !isCurrent(workspaceId, generation)) return null;
      lastError.value = (err as Error).message;
      trustOpen.value = false;
      return null;
    } finally {
      if (seq === trustSeq && isCurrent(workspaceId, generation)) trustDeciding.value = false;
    }
  }

  return {
    loading,
    scan,
    trustState,
    lastError,
    panelOpen,
    trustOpen,
    trustDeciding,
    busySpec,
    permissionDenied,
    deniedNotice,
    deniedRequest,
    activeWorkspaceId,
    resources,
    trust,
    scanErrors,
    mcpNote,
    byKind,
    setWorkspace,
    refresh,
    setEnabled,
    install,
    remove,
    authorize,
    openPermissionCenter,
    clearDenied,
    openDir,
    describeTrust,
    decideTrust,
  };
});
