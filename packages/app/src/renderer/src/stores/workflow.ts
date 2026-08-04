/**
 * 可视化工作流的渲染侧状态（common.workflow）。
 *
 * ## 渲染进程只做两件事
 *
 * 把工作流画出来、把用户的编排意图交给主进程。真正跑 DAG、触发 Agent 节点的
 * pi run 都在主进程——因此这里没有任何「直接执行」的能力，只有 IPC。
 *
 * ## 运行快照 + sequence 订阅
 *
 * 主进程每次运行状态变更推一份 `PiEnvelope<WorkflowRunSnapshot>`。这里用与
 * app store / agent-pool store 同源的丢弃规则（`shouldAcceptEnvelope`）对齐：
 * 晚到的旧快照被序号闸门丢掉。推送是全量的（含所有工作区的运行），本 store
 * 只保留**当前工作区**的运行。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import {
  shouldAcceptEnvelope,
  type PiEnvelope,
  type SequencedFrame,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunSnapshot,
} from "@contract";

export const useWorkflowStore = defineStore("workflow", () => {
  const workspaceId = ref<string | null>(null);
  const definitions = shallowRef<WorkflowDefinition[]>([]);
  const runs = shallowRef<WorkflowRun[]>([]);
  const selectedId = ref<string | null>(null);
  const lastError = ref("");
  const droppedSnapshots = ref(0);

  let lastFrame: SequencedFrame | null = null;

  const selected = computed(
    () => definitions.value.find((d) => d.id === selectedId.value) ?? null
  );

  /** definitionId → 该定义最近一次运行（驱动画布上的运行态着色）。 */
  const latestRunByDefinition = computed(() => {
    const map = new Map<string, WorkflowRun>();
    for (const run of runs.value) {
      const prev = map.get(run.definitionId);
      if (!prev || run.startedAt > prev.startedAt) map.set(run.definitionId, run);
    }
    return map;
  });

  const selectedRun = computed(() =>
    selectedId.value ? (latestRunByDefinition.value.get(selectedId.value) ?? null) : null
  );

  function acceptEnvelope(raw: PiEnvelope<WorkflowRunSnapshot>): void {
    const frame: SequencedFrame = { generation: raw.generation, sequence: raw.sequence };
    if (!shouldAcceptEnvelope(lastFrame, frame)) {
      droppedSnapshots.value++;
      return;
    }
    lastFrame = frame;
    applyRuns(raw.payload.runs);
  }

  /** 只留当前工作区的运行。 */
  function applyRuns(all: WorkflowRun[]): void {
    const ws = workspaceId.value;
    runs.value = ws ? all.filter((r) => r.workspaceId === ws) : [];
  }

  let subscribed = false;
  let unsubscribe: (() => void) | null = null;

  async function init(ws: string): Promise<void> {
    workspaceId.value = ws;
    if (!subscribed) {
      subscribed = true;
      unsubscribe = window.piBuddy.workflow.onSnapshot((e) => acceptEnvelope(e));
    }
    await reload();
  }

  async function reload(): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      const [list, snap] = await Promise.all([
        window.piBuddy.workflow.list(ws),
        window.piBuddy.workflow.runs(ws),
      ]);
      definitions.value = list.definitions;
      applyRuns(snap.runs);
      if (selectedId.value && !definitions.value.some((d) => d.id === selectedId.value)) {
        selectedId.value = definitions.value[0]?.id ?? null;
      }
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
    subscribed = false;
    lastFrame = null;
  }

  function select(id: string | null): void {
    selectedId.value = id;
  }

  async function save(definition: WorkflowDefinition): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      const res = await window.piBuddy.workflow.save(ws, definition);
      definitions.value = res.definitions;
      selectedId.value = definition.id;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  async function remove(id: string): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      const res = await window.piBuddy.workflow.remove(ws, id);
      definitions.value = res.definitions;
      if (selectedId.value === id) selectedId.value = definitions.value[0]?.id ?? null;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  async function run(id: string): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      const snap = await window.piBuddy.workflow.run(ws, id);
      applyRuns(snap.runs);
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  async function stop(runId: string): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      const snap = await window.piBuddy.workflow.stop(ws, runId);
      applyRuns(snap.runs);
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  async function exportJson(id: string): Promise<string> {
    const ws = workspaceId.value;
    if (!ws) return "";
    try {
      const res = await window.piBuddy.workflow.exportJson(ws, id);
      lastError.value = "";
      return res.json;
    } catch (err) {
      lastError.value = (err as Error).message;
      return "";
    }
  }

  async function importJson(json: string): Promise<void> {
    const ws = workspaceId.value;
    if (!ws) return;
    try {
      const res = await window.piBuddy.workflow.importJson(ws, json);
      definitions.value = res.definitions;
      selectedId.value = res.definition.id;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  return {
    workspaceId,
    definitions,
    runs,
    selectedId,
    selected,
    selectedRun,
    latestRunByDefinition,
    lastError,
    droppedSnapshots,
    acceptEnvelope,
    init,
    reload,
    dispose,
    select,
    save,
    remove,
    run,
    stop,
    exportJson,
    importJson,
  };
});
