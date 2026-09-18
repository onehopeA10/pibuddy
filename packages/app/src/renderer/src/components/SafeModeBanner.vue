<script setup lang="ts">
/**
 * 安全模式横幅（UPD-006）。
 *
 * 进了安全模式的用户看到的第一句话，必须是**具体发生了什么、什么被关了、
 * 我现在能做什么**，而不是一句「已进入安全模式」。因此这里逐条列出被禁用
 * 的能力，并给两个出口：看诊断、下载上一稳定版本。
 *
 * 「下载上一稳定版本」是链接到发布页，不是自动回滚 —— v1 不做真实的二进制
 * 回滚，界面上也就不许摆一个看起来像回滚的按钮（见 ADR-0001）。
 */
import { onMounted, ref } from "vue";
import { NAlert, NButton, NSpace } from "naive-ui";
import type { SafeModeState } from "@contract";
import { useAppStore } from "../stores/app";

const store = useAppStore();
const state = ref<SafeModeState | null>(null);
const failed = ref<string[]>([]);

onMounted(async () => {
  try {
    const report = await window.piBuddy.diagnostics.getHealthReport();
    state.value = report.safeMode;
    failed.value = report.health?.failed ?? [];
  } catch {
    // 诊断读不出来不该让主界面挂掉
    state.value = null;
  }
});

const FAILED_LABEL: Record<string, string> = {
  "db-migration": "会话索引升级",
  "renderer-ready": "界面加载",
  "pi-handshake": "内置 Pi 运行时",
};

function openDiagnostics(): void {
  store.settingsOpen = true;
}
</script>

<template>
  <n-alert
    v-if="state?.active"
    type="warning"
    title="已进入安全模式"
    style="margin: 8px 12px 0"
  >
    <p style="margin: 0 0 6px">
      上次更新之后启动检查连续失败
      <strong>{{ state.consecutiveFailures }}</strong> 次<span v-if="failed.length">
        （{{ failed.map((f) => FAILED_LABEL[f] ?? f).join("、") }}）</span
      >。为了让你能把东西导出来，以下功能已被暂时关闭：
    </p>
    <ul style="margin: 0 0 8px; padding-left: 20px">
      <li v-for="item in state.disabled" :key="item">{{ item }}</li>
    </ul>
    <p v-if="state.previousVersion" style="margin: 0 0 8px; font-size: var(--font-ui-12); color: var(--text-tertiary)">
      上一个正常启动过的版本是 {{ state.previousVersion }}。PiBuddy
      不会自动把你降回去 —— 需要的话请自行下载安装。
    </p>
    <n-space>
      <n-button size="small" @click="openDiagnostics">查看诊断</n-button>
      <n-button
        v-if="state.previousVersion"
        size="small"
        tag="a"
        href="https://github.com/onehopeA10/pibuddy/releases"
        target="_blank"
        rel="noreferrer"
      >
        下载上一稳定版本（{{ state.previousVersion }}）
      </n-button>
    </n-space>
  </n-alert>
</template>
