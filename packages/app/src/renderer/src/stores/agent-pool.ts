/**
 * 后台会话池的渲染侧状态（AGT-101）。
 *
 * ## snapshot + sequence 订阅
 *
 * 主进程每次变更推一份 `PiEnvelope<PoolSnapshot>`。这里用与 app store 同源的
 * 丢弃规则（`shouldAcceptEnvelope`：generation 全局判、sequence 单调判）对齐：
 * 晚到的旧快照被序号闸门丢掉，只保留最新的全量真相。**绝不手写第二份序号
 * 比较**——各写一份的那份迟早漏掉一种情形（envelope.ts 头注释记过）。
 *
 * ## 与 app store 归一化的关系
 *
 * app store 的 `runtimeScope` 已经按 sessionId 归一化了当前（前台）会话的
 * started/streaming/runtimeId/generation。本 store 是**并列**的一层：它承载的是
 * 「所有会话」的进程态 / 列表态 / 未读 / 资源占用 / 统一权限 inbox，供后台会话
 * 列表与监督面渲染。两者不重叠：前台会话的流式渲染仍走 app store 那条零回归
 * 的老路，本 store 只读不写会话内容。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import {
  parseEnvelope,
  shouldAcceptEnvelope,
  type PoolCaps,
  type PoolInboxItem,
  type PoolSessionView,
  type PoolSnapshot,
  type SequencedFrame,
} from "@contract";

export const useAgentPoolStore = defineStore("agentPool", () => {
  const sessions = shallowRef<PoolSessionView[]>([]);
  const inbox = shallowRef<PoolInboxItem[]>([]);
  const caps = ref<PoolCaps | null>(null);
  const activeCount = ref(0);
  const queuedCount = ref(0);
  const totalMemoryMb = ref(0);
  const totalCostUsd = ref(0);
  /** describe() 是否已回来过一次。 */
  const loaded = ref(false);
  /** 被序号闸门丢弃的旧快照计数（诊断用，UI 不展示）。 */
  const droppedSnapshots = ref(0);

  /** 快照序号闸门的上一帧。池信封 generation 固定，实际只做 sequence 单调判。 */
  let lastFrame: SequencedFrame | null = null;

  /** 有未读进展的后台会话。 */
  const unreadSessions = computed(() => sessions.value.filter((s) => s.unread));
  /** 卡在待裁决权限上的会话数（驱动统一 inbox 的角标）。 */
  const waitingPermissionCount = computed(
    () => sessions.value.filter((s) => s.listState === "waiting_permission").length
  );

  function applySnapshot(snapshot: PoolSnapshot): void {
    sessions.value = snapshot.sessions;
    inbox.value = snapshot.inbox;
    caps.value = snapshot.caps;
    activeCount.value = snapshot.activeCount;
    queuedCount.value = snapshot.queuedCount;
    totalMemoryMb.value = snapshot.totalMemoryMb;
    totalCostUsd.value = snapshot.totalCostUsd;
    loaded.value = true;
  }

  /** 处理一条推送信封：过序号闸门，晚到的旧快照丢弃。 */
  function acceptEnvelope(raw: unknown): void {
    const parsed = parseEnvelope<PoolSnapshot>(raw);
    if (!parsed.ok) {
      droppedSnapshots.value++;
      return;
    }
    const env = parsed.envelope;
    const frame: SequencedFrame = { generation: env.generation, sequence: env.sequence };
    if (!shouldAcceptEnvelope(lastFrame, frame)) {
      droppedSnapshots.value++;
      return;
    }
    lastFrame = frame;
    applySnapshot(env.payload);
  }

  let subscribed = false;
  let unsubscribe: (() => void) | null = null;

  async function init(): Promise<void> {
    if (!subscribed) {
      subscribed = true;
      unsubscribe = window.piBuddy.agentPool.onSnapshot((e) => acceptEnvelope(e));
    }
    // 首帧直接 describe 一次：推送只在后续变更时来，进来得先有个当前真相。
    applySnapshot(await window.piBuddy.agentPool.describe());
  }

  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
    subscribed = false;
    lastFrame = null;
  }

  async function focus(sessionId: string | null): Promise<void> {
    applySnapshot(await window.piBuddy.agentPool.focus(sessionId));
  }

  async function stop(sessionId: string): Promise<void> {
    applySnapshot(await window.piBuddy.agentPool.stop(sessionId));
  }

  async function setCaps(next: PoolCaps): Promise<void> {
    applySnapshot(await window.piBuddy.agentPool.setCaps(next));
  }

  async function decideInbox(
    item: { capabilityId: string; permission: string; resource: string | null; workspaceId: string | null },
    allow: boolean
  ): Promise<void> {
    await window.piBuddy.permission.decide({
      capabilityId: item.capabilityId,
      permission: item.permission,
      resource: item.resource,
      disposition: allow ? "allow-once" : "deny",
      workspaceId: item.workspaceId,
    });
    applySnapshot(await window.piBuddy.agentPool.describe());
  }

  return {
    sessions,
    inbox,
    caps,
    activeCount,
    queuedCount,
    totalMemoryMb,
    totalCostUsd,
    loaded,
    droppedSnapshots,
    unreadSessions,
    waitingPermissionCount,
    // 仅供单测直接投喂信封 / 快照。
    acceptEnvelope,
    applySnapshot,
    init,
    dispose,
    focus,
    stop,
    setCaps,
    decideInbox,
  };
});
