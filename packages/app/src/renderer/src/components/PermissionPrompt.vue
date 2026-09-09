<script setup lang="ts">
/**
 * 权限裁决弹窗（ADR-0002 D3 / SEC-003）。
 *
 * 一次动作被主进程第五道闸挡下后，界面用它向用户申请授权。四档一一对应
 * SEC-003 原文：deny / allow once / allow session / allow workspace。用户点
 * 哪一档，只是把选择交给主进程去**记录**——决策与拦截始终在主进程侧，弹窗
 * 本身不放行任何东西。危险权限（process.git / shell / network / secret）的
 * 持久化授权，主进程还会再弹一次原生确认框（渲染进程伪造不了、绕不开）。
 *
 * ## 这里显示的每一个字都是**投影**过的
 *
 * `store.pending` 存的是 `projectPermissionPrompt` 的产出，不是原始请求：
 * 控制字符与 BiDi 覆写字符（Trojan Source）已被剥成可见转义、各字段已有界化、
 * 命令若被截断则**截断后仍属同一危险类别**（否则投影抛错，这个框根本不会出现）。
 * 换句话说，「用户看到的那条」和「用户批准的那条」在结构上是同一条——所见即所批。
 */
import { computed } from "vue";
import { NButton, NModal, NSpace, NTag, NText } from "naive-ui";
import type { PermissionDisposition } from "@contract";
import { humanCapability, humanPermission } from "../../../lib/permission-plain";
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
          <n-text depth="3">它想动哪一块</n-text>
          <n-tag :bordered="false">{{ humanCapability(pending.capabilityId) }}</n-tag>
          <n-text depth="3">具体要做什么</n-text>
          <n-tag type="warning" :bordered="false">{{ humanPermission(pending.permission) }}</n-tag>
          <template v-if="pending.resource">
            <n-text depth="3">资源</n-text>
            <n-tag :bordered="false">{{ pending.resource }}</n-tag>
          </template>
          <template v-if="pending.command">
            <n-text depth="3">命令（{{ pending.command.wording }}）</n-text>
            <n-tag type="error" :bordered="false">{{ pending.command.text }}</n-tag>
            <n-text v-if="pending.command.truncated" depth="3">
              已截断显示（原文 {{ pending.command.bytes }} 字节）；截断后仍属
              {{ pending.command.category }} 类，否则本框不会出现
            </n-text>
          </template>
        </n-space>
        <n-space justify="end">
          <n-button size="small" @click="choose('deny')">这次不行</n-button>
          <n-button size="small" @click="choose('allow-once')">就这一次</n-button>
          <n-button size="small" @click="choose('allow-session')">这次对话都行</n-button>
          <n-button size="small" type="primary" @click="choose('allow-workspace')">
            以后在这个文件夹都允许
          </n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>
