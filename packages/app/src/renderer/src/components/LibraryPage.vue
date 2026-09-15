<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NTabPane, NTabs } from "naive-ui";
import PromptLibraryPanel from "./PromptLibraryPanel.vue";
import OfficeSkillsPanel from "./OfficeSkillsPanel.vue";
import PiResourcesPanel from "./PiResourcesPanel.vue";
import { useCapabilitiesStore } from "../stores/capabilities";

/**
 * 资源库页是提示词库 / 办公技能两个能力包的 UI 宿主，门控就地读能力快照
 * （与其它宿主同一判据：「启用」= 主进程通道已注册），不经父级 props 转手。
 */
const capabilities = useCapabilitiesStore();
const showPrompts = computed(() => capabilities.isEnabled("common.prompt-library"));
const showSkills = computed(() => capabilities.isEnabled("common.office-skills"));

const tab = ref("prompts");

watch(
  () => [showPrompts.value, showSkills.value] as const,
  ([prompts, skills]) => {
    if (tab.value === "prompts" && !prompts) tab.value = skills ? "skills" : "extensions";
    if (tab.value === "skills" && !skills) tab.value = prompts ? "prompts" : "extensions";
  },
  { immediate: true }
);
</script>

<template>
  <div class="library-page">
    <n-tabs v-model:value="tab" type="line" size="small" class="library-tabs">
      <n-tab-pane v-if="showPrompts" name="prompts" tab="提示词">
        <PromptLibraryPanel embedded />
      </n-tab-pane>
      <n-tab-pane v-if="showSkills" name="skills" tab="技能">
        <OfficeSkillsPanel />
      </n-tab-pane>
      <n-tab-pane name="extensions" tab="扩展">
        <PiResourcesPanel embedded />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<style scoped>
.library-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 var(--space-5) var(--space-5);
}
.library-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.library-tabs :deep(.n-tabs-pane-wrapper) {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.library-tabs :deep(.n-tab-pane) {
  padding-top: var(--space-3);
}
</style>
