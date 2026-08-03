<script setup lang="ts">
/**
 * 子 Agent 编排面板（AGT-102）。
 *
 * 展示父子拓扑、每个子的状态 / 成本 / 最近活动 / 阻塞 / 证据 / patch/commit /
 * 最终结果；cancel 向子树传播；子的结构化提问就地回答；coding 子的 worktree
 * 改动就地裁决合并。创建子时给出目标 / 输入 / 模型 / 预算 / 权限继承 / 超时 /
 * 交付物 / 是否独立 worktree / 是否幂等。
 *
 * 挂载点是 AppShell 的 main slot（能力门控 common.child-agent），与 GitPanel /
 * TasksPanel 等并列。
 */
import { computed, onMounted, ref } from "vue";
import {
  NButton,
  NInput,
  NInputNumber,
  NCheckbox,
  NCard,
  NTag,
  NSpace,
  NEmpty,
  useMessage,
} from "naive-ui";
import type { ChildNodeView, ChildSpec, ChildStatus } from "@contract";
import { useChildAgentStore } from "../stores/child-agent";

const store = useChildAgentStore();
const message = useMessage();

onMounted(() => {
  void store.init();
});

/** DFS 展平拓扑，带 depth，用于缩进渲染父子关系。 */
const flat = computed(() => {
  const out: Array<{ node: ChildNodeView; depth: number }> = [];
  const byParent = store.childrenOf;
  const walk = (node: ChildNodeView, depth: number): void => {
    out.push({ node, depth });
    for (const child of byParent.get(node.nodeId) ?? []) walk(child, depth + 1);
  };
  for (const root of store.roots) walk(root, 0);
  return out;
});

const STATUS_TAG: Record<ChildStatus, "default" | "info" | "success" | "warning" | "error"> = {
  pending: "default",
  running: "info",
  waiting_answer: "warning",
  blocked: "warning",
  succeeded: "success",
  failed: "error",
  cancelled: "default",
  timed_out: "error",
};

const STATUS_LABEL: Record<ChildStatus, string> = {
  pending: "排队",
  running: "运行中",
  waiting_answer: "等待回答",
  blocked: "阻塞",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时",
};

// ---- 创建子 Agent 表单 ----
const showCreate = ref(false);
const createParentId = ref<string | null>(null);
const form = ref({
  goal: "",
  input: "",
  budgetUsd: 0,
  timeoutMs: 0,
  inheritPermissions: true,
  isolatedWorktree: false,
  idempotent: false,
  retryBudget: 1,
  deliverables: "",
});

function openCreate(parentId: string | null): void {
  createParentId.value = parentId;
  form.value = {
    goal: "",
    input: "",
    budgetUsd: 0,
    timeoutMs: 0,
    inheritPermissions: true,
    isolatedWorktree: false,
    idempotent: false,
    retryBudget: 1,
    deliverables: "",
  };
  showCreate.value = true;
}

async function submitCreate(): Promise<void> {
  const goal = form.value.goal.trim();
  if (!goal) {
    message.warning("请填写目标");
    return;
  }
  const spec: ChildSpec = {
    goal,
    input: form.value.input,
    workspaceId: null,
    model: null,
    budgetUsd: form.value.budgetUsd,
    timeoutMs: form.value.timeoutMs,
    inheritPermissions: form.value.inheritPermissions,
    deliverables: form.value.deliverables
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    isolatedWorktree: form.value.isolatedWorktree,
    idempotent: form.value.idempotent,
    retryBudget: form.value.retryBudget,
  };
  await store.create(createParentId.value, spec);
  showCreate.value = false;
}

// ---- 回答子的提问 ----
const answerText = ref<Record<string, string>>({});
async function submitAnswer(node: ChildNodeView): Promise<void> {
  if (!node.question) return;
  await store.answer(node.nodeId, node.question.id, answerText.value[node.nodeId] ?? "");
  answerText.value[node.nodeId] = "";
}

async function onCancel(nodeId: string): Promise<void> {
  await store.cancel(nodeId);
}

async function onMerge(nodeId: string, accept: boolean): Promise<void> {
  await store.resolveMerge(nodeId, accept);
}
</script>

<template>
  <div class="child-agent-panel">
    <div class="header">
      <strong>子 Agent 编排</strong>
      <NSpace :size="6">
        <NTag
          v-for="(count, provider) in store.providerInFlight"
          :key="provider"
          size="small"
          type="info"
          :bordered="false"
        >
          {{ provider }} 在飞 {{ count }}/{{ store.providerConcurrencyCap }}
        </NTag>
        <NButton size="tiny" type="primary" @click="openCreate(null)">+ 新建子 Agent</NButton>
      </NSpace>
    </div>

    <NEmpty v-if="flat.length === 0" description="还没有子 Agent。新建一个把子任务交给它。" />

    <div v-else class="tree">
      <NCard
        v-for="{ node, depth } in flat"
        :key="node.nodeId"
        size="small"
        class="node"
        :style="{ marginLeft: depth * 20 + 'px' }"
      >
        <div class="node-head">
          <NTag :type="STATUS_TAG[node.status]" size="small" :bordered="false">
            {{ STATUS_LABEL[node.status] }}
          </NTag>
          <span class="goal">{{ node.goal }}</span>
          <span class="spacer" />
          <span class="cost">
            ${{ node.costUsd.toFixed(2) }}<span v-if="node.budgetUsd > 0">/{{ node.budgetUsd }}</span>
          </span>
        </div>

        <div class="meta">
          <NTag v-if="node.isolatedWorktree" size="tiny" :bordered="false">独立 worktree</NTag>
          <NTag size="tiny" :bordered="false">{{ node.idempotent ? "幂等" : "非幂等" }}</NTag>
          <NTag v-if="!node.inheritPermissions" size="tiny" :bordered="false">权限独立</NTag>
          <NTag v-if="node.retryBudget > 0" size="tiny" :bordered="false">
            重试 {{ node.retryCount }}/{{ node.retryBudget }}
          </NTag>
        </div>

        <div v-if="node.progress" class="progress">
          进展：{{ node.progress.note }}
          <span v-if="node.progress.fraction !== null">（{{ Math.round(node.progress.fraction * 100) }}%）</span>
        </div>

        <div v-if="node.blockedReason" class="blocked">⚠ {{ node.blockedReason }}</div>

        <div v-if="node.deliverables.length" class="deliverables">
          交付物：<span v-for="d in node.deliverables" :key="d" class="chip">{{ d }}</span>
        </div>

        <div v-if="node.evidence.length" class="evidence">
          <div v-for="(e, i) in node.evidence" :key="i" class="ev">
            <NTag size="tiny" :bordered="false">{{ e.kind }}</NTag>
            <span class="ev-title">{{ e.title }}</span>
          </div>
        </div>

        <div v-if="node.question" class="question">
          <div class="q-prompt">❓ {{ node.question.prompt }}</div>
          <NSpace :size="6">
            <NInput
              v-model:value="answerText[node.nodeId]"
              size="small"
              placeholder="回答子 Agent…"
              style="max-width: 320px"
            />
            <NButton size="tiny" type="primary" @click="submitAnswer(node)">回答</NButton>
          </NSpace>
        </div>

        <div v-if="node.pendingMerge" class="merge">
          <div>
            🔀 待裁决合并：{{ node.pendingMerge.patchTitle }}
            <NTag v-if="node.pendingMerge.hasConflict" type="error" size="tiny" :bordered="false">
              有冲突
            </NTag>
          </div>
          <NSpace :size="6">
            <NButton size="tiny" type="success" @click="onMerge(node.nodeId, true)">合并</NButton>
            <NButton size="tiny" type="error" @click="onMerge(node.nodeId, false)">拒绝</NButton>
          </NSpace>
        </div>

        <div v-if="node.result" class="result">
          <NTag :type="node.result.ok ? 'success' : 'error'" size="tiny" :bordered="false">
            {{ node.result.ok ? "结果" : "失败" }}
          </NTag>
          {{ node.result.summary }}
        </div>

        <div class="actions">
          <NButton size="tiny" quaternary @click="openCreate(node.nodeId)">+ 子任务</NButton>
          <NButton
            v-if="node.status === 'running' || node.status === 'pending' || node.status === 'waiting_answer' || node.status === 'blocked'"
            size="tiny"
            quaternary
            type="error"
            @click="onCancel(node.nodeId)"
          >
            取消（含子树）
          </NButton>
        </div>
      </NCard>
    </div>

    <!-- 创建子 Agent 表单 -->
    <NCard v-if="showCreate" size="small" class="create-form" title="新建子 Agent">
      <NSpace vertical :size="8">
        <NInput v-model:value="form.goal" placeholder="目标：子 Agent 要达成什么（必填）" />
        <NInput
          v-model:value="form.input"
          type="textarea"
          :rows="3"
          placeholder="输入 / 上下文：交给子的材料"
        />
        <NInput
          v-model:value="form.deliverables"
          type="textarea"
          :rows="2"
          placeholder="预期交付物（每行一个）"
        />
        <NSpace :size="10">
          <span>预算 $ <NInputNumber v-model:value="form.budgetUsd" size="small" :min="0" style="width: 100px" /></span>
          <span>超时 ms <NInputNumber v-model:value="form.timeoutMs" size="small" :min="0" style="width: 120px" /></span>
          <span>重试 <NInputNumber v-model:value="form.retryBudget" size="small" :min="0" style="width: 80px" /></span>
        </NSpace>
        <NSpace :size="14">
          <NCheckbox v-model:checked="form.inheritPermissions">继承父权限</NCheckbox>
          <NCheckbox v-model:checked="form.isolatedWorktree">独立 worktree（coding）</NCheckbox>
          <NCheckbox v-model:checked="form.idempotent">幂等（断线可自动重放）</NCheckbox>
        </NSpace>
        <NSpace :size="6">
          <NButton size="small" type="primary" @click="submitCreate">创建</NButton>
          <NButton size="small" quaternary @click="showCreate = false">取消</NButton>
        </NSpace>
      </NSpace>
    </NCard>
  </div>
</template>

<style scoped>
.child-agent-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: auto;
  height: 100%;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tree {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.node-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.node-head .goal {
  font-weight: 500;
}
.node-head .spacer {
  flex: 1;
}
.node-head .cost {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
.meta,
.evidence,
.deliverables {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.chip {
  padding: 0 6px;
  border-radius: 6px;
  background: rgba(99, 102, 241, 0.1);
  margin-right: 4px;
}
.ev {
  display: flex;
  align-items: center;
  gap: 4px;
}
.progress,
.result {
  margin-top: 4px;
  font-size: 13px;
}
.blocked {
  margin-top: 4px;
  color: #d97706;
  font-size: 13px;
}
.question,
.merge {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.03);
}
.q-prompt {
  margin-bottom: 4px;
}
.actions {
  margin-top: 6px;
  display: flex;
  gap: 6px;
}
.create-form {
  margin-top: 8px;
}
</style>
