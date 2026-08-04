/**
 * 终端能力包的渲染侧状态（coding.terminal / PTY-101）。
 *
 * ## 渲染进程只做两件事
 *
 * 管标签页的元数据（列表 / 活跃 / 退出态）、把用户的意图（开 / 输入 / 缩放 /
 * 清 / 杀 / 重启 / 重命名）交给主进程。真正 spawn shell、跑进程都在主进程
 * （node-pty）——因此这里没有任何「直接执行」的能力，只有 IPC。
 *
 * ## 权限：开终端就是开 shell
 *
 * `terminal:*` 全部要 process.shell 授权，未授权时主进程第五道闸抛
 * `IPC_PERMISSION_DENIED`。这里把它翻译成 `permissionDenied` 状态，界面据此
 * 弹「授权终端」。授权走 `permission.decide(allow-session)`（与 git 同一套决策
 * 通道），成功后重试。
 *
 * ## 输出不经本 store
 *
 * PTY 输出是高频字节流，直接由 TerminalPanel 组件订阅 `terminal.onEvent` 写进
 * 对应的 xterm（复用 `shouldAcceptEnvelope` 的代际 + 序号丢弃规则）。本 store
 * 只订阅 `exit` 事件更新标签页的运行态 / 退出码——把高频 data 灌进 Pinia 会
 * 触发无谓的响应式更新。
 */
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { PiEnvelope, TerminalEventPayload, TerminalProfile, TerminalTabMeta } from "@contract";

const CAPABILITY_ID = "coding.terminal";
const PERMISSION = "process.shell";

export const useTerminalStore = defineStore("terminal", () => {
  const workspaceId = ref<string | null>(null);
  const tabs = shallowRef<TerminalTabMeta[]>([]);
  const activeTabId = ref<string | null>(null);
  const profiles = shallowRef<TerminalProfile[]>([]);
  const defaultProfileId = ref("");
  const lastError = ref("");
  /** 上一次操作被第五道闸挡下（未授权 process.shell）。 */
  const permissionDenied = ref(false);

  function handle(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("IPC_PERMISSION_DENIED")) permissionDenied.value = true;
    lastError.value = msg;
  }

  function upsert(meta: TerminalTabMeta): void {
    const idx = tabs.value.findIndex((t) => t.tabId === meta.tabId);
    if (idx >= 0) {
      const next = [...tabs.value];
      next[idx] = meta;
      tabs.value = next;
    } else {
      tabs.value = [...tabs.value, meta];
    }
  }

  let subscribed = false;
  let unsubscribe: (() => void) | null = null;

  /** 只更新退出态：把高频 data 交给组件的 xterm，不进 store。 */
  function onExitEvent(e: PiEnvelope<TerminalEventPayload>): void {
    if (e.payload.kind !== "exit") return;
    const idx = tabs.value.findIndex((t) => t.tabId === e.payload.tabId);
    if (idx < 0) return;
    // 只认当前代际的退出（上一代 PTY 的迟到退出忽略）。
    if (tabs.value[idx].generation !== e.generation) return;
    const next = [...tabs.value];
    next[idx] = {
      ...next[idx],
      running: false,
      exitCode: e.payload.kind === "exit" ? e.payload.exitCode : null,
      exitSignal: e.payload.kind === "exit" ? e.payload.exitSignal : null,
    };
    tabs.value = next;
  }

  async function init(ws: string): Promise<void> {
    workspaceId.value = ws;
    if (!subscribed) {
      subscribed = true;
      unsubscribe = window.piBuddy.terminal.onEvent((e) => onExitEvent(e));
    }
    await refreshProfiles();
    await refresh();
  }

  async function refreshProfiles(): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      const r = await window.piBuddy.terminal.profiles(ws);
      profiles.value = r.profiles;
      defaultProfileId.value = r.defaultId;
      permissionDenied.value = false;
    } catch (err) {
      handle(err);
    }
  }

  async function refresh(): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      const r = await window.piBuddy.terminal.list(ws);
      tabs.value = r.tabs;
      if (!activeTabId.value && r.tabs.length > 0) activeTabId.value = r.tabs[0].tabId;
      if (activeTabId.value && !r.tabs.some((t) => t.tabId === activeTabId.value)) {
        activeTabId.value = r.tabs[0]?.tabId ?? null;
      }
      permissionDenied.value = false;
    } catch (err) {
      handle(err);
    }
  }

  /** 申请 process.shell（allow-session），成功后清掉未授权态。 */
  async function requestPermission(): Promise<boolean> {
    const ws = workspaceId.value;
    try {
      await window.piBuddy.permission.decide({
        capabilityId: CAPABILITY_ID,
        permission: PERMISSION,
        disposition: "allow-session",
        workspaceId: ws,
      });
      permissionDenied.value = false;
      return true;
    } catch (err) {
      handle(err);
      return false;
    }
  }

  async function open(profileId: string | null = null): Promise<TerminalTabMeta | null> {
    const ws = workspaceId.value;
    if (!ws) return null;
    try {
      const meta = await window.piBuddy.terminal.open(ws, profileId);
      upsert(meta);
      activeTabId.value = meta.tabId;
      permissionDenied.value = false;
      return meta;
    } catch (err) {
      handle(err);
      return null;
    }
  }

  async function kill(tabId: string): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      await window.piBuddy.terminal.kill(ws, tabId);
      tabs.value = tabs.value.filter((t) => t.tabId !== tabId);
      if (activeTabId.value === tabId) activeTabId.value = tabs.value[0]?.tabId ?? null;
    } catch (err) {
      handle(err);
    }
  }

  async function restart(tabId: string): Promise<TerminalTabMeta | null> {
    const ws = workspaceId.value;
    if (!ws) return null;
    try {
      const meta = await window.piBuddy.terminal.restart(ws, tabId);
      upsert(meta);
      return meta;
    } catch (err) {
      handle(err);
      return null;
    }
  }

  async function rename(tabId: string, title: string): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      const meta = await window.piBuddy.terminal.rename(ws, tabId, title);
      upsert(meta);
    } catch (err) {
      handle(err);
    }
  }

  function setActive(tabId: string): void {
    activeTabId.value = tabId;
  }

  function dispose(): void {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    subscribed = false;
  }

  return {
    workspaceId,
    tabs,
    activeTabId,
    profiles,
    defaultProfileId,
    lastError,
    permissionDenied,
    init,
    refresh,
    refreshProfiles,
    requestPermission,
    open,
    kill,
    restart,
    rename,
    setActive,
    dispose,
  };
});
