<script setup lang="ts">
/**
 * 可视化工作流画布（common.workflow）。
 *
 * 基于 `@vue-flow/core`（纯 JS，无原生依赖，已过 check-pure-js-deps 闸门）：节点
 * 拖拽、连线成边、增删节点、选中节点编辑配置。画布只管**编辑一张图**并在需要时
 * 把当前图重建成一份 `WorkflowDefinition`（`toDefinition`），运行与落盘都由上层
 * 面板经 store 交给主进程——画布自己没有任何「执行」能力。
 *
 * 运行态着色由 `runStates` 驱动：主进程推来的运行快照里每个节点的状态映射成节点
 * 的 CSS class，画布据此把 running / succeeded / failed / skipped 画成不同颜色。
 *
 * 节点 / 边用**本地浅类型** FlowNode / FlowEdge，而不是 Vue Flow 深度泛型的
 * Node / Edge：后者在对象字面量里展开会让 vue-tsc 触发「类型实例化过深」。
 * 绑定用单向 `:nodes` + `@update:nodes` 而非 v-model，避免 v-model 的不变型校验。
 */
import { ref, watch } from "vue";
import { VueFlow, type Connection } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import { NButton, NInput, NSelect, NSpace } from "naive-ui";
import type {
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowRunNodeStateKind,
} from "@contract";

/** 画布内部的浅节点 / 浅边（避免 Vue Flow 深泛型拖垮 vue-tsc）。 */
interface FlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  label?: string;
  data?: Record<string, unknown>;
  class?: string;
}
interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  label?: string;
  animated?: boolean;
}

/**
 * Vue Flow 回推的 GraphNode / GraphEdge 的**读取面**（宽松版）。
 *
 * GraphNode.label 可能是 VNode / Component，sourceHandle 可能是 null——用宽松
 * 类型接住再收成 FlowNode / FlowEdge，避免把 Vue Flow 的深泛型引进本组件。
 */
interface IncomingNode {
  id: string;
  position: { x: number; y: number };
  type?: string;
  label?: unknown;
  data?: Record<string, unknown>;
  class?: unknown;
}
interface IncomingEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  label?: unknown;
  animated?: boolean;
}

const props = defineProps<{
  definition: WorkflowDefinition;
  /** nodeId → 运行态（着色用）。 */
  runStates?: Record<string, WorkflowRunNodeStateKind>;
}>();

/** 节点种类 → Vue Flow 内建节点类型（起点入型 / 终点出型 / 其余默认型）。 */
function flowType(kind: WorkflowNodeKind): string {
  if (kind === "start" || kind === "input") return "input";
  if (kind === "end" || kind === "output") return "output";
  return "default";
}

const KIND_LABEL: Record<WorkflowNodeKind, string> = {
  start: "开始",
  end: "结束",
  input: "输入",
  output: "输出",
  agent: "Agent",
  condition: "条件",
};

function runClass(nodeId: string): string {
  return props.runStates?.[nodeId] ?? "idle";
}

function toFlowNode(n: WorkflowNode): FlowNode {
  const label = n.title || KIND_LABEL[n.kind];
  const data: Record<string, unknown> = { kind: n.kind, title: n.title };
  if (n.kind === "input") data.value = n.value;
  if (n.kind === "agent") data.prompt = n.prompt;
  if (n.kind === "condition") data.condition = n.condition;
  return {
    id: n.id,
    type: flowType(n.kind),
    position: { ...n.position },
    label: `${KIND_LABEL[n.kind]}｜${label}`,
    data,
    class: `wf-node wf-${runClass(n.id)}`,
  };
}

function toFlowEdge(e: WorkflowEdge): FlowEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    label: e.sourceHandle ?? undefined,
    animated: true,
  };
}

const nodes = ref<FlowNode[]>([]);
const edges = ref<FlowEdge[]>([]);
const selectedId = ref<string | null>(null);

/** 从定义重建画布（切换定义时 / 外部刷新时）。 */
function loadFrom(def: WorkflowDefinition): void {
  nodes.value = def.nodes.map(toFlowNode);
  edges.value = def.edges.map(toFlowEdge);
  selectedId.value = null;
}

watch(() => props.definition.id, () => loadFrom(props.definition), { immediate: true });

// 运行态变化 → 更新节点 class（着色）。不动位置 / 数据。
watch(
  () => props.runStates,
  () => {
    nodes.value = nodes.value.map((n) => ({ ...n, class: `wf-node wf-${runClass(n.id)}` }));
  },
  { deep: true }
);

// -------- 连线 --------
function onConnect(connection: Connection): void {
  const id = `e-${connection.source}-${connection.target}-${Date.now().toString(36)}`;
  edges.value = [
    ...edges.value,
    {
      id,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle ?? undefined,
      animated: true,
    },
  ];
}

function onNodeClick(payload: { node: { id: string } }): void {
  selectedId.value = payload.node.id;
}

/** Vue Flow 回推节点变更（主要是拖拽后的位置）→ 收成浅 FlowNode。 */
function onNodesUpdate(v: IncomingNode[]): void {
  nodes.value = v.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.position.x, y: n.position.y },
    label: typeof n.label === "string" ? n.label : undefined,
    data: n.data,
    class: typeof n.class === "string" ? n.class : undefined,
  }));
}
function onEdgesUpdate(v: IncomingEdge[]): void {
  edges.value = v.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    label: typeof e.label === "string" ? e.label : undefined,
    animated: e.animated,
  }));
}

// -------- 增删节点 --------
let addCounter = 0;
function addNode(kind: WorkflowNodeKind): void {
  addCounter += 1;
  const id = `n-${kind}-${Date.now().toString(36)}-${addCounter}`;
  const base: WorkflowNode =
    kind === "input"
      ? { kind, id, title: "", position: nextPosition(), value: "" }
      : kind === "agent"
        ? { kind, id, title: "", position: nextPosition(), prompt: "" }
        : kind === "condition"
          ? { kind, id, title: "", position: nextPosition(), condition: { mode: "non-empty", value: "" } }
          : { kind, id, title: "", position: nextPosition() };
  nodes.value = [...nodes.value, toFlowNode(base)];
  selectedId.value = id;
}

function nextPosition(): { x: number; y: number } {
  return { x: 60 + (addCounter % 5) * 40, y: 60 + nodes.value.length * 30 };
}

function removeSelected(): void {
  const id = selectedId.value;
  if (!id) return;
  nodes.value = nodes.value.filter((n) => n.id !== id);
  edges.value = edges.value.filter((e) => e.source !== id && e.target !== id);
  selectedId.value = null;
}

// -------- 选中节点编辑 --------
function selectedNode(): FlowNode | null {
  return nodes.value.find((n) => n.id === selectedId.value) ?? null;
}

function patchData(patch: Record<string, unknown>): void {
  const id = selectedId.value;
  if (!id) return;
  nodes.value = nodes.value.map((n) =>
    n.id === id ? { ...n, data: { ...n.data, ...patch } } : n
  );
}

function selectedKind(): WorkflowNodeKind {
  return (selectedNode()?.data?.kind ?? "start") as WorkflowNodeKind;
}

function setTitle(title: string): void {
  const id = selectedId.value;
  if (!id) return;
  const kind = selectedKind();
  nodes.value = nodes.value.map((n) =>
    n.id === id
      ? { ...n, label: `${KIND_LABEL[kind]}｜${title || KIND_LABEL[kind]}`, data: { ...n.data, title } }
      : n
  );
}

function setPrompt(prompt: string): void {
  patchData({ prompt });
}
function setInputValue(value: string): void {
  patchData({ value });
}
function currentCondition(): WorkflowCondition {
  return (selectedNode()?.data?.condition as WorkflowCondition) ?? { mode: "non-empty", value: "" };
}
function setConditionMode(mode: WorkflowCondition["mode"]): void {
  patchData({ condition: { ...currentCondition(), mode } });
}
function setConditionValue(value: string): void {
  patchData({ condition: { ...currentCondition(), value } });
}

// -------- 重建定义 --------
function toWorkflowNode(n: FlowNode): WorkflowNode {
  const kind = (n.data?.kind ?? "start") as WorkflowNodeKind;
  const title = (n.data?.title as string) ?? "";
  const position = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
  if (kind === "input") return { kind, id: n.id, title, position, value: (n.data?.value as string) ?? "" };
  if (kind === "agent") return { kind, id: n.id, title, position, prompt: (n.data?.prompt as string) ?? "" };
  if (kind === "condition")
    return { kind, id: n.id, title, position, condition: currentConditionOf(n) };
  return { kind, id: n.id, title, position };
}
function currentConditionOf(n: FlowNode): WorkflowCondition {
  return (n.data?.condition as WorkflowCondition) ?? { mode: "non-empty", value: "" };
}

/** 把当前画布重建成一份定义（上层保存时调用）。 */
function toDefinition(): WorkflowDefinition {
  return {
    ...props.definition,
    nodes: nodes.value.map(toWorkflowNode),
    edges: edges.value.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle === "true" || e.sourceHandle === "false" ? e.sourceHandle : null,
    })),
    updatedAt: Date.now(),
  };
}

defineExpose({ toDefinition, loadFrom });

const CONDITION_MODES = [
  { label: "输入非空", value: "non-empty" },
  { label: "输入包含", value: "contains" },
  { label: "输入等于", value: "equals" },
];
</script>

<template>
  <div class="workflow-canvas">
    <div class="palette">
      <NSpace size="small">
        <NButton size="tiny" @click="addNode('start')">＋开始</NButton>
        <NButton size="tiny" @click="addNode('input')">＋输入</NButton>
        <NButton size="tiny" @click="addNode('agent')">＋Agent</NButton>
        <NButton size="tiny" @click="addNode('condition')">＋条件</NButton>
        <NButton size="tiny" @click="addNode('output')">＋输出</NButton>
        <NButton size="tiny" @click="addNode('end')">＋结束</NButton>
      </NSpace>
    </div>

    <div class="flow-wrap">
      <VueFlow
        :nodes="nodes"
        :edges="edges"
        :apply-default="true"
        fit-view-on-init
        @connect="onConnect"
        @node-click="onNodeClick"
        @update:nodes="onNodesUpdate"
        @update:edges="onEdgesUpdate"
      />
    </div>

    <div v-if="selectedNode()" class="inspector">
      <div class="inspector-title">
        节点：{{ KIND_LABEL[selectedKind()] }}
        <NButton size="tiny" type="error" quaternary @click="removeSelected">删除节点</NButton>
      </div>
      <NInput
        size="small"
        placeholder="节点标题"
        :value="(selectedNode()!.data?.title as string) ?? ''"
        @update:value="setTitle"
      />
      <template v-if="selectedKind() === 'input'">
        <NInput
          size="small"
          type="textarea"
          placeholder="输入的种子文本（下游节点的输入）"
          :autosize="{ minRows: 2, maxRows: 5 }"
          :value="(selectedNode()!.data?.value as string) ?? ''"
          @update:value="setInputValue"
        />
      </template>
      <template v-else-if="selectedKind() === 'agent'">
        <NInput
          size="small"
          type="textarea"
          placeholder="提示词模板（{{input}} 会被替换为上游产出）"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :value="(selectedNode()!.data?.prompt as string) ?? ''"
          @update:value="setPrompt"
        />
      </template>
      <template v-else-if="selectedKind() === 'condition'">
        <NSelect
          size="small"
          :options="CONDITION_MODES"
          :value="currentCondition().mode"
          @update:value="(v: string) => setConditionMode(v as WorkflowCondition['mode'])"
        />
        <NInput
          v-if="currentCondition().mode !== 'non-empty'"
          size="small"
          placeholder="比较值"
          :value="currentCondition().value"
          @update:value="setConditionValue"
        />
        <p class="hint">条件命中 → true 分支边活；否则 → false 分支边活。给出边设 handle=true/false。</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.workflow-canvas {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 320px;
}
.palette {
  padding: 6px 8px;
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.flow-wrap {
  flex: 1;
  min-height: 240px;
  position: relative;
}
.inspector {
  border-top: var(--border-w) solid var(--border-subtle);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.inspector-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--text-tertiary);
}
.hint {
  font-size: 11px;
  color: var(--text-tertiary);
  margin: 0;
}
/* 运行态着色 */
:deep(.wf-running) { box-shadow: 0 0 0 2px var(--status-running); }
:deep(.wf-succeeded) { box-shadow: 0 0 0 2px var(--status-success); }
:deep(.wf-failed) { box-shadow: 0 0 0 2px var(--status-error); }
:deep(.wf-skipped) { opacity: 0.5; }
</style>
