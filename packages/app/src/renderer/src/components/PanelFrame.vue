<script setup lang="ts">
import { NDrawer, NDrawerContent, NModal } from "naive-ui";

withDefaults(
  defineProps<{
    embedded?: boolean;
    show?: boolean;
    title?: string;
    width?: string;
    mode?: "modal" | "drawer";
  }>(),
  { mode: "modal", width: "720px" }
);

const emit = defineEmits<{ "update:show": [value: boolean] }>();
</script>

<template>
  <div v-if="embedded" class="panel-frame-embed">
    <slot />
  </div>
  <n-drawer
    v-else-if="mode === 'drawer'"
    :show="show"
    :width="Number.parseInt(width, 10) || 560"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content :title="title" closable>
      <slot />
    </n-drawer-content>
  </n-drawer>
  <n-modal
    v-else
    :show="show"
    preset="card"
    :title="title"
    :style="{ width, maxWidth: '94vw' }"
    @update:show="emit('update:show', $event)"
  >
    <slot />
  </n-modal>
</template>

<style scoped>
.panel-frame-embed {
  min-width: 0;
  height: 100%;
  overflow: auto;
}
</style>
