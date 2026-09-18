<script setup lang="ts">
/**
 * 真实渠道面板（connector.feishu / connector.slack / connector.telegram）。
 *
 * 与通用 webhook 面板同一套「意图只进不出、凭证不回渲染进程、出站经权限授权 +
 * safeFetch」的口径，只是把三个真实渠道单列出来：建连接器时选平台（域名上界随之
 * 收紧到该平台的一个 host），推送走**平台专属通道**（`sendVia`：消息体按平台文档
 * 拼、授权按平台 capabilityId 判）。这三个渠道各自是一份能力包（可在能力中心单独
 * 启停），此面板只呈现已建的渠道实例并转达意图。
 */
import { computed, onMounted, ref } from "vue";
import { NButton, NInput, NSelect, NSwitch, NTag } from "naive-ui";
import type { ConnectorKind } from "@contract";
import { useAppStore } from "../stores/app";
import { useConnectorStore } from "../stores/connector";

const app = useAppStore();
const connector = useConnectorStore();

const workspaceId = computed(() => app.workspaceId);

/** 本面板只管三个真实渠道，通用 webhook 归 ConnectorPanel。 */
const CHANNEL_KINDS = ["feishu", "slack", "telegram"] as const;
type ChannelKind = (typeof CHANNEL_KINDS)[number];

const KIND_LABEL: Record<ChannelKind, string> = {
  feishu: "飞书",
  slack: "Slack",
  telegram: "Telegram",
};
const KIND_HINT: Record<ChannelKind, string> = {
  feishu: "自定义机器人 webhook：https://open.feishu.cn/open-apis/bot/v2/hook/…",
  slack: "Incoming Webhook：https://hooks.slack.com/services/…",
  telegram: "sendMessage（含 chat_id）：https://api.telegram.org/bot<token>/sendMessage?chat_id=…",
};

const kindOptions = CHANNEL_KINDS.map((k) => ({ label: KIND_LABEL[k], value: k }));

const newKind = ref<ChannelKind>("feishu");
const newName = ref("");
const newUrl = ref("");
/** connectorId → 待推送文本。 */
const drafts = ref<Record<string, string>>({});

/** 只显示三个真实渠道的实例。 */
const channels = computed(() =>
  connector.connectors.filter((c) => (CHANNEL_KINDS as readonly string[]).includes(c.kind))
);

onMounted(() => {
  void connector.refresh();
});

async function onCreate(): Promise<void> {
  if (!newName.value.trim() || !newUrl.value.trim()) return;
  const ok = await connector.createChannel(
    newKind.value as ConnectorKind,
    newName.value.trim(),
    newUrl.value.trim()
  );
  if (ok) {
    newName.value = "";
    newUrl.value = "";
  }
}

function resultTag(errorCode: string | undefined): "success" | "warning" | "error" | "default" {
  if (errorCode === "ok") return "success";
  if (errorCode === "permission" || errorCode === "domain" || errorCode === "config") return "warning";
  if (errorCode === "ssrf" || errorCode === "network") return "error";
  return "default";
}
</script>

<template>
  <div class="connector-panel">
    <header class="cp-head">
      <strong>渠道</strong>
      <span class="cp-sub">飞书 / Slack / Telegram —— 各自一份能力包，凭证加密留在本机</span>
    </header>

    <!-- 新建 -->
    <section class="cp-create">
      <n-select v-model:value="newKind" size="small" :options="kindOptions" />
      <n-input v-model:value="newName" size="small" placeholder="名称（如：研发群机器人）" />
      <n-input v-model:value="newUrl" size="small" type="text" :placeholder="KIND_HINT[newKind]" />
      <n-button size="small" type="primary" :loading="connector.busy" @click="onCreate">
        添加 {{ KIND_LABEL[newKind] }} 渠道
      </n-button>
    </section>

    <p v-if="connector.lastError" class="cp-error">{{ connector.lastError }}</p>

    <!-- 列表 -->
    <section v-if="channels.length > 0" class="cp-list">
      <div v-for="c in channels" :key="c.id" class="cp-item">
        <div class="cp-item-head">
          <n-tag size="small" type="info" :bordered="false">{{ KIND_LABEL[c.kind as ChannelKind] }}</n-tag>
          <span class="cp-name">{{ c.displayName }}</span>
          <n-tag size="small" :bordered="false">{{ c.domain }}</n-tag>
          <n-tag v-if="c.configured" size="small" type="success" :bordered="false">
            凭证 ····{{ c.last4 }}
          </n-tag>
          <n-tag v-else size="small" type="warning" :bordered="false">未配置凭证</n-tag>
          <n-switch
            size="small"
            :value="c.enabled"
            @update:value="(v: boolean) => connector.setEnabled(c.id, v)"
          />
        </div>

        <div class="cp-item-actions">
          <n-input v-model:value="drafts[c.id]" size="tiny" placeholder="要推送的文本…" />
          <n-button
            size="tiny"
            :disabled="!workspaceId || !drafts[c.id]"
            @click="connector.sendVia(c.kind, c.id, workspaceId!, drafts[c.id]!)"
          >
            推送
          </n-button>
          <n-button size="tiny" :disabled="!workspaceId" @click="connector.test(c.id, workspaceId!)">
            连接测试
          </n-button>
          <n-button size="tiny" quaternary @click="connector.remove(c.id)">删除</n-button>
        </div>
      </div>
    </section>

    <p v-else class="cp-empty">还没有渠道。选平台、填名称与地址即可添加。</p>

    <!-- 上一次出站结果 -->
    <section v-if="connector.lastResult" class="cp-result">
      <n-tag size="small" :type="resultTag(connector.lastResult.errorCode)" :bordered="false">
        {{ connector.lastResult.ok ? "已送达" : connector.lastResult.errorCode }}
      </n-tag>
      <span>{{ connector.lastResult.redactedMessage }}</span>
    </section>
  </div>
</template>

<style scoped>
.connector-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 0 8px;
  min-width: 280px;
  overflow-y: auto;
}
.cp-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cp-sub {
  font-size: 12px;
  opacity: 0.6;
}
.cp-create {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.cp-create :deep(.n-input),
.cp-create :deep(.n-select) {
  width: 100%;
  max-width: 560px;
}
.cp-error {
  color: var(--status-error);
  font-size: 12px;
  margin: 0;
}
.cp-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cp-item {
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-l);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cp-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.cp-name {
  font-weight: 600;
}
.cp-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.cp-empty {
  font-size: 12px;
  opacity: 0.6;
}
.cp-result {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
</style>
