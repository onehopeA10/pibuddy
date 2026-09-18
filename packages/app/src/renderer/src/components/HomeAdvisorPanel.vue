<script setup lang="ts">
/**
 * 家居场景建议面板（home.advisor，家居四包里最轻的纯 skill 内容包）。
 *
 * 两张静态卡片 + 一条只读通道：每张卡片说明「这个技能是干什么的、对 agent
 * 说什么就能用起来」，徽标显示**可证伪的**物化状态——来源是主进程读 R4
 * 归属账本的结果，不是面板自己认定的「应该已就绪」。
 *
 * 这是本包合规所需的最薄 UI（drift 2 要求 uiContributions 的组件真实存在、
 * 被宿主挂载且做启用门控）：与 OfficeSkillsPanel 同款形态，不建 store——
 * 一条无参只读通道用不着状态管理。技能的执行不在这里：用户在会话里直接
 * 吩咐，pi agent 按 SKILL.md 的操作规程干活（用 home.assistant 基座的工具）。
 * 面板因此没有任何「运行」按钮。
 */
import { onMounted, ref } from "vue";
import { NButton, NSpin, NTag } from "naive-ui";
import type { HomeAdvisorState } from "@contract";

const state = ref<HomeAdvisorState | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    state.value = await window.piBuddy.homeAdvisor.skillsStatus();
  } catch (err) {
    error.value = String((err as Error).message ?? err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void reload());
</script>

<template>
  <aside class="home-advisor-panel">
    <header class="head">
      <span class="title">家居建议</span>
      <span class="count" v-if="state">{{ state.skills.length }} 个建议技能</span>
      <NButton size="tiny" quaternary :loading="loading" @click="reload">刷新</NButton>
    </header>

    <p v-if="error" class="msg error">{{ error }}</p>
    <p v-else-if="state && !state.ledgerFound" class="msg notice">
      技能还没物化（首次启用需要重启应用一次）。重启后这里会显示「已就绪」。
    </p>

    <div class="body">
      <NSpin v-if="loading && !state" size="small" />
      <template v-else-if="state">
        <article v-for="skill in state.skills" :key="skill.name" class="card">
          <div class="card-head">
            <span class="card-title">{{ skill.title }}</span>
            <NTag size="small" :type="skill.materialized ? 'success' : 'warning'" :bordered="false">
              {{ skill.materialized ? "已就绪" : "待重启物化" }}
            </NTag>
          </div>
          <p class="summary">{{ skill.summary }}</p>
          <p class="usage">{{ skill.usageHint }}</p>
        </article>
        <p class="foot-hint">
          建议技能只出方案不动设备：AI 助手先盘点设备、了解作息，给出带风险提示的建议清单，
          经你确认才落地成自动化规则。停用本能力包并重启，会把物化的技能收回。
        </p>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.home-advisor-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  border-top: var(--border-w) solid var(--border-subtle);
  padding: 8px;
  min-height: 240px;
  max-height: 420px;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.title {
  font-weight: 600;
  font-size: 13px;
}
.count {
  font-size: 11px;
  color: var(--text-secondary);
  margin-right: auto;
}
.msg {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
}
.msg.error {
  color: var(--status-error);
  background: var(--danger-bg);
}
.msg.notice {
  color: var(--status-warning);
  background: var(--warning-bg);
}
.body {
  flex: 1;
  overflow: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card {
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-l);
  padding: 14px 16px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.card-title {
  font-weight: 600;
  font-size: 13px;
}
.summary {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.5;
}
.usage {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--status-info);
  line-height: 1.5;
}
.foot-hint {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.6;
}
</style>
