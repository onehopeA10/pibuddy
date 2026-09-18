<script setup lang="ts">
/**
 * 会话树 / 分叉可视化面板（common.session-tree）。
 *
 * ## 布局在渲染侧算，结构在主进程折
 *
 * 主进程只承诺**结构**（拍平的节点 + parentId + 当前叶子 + 性能截断）；这里把
 * 结构算成坐标：y 由深度决定，x 由「叶子顺序 + 内部节点取子节点中点」的经典
 * tidy 布局给出。一次线性 + 一次 DFS，节点数已被主进程截断到上限内。
 *
 * ## 点击 = 导航到该 entry（高亮），不是切换/删除
 *
 * pi 的会话是 append-only 的树，没有「跳到某个 entry」的 RPC，也不该有——
 * 切分支的唯一非破坏性手段是从某条历史 user 消息 fork。因此点击一个节点在
 * 这里的语义是**在树里高亮它**（导航）；选中的若是一条可分叉的 user 消息，
 * 才亮出「从此分叉」。原分支永远留在图上。
 */
import { computed, onMounted, watch } from "vue";
import { NButton, NSpin } from "naive-ui";
import type { SessionTreeNode } from "@contract";
import { useAppStore } from "../stores/app";
import { useSessionTreeStore } from "../stores/session-tree";
import SessionTreeNodeView from "./SessionTreeNode.vue";

const app = useAppStore();
const tree = useSessionTreeStore();

const COL_W = 168;
const ROW_H = 56;
const PAD = 28;

interface Positioned {
  node: SessionTreeNode;
  x: number;
  y: number;
}
interface Edge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  active: boolean;
}

/**
 * 把拍平的节点算成坐标 + 连边。
 *
 * 主进程保证「父恒排在子之前」且「被下发的非根节点，其父一定也被下发」，
 * 因此这里 childrenOf 建图、从 rootIds 做 DFS 一定连得起来，不会连出指向
 * 缺失父的边。
 */
const layout = computed<{ nodes: Positioned[]; edges: Edge[]; width: number; height: number }>(() => {
  const graph = tree.graph;
  if (!graph || graph.nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const childrenOf = new Map<string, SessionTreeNode[]>();
  for (const n of graph.nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const list = childrenOf.get(n.parentId) ?? [];
      list.push(n);
      childrenOf.set(n.parentId, list);
    }
  }

  const colOf = new Map<string, number>();
  let nextLeafCol = 0;
  const assign = (n: SessionTreeNode): number => {
    const kids = childrenOf.get(n.id) ?? [];
    if (kids.length === 0) {
      const c = nextLeafCol++;
      colOf.set(n.id, c);
      return c;
    }
    const cols = kids.map(assign);
    const center = (cols[0] + cols[cols.length - 1]) / 2;
    colOf.set(n.id, center);
    return center;
  };
  for (const id of graph.rootIds) {
    const root = byId.get(id);
    if (root) assign(root);
  }

  const posOf = new Map<string, { x: number; y: number }>();
  const nodes: Positioned[] = graph.nodes.map((n) => {
    const x = (colOf.get(n.id) ?? 0) * COL_W + PAD;
    const y = n.depth * ROW_H + PAD;
    posOf.set(n.id, { x, y });
    return { node: n, x, y };
  });

  const edges: Edge[] = [];
  for (const n of graph.nodes) {
    if (!n.parentId) continue;
    const from = posOf.get(n.parentId);
    const to = posOf.get(n.id);
    if (!from || !to) continue;
    edges.push({
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      active: n.current || n.id === graph.currentLeafId,
    });
  }

  const width = Math.max(...nodes.map((p) => p.x)) + COL_W;
  const height = Math.max(...nodes.map((p) => p.y)) + PAD * 2;
  return { nodes, edges, width, height };
});

const selectedNode = computed<SessionTreeNode | null>(() => {
  const id = tree.selectedId;
  return id ? (tree.graph?.nodes.find((n) => n.id === id) ?? null) : null;
});
const canForkSelected = computed(
  () => selectedNode.value !== null && tree.isForkable(selectedNode.value.id)
);

/** 树 channel 只认不透明标识：workspaceId + sessionId，路径反查在 main 侧。 */
function reload(): void {
  const ws = app.workspaceId;
  const sid = app.currentSessionId;
  if (ws && sid) void tree.refresh(ws, sid);
}

// 会话切换（换 sessionId / 启动状态变化）就重拉一次树。
watch(
  () => [app.started, app.workspaceId, app.currentSessionId] as const,
  ([started]) => {
    if (started) reload();
  }
);

onMounted(() => {
  if (app.started) reload();
});
</script>

<template>
  <aside class="session-tree-panel">
    <header class="head">
      <span class="title">会话树</span>
      <span v-if="tree.graph" class="count">
        {{ tree.graph.nodes.length }} / {{ tree.graph.totalNodes }} 节点
        <span v-if="tree.graph.truncated" class="truncated" title="大树已按性能上限截断，活动分支完整">
          （已截断）
        </span>
      </span>
      <NButton size="tiny" quaternary :loading="tree.loading" @click="reload">刷新</NButton>
      <NButton size="tiny" quaternary :disabled="tree.busy" @click="tree.clone()">克隆当前分支</NButton>
    </header>

    <p v-if="tree.error" class="msg error">{{ tree.error }}</p>
    <p v-else-if="tree.notice" class="msg notice">{{ tree.notice }}</p>

    <div class="canvas">
      <NSpin v-if="tree.loading && !tree.graph" size="small" />
      <p v-else-if="!tree.graph || tree.graph.nodes.length === 0" class="empty">
        这个会话还没有可展示的分支。
      </p>
      <svg
        v-else
        class="tree-svg"
        :width="layout.width"
        :height="layout.height"
        :viewBox="`0 0 ${layout.width} ${layout.height}`"
      >
        <!-- 先画边、再画点：点压在边上面 -->
        <line
          v-for="(e, i) in layout.edges"
          :key="`e${i}`"
          class="edge"
          :class="{ active: e.active }"
          :x1="e.x1"
          :y1="e.y1"
          :x2="e.x2"
          :y2="e.y2"
        />
        <SessionTreeNodeView
          v-for="p in layout.nodes"
          :key="p.node.id"
          :node="p.node"
          :x="p.x"
          :y="p.y"
          :selected="p.node.id === tree.selectedId"
          :forkable="tree.isForkable(p.node.id)"
          @select="tree.select"
        />
      </svg>
    </div>

    <footer v-if="selectedNode" class="detail">
      <div class="detail-head">
        <span class="kind">{{ selectedNode.kind }}</span>
        <span v-if="selectedNode.modelId" class="model">{{ selectedNode.modelId }}</span>
      </div>
      <p class="preview">{{ selectedNode.preview || "（无文本）" }}</p>
      <NButton
        v-if="canForkSelected"
        size="small"
        type="primary"
        :disabled="tree.busy"
        @click="tree.fork(selectedNode.id)"
      >
        从此消息分叉
      </NButton>
      <span v-else class="hint">只有当前分支上的历史用户消息可以分叉。</span>
    </footer>
  </aside>
</template>

<style scoped>
.session-tree-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  border-top: var(--border-w) solid var(--border-subtle);
  padding: 8px;
  min-height: 360px;
  max-height: 420px;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.title {
  font-weight: 600;
  font-size: 13px;
}
.count {
  font-size: 11px;
  color: var(--text-secondary);
  margin-right: auto;
}
.truncated {
  color: var(--status-warning);
}
.msg {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
}
.msg.error {
  color: var(--status-error);
  background: var(--danger-bg);
}
.msg.notice {
  color: var(--status-success);
}
.canvas {
  flex: 1;
  min-height: 180px;
  overflow: auto;
  padding: 4px;
}
.empty {
  color: var(--text-tertiary);
  font-size: 12px;
  padding: 16px;
}
.edge {
  stroke: var(--border-strong);
  stroke-width: 1.5;
}
.edge.active {
  stroke: var(--status-success);
  stroke-width: 2.5;
}
.detail {
  border-top: var(--border-w) solid var(--border-subtle);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.detail-head {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-secondary);
}
.kind {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.preview {
  margin: 0;
  font-size: 12px;
  color: var(--text-primary);
  max-height: 72px;
  overflow: auto;
  white-space: pre-wrap;
}
.hint {
  font-size: 11px;
  color: var(--text-tertiary);
}
</style>
