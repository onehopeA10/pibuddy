<script setup lang="ts">
import { computed } from "vue";
import { NButton, NSelect, NTag, NTooltip } from "naive-ui";
import type { SelectOption, SelectGroupOption } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useExtensionUiStore } from "../stores/extensionUi";
import { usePiResourcesStore } from "../stores/piResources";
import { useProvidersStore } from "../stores/providers";
import StatusCenter from "./StatusCenter.vue";
import type { ThinkingLevel } from "@sdk";

const store = useAppStore();
const providers = useProvidersStore();
/**
 * 扩展上报的窗口标题（rpc.md:1300 setTitle）。
 *
 * 前缀与 60 字符截断在 store 的 displayTitle 里做，不在模板里做：
 * 模板里做意味着「改了模板、测试还绿」。扩展可以上报任意长度的标题，
 * 不截断会静默撑破顶栏布局 —— 不报错，只是模型选择框被挤出可视区。
 */
const extUi = useExtensionUiStore();
const piRes = usePiResourcesStore();

const folderName = computed(() => {
  const ws = store.workspace;
  return ws.split(/[\\/]/).filter(Boolean).pop() ?? ws;
});

const modelValue = computed(() =>
  store.currentModel ? `${store.currentModel.provider}::${store.currentModel.id}` : null
);

const modelOptions = computed<(SelectOption | SelectGroupOption)[]>(() => {
  const byProvider = new Map<string, SelectOption[]>();
  for (const m of store.models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push({ label: m.name || m.id, value: `${m.provider}::${m.id}` });
    byProvider.set(m.provider, list);
  }
  return [...byProvider.entries()].map(([provider, children]) => ({
    type: "group",
    label: provider,
    key: provider,
    children,
  }));
});

function onModelChange(value: string): void {
  const [provider, ...rest] = value.split("::");
  void store.setModel(provider, rest.join("::"));
}

const THINKING_LABELS: Record<string, string> = {
  off: "思考：关",
  minimal: "思考：极少",
  low: "思考：少",
  medium: "思考：中",
  high: "思考：多",
  xhigh: "思考：超多",
  max: "思考：最强",
};

const thinkingOptions = computed<SelectOption[]>(() =>
  store.thinkingLevels.map((l) => ({ label: THINKING_LABELS[l] ?? l, value: l }))
);

const contextPercent = computed(() => store.stats?.contextUsage?.percent ?? null);

/**
 * 当前模型的能力标签（图片 / 深度思考 / 记忆容量 / 单价）。
 *
 * 全部来自 `get_available_models` 返回的 Model 字段，没有一处硬编码。
 * 「这个模型收不收图」是用户在拖图之前唯一需要知道的事，把它摆在模型
 * 选择框旁边，比等发送失败之后再解释便宜得多。
 */
const modelCaps = computed(() => {
  const m = store.currentModel;
  if (!m) return null;
  return {
    image: (m.input ?? []).includes("image"),
    reasoning: m.reasoning === true,
    contextK: m.contextWindow ? Math.round(m.contextWindow / 1000) : 0,
    costIn: m.cost?.input ?? 0,
  };
});

const mismatch = computed(() => store.modelMismatchPrompt);
</script>

<template>
  <!--
    历史会话的模型与当前默认不同时的提示条（PROV-101）。
    **只问，不动作** —— 自动切走会丢掉「这条会话当时用的是什么」这个事实。
  -->
  <div
    v-if="mismatch"
    class="model-mismatch"
    role="status"
    data-testid="model-mismatch-prompt"
    :data-session-model="mismatch.sessionModelId"
  >
    <span>
      这个会话原来用的是「{{ mismatch.sessionModelId }}」，
      当前默认是「{{ mismatch.targetModelId }}」，是否切换？
    </span>
    <div style="flex: 1" />
    <n-button size="tiny" quaternary @click="store.keepSessionModel()">保持原来的</n-button>
    <n-button size="tiny" type="primary" @click="store.switchToPromptedModel()">
      切换到默认
    </n-button>
  </div>

  <header class="topbar">
    <n-tooltip>
      <template #trigger>
        <n-button quaternary size="small" @click="store.chooseWorkspace()">
          📁 {{ folderName }}
        </n-button>
      </template>
      工作文件夹：{{ store.workspace }}（点击更换）
    </n-tooltip>

    <span v-if="extUi.displayTitle" class="ext-title" :title="extUi.displayTitle">
      {{ extUi.displayTitle }}
    </span>

    <div class="spacer" />

    <n-tooltip>
      <template #trigger>
        <n-button quaternary size="small" aria-label="Pi 资源" @click="piRes.panelOpen = true">
          🧩 资源
        </n-button>
      </template>
      查看和管理 Pi 的技能、扩展与包
    </n-tooltip>

    <n-tooltip>
      <template #trigger>
        <n-button
          quaternary
          size="small"
          aria-label="账号与模型"
          @click="providers.panelOpen = true"
        >
          🔑 账号
        </n-button>
      </template>
      配置 AI 服务商账号与模型（不需要打开终端）
    </n-tooltip>

    <n-tooltip>
      <template #trigger>
        <n-button
          quaternary
          size="small"
          aria-label="用量与花费"
          @click="providers.usagePanelOpen = true"
        >
          📊 用量
        </n-button>
      </template>
      看看每天用了多少 token、花了多少钱
    </n-tooltip>

    <StatusCenter />

    <span v-if="store.extStatus" class="usage ext-status">{{ store.extStatus }}</span>

    <span v-if="contextPercent !== null" class="usage">
      记忆已用 {{ Math.round(contextPercent) }}%
    </span>

    <!-- 模型能力标签：判据全部来自 get_available_models 返回的字段 -->
    <n-tooltip v-if="modelCaps">
      <template #trigger>
        <span class="model-caps" data-testid="model-caps">
          <n-tag size="tiny" :bordered="false" :type="modelCaps.image ? 'success' : 'default'">
            {{ modelCaps.image ? "🖼 可收图" : "🚫 不收图" }}
          </n-tag>
          <n-tag v-if="modelCaps.contextK" size="tiny" :bordered="false">
            {{ modelCaps.contextK }}K
          </n-tag>
        </span>
      </template>
      {{ modelCaps.image ? "这个模型可以接收图片" : "这个模型不支持图片，发图前需要切换模型" }}
      <template v-if="modelCaps.reasoning"> · 支持深度思考</template>
      <template v-if="modelCaps.costIn"> · 输入 ${{ modelCaps.costIn }}/M tokens</template>
    </n-tooltip>

    <n-select
      v-if="store.thinkingLevels.length > 1"
      :value="store.agentState?.thinkingLevel ?? 'off'"
      :options="thinkingOptions"
      size="small"
      style="width: 128px"
      :consistent-menu-width="false"
      @update:value="(v: string) => store.setThinkingLevel(v as ThinkingLevel)"
    />

    <n-select
      :value="modelValue"
      :options="modelOptions"
      size="small"
      filterable
      placeholder="选择模型"
      style="width: 240px"
      :consistent-menu-width="false"
      @update:value="onModelChange"
    />
  </header>
</template>

<style scoped>
.model-mismatch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12.5px;
  background: rgba(240, 160, 32, 0.12);
  border-bottom: 1px solid rgba(240, 160, 32, 0.3);
}
.model-caps {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.ext-title {
  margin-left: 12px;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.72;
}
</style>
