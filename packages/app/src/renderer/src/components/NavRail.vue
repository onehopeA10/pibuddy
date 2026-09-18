<script setup lang="ts">
import { computed } from "vue";
import { NTooltip } from "naive-ui";
import { useAppStore } from "../stores/app";
import { appLogo } from "../brand";

export type RailId =
  | "chat"
  | "tasks"
  | "library"
  | "memory"
  | "channels"
  | "workflows"
  | "terminal"
  | "account"
  | "settings";

const props = defineProps<{
  active: RailId;
  enabled: Partial<Record<RailId, boolean>>;
  sessionCollapsed?: boolean;
}>();

const emit = defineEmits<{
  select: [id: RailId];
}>();

const chatTip = computed(() => {
  if (props.active !== "chat") return "会话与对话";
  return props.sessionCollapsed ? "打开会话列表" : "收起会话列表";
});

const primary: { id: RailId; label: string; tip: string }[] = [
  { id: "chat", label: "对话", tip: "会话与对话" },
  { id: "tasks", label: "任务", tip: "定时任务" },
  { id: "library", label: "资源库", tip: "提示词、技能与扩展" },
  { id: "memory", label: "记忆", tip: "长期记忆" },
  { id: "channels", label: "渠道", tip: "飞书 / Slack / Telegram / 连接器" },
  { id: "workflows", label: "工作流", tip: "可视化工作流" },
  { id: "terminal", label: "终端", tip: "本机终端" },
];

const footer: { id: RailId; label: string; tip: string }[] = [
  { id: "account", label: "模型", tip: "模型与用量" },
  { id: "settings", label: "设置", tip: "应用设置" },
];

function visible(id: RailId, enabled: Partial<Record<RailId, boolean>>): boolean {
  if (id === "chat" || id === "account" || id === "settings") return true;
  return enabled[id] !== false;
}

// 顶栏右侧的白天 / 黑夜切换：与设置页共用同一个 settings.theme，改哪边另一边
// 都跟着变。点一下在深 / 浅之间来回切。
const app = useAppStore();
const isLight = computed(() => app.settings.theme === "light");
function toggleTheme(): void {
  void app.saveSettings({ theme: isLight.value ? "dark" : "light" });
}
</script>

<template>
  <!--
    应用顶栏：自绘标题栏 + 主导航（原先是左侧 68px 图标轨）。

    整条是窗口拖拽区（-webkit-app-region: drag），按钮各自 no-drag。右侧
    经 env(titlebar-area-*) 给 Electron 的 titleBarOverlay（最小化/最大化/
    关闭）留位，不与「设置」重叠。
  -->
  <nav class="app-header" aria-label="主导航">
    <div class="header-inner">
    <img class="brand" :src="appLogo" alt="PiBuddy" />
    <div class="rail-top">
      <n-tooltip v-for="item in primary" :key="item.id" placement="bottom" :delay="400">
        <template #trigger>
          <button
            v-if="visible(item.id, enabled)"
            type="button"
            class="rail-item"
            :class="{ active: active === item.id }"
            :aria-current="active === item.id ? 'page' : undefined"
            :aria-expanded="item.id === 'chat' && active === 'chat' ? !sessionCollapsed : undefined"
            :aria-label="item.label"
            @click="emit('select', item.id)"
          >
            <svg class="rail-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                v-if="item.id === 'chat'"
                d="M4 5.5h12v7.5H8.5L5 16v-3H4V5.5Z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
              <path
                v-else-if="item.id === 'tasks'"
                d="M6 4.5h8M5 7.5h10v8H5v-8Zm3 3h4"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
              <path
                v-else-if="item.id === 'library'"
                d="M5 4.5h7.5L15 7v8.5H5v-11Z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
              <path
                v-else-if="item.id === 'memory'"
                d="M10 4.5a4.5 4.5 0 0 1 3 8l-3 3-3-3a4.5 4.5 0 0 1 3-8Z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
              <path
                v-else-if="item.id === 'channels'"
                d="M5 7.5h4v5H5v-5Zm6 0h4v5h-4v-5ZM7 12.5v3M13 12.5v3"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
              <path
                v-else-if="item.id === 'workflows'"
                d="M5 5.5h4v4H5v-4Zm6 6h4v4h-4v-4ZM9 7.5h3M7 9.5v3"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
              <path
                v-else-if="item.id === 'terminal'"
                d="M4 5h12v10H4V5Zm2 3 2 2-2 2M9.5 12.5H13"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
            </svg>
            <span class="label">{{ item.label }}</span>
          </button>
        </template>
        {{ item.id === "chat" ? chatTip : item.tip }}
      </n-tooltip>
    </div>
    <div class="rail-spacer" />
    <div class="rail-bottom">
      <n-tooltip placement="bottom" :delay="400">
        <template #trigger>
          <button
            type="button"
            class="rail-item rail-icon-only theme-toggle"
            role="switch"
            :aria-checked="isLight"
            aria-label="切换深色 / 浅色"
            @click="toggleTheme"
          >
            <svg
              v-if="isLight"
              class="rail-icon"
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <!-- 太阳：当前是浅色，点一下回深色 -->
              <circle cx="10" cy="10" r="3.2" stroke="currentColor" stroke-width="1.5" />
              <path
                d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            <svg
              v-else
              class="rail-icon"
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <!-- 月亮：当前是深色，点一下切浅色 -->
              <path
                d="M15.5 11.2A6 6 0 1 1 8.8 4.5a4.7 4.7 0 0 0 6.7 6.7Z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </template>
        {{ isLight ? "切换到深色" : "切换到浅色" }}
      </n-tooltip>
      <n-tooltip v-for="item in footer" :key="item.id" placement="bottom" :delay="400">
        <template #trigger>
          <button
            type="button"
            class="rail-item"
            :class="{ active: active === item.id }"
            :aria-label="item.label"
            @click="emit('select', item.id)"
          >
            <svg class="rail-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                v-if="item.id === 'account'"
                d="M4 5.5h12v3.2H4V5.5Zm0 5.8h12V14.5H4v-3.2Zm1.2-4.3h2.2v1.2H5.2V7Zm0 5.8h2.2v1.2H5.2v-1.2Z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
              <path
                v-else
                d="M8 3.5h4l.7 2.2 2.2.7v4l-2.2.7L12 16.5H8l-.7-2.2-2.2-.7V9.6l2.2-.7L8 3.5Zm2 8.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
            </svg>
            <span class="label">{{ item.label }}</span>
          </button>
        </template>
        {{ item.tip }}
      </n-tooltip>
    </div>
    </div>
  </nav>
</template>
