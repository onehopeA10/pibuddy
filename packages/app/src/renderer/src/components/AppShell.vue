<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDialog, useMessage, NButton, NSpin } from "naive-ui";
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
import FileTreePanel from "./FileTreePanel.vue";
import FileEditorPane from "./FileEditorPane.vue";
import ChangesetPanel from "./ChangesetPanel.vue";
import ArtifactLibrary from "./ArtifactLibrary.vue";
import MemoryPanel from "./MemoryPanel.vue";
import PreviewPane from "./PreviewPane.vue";
import SessionTreePanel from "./SessionTreePanel.vue";
import GitPanel from "./GitPanel.vue";
import TasksPanel from "./TasksPanel.vue";
import ConnectorPanel from "./ConnectorPanel.vue";
import { useUpdateStore } from "../stores/update";
import { usePiResourcesStore } from "../stores/piResources";
import { useProvidersStore } from "../stores/providers";
import { useArtifactsStore } from "../stores/artifacts";
import { useMemoryStore } from "../stores/memory";
import { useTasksStore } from "../stores/tasks";
import { useCapabilitiesStore } from "../stores/capabilities";
import {
  createDirtyDialog,
  setDirtyPrompt,
  type DirtyDecision,
  type EditorTab,
} from "../stores/workspace";

const store = useAppStore();
const updateStore = useUpdateStore();
const piRes = usePiResourcesStore();
const providers = useProvidersStore();
const artifacts = useArtifactsStore();
const memory = useMemoryStore();
const tasks = useTasksStore();
const capabilities = useCapabilitiesStore();
const message = useMessage();
const dialog = useDialog();
store.setNotifier(message);

/**
 * 未保存编辑的三选一，装在这里而不是编辑器组件里。
 *
 * 提问的时机有两个：关 tab（编辑器面板里）和切工作区（app store 里）。
 * 后者在编辑器面板根本没挂载的时候也会发生 —— 装在面板里就等于「面板
 * 没开时切工作区照样静默丢弃」，而那正是这次要修的缺陷本身。AppShell
 * 在 NDialogProvider 之内、且与应用同生命周期，是唯一两边都够得着的位置。
 *
 * 三个按钮各自对应一种真实意图，没有默认选中项：默认放弃就是这条缺陷的
 * 成因。右上角的 ×、Esc、点遮罩都归入「取消」。
 *
 * 每条出口各自 resolve、一次都不依赖 onAfterLeave —— 理由与断言见
 * `createDirtyDialog`（那段逻辑住在 store 模块里正是为了能被单测钉住）。
 */
function askDirty(tabs: EditorTab[]): Promise<DirtyDecision> {
  const { handlers, decision } = createDirtyDialog();
  const names = tabs.map((t) => t.relativePath).join("、");
  dialog.warning({
    title: "有还没保存的修改",
    content:
      tabs.length === 1
        ? `《${names}》里的修改还没保存。要先保存吗？`
        : `这 ${tabs.length} 个文件还没保存：${names}。要先保存吗？`,
    positiveText: "保存",
    negativeText: "放弃修改",
    closable: true,
    ...handlers,
  });
  return decision;
}

setDirtyPrompt(askDirty);
onBeforeUnmount(() => setDirtyPrompt(null));

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

/**
 * 三栏的可折叠开关（FS-101 / FS-102）。
 *
 * 默认都关着：绝大多数会话里用户只是想说句话，一进来就被文件树和变更
 * 面板挤掉一半聊天区不是帮忙。两个开关都放在顶栏右侧，随手可开。
 */
const filesOpen = ref(false);
const changesOpen = ref(false);
// 会话树面板的开合。独立的 ref，不复用 filesOpen / changesOpen —— 它是自己
// 一个能力域（common.session-tree），与文件树 / 改动面板互不牵连。
const sessionTreeOpen = ref(false);
// Git 面板（coding.git 垂直能力包）的开合。同样独立成 ref：它是第一个垂直
// 能力域，默认只在「编码」Profile 里可见。
const gitOpen = ref(false);
// 连接器面板（connector.webhook）的开合。独立成 ref：它是第一个 connector
// 能力域，与其它面板互不牵连。
const connectorOpen = ref(false);

/**
 * UI 门控（ADR-0002 feature gate 的渲染侧一半）。
 *
 * 判据来自主进程的能力快照，不是本地的一个布尔 —— 「启用」在主进程侧的
 * 含义是「通道已注册」，渲染侧另记一份必然会在依赖被拒这类情况上分叉，
 * 表现是面板照常出现、点下去每个动作都报未知通道。
 *
 * 现阶段只门控这四块的**可见性**，AppShell 的四个具名 slot 一个都没动
 * （ADR-0002 D5 的 registry 驱动改造属第二阶段）。
 */
const filesEnabled = computed(() => capabilities.isEnabled("common.workspace-files"));
const reviewEnabled = computed(() => capabilities.isEnabled("common.workspace-review"));
const previewEnabled = computed(() => capabilities.isEnabled("common.preview"));
const artifactsEnabled = computed(() => capabilities.isEnabled("common.artifacts"));
const memoryEnabled = computed(() => capabilities.isEnabled("common.memory"));
const sessionTreeEnabled = computed(() => capabilities.isEnabled("common.session-tree"));
// coding.git 的 UI 门控：判据同样来自主进程能力快照（「启用」= 通道已注册）。
// 它默认只在「编码」Profile 启用，因此在「通用办公」下这个开关与面板都不出现。
const gitEnabled = computed(() => capabilities.isEnabled("coding.git"));
const tasksEnabled = computed(() => capabilities.isEnabled("common.tasks"));
// connector.webhook 的 UI 门控：判据同样来自主进程能力快照（「启用」= 通道
// 已注册）。默认进「通用办公」与「编码」两个 Profile，「精简」下不出现。
const connectorEnabled = computed(() => capabilities.isEnabled("connector.webhook"));

onMounted(() => {
  void store.init();
  // 先取快照再订阅：窗口 reload 之后进度必须从 main 的快照原样恢复，
  // 而不是回到 idle。
  void updateStore.init();
  // 能力快照：没回来之前 isEnabled() 一律放行，因此这一行的迟到不会让
  // 界面先闪一下空壳（理由见 stores/capabilities.ts 的文件头）。
  void capabilities.refresh();
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

    <slot name="sidebar">
      <Sidebar />
      <FileTreePanel v-if="filesOpen && filesEnabled" />
    </slot>
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
          <div class="workspace-toggles">
            <n-button
              v-if="filesEnabled"
              size="tiny"
              :type="filesOpen ? 'primary' : 'default'"
              quaternary
              @click="filesOpen = !filesOpen"
            >
              📁 文件
            </n-button>
            <n-button
              v-if="reviewEnabled"
              size="tiny"
              :type="changesOpen ? 'primary' : 'default'"
              quaternary
              @click="changesOpen = !changesOpen"
            >
              🔀 改动
            </n-button>
            <n-button
              v-if="artifactsEnabled"
              size="tiny"
              :type="artifacts.panelOpen ? 'primary' : 'default'"
              quaternary
              @click="artifacts.panelOpen = !artifacts.panelOpen"
            >
              📦 产物
            </n-button>
            <n-button
              v-if="memoryEnabled"
              size="tiny"
              :type="memory.panelOpen ? 'primary' : 'default'"
              quaternary
              @click="memory.panelOpen = !memory.panelOpen"
            >
              🧠 记忆
            </n-button>
            <n-button
              v-if="sessionTreeEnabled"
              size="tiny"
              :type="sessionTreeOpen ? 'primary' : 'default'"
              quaternary
              @click="sessionTreeOpen = !sessionTreeOpen"
            >
              🌳 会话树
            </n-button>
            <n-button
              v-if="gitEnabled"
              size="tiny"
              :type="gitOpen ? 'primary' : 'default'"
              quaternary
              @click="gitOpen = !gitOpen"
            >
              🌿 Git
              v-if="tasksEnabled"
              size="tiny"
              :type="tasks.panelOpen ? 'primary' : 'default'"
              quaternary
              @click="tasks.panelOpen = !tasks.panelOpen"
            >
              ⏰ 定时
            </n-button>
            <n-button
              v-if="connectorEnabled"
              size="tiny"
              :type="connectorOpen ? 'primary' : 'default'"
              quaternary
              @click="connectorOpen = !connectorOpen"
            >
              🔌 连接器
            </n-button>
          </div>
          <ChatView />
          <FileEditorPane v-if="filesOpen && filesEnabled" />
          <!-- 预览区跟着文件面板一起开合：不开文件树的时候它没有输入来源。
               能力门控是**两个**：文件树给它输入，预览能力给它转换与沙箱窗口，
               缺任何一个这块都没有意义（ADR-0002 D5 记的那个「一个 filesOpen
               同时控制两个能力域」的问题，在这里先按两个判据拆开表达）。 -->
          <PreviewPane
            v-if="filesOpen && filesEnabled && previewEnabled"
            :workspace-id="store.workspaceId ?? undefined"
            :relative-path="artifacts.previewRelativePath || undefined"
          />
          <ChangesetPanel v-if="changesOpen && reviewEnabled" />
          <SessionTreePanel v-if="sessionTreeOpen && sessionTreeEnabled" />
          <GitPanel v-if="gitOpen && gitEnabled" />
          <ConnectorPanel v-if="connectorOpen && connectorEnabled" />
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
      <ArtifactLibrary v-if="artifactsEnabled" />
      <MemoryPanel v-if="memoryEnabled" />
      <TasksPanel v-if="tasksEnabled" />
    </slot>
  </div>
</template>
