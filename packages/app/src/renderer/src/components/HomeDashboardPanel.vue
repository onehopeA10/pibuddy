<script setup lang="ts">
/**
 * 智能家居监控面板（home.dashboard，基座诚实遗留 #7 的落点）。
 *
 * 挂载 = dashboard:subscribe 登记面板消费者（基座维持 WS 实时订阅）并取快照；
 * 卸载 = unsubscribe 释放（归零后基座 5min linger 拆线）。增量经
 * dashboard:event 信封进来，用契约的 shouldAcceptEnvelope（代际 + 序号）
 * 丢弃上一次订阅的迟到帧；收到 link stale=false（重连 resync 完成）时重拉
 * 一次快照——断线窗口内丢的增量只能靠全量补。
 *
 * ## v1 刻意不做控制按钮（只读取舍）
 *
 * 设备控制走会话对话：pi 回路内工具 home.assistant.call_service 经主进程
 * tool bridge → safeLocalFetch 三道关执行。面板做控制按钮意味着渲染进程多出
 * 一条「直接调 HA 服务」的 IPC 通道——那正是基座刻意收掉的攻击面；对话里
 * 「把客厅灯关了」也远比在几百个实体卡片里找开关自然。面板因此只有分组
 * 总览、状态徽标、stale 横幅与筛选，没有任何写路径。
 *
 * 本组件是首个 loading:"lazy" 包的 entry：AppShell 经 defineAsyncComponent
 * 动态 import，不开面板不进主 chunk。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { NButton, NInput, NSelect, NSpin, NTag } from "naive-ui";
import {
  shouldAcceptEnvelope,
  type DashboardEventPayload,
  type HaEntityRow,
  type PiEnvelope,
  type SequencedFrame,
} from "@contract";
import { useAppStore } from "../stores/app";

const store = useAppStore();

const entities = shallowRef<HaEntityRow[]>([]);
const total = ref(0);
const stale = ref(false);
const source = ref<"live" | "snapshot">("snapshot");
const loading = ref(false);
const error = ref<string | null>(null);
const query = ref("");
const domainFilter = ref<string | null>(null);

/** 当前订阅的推送代际 + 最后接受的帧（信封丢弃判据，全仓唯一实现在契约里）。 */
let generation = 0;
let lastFrame: SequencedFrame | null = null;
let subscribedWorkspace: string | null = null;
let offEvent: (() => void) | null = null;

async function subscribeTo(workspaceId: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const result = await window.piBuddy.dashboard.subscribe(workspaceId);
    subscribedWorkspace = workspaceId;
    generation = result.generation;
    lastFrame = null;
    applySnapshot(result.snapshot);
  } catch (err) {
    error.value = String((err as Error).message ?? err);
  } finally {
    loading.value = false;
  }
}

function applySnapshot(snapshot: {
  entities: HaEntityRow[];
  total: number;
  stale: boolean;
  source: "live" | "snapshot";
}): void {
  entities.value = snapshot.entities;
  total.value = snapshot.total;
  stale.value = snapshot.stale;
  source.value = snapshot.source;
}

async function refetchSnapshot(): Promise<void> {
  if (!subscribedWorkspace) return;
  try {
    applySnapshot(await window.piBuddy.dashboard.snapshot(subscribedWorkspace));
  } catch {
    /* 快照重拉失败不打断面板：下一次 link 事件还会再试 */
  }
}

function onEnvelope(envelope: PiEnvelope<DashboardEventPayload>): void {
  if (envelope.workspaceId !== subscribedWorkspace) return;
  if (envelope.generation !== generation) return; // 上一次订阅的迟到帧
  if (!shouldAcceptEnvelope(lastFrame, envelope)) return;
  lastFrame = { generation: envelope.generation, sequence: envelope.sequence };

  const payload = envelope.payload;
  if (payload.type === "link") {
    stale.value = payload.stale;
    // resync 完成：断线窗口内丢失的增量只能靠全量补。
    if (!payload.stale) void refetchSnapshot();
    return;
  }
  // state-changed：就地增量维护（state=null = 实体被移除）。
  const rows = entities.value;
  const idx = rows.findIndex((e) => e.id === payload.entityId);
  if (payload.state === null) {
    if (idx >= 0) {
      entities.value = rows.filter((e) => e.id !== payload.entityId);
      total.value = Math.max(0, total.value - 1);
    }
    return;
  }
  if (idx >= 0) {
    const prev = rows[idx]!;
    const next = [...rows];
    next[idx] = { ...prev, state: payload.state, name: payload.name ?? prev.name };
    entities.value = next;
  } else {
    const domain = payload.entityId.includes(".")
      ? payload.entityId.slice(0, payload.entityId.indexOf("."))
      : payload.entityId;
    entities.value = [
      ...rows,
      { id: payload.entityId, name: payload.name ?? payload.entityId, domain, state: payload.state, area: null },
    ];
    total.value += 1;
  }
}

async function releaseCurrent(): Promise<void> {
  const workspaceId = subscribedWorkspace;
  subscribedWorkspace = null;
  if (workspaceId) {
    try {
      await window.piBuddy.dashboard.unsubscribe(workspaceId);
    } catch {
      /* 释放失败（如主进程已在拆卸）不阻塞卸载 */
    }
  }
}

onMounted(() => {
  offEvent = window.piBuddy.dashboard.onEvent(onEnvelope);
  if (store.workspaceId) void subscribeTo(store.workspaceId);
});

// 切工作区：释放旧消费者、登记新消费者（不释放的话旧工作区 WS 一直挂着）。
watch(
  () => store.workspaceId,
  (id, prev) => {
    if (id === prev) return;
    void releaseCurrent().then(() => {
      if (id) void subscribeTo(id);
    });
  }
);

onBeforeUnmount(() => {
  offEvent?.();
  offEvent = null;
  void releaseCurrent();
});

// ---------------------------------------------------------------- 展示

/** domain → 分类名（灯/开关/传感器/温控四类 + 常见回落）。 */
const DOMAIN_LABELS: Record<string, string> = {
  light: "灯",
  switch: "开关",
  sensor: "传感器",
  binary_sensor: "二元传感",
  climate: "温控",
  fan: "风扇",
  cover: "遮盖",
  media_player: "媒体",
  lock: "锁",
  vacuum: "扫地机",
};
function iconOf(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain;
}

/** 状态徽标配色：亮/开/在家 = 绿；不可用 = 橙；其余中性。 */
function stateTagType(state: string | null): "success" | "warning" | "default" {
  if (state === null || state === "unavailable" || state === "unknown") return "warning";
  if (["on", "open", "home", "heat", "cool", "playing", "unlocked"].includes(state)) {
    return "success";
  }
  return "default";
}
function stateLabel(state: string | null): string {
  return state ?? "无状态";
}

const domainOptions = computed(() => {
  const domains = [...new Set(entities.value.map((e) => e.domain))].sort();
  return domains.map((d) => ({ label: `${iconOf(d)} ${d}`, value: d }));
});

/** 筛选（文本命中 id/名称 + 可选 domain）后按房间（area）分组。 */
const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const byArea = new Map<string, HaEntityRow[]>();
  for (const entity of entities.value) {
    if (domainFilter.value !== null && entity.domain !== domainFilter.value) continue;
    if (q !== "" && !`${entity.id} ${entity.name}`.toLowerCase().includes(q)) continue;
    const area = entity.area ?? "未分区";
    const bucket = byArea.get(area);
    if (bucket) bucket.push(entity);
    else byArea.set(area, [entity]);
  }
  return [...byArea.entries()]
    .sort((a, b) => {
      // 「未分区」沉底，其余按名称排。
      if (a[0] === "未分区") return 1;
      if (b[0] === "未分区") return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([area, rows]) => ({
      area,
      rows: [...rows].sort((x, y) => x.name.localeCompare(y.name)),
    }));
});
</script>

<template>
  <aside class="home-dashboard-panel">
    <header class="head">
      <span class="title">家居面板</span>
      <span class="count">{{ total }} 个实体</span>
      <NButton size="tiny" quaternary :loading="loading" @click="refetchSnapshot">刷新</NButton>
    </header>

    <!-- stale 横幅：断线 / 冷启动快照时如实显示「这份数据可能过期」。 -->
    <p v-if="stale" class="msg stale">
      与 Home Assistant 的连接中断或数据未同步，以下状态可能已过期。
    </p>
    <p v-if="error" class="msg error">{{ error }}</p>
    <p v-else-if="source === 'snapshot' && !stale" class="msg notice">
      正在显示冷启动快照（无实时状态）。
    </p>

    <div class="filters">
      <NInput v-model:value="query" size="small" placeholder="按名称 / 实体 id 筛选" clearable />
      <NSelect
        v-model:value="domainFilter"
        size="small"
        :options="domainOptions"
        placeholder="全部类型"
        clearable
        class="domain-select"
      />
    </div>

    <div class="body">
      <NSpin v-if="loading && entities.length === 0" size="small" />
      <p v-else-if="groups.length === 0" class="empty">
        没有匹配的实体。基座未配置时请先到「设置 → 智能家居」填写端点并授权。
      </p>
      <section v-for="group in groups" :key="group.area" class="area">
        <h3 class="area-name">{{ group.area }}</h3>
        <div v-for="entity in group.rows" :key="entity.id" class="row" :title="entity.id">
          <span class="icon">{{ iconOf(entity.domain) }}</span>
          <span class="name">{{ entity.name }}</span>
          <NTag size="small" :type="stateTagType(entity.state)" :bordered="false">
            {{ stateLabel(entity.state) }}
          </NTag>
        </div>
      </section>
      <!-- v1 只读取舍：不做控制按钮。控制走会话对话（基座 call_service 工具，
           经主进程 tool bridge 三道关），面板不给渲染进程留第二条控制通道。 -->
      <p class="foot-hint">
        面板是只读的：要控制设备，直接在对话里吩咐（如「把客厅灯关了」），
        AI 助手会经受控通道执行并在这里实时回显。
      </p>
    </div>
  </aside>
</template>

<style scoped>
.home-dashboard-panel {
  display: flex;
  flex-direction: column;
  width: 340px;
  height: 100%;
  border-left: var(--border-w) solid var(--border-subtle);
  background: var(--bg-surface);
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
.msg {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
}
.msg.error {
  color: var(--status-error);
  background: var(--danger-bg);
}
.msg.stale {
  color: var(--status-warning);
  background: var(--warning-bg);
}
.msg.notice {
  color: var(--text-secondary);
  background: var(--bg-surface);
}
.filters {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.domain-select {
  width: 140px;
  flex: none;
}
.body {
  flex: 1;
  overflow: auto;
  padding: 8px 10px;
}
.empty {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.area {
  margin-bottom: 10px;
}
.area-name {
  margin: 4px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  font-size: 12px;
}
.row .icon {
  flex: none;
}
.row .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.foot-hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.6;
}
</style>
