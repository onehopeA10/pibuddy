<script setup lang="ts">
/**
 * 预置办公技能面板（common.office-skills，REQ-0001 R2）。
 *
 * 一组静态卡片 + 一条只读通道：每张卡片说明「这个技能是干什么的、对 agent
 * 说什么就能用起来」，右上角的徽标显示**可证伪的**物化状态——来源是主进程
 * 读 R4 归属账本的结果，不是面板自己认定的「应该已就绪」。
 *
 * 技能的执行不在这里：用户在会话里直接吩咐，pi agent 按 SKILL.md 干活。
 * 「说到输入框」只是把用法填进 composer，不是假装在这里运行。
 */
import { onMounted, ref } from "vue";
import { NButton, NSpin, NTag } from "naive-ui";
import type { OfficeSkillStatus, OfficeSkillsState } from "@contract";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const state = ref<OfficeSkillsState | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

function promptOf(skill: OfficeSkillStatus): string {
  const quoted = skill.usageHint.match(/「(.+)」/);
  return quoted?.[1]?.trim() || skill.usageHint;
}

function fillComposer(skill: OfficeSkillStatus): void {
  app.editorText = promptOf(skill);
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    state.value = await window.piBuddy.officeSkills.list();
  } catch (err) {
    error.value = String((err as Error).message ?? err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void reload());
</script>

<template>
  <aside class="office-skills-panel">
    <header class="head">
      <span class="title">🗂️ 办公技能</span>
      <span class="count" v-if="state">{{ state.skills.length }} 个预置技能</span>
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
          <div class="card-actions">
            <NButton size="tiny" type="primary" secondary :disabled="!skill.materialized" @click="fillComposer(skill)">
              说到输入框
            </NButton>
            <span v-if="skill.materialized" class="files">{{ skill.fileCount }} 个文件已就绪</span>
          </div>
        </article>
        <p class="foot-hint">
          点「说到输入框」再发送即可。助手会按写好的规程先预览、经你确认才动手。
          停用本能力包并重启，会把物化的技能收回（你自己改过的文件会保留）。
        </p>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.office-skills-panel {
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
.msg.notice {
  color: #92400e;
  background: #fffbeb;
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
.summary {
  margin: 6px 0 0;
  font-size: 12px;
  color: #334155;
  line-height: 1.5;
}
.usage {
  margin: 6px 0 0;
  font-size: 12px;
  color: #0f766e;
  line-height: 1.5;
}
.card-actions {
  margin: 8px 0 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.files {
  font-size: 11px;
  color: #64748b;
}
.foot-hint {
  margin: 2px 0 0;
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.6;
}
</style>
