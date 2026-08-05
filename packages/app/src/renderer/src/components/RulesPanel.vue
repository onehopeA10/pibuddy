<script setup lang="ts">
/**
 * 家居自动化规则面板（home.automation / 智能家居 Phase B）。
 *
 * v1 刻意只做**列表 / 启停 / 删除**：规则的创建与修改走会话对话（agent 用
 * manage_rule 工具落库），面板顶部给一句引导话术。不做表单编辑器——触发器 /
 * 条件 / 动作的组合面在对话里表达比在表单里表达自然得多，等真实使用长出
 * 高频形态再谈编辑器。每个动作的返回都是主进程权威快照，「点了没反应」在
 * 结构上不成立。
 */
import { computed, onMounted, watch } from "vue";
import { NButton, NEmpty, NPopconfirm, NSpin, NSwitch, NTag } from "naive-ui";
import type { AutomationAction, AutomationRule } from "@contract";
import { useAppStore } from "../stores/app";
import { useHomeAutomationStore } from "../stores/homeAutomation";

const app = useAppStore();
const store = useHomeAutomationStore();
const workspaceId = computed(() => app.workspaceId);

function reload(): void {
  if (workspaceId.value) void store.refresh(workspaceId.value);
}

onMounted(reload);
watch(workspaceId, reload);

/** 触发器的一句话摘要。 */
function triggerText(rule: AutomationRule): string {
  const t = rule.trigger;
  if (t.kind === "time") return `每天 ${t.time}`;
  const parts = [t.entityId];
  if (t.from !== undefined) parts.push(`从 ${t.from}`);
  parts.push(t.to !== undefined ? `变为 ${t.to}` : "状态变化");
  return parts.join(" ");
}

/** 单个动作的短标签。 */
function actionText(action: AutomationAction): string {
  if (action.kind === "service") {
    return `${action.domain}.${action.service}${action.entityId ? ` → ${action.entityId}` : ""}`;
  }
  if (action.kind === "notify") return "通知";
  return "Agent 任务";
}

function toggle(rule: AutomationRule, enabled: boolean): void {
  if (workspaceId.value) void store.setEnabled(workspaceId.value, rule.id, enabled);
}

function remove(rule: AutomationRule): void {
  if (workspaceId.value) void store.remove(workspaceId.value, rule.id);
}
</script>

<template>
  <aside class="rules-panel">
    <header class="head">
      <span class="title">⚙️ 自动化规则</span>
      <span class="count">{{ store.rules.length }} 条</span>
      <NButton size="tiny" quaternary :loading="store.loading" @click="reload">刷新</NButton>
    </header>

    <p v-if="store.lastError" class="msg error">{{ store.lastError }}</p>
    <p class="msg hint">
      在会话里直接吩咐即可建规则，例如「客厅灯亮起时打开烧水壶」「每天 23:00 帮我总结今天的用电」
      ——AI 助手会用 manage_rule 工具落成规则；这里管启停与删除。
    </p>

    <div class="body">
      <NSpin v-if="store.loading && store.rules.length === 0" size="small" />
      <NEmpty
        v-else-if="store.rules.length === 0"
        size="small"
        description="还没有自动化规则"
      />
      <article v-for="rule in store.rules" :key="rule.id" class="card">
        <div class="card-head">
          <span class="card-title">{{ rule.name }}</span>
          <NSwitch
            size="small"
            :value="rule.enabled"
            :loading="store.busyRuleId === rule.id"
            @update:value="(v: boolean) => toggle(rule, v)"
          />
        </div>
        <p class="line">触发：{{ triggerText(rule) }}</p>
        <p class="line">
          动作：
          <NTag
            v-for="(action, i) in rule.actions"
            :key="i"
            size="small"
            :bordered="false"
            :type="action.kind === 'agent' ? 'info' : 'default'"
            class="action-tag"
          >
            {{ actionText(action) }}
          </NTag>
        </p>
        <p v-if="rule.lastError" class="line error-line">上次执行失败：{{ rule.lastError }}</p>
        <p v-else-if="rule.lastFiredAt" class="line fired-line">
          上次触发：{{ new Date(rule.lastFiredAt).toLocaleString() }}
        </p>
        <div class="card-foot">
          <NPopconfirm @positive-click="remove(rule)">
            <template #trigger>
              <NButton size="tiny" quaternary type="error" :loading="store.busyRuleId === rule.id">
                删除
              </NButton>
            </template>
            删除规则「{{ rule.name }}」？它的 Agent 后台任务会一并删除。
          </NPopconfirm>
        </div>
      </article>
    </div>
  </aside>
</template>

<style scoped>
.rules-panel {
  display: flex;
  flex-direction: column;
  width: 320px;
  height: 100%;
  border-left: 1px solid var(--border-color, #e2e8f0);
  background: var(--panel-bg, #fff);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color, #e2e8f0);
}
.title {
  font-weight: 600;
  font-size: 13px;
}
.count {
  font-size: 11px;
  color: #64748b;
  margin-right: auto;
}
.msg {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
}
.msg.error {
  color: #b91c1c;
  background: #fef2f2;
}
.msg.hint {
  color: #64748b;
  background: #f8fafc;
  line-height: 1.5;
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
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 8px;
  padding: 10px 12px;
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
.line {
  margin: 6px 0 0;
  font-size: 12px;
  color: #334155;
  line-height: 1.5;
}
.action-tag {
  margin-right: 4px;
}
.error-line {
  color: #b91c1c;
}
.fired-line {
  color: #64748b;
}
.card-foot {
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
}
</style>
