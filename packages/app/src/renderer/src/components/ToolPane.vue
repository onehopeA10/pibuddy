<script setup lang="ts">
/**
 * 工具菜单打开的面板外壳：统一给一颗关闭按钮。
 *
 * 这些面板以前只能再点一次「工具 → 某某（已开）」才能关，看起来像卡住。
 * 外壳不改面板内部标题，只在顶上加一条关闭栏。
 */
import { NButton } from "naive-ui";

defineEmits<{ close: [] }>();
</script>

<template>
  <div class="tool-pane">
    <div class="tool-pane-bar">
      <n-button size="tiny" quaternary aria-label="关闭" @click="$emit('close')">关闭</n-button>
    </div>
    <div class="tool-pane-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.tool-pane {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

.tool-pane-bar {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
  padding: 4px 8px 0;
}

.tool-pane-body {
  width: 100%;
  min-height: 0;
  min-width: 0;
}
</style>
