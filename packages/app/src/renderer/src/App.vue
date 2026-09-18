<script setup lang="ts">
import { computed, watch } from "vue";
import {
  zhCN,
  dateZhCN,
  darkTheme,
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  type GlobalThemeOverrides,
} from "naive-ui";
import AppShell from "./components/AppShell.vue";
// 权限 UI 挂在根组件而不是 AppShell：它是跨能力的内核设施（授权中心 + 裁决
// 弹窗恒在），且这样不与 AppShell 那四个具名 slot 抢位置。
import PermissionPrompt from "./components/PermissionPrompt.vue";
import PermissionCenter from "./components/PermissionCenter.vue";
import { useAppStore } from "./stores/app";
import { applyTheme } from "./theme";

const store = useAppStore();

// 设置一到就落到 DOM（data-theme + hljs 样式表）。首帧由 main.ts 用缓存值
// 先上过一次色，这里只负责跟真值对齐。
watch(
  () => store.settings.theme,
  (theme) => applyTheme(theme ?? "dark"),
  { immediate: true }
);

const isLight = computed(() => store.settings.theme === "light");

// Naive UI 的颜色与 tokens.css 同源：两边的十六进制值必须逐项对应
// （深色对应 :root，浅色对应 :root[data-theme="light"]）。
const sharedOverrides: GlobalThemeOverrides = {
  common: {
    borderRadius: "10px",
    scrollbarWidth: "8px",
    scrollbarHeight: "8px",
    scrollbarBorderRadius: "8px",
  },
  Card: { borderRadius: "12px" },
  Dialog: { borderRadius: "16px" },
  Alert: { borderRadius: "12px" },
};

const darkOverrides: GlobalThemeOverrides = {
  common: {
    ...sharedOverrides.common,
    primaryColor: "#7C6CF0",
    primaryColorHover: "#8F80F5",
    primaryColorPressed: "#6B5BE0",
    primaryColorSuppl: "#7C6CF0",
    bodyColor: "#0F1115",
    cardColor: "#161A21",
    modalColor: "#1C212B",
    popoverColor: "#1C212B",
    inputColor: "#1A1F28",
    tableColor: "#161A21",
    textColorBase: "#E6E8EC",
    textColor1: "#E6E8EC",
    textColor2: "#9BA3B0",
    textColor3: "#6E7686",
    borderColor: "#262C37",
    hoverColor: "#20262F",
    dividerColor: "#262C37",
    scrollbarColor: "#39404D",
    scrollbarColorHover: "#6E7686",
  },
};

const lightOverrides: GlobalThemeOverrides = {
  common: {
    ...sharedOverrides.common,
    primaryColor: "#6B5BE0",
    primaryColorHover: "#7C6CF0",
    primaryColorPressed: "#5B4BD0",
    primaryColorSuppl: "#6B5BE0",
    bodyColor: "#F6F7F9",
    cardColor: "#FFFFFF",
    modalColor: "#FFFFFF",
    popoverColor: "#FFFFFF",
    inputColor: "#FFFFFF",
    tableColor: "#FFFFFF",
    textColorBase: "#1F2329",
    textColor1: "#1F2329",
    textColor2: "#5B6472",
    textColor3: "#8A93A3",
    borderColor: "#E3E6EB",
    hoverColor: "#E9ECF1",
    dividerColor: "#E3E6EB",
    scrollbarColor: "#C9CED8",
    scrollbarColorHover: "#8A93A3",
  },
};

// Naive 的浅色主题就是 theme=null（内建默认）
const naiveTheme = computed(() => (isLight.value ? null : darkTheme));
const themeOverrides = computed(() => (isLight.value ? lightOverrides : darkOverrides));
</script>

<template>
  <!-- abstract：不渲染包裹 div，保证 #app → .app-shell 的高度链不断 -->
  <n-config-provider
    abstract
    :theme="naiveTheme"
    :locale="zhCN"
    :date-locale="dateZhCN"
    :theme-overrides="themeOverrides"
  >
    <n-message-provider placement="top" :max="3">
      <n-dialog-provider>
        <AppShell />
        <PermissionPrompt />
        <PermissionCenter />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
