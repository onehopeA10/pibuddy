<script setup lang="ts">
/**
 * 权限裁决弹窗（ADR-0002 D3 / SEC-003）。
 *
 * 一次动作被主进程第五道闸挡下后，界面用它向用户申请授权。四档一一对应
 * SEC-003 原文：deny / allow once / allow session / allow workspace。用户点
 * 哪一档，只是把选择交给主进程去**记录**——决策与拦截始终在主进程侧，弹窗
 * 本身不放行任何东西。危险权限（process.git / shell / network / secret）的
 * 持久化授权，主进程还会再弹一次原生确认框（渲染进程伪造不了、绕不开）。
 */
import { computed } from "vue";
import { NButton, NModal, NSpace, NTag, NText } from "naive-ui";
import type { PermissionDisposition } from "@contract";
import { usePermissionStore } from "../stores/permission";

const store = usePermissionStore();
const pending = computed(() => store.pending);

async function choose(disposition: PermissionDisposition): Promise<void> {
  await store.decide(disposition);
}
</script>

<template>
  <n-modal
    :show="pending !== null"
    preset="card"
    title="权限申请"
    :style="{ width: '440px' }"
    :mask-closable="false"
    :closable="false"
  >
    <template v-if="pending">
      <n-space vertical size="large">
        <n-space vertical size="small">
          <n-text depth="3">能力</n-text>
          <n-tag :bordered="false">{{ pending.capabilityId }}</n-tag>
          <n-text depth="3">申请权限</n-text>
          <n-tag type="warning" :bordered="false">{{ pending.permission }}</n-tag>
          <template v-if="pending.resource">
            <n-text depth="3">资源</n-text>
            <n-tag :bordered="false">{{ pending.resource }}</n-tag>
          </template>
        </n-space>
        <n-space justify="end">
          <n-button size="small" @click="choose('deny')">拒绝</n-button>
          <n-button size="small" @click="choose('allow-once')">仅此一次</n-button>
          <n-button size="small" @click="choose('allow-session')">本次运行</n-button>
          <n-button size="small" type="primary" @click="choose('allow-workspace')">
            始终允许（本工作区）
          </n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>
