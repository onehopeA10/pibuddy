<script setup lang="ts">
import { zhCN, dateZhCN, NConfigProvider, NMessageProvider, NDialogProvider } from "naive-ui";
import AppShell from "./components/AppShell.vue";

const themeOverrides = {
  common: {
    primaryColor: "#6366f1",
    primaryColorHover: "#7c7ff5",
    primaryColorPressed: "#5155d9",
    primaryColorSuppl: "#6366f1",
    borderRadius: "10px",
  },
};
</script>

<template>
  <!-- abstract：不渲染包裹 div，保证 #app → .app-shell 的高度链不断 -->
  <n-config-provider
    abstract
    :locale="zhCN"
    :date-locale="dateZhCN"
    :theme-overrides="themeOverrides"
  >
    <n-message-provider placement="top" :max="3">
      <n-dialog-provider>
        <AppShell />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
