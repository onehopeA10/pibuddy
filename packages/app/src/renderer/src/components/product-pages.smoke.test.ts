// @vitest-environment happy-dom
/**
 * 产品页自身的挂载冒烟（记忆 / 任务 / 设置 / 账号）。
 *
 * 导航测的是壳；这里测的是点进去之后页面还在：居中栏、分区标题、空态文案。
 * 不走真实 IPC，只证明这四个发布后用户天天点的面「能渲染、关键文案还在」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("naive-ui", () => ({
  NAlert: { template: `<div class="alert"><slot /></div>` },
  NButton: { inheritAttrs: false, template: `<button v-bind="$attrs"><slot /></button>` },
  NCheckbox: {
    props: ["checked"],
    emits: ["update:checked"],
    template: `<label><input type="checkbox" :checked="checked" /><slot /></label>`,
  },
  NCheckboxGroup: { template: `<div><slot /></div>` },
  NForm: { template: `<form><slot /></form>` },
  NFormItem: { inheritAttrs: false, template: `<div class="form-item"><slot /></div>` },
  NInput: {
    inheritAttrs: false,
    props: ["value"],
    emits: ["update:value"],
    template: `<input v-bind="$attrs" :value="value" />`,
  },
  NInputNumber: {
    inheritAttrs: false,
    props: ["value"],
    template: `<input type="number" v-bind="$attrs" :value="value" />`,
  },
  NModal: { template: `<div class="modal"><slot /></div>` },
  NRadio: { inheritAttrs: false, template: `<label v-bind="$attrs"><slot /></label>` },
  NRadioGroup: { inheritAttrs: false, template: `<div v-bind="$attrs"><slot /></div>` },
  NSelect: { inheritAttrs: false, template: `<div class="n-select" v-bind="$attrs" />` },
  NSpace: { template: `<div><slot /></div>` },
  NSpin: { template: `<span class="spin" />` },
  NSwitch: { inheritAttrs: false, template: `<button type="button" v-bind="$attrs" />` },
  NTabPane: {
    inheritAttrs: false,
    props: ["name", "tab"],
    template: `<section :data-tab="name"><slot /></section>`,
  },
  NTabs: { inheritAttrs: false, template: `<div class="tabs"><slot /></div>` },
  NTag: { inheritAttrs: false, template: `<span v-bind="$attrs"><slot /></span>` },
  useMessage: () => ({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

vi.mock("./UpdateSettingsPanel.vue", () => ({ default: { template: `<div data-stub="update" />` } }));
vi.mock("./DiagnosticsPanel.vue", () => ({ default: { template: `<div data-stub="diag" />` } }));
vi.mock("./BackupPanel.vue", () => ({ default: { template: `<div data-stub="backup" />` } }));
vi.mock("./HomeAssistantSettings.vue", () => ({ default: { template: `<div data-stub="ha" />` } }));
vi.mock("./SessionImportPanel.vue", () => ({ default: { template: `<div data-stub="import" />` } }));
vi.mock("./RemotePanel.vue", () => ({ default: { template: `<div data-stub="remote" />` } }));
vi.mock("./ProviderCenter.vue", () => ({
  default: { props: ["embedded"], template: `<div data-stub="providers">服务商账号</div>` },
}));
vi.mock("./UsagePanel.vue", () => ({
  default: { props: ["embedded"], template: `<div data-stub="usage">用量</div>` },
}));

import MemoryPanel from "./MemoryPanel.vue";
import TasksPanel from "./TasksPanel.vue";
import SettingsModal from "./SettingsModal.vue";
import AccountPage from "./AccountPage.vue";
import { useAppStore } from "../stores/app";

function installBridge(): void {
  (window as unknown as { piBuddy: unknown }).piBuddy = {
    memory: {
      query: vi.fn(async () => ({
        items: [],
        total: 0,
        injectionEnabled: true,
        globalInjectionEnabled: true,
      })),
      hits: vi.fn(async () => ({ hits: [] })),
      embedStatus: vi.fn(async () => ({
        backend: "none",
        model: "-",
        embeddedMemories: 0,
        totalMemories: 0,
      })),
      knowledgeList: vi.fn(async () => ({ items: [] })),
      export: vi.fn(async () => ({ content: "" })),
      setInjection: vi.fn(async () => ({
        injectionEnabled: true,
        globalInjectionEnabled: true,
      })),
      search: vi.fn(async () => ({ items: [], backend: "none" })),
    },
    tasks: {
      list: vi.fn(async () => ({ items: [] })),
      get: vi.fn(async () => null),
    },
    settings: {
      get: vi.fn(async () => ({ theme: "dark" })),
      set: vi.fn(async (patch: Record<string, unknown>) => patch),
    },
  };
}

const mounted: ReturnType<typeof mount>[] = [];

function mountPage(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}) {
  const wrapper = mount(component, { props, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

describe("产品页挂载", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    installBridge();
    const app = useAppStore();
    app.adoptWorkspace({ workspaceId: "ws-smoke", displayPath: "D:\\tmp\\smoke" });
  });

  afterEach(() => {
    while (mounted.length) mounted.pop()?.unmount();
  });

  it("记忆页带居中栏、注入开关和保存入口", async () => {
    const memory = (await import("../stores/memory")).useMemoryStore();
    memory.panelOpen = true;
    const wrapper = mountPage(MemoryPanel, { embedded: true });
    await flushPromises();
    expect(wrapper.find(".feature-page").exists()).toBe(true);
    expect(wrapper.text()).toContain("本工作区注入");
    expect(wrapper.text()).toContain("全局注入总开关");
    expect(wrapper.find('[aria-label="保存一条记忆"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="语义检索"]').exists()).toBe(true);
  });

  it("任务页带居中栏、新建入口和空态说明", async () => {
    const tasks = (await import("../stores/tasks")).useTasksStore();
    tasks.panelOpen = true;
    const wrapper = mountPage(TasksPanel, { embedded: true });
    await flushPromises();
    expect(wrapper.find(".feature-page").exists()).toBe(true);
    expect(wrapper.text()).toContain("新建任务");
    expect(wrapper.text()).toContain("还没有定时任务");
  });

  it("设置页列出全部分区，通用里有外观切换", async () => {
    const wrapper = mountPage(SettingsModal, { embedded: true });
    await flushPromises();
    const nav = wrapper.find('[aria-label="设置分类"]');
    expect(nav.exists()).toBe(true);
    for (const label of ["通用", "记忆", "能力", "数据", "关于"]) {
      expect(nav.text()).toContain(label);
    }
    expect(nav.text()).not.toContain("模型");
    expect(wrapper.find('[data-testid="theme-picker"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="close-action-picker"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="pi-runtime-picker"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("缩小到托盘");
    expect(wrapper.text()).toContain("深色");
    expect(wrapper.text()).toContain("浅色");
  });

  it("模型页同时挂上模型与用量两个面", async () => {
    const wrapper = mountPage(AccountPage);
    await flushPromises();
    expect(wrapper.find(".account-page").exists()).toBe(true);
    expect(wrapper.find('[data-tab="account"]').exists()).toBe(true);
    expect(wrapper.find('[data-tab="usage"]').exists()).toBe(true);
    expect(wrapper.find('[data-stub="providers"]').exists()).toBe(true);
    expect(wrapper.find('[data-stub="usage"]').exists()).toBe(true);
  });
});
