<script setup lang="ts">
/**
 * 连接器面板（connector.webhook / CON-101）。
 *
 * 存在的理由：让「把 Agent 接到外部协作平台」这件事不必打开终端，同时**每一次
 * 出站都经主进程的 network:<domain> 授权 + safeFetch 出站守卫**——面板本身只发
 * 意图（建 / 改 / 删 / 启停 / 自检 / 推送），凭证只进不出（列表里只有 domain +
 * configured + last4），未授权时由 connector store 唤起「去授权」弹窗。
 */
import { computed, onMounted, ref } from "vue";
import { NButton, NInput, NSwitch, NTag } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useConnectorStore } from "../stores/connector";

const app = useAppStore();
const connector = useConnectorStore();

const workspaceId = computed(() => app.workspaceId);

const newName = ref("");
const newUrl = ref("");
/** connectorId → 待推送的文本。 */
const drafts = ref<Record<string, string>>({});

onMounted(() => {
  void connector.refresh();
});

async function onCreate(): Promise<void> {
  if (!newName.value.trim() || !newUrl.value.trim()) return;
  const ok = await connector.create(newName.value.trim(), newUrl.value.trim());
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
      <strong>连接器</strong>
      <span class="cp-sub">把 Agent 接到外部协作平台的自定义机器人 webhook</span>
    </header>

    <!-- 新建 -->
    <section class="cp-create">
      <n-input v-model:value="newName" size="small" placeholder="名称（如：飞书研发群）" />
      <n-input
        v-model:value="newUrl"
        size="small"
        type="text"
        placeholder="Webhook 地址（https://…，仅支持受信任平台域名）"
      />
      <n-button size="small" type="primary" :loading="connector.busy" @click="onCreate">
        添加连接器
      </n-button>
    </section>

    <p v-if="connector.lastError" class="cp-error">{{ connector.lastError }}</p>

    <!-- 列表 -->
    <section v-if="connector.hasAny" class="cp-list">
      <div v-for="c in connector.connectors" :key="c.id" class="cp-item">
        <div class="cp-item-head">
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
          <n-input
            v-model:value="drafts[c.id]"
            size="tiny"
            placeholder="要推送的文本…"
          />
          <n-button
            size="tiny"
            :disabled="!workspaceId || !drafts[c.id]"
            @click="connector.send(c.id, workspaceId!, drafts[c.id]!)"
          >
            推送
          </n-button>
          <n-button
            size="tiny"
            :disabled="!workspaceId"
            @click="connector.test(c.id, workspaceId!)"
          >
            连接测试
          </n-button>
          <n-button size="tiny" quaternary @click="connector.remove(c.id)">删除</n-button>
        </div>
      </div>
    </section>

    <p v-else class="cp-empty">还没有连接器。填好名称与 webhook 地址即可添加。</p>

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
  gap: 10px;
  padding: 12px;
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
  border-radius: 6px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
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
