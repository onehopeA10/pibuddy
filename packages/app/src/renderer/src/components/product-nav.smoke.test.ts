// @vitest-environment happy-dom
/**
 * 产品主导航冒烟。发布前回归要钉住的是：向导走完之后，每一栏都能切到
 * 对应页，而不是「能力默认全开、点下去标题对不上 / 仍停在对话」。
 *
 * AppShell 静态拉了一整棵聊天树。这里只保留真实的 NavRail，其余子树换成
 * 占位 —— 测的是壳上的 selectNav / FEATURE_TITLE，不是每个面板自己的 IPC。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";
import { emptyUpdateState } from "../stores/update";

vi.mock("naive-ui", () => ({
  NButton: { inheritAttrs: false, template: `<button v-bind="$attrs"><slot /></button>` },
  NSpin: { template: `<span class="spin" />` },
  NTooltip: { template: `<span><slot /><slot name="trigger" /></span>` },
  useMessage: () => ({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}));

function pageStub(name: string) {
  // defineAsyncComponent 的 loader 会把整个模块当 type 交给 vue-test-utils，
  // 后者读取 __isTeleport；vitest 的 mock 代理对未导出字段直接抛错。
  return {
    __esModule: true,
    default: { name, template: `<div data-page="${name}" />` },
    __isTeleport: false,
    __isKeepAlive: false,
  };
}

vi.mock("./Sidebar.vue", () => pageStub("Sidebar"));
vi.mock("./TaskContextPanel.vue", () => pageStub("TaskContextPanel"));
vi.mock("./TopBar.vue", () => pageStub("TopBar"));
vi.mock("./ChatView.vue", () => pageStub("ChatView"));
vi.mock("./InputBar.vue", () => pageStub("InputBar"));
vi.mock("./ModelErrorHint.vue", () => pageStub("ModelErrorHint"));
vi.mock("./ExtensionUiHost.vue", () => pageStub("ExtensionUiHost"));
vi.mock("./SettingsModal.vue", () => pageStub("SettingsModal"));
vi.mock("./UpdateBanner.vue", () => pageStub("UpdateBanner"));
vi.mock("./SafeModeBanner.vue", () => pageStub("SafeModeBanner"));
vi.mock("./InstallBlockerDialog.vue", () => pageStub("InstallBlockerDialog"));
vi.mock("./ProjectTrustDialog.vue", () => pageStub("ProjectTrustDialog"));
vi.mock("./OnboardingWizard.vue", () => ({
  default: { name: "OnboardingWizard", template: `<div data-page="onboarding">首次启动</div>` },
}));
vi.mock("./FileEditorPane.vue", () => pageStub("FileEditorPane"));
vi.mock("./ChangesetPanel.vue", () => pageStub("ChangesetPanel"));
vi.mock("./PreviewPane.vue", () => pageStub("PreviewPane"));
vi.mock("./HomeDashboardPanel.vue", () => pageStub("HomeDashboardPanel"));
vi.mock("./PiResourcesPanel.vue", () => pageStub("PiResourcesPanel"));
vi.mock("./ProviderCenter.vue", () => pageStub("ProviderCenter"));
vi.mock("./UsagePanel.vue", () => pageStub("UsagePanel"));
vi.mock("./ArtifactLibrary.vue", () => pageStub("ArtifactLibrary"));
vi.mock("./MemoryPanel.vue", () => pageStub("MemoryPanel"));
vi.mock("./SessionTreePanel.vue", () => pageStub("SessionTreePanel"));
vi.mock("./GitPanel.vue", () => pageStub("GitPanel"));
vi.mock("./TerminalPanel.vue", () => pageStub("TerminalPanel"));
vi.mock("./TasksPanel.vue", () => pageStub("TasksPanel"));
vi.mock("./ChildAgentPanel.vue", () => pageStub("ChildAgentPanel"));
vi.mock("./ConnectorPanel.vue", () => pageStub("ConnectorPanel"));
vi.mock("./ConnectorChannelsPanel.vue", () => pageStub("ConnectorChannelsPanel"));
vi.mock("./RemotePanel.vue", () => pageStub("RemotePanel"));
vi.mock("./WorkflowPanel.vue", () => pageStub("WorkflowPanel"));
vi.mock("./PromptLibraryPanel.vue", () => pageStub("PromptLibraryPanel"));
vi.mock("./LibraryPage.vue", () => pageStub("LibraryPage"));
vi.mock("./AccountPage.vue", () => pageStub("AccountPage"));
vi.mock("./HomeAdvisorPanel.vue", () => pageStub("HomeAdvisorPanel"));
vi.mock("./RulesPanel.vue", () => pageStub("RulesPanel"));
vi.mock("./EduPanel.vue", () => pageStub("EduPanel"));

import AppShell from "./AppShell.vue";

const FEATURES: { label: string; title: string }[] = [
  { label: "任务", title: "定时任务" },
  { label: "资源库", title: "资源库" },
  { label: "记忆", title: "长期记忆" },
  { label: "渠道", title: "渠道" },
  { label: "工作流", title: "工作流" },
  { label: "终端", title: "终端" },
  { label: "模型", title: "模型" },
  { label: "设置", title: "设置" },
];

function baseSettings(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    piRuntimeMode: "bundled",
    sttApiKeyConfigured: false,
    sttApiKeyLast4: "",
    crashDumpConsent: "unset",
    workspaceDefaults: {},
    onboardingStep: 0,
    notificationsEnabled: true,
    voiceEnabled: false,
    theme: "dark",
    ...extra,
  };
}

function installBridge(opts: { onboarded: boolean; workspace: boolean }): void {
  const settings = baseSettings(
    opts.onboarded ? { onboardingCompletedAt: Date.now() } : {},
  );
  const workspace = opts.workspace
    ? { workspaceId: "ws-smoke", displayPath: "D:\\tmp\\smoke" }
    : null;
  const unsub = () => undefined;
  (window as unknown as { piBuddy: unknown }).piBuddy = {
    settings: {
      get: vi.fn(async () => ({ ...settings })),
      set: vi.fn(async (patch: Record<string, unknown>) => Object.assign(settings, patch)),
    },
    dialog: {
      currentWorkspace: vi.fn(async () => workspace),
    },
    pi: {
      events: {
        onEvent: vi.fn(() => unsub),
        onUiRequest: vi.fn(() => unsub),
        onExit: vi.fn(() => unsub),
        onModelError: vi.fn(() => unsub),
        onUiExpire: vi.fn(() => unsub),
        onUiExpireAll: vi.fn(() => unsub),
      },
      runtime: {
        start: vi.fn(async () => ({
          state: { sessionId: "s1", model: { provider: "demo", id: "demo" } },
          models: [{ provider: "demo", id: "demo", name: "demo" }],
          messages: [],
        })),
      },
      getState: vi.fn(async () => ({ success: true, data: { sessionId: "s1" } })),
      getSessionStats: vi.fn(async () => ({ success: true, data: {} })),
      getAvailableThinkingLevels: vi.fn(async () => ({ success: true, data: [] })),
      getMessages: vi.fn(async () => ({ success: true, data: [] })),
      extensionUi: { respond: vi.fn(async () => ({ ok: true })) },
    },
    sessions: {
      query: vi.fn(async () => []),
      getDraft: vi.fn(async () => null),
      saveDraft: vi.fn(async () => true),
    },
    providers: {
      list: vi.fn(async () => ({ providers: [], permissionEnforced: true })),
      usage: { record: vi.fn(async () => undefined) },
    },
    capabilities: {
      describe: vi.fn(async () => ({
        activeProfileId: "",
        profiles: [],
        capabilities: [],
        restartRequired: false,
      })),
    },
    promptLibrary: { list: vi.fn(async () => ({ entries: [], errors: [] })) },
    update: {
      getState: vi.fn(async () => emptyUpdateState()),
      onEvent: vi.fn(() => unsub),
    },
    permission: {
      describe: vi.fn(async (workspaceId: string | null) => ({
        workspaceId,
        workspaceGrants: [],
        sessionGrants: [],
        audit: [],
      })),
    },
    piResources: {
      trust: { describe: vi.fn(async () => null), decide: vi.fn() },
    },
  };
}

const mounted: ReturnType<typeof mount>[] = [];

async function mountShell() {
  const wrapper = mount(AppShell, { attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe("产品主导航", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  afterEach(() => {
    while (mounted.length) {
      const wrapper = mounted.pop();
      try {
        wrapper?.unmount();
      } catch {
        /* 渲染中途失败时子树可能已经是残 vnode */
      }
    }
  });

  it("向导未完成时不进主界面", async () => {
    installBridge({ onboarded: false, workspace: true });
    const wrapper = await mountShell();
    expect(wrapper.find("[data-page=onboarding]").exists()).toBe(true);
    expect(wrapper.find(".app-shell").exists()).toBe(false);
    expect(wrapper.find('[aria-label="主导航"]').exists()).toBe(false);
  });

  it("向导完成后每一栏都能切到对应标题", async () => {
    installBridge({ onboarded: true, workspace: true });
    const wrapper = await mountShell();
    expect(wrapper.find(".app-shell").exists()).toBe(true);
    expect(wrapper.find('[aria-label="主导航"]').exists()).toBe(true);

    for (const { label, title } of FEATURES) {
      const btn = wrapper.find(`button[aria-label="${label}"]`);
      expect(btn.exists(), `导航应有「${label}」`).toBe(true);
      await btn.trigger("click");
      await wrapper.vm.$nextTick();
      expect(wrapper.find(".feature-title").text()).toBe(title);
    }

    await wrapper.find('button[aria-label="对话"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".feature-title").exists()).toBe(false);
    expect(wrapper.find('[data-page="ChatView"]').exists()).toBe(true);
  });

  it("对话页再点「对话」收起会话栏，再点展开", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
    installBridge({ onboarded: true, workspace: true });
    const wrapper = await mountShell();
    expect(wrapper.find('[data-page="Sidebar"]').exists()).toBe(true);
    expect(wrapper.find('button[aria-label="对话"]').attributes("aria-expanded")).toBe("true");

    await wrapper.find('button[aria-label="对话"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-page="Sidebar"]').exists()).toBe(false);
    expect(wrapper.find('[data-page="ChatView"]').exists()).toBe(true);
    expect(wrapper.find('button[aria-label="对话"]').attributes("aria-expanded")).toBe("false");

    await wrapper.find('button[aria-label="对话"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-page="Sidebar"]').exists()).toBe(true);
    expect(wrapper.find('button[aria-label="对话"]').attributes("aria-expanded")).toBe("true");
  });
});
