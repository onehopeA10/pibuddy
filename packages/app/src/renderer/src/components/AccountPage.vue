<script setup lang="ts">
import { ref } from "vue";
import { NTabPane, NTabs } from "naive-ui";
import ProviderCenter from "./ProviderCenter.vue";
import UsagePanel from "./UsagePanel.vue";

const tab = ref("account");
</script>

<template>
  <div class="account-page">
    <n-tabs v-model:value="tab" type="line" size="small" class="account-tabs">
      <n-tab-pane name="account" tab="模型" data-tab="account">
        <ProviderCenter embedded />
      </n-tab-pane>
      <n-tab-pane name="usage" tab="用量" data-tab="usage">
        <UsagePanel embedded />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<style scoped>
.account-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: var(--space-3) var(--space-6) var(--space-8);
}
.account-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.account-tabs :deep(.n-tabs-pane-wrapper) {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.account-tabs :deep(.n-tab-pane) {
  padding-top: var(--space-3);
}
</style>
