/**
 * 子 Agent 编排的渲染侧状态（AGT-102）。
 *
 * ## snapshot + sequence 订阅
 *
 * 主进程每次变更推一份 `PiEnvelope<ChildTopologySnapshot>`。这里用与 app store /
 * agent-pool store 同源的丢弃规则（`shouldAcceptEnvelope`：generation 全局判、
 * sequence 单调判）对齐：晚到的旧快照被序号闸门丢掉，只保留最新的全量真相。
 * **绝不手写第二份序号比较**。
 *
 * ## 与 agent-pool store 的关系
 *
 * agent-pool store 承载「所有会话」的进程态 / 资源；本 store 承载「父子编排」的
 * 拓扑 / 目标 / 证据 / 结果。两者并列、按 sessionId(=nodeId) 关联，互不重叠。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import {
  parseEnvelope,
  shouldAcceptEnvelope,
  type ChildNodeView,
  type ChildSpec,
  type ChildTopologySnapshot,
  type SequencedFrame,
} from "@contract";

export const useChildAgentStore = defineStore("childAgent", () => {
  const nodes = shallowRef<ChildNodeView[]>([]);
  const providerInFlight = ref<Record<string, number>>({});
  const providerConcurrencyCap = ref(0);
  const loaded = ref(false);
  const droppedSnapshots = ref(0);

  let lastFrame: SequencedFrame | null = null;

  /** 顶层子（用户直接创建的）。 */
  const roots = computed(() => nodes.value.filter((n) => n.parentId === null));
  /** nodeId → 直接子节点列表（渲染父子拓扑用）。 */
  const childrenOf = computed(() => {
    const map = new Map<string, ChildNodeView[]>();
    for (const n of nodes.value) {
      if (n.parentId === null) continue;
      const arr = map.get(n.parentId) ?? [];
      arr.push(n);
      map.set(n.parentId, arr);
    }
    return map;
  });
  /** 有待父回答提问的节点数（驱动角标）。 */
  const waitingAnswerCount = computed(
    () => nodes.value.filter((n) => n.status === "waiting_answer").length
  );
  /** 有待裁决合并的节点。 */
  const pendingMerges = computed(() => nodes.value.filter((n) => n.pendingMerge !== null));

  function applySnapshot(snapshot: ChildTopologySnapshot): void {
    nodes.value = snapshot.nodes;
    providerInFlight.value = snapshot.providerInFlight;
    providerConcurrencyCap.value = snapshot.providerConcurrencyCap;
    loaded.value = true;
  }

  function acceptEnvelope(raw: unknown): void {
    const parsed = parseEnvelope<ChildTopologySnapshot>(raw);
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
      unsubscribe = window.piBuddy.childAgent.onSnapshot((e) => acceptEnvelope(e));
    }
    applySnapshot(await window.piBuddy.childAgent.describe());
  }

  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
    subscribed = false;
    lastFrame = null;
  }

  async function create(parentId: string | null, spec: ChildSpec): Promise<void> {
    applySnapshot(await window.piBuddy.childAgent.create(parentId, spec));
  }

  async function cancel(nodeId: string): Promise<void> {
    applySnapshot(await window.piBuddy.childAgent.cancel(nodeId));
  }

  async function answer(nodeId: string, questionId: string, text: string): Promise<void> {
    applySnapshot(await window.piBuddy.childAgent.answer(nodeId, questionId, text));
  }

  async function resolveMerge(nodeId: string, accept: boolean): Promise<void> {
    applySnapshot(await window.piBuddy.childAgent.resolveMerge(nodeId, accept));
  }

  return {
    nodes,
    providerInFlight,
    providerConcurrencyCap,
    loaded,
    droppedSnapshots,
    roots,
    childrenOf,
    waitingAnswerCount,
    pendingMerges,
    // 仅供单测直接投喂。
    acceptEnvelope,
    applySnapshot,
    init,
    dispose,
    create,
    cancel,
    answer,
    resolveMerge,
  };
});
