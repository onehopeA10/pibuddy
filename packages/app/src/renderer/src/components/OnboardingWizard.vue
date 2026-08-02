<script setup lang="ts">
/**
 * 首次启动向导（UX-101）。
 *
 * 六步走完，用户就能发出第一条消息，**全程不需要打开终端**：
 *   0 欢迎 → 1 工作文件夹 → 2 Pi 运行时 → 3 服务商账号 + 测试连接
 *   → 4 项目信任 → 5 通知与语音
 *
 * ## 可中断恢复
 *
 * 每完成一步立刻写 `settings.onboardingStep`。用户在第 4 步关掉应用再打开，
 * 从第 4 步继续 —— 而不是从头再走一遍（那是最容易让人放弃的设计）。
 *
 * `onboardingCompletedAt` **只在最后一步完成时**写入，它才是「向导走完了」
 * 的判据。用 step 冒充完成状态的话，用户在第 3 步退出后重进会直接落到
 * 主界面，而那时候连一个可用的模型都没有。
 */
import { computed, onMounted, ref, watch } from "vue";
import {
  NAlert,
  NButton,
  NCheckbox,
  NInput,
  NRadio,
  NRadioGroup,
  NSpace,
  NSteps,
  NStep,
  NTag,
} from "naive-ui";
import { useAppStore } from "../stores/app";
import { useProvidersStore } from "../stores/providers";
import { usePiResourcesStore } from "../stores/piResources";

const app = useAppStore();
const providers = useProvidersStore();
const piRes = usePiResourcesStore();

interface OnboardingStepInfo {
  title: string;
  description: string;
}

/** 六步。索引即 `settings.onboardingStep`。 */
const STEPS: OnboardingStepInfo[] = [
  { title: "开始", description: "认识一下 PiBuddy" },
  { title: "工作文件夹", description: "我只在这个文件夹里干活" },
  { title: "Pi 运行时", description: "用内置的还是你自己的" },
  { title: "服务商账号", description: "填一个 API Key" },
  { title: "项目信任", description: "要不要加载项目里的技能" },
  { title: "通知与语音", description: "可选" },
];

const step = ref(0);
const busy = ref(false);

// 第 3 步的输入
const selectedProviderId = ref("anthropic");
const apiKeyInput = ref("");

// 第 5 步
const notifications = ref(true);
const voice = ref(false);

onMounted(() => {
  step.value = app.settings.onboardingStep ?? 0;
  notifications.value = app.settings.notificationsEnabled ?? true;
  voice.value = app.settings.voiceEnabled ?? false;
  void providers.refresh();
});

// 用户在别处改了设置（例如选完文件夹后 store 刷新）时同步过来
watch(
  () => app.settings.onboardingStep,
  (v) => {
    if (typeof v === "number" && v > step.value) step.value = v;
  }
);

/** 走到第 n 步并立刻落盘 —— 崩溃 / 关窗都不该让进度倒回去。 */
async function gotoStep(next: number): Promise<void> {
  step.value = Math.max(0, Math.min(STEPS.length - 1, next));
  await app.saveSettings({ onboardingStep: step.value });
}

const currentProvider = computed(() =>
  providers.providers.find((p) => p.id === selectedProviderId.value)
);
const testState = computed(() => providers.tests[selectedProviderId.value]);

/** 「测试连接」的文案：成功含「成功」，失败含 HTTP 状态码或 errno。 */
const testText = computed(() => {
  const result = testState.value?.result;
  if (!result) return "";
  if (result.ok) return `连接成功（${result.latencyMs}ms），可以开始用了`;
  return `连接失败：${result.redactedMessage ?? "未知问题"}`;
});

async function saveKeyAndTest(): Promise<void> {
  busy.value = true;
  try {
    const key = apiKeyInput.value.trim();
    if (key) {
      const ok = await providers.saveKey(selectedProviderId.value, key);
      if (!ok) return;
      apiKeyInput.value = "";
    }
    await providers.test(selectedProviderId.value);
  } finally {
    busy.value = false;
  }
}

async function chooseFolder(): Promise<void> {
  busy.value = true;
  try {
    await app.chooseWorkspace();
  } finally {
    busy.value = false;
  }
}

async function setRuntime(mode: "bundled" | "external"): Promise<void> {
  await app.saveSettings({ piRuntimeMode: mode });
}

/** 最后一步：写 completedAt，主界面这才渲染出来。 */
async function finish(): Promise<void> {
  busy.value = true;
  try {
    await app.saveSettings({
      onboardingStep: STEPS.length - 1,
      notificationsEnabled: notifications.value,
      voiceEnabled: voice.value,
      onboardingCompletedAt: Date.now(),
    });
    // 工作文件夹选好了但 pi 还没起来（用户是在向导里选的）：补一次启动，
    // 否则用户点完「开始使用」看到的是一个输入框禁用的空界面。
    if (app.workspaceId && !app.started) await app.start();
  } finally {
    busy.value = false;
  }
}

/** 每一步的「下一步」是否可点。不满足时按钮禁用并给出原因。 */
const canAdvance = computed(() => {
  if (step.value === 1) return Boolean(app.workspaceId);
  if (step.value === 3) return providers.hasAnyConfigured;
  return true;
});

const blockReason = computed(() => {
  if (step.value === 1 && !app.workspaceId) return "请先选一个工作文件夹";
  if (step.value === 3 && !providers.hasAnyConfigured) {
    return "请至少配置一个服务商账号 —— 没有它就发不出消息";
  }
  return "";
});
</script>

<template>
  <div
    class="wizard"
    role="dialog"
    aria-modal="true"
    aria-labelledby="wizard-title"
    data-testid="onboarding-wizard"
    :data-step="step"
  >
    <div class="wizard-card">
      <h1 id="wizard-title" class="wizard-title">{{ STEPS[step].title }}</h1>
      <p class="wizard-sub">{{ STEPS[step].description }}</p>

      <n-steps :current="step + 1" size="small" style="margin: 16px 0 24px">
        <n-step v-for="s in STEPS" :key="s.title" :title="s.title" />
      </n-steps>

      <!-- 0 欢迎 -->
      <section v-if="step === 0" class="body">
        <div class="logo">π</div>
        <p>
          我是你的 AI 办公小助手：整理文件、分析表格、写文档、处理图片和视频，
          都可以直接用一句话交给我。
        </p>
        <p class="muted">
          接下来几步会帮你配好工作文件夹和 AI 账号。全程在这个窗口里完成，
          <strong>不需要打开终端</strong>。
        </p>
      </section>

      <!-- 1 工作文件夹 -->
      <section v-else-if="step === 1" class="body">
        <p>选一个文件夹，我只会在这个文件夹里帮你干活，其他地方不动。</p>
        <n-space align="center">
          <n-button type="primary" :loading="busy" @click="chooseFolder">
            📁 选择工作文件夹
          </n-button>
          <n-tag v-if="app.workspace" size="small" type="success" :bordered="false">
            {{ app.workspace }}
          </n-tag>
        </n-space>
      </section>

      <!-- 2 Pi 运行时 -->
      <section v-else-if="step === 2" class="body">
        <p>PiBuddy 自带了一份 Pi 运行时，装好就能用，不需要你另外安装。</p>
        <n-radio-group
          :value="app.settings.piRuntimeMode ?? 'bundled'"
          @update:value="(v: 'bundled' | 'external') => setRuntime(v)"
        >
          <n-space vertical>
            <n-radio value="bundled">用内置的（推荐）</n-radio>
            <n-radio value="external">用我电脑上已装的 pi 命令</n-radio>
          </n-space>
        </n-radio-group>
        <n-alert
          v-if="app.settings.piRuntimeMode === 'external'"
          type="warning"
          :bordered="false"
          style="margin-top: 12px"
        >
          选了外部命令之后，如果它起不来，PiBuddy 不会自动切回内置 ——
          你的选择不该被一次失败悄悄抹掉。到时候在设置里手动切回来即可。
        </n-alert>
      </section>

      <!-- 3 服务商账号 -->
      <section v-else-if="step === 3" class="body">
        <p>
          填一个 AI 服务商的 API Key。密钥保存在你自己电脑上，PiBuddy 不会上传它。
        </p>
        <n-radio-group v-model:value="selectedProviderId">
          <n-space>
            <n-radio v-for="p in providers.providers.slice(0, 5)" :key="p.id" :value="p.id">
              {{ p.name }}
              <n-tag v-if="p.configured" size="tiny" type="success" :bordered="false">已配置</n-tag>
            </n-radio>
          </n-space>
        </n-radio-group>

        <n-alert
          v-if="currentProvider?.authKind === 'oauth'"
          type="info"
          :bordered="false"
          style="margin-top: 12px"
        >
          这是订阅制账号，需要在终端里运行 <code>pi</code> 并用 <code>/login</code> 登录。
          你也可以先选一个用 API Key 的服务商，之后再回来配它。
        </n-alert>

        <template v-else>
          <n-input
            v-model:value="apiKeyInput"
            type="password"
            show-password-on="click"
            placeholder="粘贴 API Key"
            aria-label="API Key"
            style="margin-top: 12px"
          />
          <n-space style="margin-top: 12px">
            <n-button
              type="primary"
              :loading="busy || testState?.pending"
              :disabled="!apiKeyInput.trim() && !currentProvider?.configured"
              @click="saveKeyAndTest"
            >
              保存并测试连接
            </n-button>
          </n-space>
        </template>

        <p
          v-if="testText"
          class="test-result"
          :class="{ ok: testState?.result?.ok }"
          data-testid="onboarding-test-result"
        >
          {{ testText }}
        </p>
        <p v-if="providers.lastError" class="test-result">{{ providers.lastError }}</p>
      </section>

      <!-- 4 项目信任 -->
      <section v-else-if="step === 4" class="body">
        <p>
          这个文件夹里可能带着项目自己的技能与扩展。要不要让我加载它们？
          不确定就选「先不加载」，之后随时能改。
        </p>
        <!-- 判据用 `saved`（用户已保存的决定）而不是 `effective`：后者在没
             决定过时会回落成默认策略，界面会显示成「你已经选过了」。 -->
        <n-space>
          <n-button
            :type="piRes.trust?.saved === 'allow' ? 'primary' : 'default'"
            @click="app.workspaceId && piRes.decideTrust(app.workspaceId, 'allow', true)"
          >
            加载项目技能
          </n-button>
          <n-button
            :type="piRes.trust?.saved === 'deny' ? 'primary' : 'default'"
            @click="app.workspaceId && piRes.decideTrust(app.workspaceId, 'deny', true)"
          >
            先不加载
          </n-button>
        </n-space>
        <p v-if="!piRes.trust?.hasProjectResources" class="muted" style="margin-top: 8px">
          这个文件夹里目前没有项目专属的技能或扩展，选哪个都不影响使用。
        </p>
      </section>

      <!-- 5 通知与语音 -->
      <section v-else class="body">
        <n-space vertical>
          <n-checkbox v-model:checked="notifications">任务做完时给我一个系统通知</n-checkbox>
          <n-checkbox v-model:checked="voice">
            显示语音输入按钮（需要另外配置语音识别服务）
          </n-checkbox>
        </n-space>
        <p class="muted" style="margin-top: 16px">
          都设好了。点「开始使用」就能发出第一条消息。
        </p>
      </section>

      <p v-if="blockReason" class="block-reason" data-testid="onboarding-block-reason">
        {{ blockReason }}
      </p>

      <div class="wizard-actions">
        <n-button v-if="step > 0" quaternary @click="gotoStep(step - 1)">上一步</n-button>
        <div style="flex: 1" />
        <n-button
          v-if="step < STEPS.length - 1"
          type="primary"
          :disabled="!canAdvance"
          @click="gotoStep(step + 1)"
        >
          下一步
        </n-button>
        <n-button v-else type="primary" :loading="busy" @click="finish">开始使用</n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--pibuddy-bg, #f5f6f8);
  z-index: 2000;
  padding: 24px;
  overflow: auto;
}
.wizard-card {
  width: 100%;
  max-width: 620px;
  background: #fff;
  border-radius: 12px;
  padding: 28px 32px 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
}
.wizard-title {
  margin: 0;
  font-size: 22px;
}
.wizard-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: #8a8f98;
}
.body {
  min-height: 180px;
  font-size: 14px;
  line-height: 1.7;
}
.body .muted {
  color: #8a8f98;
  font-size: 13px;
}
.logo {
  font-size: 48px;
  text-align: center;
  margin-bottom: 8px;
}
.test-result {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: #d03050;
  white-space: pre-wrap;
}
.test-result.ok {
  color: #18a058;
}
.block-reason {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: #f0a020;
}
.wizard-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid rgba(128, 128, 128, 0.15);
}

/* 尊重系统的「减少动态效果」设置：前庭功能障碍的用户会因为过渡动画不适 */
@media (prefers-reduced-motion: reduce) {
  .wizard,
  .wizard-card {
    transition: none !important;
    animation: none !important;
  }
}
</style>
