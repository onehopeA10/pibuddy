<script setup lang="ts">
/**
 * 后台会话池监督面（AGT-101 第一批）。
 *
 * 最小可用版：一份会话列表，每条显示进程态（focused/background/warm/stopped/
 * crashed）、列表任务态（running/waiting_permission/failed/done/idle）、未读标记、
 * 内存与成本；顶部是资源占用与上界；底部是统一权限 inbox（后台会话卡在权限上的
 * 待办，绝不自动允许——用户在这里作答）。聚焦某会话把它置前台，停止某会话终止
 * 其进程（窗口关闭不会——窗口关闭 ≠ 停止）。
 *
 * 快照订阅在 store 里（snapshot + sequence，晚到的旧快照被序号闸门丢弃）。
 */
import { computed, onMounted, onBeforeUnmount } from "vue";
import {
  NButton,
  NBadge,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NList,
  NListItem,
  NProgress,
  NSpace,
  NTag,
  NText,
} from "naive-ui";
import type { PoolListState, PoolRunState, PoolSessionView } from "@contract";
import { useAgentPoolStore } from "../stores/agent-pool";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (e: "update:show", v: boolean): void }>();

const store = useAgentPoolStore();

onMounted(() => {
  void store.init();
});
onBeforeUnmount(() => {
  store.dispose();
});

const sessions = computed<PoolSessionView[]>(() => store.sessions);

const RUN_LABEL: Record<PoolRunState, string> = {
  focused: "前台",
  background: "后台",
  warm: "热备",
  stopped: "已停",
  crashed: "已崩溃",
};
const RUN_TYPE: Record<PoolRunState, "success" | "info" | "warning" | "default" | "error"> = {
  focused: "success",
  background: "info",
  warm: "warning",
  stopped: "default",
  crashed: "error",
};
const LIST_LABEL: Record<PoolListState, string> = {
  idle: "空闲",
  running: "运行中",
  waiting_permission: "等待授权",
  failed: "失败",
  done: "已完成",
};

const memoryPercent = computed(() => {
  const ceil = store.caps?.memoryCeilingMb ?? 0;
  if (ceil <= 0) return 0;
  return Math.min(100, Math.round((store.totalMemoryMb / ceil) * 100));
});
const costPercent = computed(() => {
  const ceil = store.caps?.costCeilingUsd ?? 0;
  if (ceil <= 0) return 0;
  return Math.min(100, Math.round((store.totalCostUsd / ceil) * 100));
});
</script>

<template>
  <n-drawer :show="props.show" :width="440" placement="right" @update:show="(v) => emit('update:show', v)">
    <n-drawer-content title="会话池" closable>
      <n-space vertical size="large">
        <!-- 资源占用 -->
        <div>
          <n-space justify="space-between">
            <n-text strong>活跃 {{ store.activeCount }}<span v-if="store.queuedCount"> · 排队 {{ store.queuedCount }}</span></n-text>
            <n-text depth="3">内存 {{ Math.round(store.totalMemoryMb) }} / {{ store.caps?.memoryCeilingMb ?? "?" }} MB</n-text>
          </n-space>
          <n-progress type="line" :percentage="memoryPercent" :show-indicator="false" style="margin-top: 6px" />
          <n-space justify="space-between" style="margin-top: 6px">
            <n-text depth="3">成本 ${{ store.totalCostUsd.toFixed(2) }} / ${{ store.caps?.costCeilingUsd ?? "?" }}</n-text>
          </n-space>
          <n-progress type="line" status="warning" :percentage="costPercent" :show-indicator="false" style="margin-top: 6px" />
        </div>

        <!-- 会话列表 -->
        <div>
          <n-text strong>会话</n-text>
          <n-empty v-if="sessions.length === 0" description="暂无会话" size="small" style="margin-top: 8px" />
          <n-list v-else bordered style="margin-top: 8px">
            <n-list-item v-for="s in sessions" :key="s.sessionId">
              <n-space vertical size="small">
                <n-space size="small" align="center">
                  <n-badge v-if="s.unread" dot :offset="[2, 0]" />
                  <n-tag size="small" :type="RUN_TYPE[s.runState]" :bordered="false">{{ RUN_LABEL[s.runState] }}</n-tag>
                  <n-tag size="small" :bordered="false" :type="s.listState === 'failed' ? 'error' : s.listState === 'waiting_permission' ? 'warning' : 'default'">
                    {{ LIST_LABEL[s.listState] }}
                  </n-tag>
                  <n-tag v-if="s.queued" size="small" type="info" :bordered="false">排队</n-tag>
                </n-space>
                <n-text depth="3" style="font-size: 12px">{{ s.sessionId }}</n-text>
                <n-text depth="3" style="font-size: 12px">
                  {{ Math.round(s.memoryMb) }} MB · ${{ s.costUsd.toFixed(2) }}<span v-if="s.crashCount"> · 崩溃 {{ s.crashCount }}</span>
                </n-text>
              </n-space>
              <template #suffix>
                <n-space size="small">
                  <n-button v-if="s.runState !== 'focused'" size="tiny" @click="store.focus(s.sessionId)">聚焦</n-button>
                  <n-button v-if="s.runState !== 'stopped' && s.runState !== 'crashed'" size="tiny" @click="store.stop(s.sessionId)">停止</n-button>
                </n-space>
              </template>
            </n-list-item>
          </n-list>
        </div>

        <!-- 统一权限 inbox -->
        <div>
          <n-space size="small" align="center">
            <n-text strong>权限 inbox</n-text>
            <n-badge v-if="store.inbox.length" :value="store.inbox.length" type="warning" />
          </n-space>
          <n-empty v-if="store.inbox.length === 0" description="无待办" size="small" style="margin-top: 8px" />
          <n-list v-else bordered style="margin-top: 8px">
            <n-list-item v-for="item in store.inbox" :key="item.id">
              <n-space vertical size="small">
                <n-space size="small">
                  <n-tag size="small" :bordered="false">{{ item.capabilityId }}</n-tag>
                  <n-tag size="small" type="warning" :bordered="false">{{ item.permission }}</n-tag>
                </n-space>
                <n-text depth="3" style="font-size: 12px">会话 {{ item.sessionId }}</n-text>
                <n-text depth="3" style="font-size: 12px">无人响应将在超时后自动拒绝，绝不自动允许</n-text>
              </n-space>
            </n-list-item>
          </n-list>
        </div>
      </n-space>
    </n-drawer-content>
  </n-drawer>
</template>
