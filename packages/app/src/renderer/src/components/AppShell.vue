<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useMessage, NButton, NSpin } from "naive-ui";
import { useAppStore } from "../stores/app";
import Sidebar from "./Sidebar.vue";
import TopBar from "./TopBar.vue";
import ChatView from "./ChatView.vue";
import InputBar from "./InputBar.vue";
import ExtensionUiHost from "./ExtensionUiHost.vue";
import SettingsModal from "./SettingsModal.vue";
import UpdateBanner from "./UpdateBanner.vue";
import SafeModeBanner from "./SafeModeBanner.vue";
import InstallBlockerDialog from "./InstallBlockerDialog.vue";
import PiResourcesPanel from "./PiResourcesPanel.vue";
import ProjectTrustDialog from "./ProjectTrustDialog.vue";
import OnboardingWizard from "./OnboardingWizard.vue";
import ProviderCenter from "./ProviderCenter.vue";
import UsagePanel from "./UsagePanel.vue";
import { useUpdateStore } from "../stores/update";
import { usePiResourcesStore } from "../stores/piResources";
import { useProvidersStore } from "../stores/providers";

const store = useAppStore();
const updateStore = useUpdateStore();
const piRes = usePiResourcesStore();
const providers = useProvidersStore();
const message = useMessage();
store.setNotifier(message);

/**
 * 向导是否还没走完。
 *
 * 判据是 `onboardingCompletedAt`（只在最后一步写入），**不是** onboardingStep ——
 * 用 step 冒充完成状态的话，用户在第 3 步退出后重进会直接落到主界面，
 * 而那时候连一个可用的模型都没有。
 */
const onboardingPending = computed(
  () => !store.booting && store.settings.onboardingCompletedAt === undefined
);

/**
 * 主界面渲染出来之后，把 provider 列表拉一次，供状态中心使用。
 *
 * `immediate: true` 是必需的：绝大多数用户打开应用时向导**早就走完了**，
 * onboardingPending 从头到尾就是 false，一个不带 immediate 的 watch 永远
 * 不会触发。表现是状态中心里「服务商账号」一栏恒为「暂不可用」，而且
 * typecheck / 单测 / 构建全绿 —— 真机验证才看得出来。
 */
watch(
  onboardingPending,
  (pending) => {
    if (!pending) void providers.refresh();
  },
  { immediate: true }
);

const dragging = ref(0);

onMounted(() => {
  void store.init();
  // 先取快照再订阅：窗口 reload 之后进度必须从 main 的快照原样恢复，
  // 而不是回到 idle。
  void updateStore.init();
});

/**
 * 工作目录一旦确定就问一次 project trust。
 *
 * 必须在这里而不是在 pi:start 里等它自己发现：RPC 模式下 pi 不弹 trust
 * 提示（security.md:30），没有已保存决定时 `defaultProjectTrust: "ask"`
 * 的行为等同于 `"never"` —— 项目里的技能会毫无提示地不被加载。
 */
watch(
  () => store.workspaceId,
  (id) => {
    if (id) void piRes.describeTrust(id);
  },
  { immediate: true }
);

function onDragEnter(e: DragEvent): void {
  if (e.dataTransfer?.types.includes("Files")) dragging.value++;
}
function onDragLeave(): void {
  dragging.value = Math.max(0, dragging.value - 1);
}
function onDrop(): void {
  dragging.value = 0;
}
</script>

<template>
  <!-- 首次使用：选择工作文件夹 -->
  <div v-if="store.booting" class="onboarding">
    <n-spin size="large" />
  </div>

  <!--
    首次启动向导（UX-101）。它取代了原先那个只有「选文件夹」一步的欢迎页 ——
    选完文件夹之后用户还得去终端里 `pi` 然后 `/login` 才能真的用起来，
    而那一步是没有人告诉他的。向导没走完时**不渲染主界面**。
  -->
  <OnboardingWizard v-else-if="onboardingPending" />

  <div v-else-if="!store.workspace" class="onboarding">
    <div class="logo">📁</div>
    <h1>还没有工作文件夹</h1>
    <p>我需要一个文件夹才能帮你干活。选好之后，我只会在这个文件夹里操作。</p>
    <n-button type="primary" size="large" @click="store.chooseWorkspace()">
      📁 选择工作文件夹
    </n-button>
  </div>

  <!-- 主界面 -->
  <div
    v-else
    class="app-shell"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 布局契约（TASK-009 定义，M3-M5 各任务只往这四个具名插槽里注入内容，
         不得改动插槽名集合）：banner 顶部通条 / sidebar 侧栏 / main 主区 /
         overlay 浮层。默认内容即当前形态，不传插槽时渲染结果与改造前一致。 -->
    <!-- safe mode 横幅排在更新横幅**之前**：进了安全模式的用户最需要看到的
         是「什么被关了、我现在能做什么」，而不是又一条更新提示。 -->
    <slot name="banner"><SafeModeBanner /><UpdateBanner /></slot>

    <slot name="sidebar"><Sidebar /></slot>
    <div class="main-col">
      <TopBar />

      <template v-if="store.startError">
        <div class="onboarding">
          <h1>😥 启动失败</h1>
          <p style="white-space: pre-wrap; max-width: 640px">{{ store.startError }}</p>
          <n-button type="primary" @click="store.start()">重试</n-button>
          <n-button
            v-if="store.settings.piRuntimeMode === 'external'"
            @click="store.switchToBundledRuntime()"
          >
            切回内置
          </n-button>
          <n-button quaternary @click="store.chooseWorkspace()">换个文件夹</n-button>
        </div>
      </template>
      <!--
        no-model 空状态（UX-101）：一个可用模型都没有时，聊天区是发不出去
        任何东西的。收敛前这种情况表现为「输入框能打字，一按发送报一句
        看不懂的错」；现在直接给出唯一有意义的那个动作。
      -->
      <template v-else-if="store.started && store.models.length === 0">
        <div class="onboarding">
          <h1>还没有可用的模型</h1>
          <p>需要先配置一个 AI 服务商的账号，才能开始对话。</p>
          <n-button type="primary" @click="providers.panelOpen = true">去配置账号</n-button>
          <n-button quaternary @click="store.start()">重新检查</n-button>
        </div>
      </template>
      <template v-else>
        <slot name="main">
          <ChatView />
          <InputBar />
        </slot>
      </template>
    </div>

    <div v-if="dragging > 0" class="drop-mask">把图片或文件拖到这里交给我</div>
    <slot name="overlay">
      <ExtensionUiHost />
      <SettingsModal />
      <InstallBlockerDialog />
      <PiResourcesPanel />
      <ProjectTrustDialog />
      <ProviderCenter />
      <UsagePanel />
    </slot>
  </div>
</template>
