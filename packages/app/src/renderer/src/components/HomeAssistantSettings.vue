<script setup lang="ts">
/**
 * 设置面的「智能家居」区块（home.assistant / settings.section 插槽）——
 * 能力设置 UI 的第一个消费者。
 *
 * 端点配置（host/port/token）+「保存并授权」+「测试连接」+ 授权与连接状态。
 * token 输入框**永远从空开始**（与 stt 密钥同一口径）：渲染进程拿不到明文，
 * 只显示 {configured, last4}；留空保存 = 不改动。授权的真正确认发生在主进程
 * 原生框上（network.local 危险权限），这里只是把用户选择递过去。
 */
import { computed, ref, watch } from "vue";
import { NAlert, NButton, NInput, NInputNumber, NSpace, NTag } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useHomeAssistantStore } from "../stores/homeAssistant";

const app = useAppStore();
const ha = useHomeAssistantStore();

const workspaceId = computed(() => app.workspaceId);

const hostInput = ref("");
const portInput = ref<number | null>(8123);
const tokenInput = ref("");

const tokenHint = computed(() => {
  const token = ha.config?.token;
  if (!token?.configured) return "";
  return `已配置 ····${token.last4 || "????"}（留空则不改动）`;
});

function adoptConfig(): void {
  hostInput.value = ha.config?.host ?? "";
  portInput.value = ha.config?.port ?? 8123;
  tokenInput.value = "";
}

watch(
  () => workspaceId.value,
  (id) => {
    if (id) void ha.refresh(id).then(adoptConfig);
  },
  { immediate: true }
);

async function saveAndAuthorize(): Promise<void> {
  if (!workspaceId.value || !hostInput.value.trim() || !portInput.value) return;
  await ha.saveAndAuthorize(
    workspaceId.value,
    hostInput.value.trim(),
    portInput.value,
    tokenInput.value.trim()
  );
  adoptConfig();
}

async function testConnection(): Promise<void> {
  if (!workspaceId.value) return;
  await ha.testConnection(workspaceId.value);
}

const wsStatusLabel = computed(() => {
  switch (ha.status?.wsStatus) {
    case "connected":
      return "实时连接中";
    case "connecting":
      return "连接中…";
    case "stale":
      return "已断线（数据可能过期）";
    default:
      return "按需连接（无常驻）";
  }
});
</script>

<template>
  <div style="margin: 16px 0 4px">
    <div style="margin: 0 0 8px; font-size: 13.5px; font-weight: 600">智能家居（Home Assistant）</div>
    <div style="margin: 0 0 10px; font-size: 12.5px; color: #8a8f98">
      填写局域网内 Home Assistant 的地址与长效访问令牌（用户头像 → 安全 → 长效访问令牌）。
      保存后会弹出系统确认框，逐一确认这个 host:port 的访问授权——授权只绑定这一个端点，
      不放开整个内网。
    </div>

    <n-space vertical size="small" style="width: 100%">
      <n-space align="center" :wrap="false">
        <span style="width: 96px; font-size: 13px; color: #4b5563">地址</span>
        <n-input
          v-model:value="hostInput"
          placeholder="homeassistant.local 或 192.168.1.10"
          style="flex: 1"
        />
        <n-input-number
          v-model:value="portInput"
          :min="1"
          :max="65535"
          :show-button="false"
          placeholder="8123"
          style="width: 96px"
        />
      </n-space>
      <n-space align="center" :wrap="false">
        <span style="width: 96px; font-size: 13px; color: #4b5563">访问令牌</span>
        <n-input
          v-model:value="tokenInput"
          type="password"
          show-password-on="click"
          placeholder="eyJhbGci…（long-lived access token）"
          style="flex: 1"
        />
      </n-space>
      <div v-if="tokenHint" style="margin-left: 104px; font-size: 12px; color: #8a8f98">
        {{ tokenHint }}
      </div>

      <n-space align="center">
        <n-button
          size="small"
          type="primary"
          :loading="ha.busy"
          :disabled="!workspaceId || !hostInput.trim() || !portInput"
          @click="saveAndAuthorize"
        >
          保存并授权
        </n-button>
        <n-button
          size="small"
          :loading="ha.testing"
          :disabled="!workspaceId || !ha.config?.configured"
          @click="testConnection"
        >
          测试连接
        </n-button>
        <n-tag v-if="ha.config?.configured" size="small" :type="ha.config?.authorized ? 'success' : 'warning'">
          {{ ha.config?.authorized ? "已授权" : "未授权" }}
        </n-tag>
        <span v-if="ha.status" style="font-size: 12px; color: #8a8f98">{{ wsStatusLabel }}</span>
      </n-space>

      <n-alert
        v-if="ha.testResult"
        :type="ha.testResult.ok ? 'success' : 'error'"
        :title="ha.testResult.ok ? '连接成功' : '连接失败'"
      >
        <p style="white-space: pre-wrap; margin: 0">{{ ha.testResult.message }}</p>
      </n-alert>
      <n-alert v-if="ha.lastError" type="error" title="操作失败">
        <p style="white-space: pre-wrap; margin: 0">{{ ha.lastError }}</p>
      </n-alert>
    </n-space>
  </div>
</template>
