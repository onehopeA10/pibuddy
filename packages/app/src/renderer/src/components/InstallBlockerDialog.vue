<script setup lang="ts">
/**
 * 安装前的阻断对话框（UPD-004）。
 *
 * 自动更新最容易造成的真实损失不是装错版本，而是**在用户还有东西没保存的
 * 时候把应用关掉**。因此「立即重启安装」在有阻断项时不会直接执行，而是把
 * 清单摊开给用户，让他三选一：
 *
 *   等任务结束后安装 —— 进 waiting-for-agent，收到真实的 agent_settled
 *                       事件后才安装（订阅，不是轮询）
 *   停止任务并安装   —— 明确知道自己在丢什么
 *   取消             —— 什么都不做
 *
 * 三个按钮里没有默认焦点在「停止任务并安装」上，这是刻意的：回车不该
 * 意味着丢东西。
 */
import { computed } from "vue";
import { NButton, NModal, NSpace } from "naive-ui";
import { useUpdateStore } from "../stores/update";

const store = useUpdateStore();

/**
 * 只在「用户点过安装、且主进程回了阻断清单」时弹。
 * waiting-for-agent 已经是用户做过选择之后的状态，不再弹第二次。
 */
const show = computed(() => store.blockerDialogOpen && store.blockers.length > 0);
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="max-width: 420px"
    title="现在重启会丢东西"
    :closable="false"
    :mask-closable="false"
  >
    <p style="margin: 0 0 8px; font-size: 13px; color: #4b5563">
      更新已经下载好了，但现在重启会打断下面这些：
    </p>
    <ul style="margin: 0 0 14px; padding-left: 20px; font-size: 13px; color: #1f2937">
      <li v-for="b in store.blockers" :key="b.kind">{{ b.label }}</li>
    </ul>

    <n-space justify="end">
      <n-button size="small" @click="store.install('wait')">等任务结束后安装</n-button>
      <n-button size="small" type="warning" @click="store.install('force')">
        停止任务并安装
      </n-button>
      <n-button size="small" quaternary @click="store.closeBlockerDialog()">取消</n-button>
    </n-space>
  </n-modal>
</template>
