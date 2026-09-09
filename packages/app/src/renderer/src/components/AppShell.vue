<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDialog, useMessage, NButton, NSpin } from "naive-ui";
import { useAppStore } from "../stores/app";
import Sidebar from "./Sidebar.vue";
import TopBar from "./TopBar.vue";
import ChatView from "./ChatView.vue";
import InputBar from "./InputBar.vue";
import ModelErrorHint from "./ModelErrorHint.vue";
import ExtensionUiHost from "./ExtensionUiHost.vue";
import SettingsModal from "./SettingsModal.vue";
import UpdateBanner from "./UpdateBanner.vue";
import SafeModeBanner from "./SafeModeBanner.vue";
import InstallBlockerDialog from "./InstallBlockerDialog.vue";
import ProjectTrustDialog from "./ProjectTrustDialog.vue";
import OnboardingWizard from "./OnboardingWizard.vue";
import FileTreePanel from "./FileTreePanel.vue";
import FileEditorPane from "./FileEditorPane.vue";
import ChangesetPanel from "./ChangesetPanel.vue";
import PreviewPane from "./PreviewPane.vue";
import { useUpdateStore } from "../stores/update";
import { usePiResourcesStore } from "../stores/piResources";
import { useMcpStore } from "../stores/mcp";
import { usePermissionStore } from "../stores/permission";
import { useProvidersStore } from "../stores/providers";
import { useArtifactsStore } from "../stores/artifacts";
import { useMemoryStore } from "../stores/memory";
import { useTasksStore } from "../stores/tasks";
import { useCapabilitiesStore } from "../stores/capabilities";
import { usePromptLibraryStore } from "../stores/promptLibrary";
import {
  createDirtyDialog,
  setDirtyPrompt,
  type DirtyDecision,
  type EditorTab,
} from "../stores/workspace";

/**
 * 家居监控面板（home.dashboard）——**首个 loading:"lazy" 能力包的渲染侧一半**。
 *
 * 静态 import 会把组件打进主 chunk，manifest 里的 lazy 声明就成了一句空话；
 * 这里用 defineAsyncComponent + 动态 import：electron-vite 据此单独拆 chunk，
 * 不开面板不加载（manifest.runtime.entry 指向的就是这个文件，bundleBudgetKb
 * 是它的预算上界）。
 */
const HomeDashboardPanel = defineAsyncComponent(() => import("./HomeDashboardPanel.vue"));
const PiResourcesPanel = defineAsyncComponent(() => import("./PiResourcesPanel.vue"));
const ProviderCenter = defineAsyncComponent(() => import("./ProviderCenter.vue"));
const UsagePanel = defineAsyncComponent(() => import("./UsagePanel.vue"));
const ArtifactLibrary = defineAsyncComponent(() => import("./ArtifactLibrary.vue"));
const MemoryPanel = defineAsyncComponent(() => import("./MemoryPanel.vue"));
const SessionTreePanel = defineAsyncComponent(() => import("./SessionTreePanel.vue"));
const GitPanel = defineAsyncComponent(() => import("./GitPanel.vue"));
const TerminalPanel = defineAsyncComponent(() => import("./TerminalPanel.vue"));
const TasksPanel = defineAsyncComponent(() => import("./TasksPanel.vue"));
const ChildAgentPanel = defineAsyncComponent(() => import("./ChildAgentPanel.vue"));
const ConnectorPanel = defineAsyncComponent(() => import("./ConnectorPanel.vue"));
const ConnectorChannelsPanel = defineAsyncComponent(() => import("./ConnectorChannelsPanel.vue"));
const RemotePanel = defineAsyncComponent(() => import("./RemotePanel.vue"));
const WorkflowPanel = defineAsyncComponent(() => import("./WorkflowPanel.vue"));
const PromptLibraryPanel = defineAsyncComponent(() => import("./PromptLibraryPanel.vue"));
const OfficeSkillsPanel = defineAsyncComponent(() => import("./OfficeSkillsPanel.vue"));
const HomeAdvisorPanel = defineAsyncComponent(() => import("./HomeAdvisorPanel.vue"));
const RulesPanel = defineAsyncComponent(() => import("./RulesPanel.vue"));
const EduPanel = defineAsyncComponent(() => import("./EduPanel.vue"));

const store = useAppStore();
const updateStore = useUpdateStore();
const piRes = usePiResourcesStore();
const mcp = useMcpStore();
const permission = usePermissionStore();
const providers = useProvidersStore();
const artifacts = useArtifactsStore();
const memory = useMemoryStore();
const tasks = useTasksStore();
const capabilities = useCapabilitiesStore();
const promptLibrary = usePromptLibraryStore();
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
onBeforeUnmount(() => {
  setDirtyPrompt(null);
  store.dispose();
});

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
// 终端面板（coding.terminal 垂直能力包，node-pty）的开合。独立成 ref：它是
// 第一个原生模块能力域，与其它面板互不牵连，默认只在「编码」Profile 里可见。
const terminalOpen = ref(false);
// 子 Agent 编排面板（common.child-agent）的开合。独立成 ref：它是自己一个
// 能力域（父子拓扑 / 结构化消息 / cancel 传播），与其它面板互不牵连。
const childAgentOpen = ref(false);
// 连接器面板（connector.webhook）的开合。独立成 ref：它是第一个 connector
// 能力域，与其它面板互不牵连。
const connectorOpen = ref(false);
// 真实渠道面板（connector.feishu / slack / telegram）的开合。独立成 ref：它是
// 三个真实渠道能力包的共享面板，与通用 webhook 面板互不牵连。
const channelsOpen = ref(false);
// 可视化工作流面板（common.workflow）的开合。独立成 ref：它是自己一个能力域
// （DAG 画布 / 运行 / 历史），与其它面板互不牵连。
const workflowOpen = ref(false);
// 远程访问面板（connector.remote）的开合。独立成 ref：它管的是对外网络服务的
// 开关 / 配对 / 设备，与其它面板互不牵连。
const remoteOpen = ref(false);
// 办公技能面板（common.office-skills）的开合。独立成 ref：它是第一个内容型
// 能力域（预置 pi 技能 + 物化状态），与其它面板互不牵连。
const officeSkillsOpen = ref(false);
// 家居建议面板（home.advisor 垂直能力包，纯 skill 内容包）的开合。独立成
// ref：它是自己一个能力域（两个建议技能的物化状态），与其它面板互不牵连。
const homeAdvisorOpen = ref(false);
// 自动化规则面板（home.automation 垂直能力包）的开合。独立成 ref：它是自己
// 一个能力域（规则列表 / 启停 / 删除），与其它面板互不牵连。
const rulesOpen = ref(false);
// 学习面板（edu.kids 垂直能力包，首个真内容垂直包）的开合。独立成 ref：
// 它是自己一个能力域（档案 / 一键出卷 / 错题本），默认只在「家庭教育」
// Profile 里可见。
const eduOpen = ref(false);
// 家居监控面板（home.dashboard 垂直能力包，首个 lazy 包）的开合。独立成 ref：
// 它是自己一个能力域（实体状态总览 + 消费者信令），与家居建议面板互不牵连。
// 面板的挂载/卸载就是基座实体缓存消费者的登记/释放（诚实遗留 #7 的落点）。
const homeDashboardOpen = ref(false);

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
// coding.terminal 的 UI 门控：判据同样来自主进程能力快照（「启用」= 通道已注册）。
// 它默认只在「编码」Profile 启用，因此在「通用办公」下这个开关与面板都不出现。
const terminalEnabled = computed(() => capabilities.isEnabled("coding.terminal"));
const tasksEnabled = computed(() => capabilities.isEnabled("common.tasks"));
// 子 Agent 编排的 UI 门控：判据同样来自主进程能力快照（「启用」= 通道已注册）。
const childAgentEnabled = computed(() => capabilities.isEnabled("common.child-agent"));
// connector.webhook 的 UI 门控：判据同样来自主进程能力快照（「启用」= 通道
// 已注册）。默认进「通用办公」与「编码」两个 Profile，「精简」下不出现。
const connectorEnabled = computed(() => capabilities.isEnabled("connector.webhook"));
// 三个真实渠道能力包各自的 UI 门控（判据同样来自主进程能力快照）。它们各自
// dependencies connector.webhook，因此基座被关掉时也随之判为未启用。共享同一个
// ConnectorChannelsPanel，面板 / 工具栏按钮只要任一渠道启用就出现。
const feishuEnabled = computed(() => capabilities.isEnabled("connector.feishu"));
const slackEnabled = computed(() => capabilities.isEnabled("connector.slack"));
const telegramEnabled = computed(() => capabilities.isEnabled("connector.telegram"));
const channelsEnabled = computed(
  () => feishuEnabled.value || slackEnabled.value || telegramEnabled.value
);
// 可视化工作流的 UI 门控：判据同样来自主进程能力快照（「启用」= 通道已注册）。
const workflowEnabled = computed(() => capabilities.isEnabled("common.workflow"));
// 远程访问（connector.remote）：唯一开对外网络监听的能力。门控只决定管理面板
// 是否出现；远程服务本身默认不监听，须在面板里显式开启。
const remoteEnabled = computed(() => capabilities.isEnabled("connector.remote"));
// 提示词库（common.prompt-library / REQ-0001 R1）的 UI 门控：判据同样来自
// 主进程能力快照（「启用」= 六条通道已注册）。
const promptLibraryEnabled = computed(() => capabilities.isEnabled("common.prompt-library"));

/**
 * 当前工作文件夹是否在 WSL 内（R5.1）。
 *
 * 判据是显示路径的 `\\wsl$` / `\\wsl.localhost` 前缀——store.workspace 是主进程
 * 下发的 displayPath，这里不需要（也拿不到）canonical root。命中时给一条常驻
 * 提示：pi 运行时**仍在 Windows 侧**运行、经 UNC 路径读写 WSL 内文件（不做
 * pi-in-WSL），且 WSL 共享不支持文件变更通知，文件树需手动刷新。
 */
const isWslWorkspace = computed(() =>
  /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]/i.test(store.workspace ?? "")
);
// 办公技能包（common.office-skills）的 UI 门控：判据同样来自主进程能力快照。
// 关掉它 = 面板与开关都不出现；物化的技能文件由下次启动对账收回。
const officeSkillsEnabled = computed(() => capabilities.isEnabled("common.office-skills"));
// home.advisor 的 UI 门控：判据同样来自主进程能力快照。它依赖 home.assistant
// 基座，基座未启用时装配期就被拒绝（enabled=false），面板与开关都不出现。
const homeAdvisorEnabled = computed(() => capabilities.isEnabled("home.advisor"));
// home.automation 的 UI 门控：判据同样来自主进程能力快照。它依赖 home.assistant
// 与 common.tasks，任一未启用时装配期就被拒绝（enabled=false），面板与开关都不出现。
const homeAutomationEnabled = computed(() => capabilities.isEnabled("home.automation"));
// edu.kids 的 UI 门控：判据同样来自主进程能力快照（「启用」= 通道已注册）。
// 它默认只在「家庭教育」Profile 启用，其它 Profile 下这个开关与面板都不出现。
const eduEnabled = computed(() => capabilities.isEnabled("edu.kids"));
// home.dashboard 的 UI 门控：判据同样来自主进程能力快照。它依赖 home.assistant
// 基座，基座未启用时装配期就被拒绝（enabled=false），面板与开关都不出现。
const homeDashboardEnabled = computed(() => capabilities.isEnabled("home.dashboard"));

onMounted(() => {
  void store.init();
  // 先取快照再订阅：窗口 reload 之后进度必须从 main 的快照原样恢复，
  // 而不是回到 idle。
  void updateStore.init();
  // 能力快照：没回来之前 isEnabled() 一律放行，因此这一行的迟到不会让
  // 界面先闪一下空壳（理由见 stores/capabilities.ts 的文件头）。
  void capabilities.refresh();
  // 提示词库拉一次快照：list 通道的实现会先把预置提示词物化到
  // ~/.pi/agent/prompts/（幂等），因此**首启动**这里就是「全新用户零配置、
  // 库非空」（R1.4）的触发点，而不是等用户第一次点开面板。能力被关掉时
  // 通道未注册，refresh 把错误折进 store.lastError，不打断启动。
  void promptLibrary.refresh();
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
    mcp.setWorkspace(id);
    piRes.setWorkspace(id);
    void permission.refresh(id || null);
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

      <!-- WSL workspace 提示（R5.1）：pi 仍跑在 Windows 侧，经 \\wsl.localhost
           UNC 读写这个目录（不做 pi-in-WSL）；WSL 共享（9P）不支持变更通知，
           文件树不会自动刷新。 -->
      <div v-if="isWslWorkspace" class="wsl-workspace-banner">
        🐧 当前工作文件夹在 WSL 内：pi 仍在 Windows 侧运行，经网络路径读写这个目录；
        文件树不会自动刷新（WSL 共享不支持变更通知），终端可选择进入对应发行版。
      </div>

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
          <p v-if="store.modelsError">未能列出模型：{{ store.modelsError }}</p>
          <p v-else>需要先配置一个 AI 服务商的账号，才能开始对话。</p>
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
              v-if="childAgentEnabled"
              size="tiny"
              :type="childAgentOpen ? 'primary' : 'default'"
              quaternary
              @click="childAgentOpen = !childAgentOpen"
            >
              🤖 子 Agent
            </n-button>
            <n-button
              v-if="gitEnabled"
              size="tiny"
              :type="gitOpen ? 'primary' : 'default'"
              quaternary
              @click="gitOpen = !gitOpen"
            >
              🌿 Git
            </n-button>
            <n-button
              v-if="terminalEnabled"
              size="tiny"
              :type="terminalOpen ? 'primary' : 'default'"
              quaternary
              @click="terminalOpen = !terminalOpen"
            >
              💻 终端
            </n-button>
            <n-button
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
            <n-button
              v-if="channelsEnabled"
              size="tiny"
              :type="channelsOpen ? 'primary' : 'default'"
              quaternary
              @click="channelsOpen = !channelsOpen"
            >
              💬 渠道
            </n-button>
            <n-button
              v-if="workflowEnabled"
              size="tiny"
              :type="workflowOpen ? 'primary' : 'default'"
              quaternary
              @click="workflowOpen = !workflowOpen"
            >
              🧩 工作流
            </n-button>
            <n-button
              v-if="remoteEnabled"
              size="tiny"
              :type="remoteOpen ? 'primary' : 'default'"
              quaternary
              @click="remoteOpen = !remoteOpen"
            >
              📡 远程
            </n-button>
            <n-button
              v-if="promptLibraryEnabled"
              size="tiny"
              :type="promptLibrary.panelOpen ? 'primary' : 'default'"
              quaternary
              @click="promptLibrary.panelOpen = !promptLibrary.panelOpen"
            >
              📋 提示词
            </n-button>
            <n-button
              v-if="officeSkillsEnabled"
              size="tiny"
              :type="officeSkillsOpen ? 'primary' : 'default'"
              quaternary
              @click="officeSkillsOpen = !officeSkillsOpen"
            >
              🗂️ 技能
            </n-button>
            <n-button
              v-if="homeAdvisorEnabled"
              size="tiny"
              :type="homeAdvisorOpen ? 'primary' : 'default'"
              quaternary
              @click="homeAdvisorOpen = !homeAdvisorOpen"
            >
              🏠 家居建议
            </n-button>
            <n-button
              v-if="homeDashboardEnabled"
              size="tiny"
              :type="homeDashboardOpen ? 'primary' : 'default'"
              quaternary
              @click="homeDashboardOpen = !homeDashboardOpen"
            >
              📊 家居面板
            </n-button>
            <n-button
              v-if="homeAutomationEnabled"
              size="tiny"
              :type="rulesOpen ? 'primary' : 'default'"
              quaternary
              @click="rulesOpen = !rulesOpen"
            >
              ⚙️ 自动化
            </n-button>
            <n-button
              v-if="eduEnabled"
              size="tiny"
              :type="eduOpen ? 'primary' : 'default'"
              quaternary
              @click="eduOpen = !eduOpen"
            >
              🎒 学习
            </n-button>
          </div>
          <ChatView />
          <FileEditorPane v-if="filesOpen && filesEnabled" />
          <!-- 预览区跟着文件面板一起开合：不开文件树的时候它没有输入来源。
               能力门控是**两个**：文件树给它输入，预览能力给它转换与沙箱窗口，
               缺任何一个这块都没有意义（ADR-0002 D5 记的那个「一个 filesOpen
               同时控制两个能力域」的问题，在这里先按两个判据拆开表达）。 -->
          <PreviewPane
            v-if="previewEnabled && (filesOpen || Boolean(artifacts.previewRelativePath) || Boolean(artifacts.previewArtifactId))"
            :workspace-id="store.workspaceId ?? undefined"
            :relative-path="artifacts.previewRelativePath || undefined"
            :artifact-id="artifacts.previewArtifactId || undefined"
          />
          <ChangesetPanel v-if="changesOpen && reviewEnabled" />
          <SessionTreePanel v-if="sessionTreeOpen && sessionTreeEnabled" />
          <GitPanel v-if="gitOpen && gitEnabled" />
          <TerminalPanel v-if="terminalOpen && terminalEnabled" />
          <ChildAgentPanel v-if="childAgentOpen && childAgentEnabled" />
          <ConnectorPanel v-if="connectorOpen && connectorEnabled" />
          <ConnectorChannelsPanel v-if="channelsOpen && channelsEnabled" />
          <RemotePanel v-if="remoteOpen && remoteEnabled" />
          <WorkflowPanel v-if="workflowOpen && workflowEnabled" />
          <OfficeSkillsPanel v-if="officeSkillsOpen && officeSkillsEnabled" />
          <HomeAdvisorPanel v-if="homeAdvisorOpen && homeAdvisorEnabled" />
          <!-- 懒加载组件（首个 lazy 包）：v-if 为假时连 chunk 都不请求；挂载即
               subscribe（登记基座缓存消费者），卸载即 unsubscribe（释放）。 -->
          <HomeDashboardPanel v-if="homeDashboardOpen && homeDashboardEnabled" />
          <RulesPanel v-if="rulesOpen && homeAutomationEnabled" />
          <EduPanel v-if="eduOpen && eduEnabled" />
          <!-- 紧贴输入框上方：这条提示要回答的是「我下一句话还能不能发出去」，
               放在对话流里会随着历史一起被滚走。 -->
          <ModelErrorHint />
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
      <PromptLibraryPanel v-if="promptLibraryEnabled" />
    </slot>
  </div>
</template>
