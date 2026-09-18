<script setup lang="ts">
/**
 * 状态中心（UX-101）。
 *
 * 顶栏上一个小圆点 + 一句话，点开是六类状态的详情：
 * runtime / session / 网络与 Provider / context / 后台任务 / update。
 *
 * ## 为什么要有它
 *
 * 收敛前这些状态散落在四五个地方，而「出问题时我该看哪里」没有答案。
 * 用户报「它不动了」时，我们既不知道 pi 进程还在不在、也不知道是不是在
 * 重试、还是更新正在下载。把它们收进一个入口之后，「现在是什么情况」
 * 变成了一个一眼能看完的列表。
 *
 * ## 降级要如实
 *
 * 某一类状态取不到时显示「暂不可用」，而不是显示一个好看的默认值。
 * 假装一切正常是这类面板最容易犯、也最难被发现的错误。
 */
import { computed } from "vue";
import { NBadge, NButton, NPopover, NTag } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useProvidersStore } from "../stores/providers";
import { useUpdateStore } from "../stores/update";

const app = useAppStore();
const providers = useProvidersStore();
const update = useUpdateStore();

type Level = "ok" | "busy" | "warn" | "error";

interface StatusItem {
  key: string;
  label: string;
  text: string;
  level: Level;
}

const items = computed<StatusItem[]>(() => {
  const out: StatusItem[] = [];

  // 1. runtime
  out.push({
    key: "runtime",
    label: "助手进程",
    text: app.startError
      ? `启动失败：${app.startError.slice(0, 80)}`
      : app.runtimeWaking
        ? "正在唤醒助手…"
        : app.runtimeAsleep
          ? "已休眠（回到窗口或发送时唤醒）"
          : app.started
            ? `运行中（${app.settings.piRuntimeMode === "external" ? "外部" : "内置"} Pi）`
            : "未启动",
    level: app.startError
      ? "error"
      : app.runtimeWaking
        ? "busy"
        : app.started
          ? "ok"
          : "warn",
  });

  // 2. session
  out.push({
    key: "session",
    label: "当前会话",
    text: app.currentSessionId
      ? `${app.items.length} 条消息${app.sessionLoadError ? " · 加载出错" : ""}`
      : "还没有会话",
    level: app.sessionLoadError ? "error" : app.currentSessionId ? "ok" : "warn",
  });

  // 3. 网络与 Provider
  const configured = providers.providers.filter((p) => p.configured).length;
  out.push({
    key: "provider",
    label: "模型",
    text: providers.providers.length === 0
      ? "暂不可用（还没读到账号列表）"
      : configured > 0
        ? `已配置 ${configured} 个`
        : "一个都没配 —— 点这里去配置",
    level: providers.providers.length === 0 ? "warn" : configured > 0 ? "ok" : "error",
  });

  // 4. context
  const percent = app.stats?.contextUsage?.percent ?? null;
  out.push({
    key: "context",
    label: "记忆占用",
    text: percent === null ? "暂不可用" : `${Math.round(percent)}%`,
    level: percent === null ? "warn" : percent > 85 ? "warn" : "ok",
  });

  // 5. 后台任务
  const queued = app.queue.steering.length + app.queue.followUp.length + app.localQueue.length;
  out.push({
    key: "tasks",
    label: "后台任务",
    text: app.streaming
      ? `正在处理${queued ? ` · 排队 ${queued} 条` : ""}`
      : queued
        ? `排队 ${queued} 条`
        : "空闲",
    level: app.streaming ? "busy" : "ok",
  });

  // 6. update —— store 未就绪时如实说 unsupported，不显示一个假的「最新版」
  out.push({
    key: "update",
    label: "应用更新",
    text: update.status ? UPDATE_LABELS[update.status] ?? update.status : "unsupported",
    level: update.status === "error" ? "error" : update.status === "downloading" ? "busy" : "ok",
  });

  return out;
});

const UPDATE_LABELS: Record<string, string> = {
  idle: "已是最新",
  checking: "正在检查…",
  available: "有新版本",
  downloading: "正在下载…",
  downloaded: "下载完成，待重启",
  error: "检查失败",
  unsupported: "此平台不支持自动更新",
  disabled: "已关闭自动更新",
};

/** 顶栏那个点的颜色取全部条目里最严重的一档。 */
const worst = computed<Level>(() => {
  const levels = items.value.map((i) => i.level);
  if (levels.includes("error")) return "error";
  if (levels.includes("warn")) return "warn";
  if (levels.includes("busy")) return "busy";
  return "ok";
});

const BADGE_TYPE: Record<Level, "success" | "info" | "warning" | "error"> = {
  ok: "success",
  busy: "info",
  warn: "warning",
  error: "error",
};

function onItemClick(key: string): void {
  if (key === "provider") providers.panelOpen = true;
  else if (key === "update" || key === "runtime") app.settingsOpen = true;
}
</script>

<template>
  <n-popover trigger="click" placement="bottom-end" :width="320">
    <template #trigger>
      <n-button quaternary size="small" aria-label="状态中心" data-testid="status-center-trigger">
        <n-badge dot :type="BADGE_TYPE[worst]" />
        <span style="margin-left: 6px">状态</span>
      </n-button>
    </template>

    <div role="group" aria-label="应用状态" data-testid="status-center-panel">
      <div
        v-for="item in items"
        :key="item.key"
        class="status-row"
        :data-status-key="item.key"
        :data-status-level="item.level"
        tabindex="0"
        role="button"
        @click="onItemClick(item.key)"
        @keydown.enter="onItemClick(item.key)"
      >
        <span class="status-label">{{ item.label }}</span>
        <n-tag size="small" :bordered="false" :type="BADGE_TYPE[item.level]">
          {{ item.text }}
        </n-tag>
      </div>
    </div>
  </n-popover>
</template>

<style scoped>
.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 2px;
  border-radius: var(--radius-l);
  cursor: pointer;
}
.status-row:hover,
.status-row:focus-visible {
  background: var(--bg-hover);
  outline: none;
}
.status-label {
  font-size: 12.5px;
  color: var(--text-secondary);
  white-space: nowrap;
}
</style>
