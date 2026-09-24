// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("naive-ui", () => ({
  NButton: {
    props: ["tag", "disabled"],
    template: `<component :is="tag || 'button'" :disabled="disabled" v-bind="$attrs"><slot /></component>`,
  },
  NBadge: { template: `<span />` },
  NPopover: { template: `<div><slot name="trigger" /><slot /></div>` },
  NTag: { template: `<span><slot /></span>` },
  NSpace: { template: `<div><slot /></div>` },
  NSwitch: { template: `<button />` },
  NRadio: { template: `<label><slot /></label>` },
  NRadioGroup: { template: `<div><slot /></div>` },
}));

vi.mock("../stores/app", () => ({
  useAppStore: () => ({
    startError: null,
    runtimeWaking: false,
    runtimeAsleep: false,
    started: false,
    settings: { piRuntimeMode: "bundled" },
    currentSessionId: null,
    items: [],
    sessionLoadError: null,
    stats: null,
    queue: { steering: [], followUp: [] },
    localQueue: [],
    streaming: false,
  }),
}));
vi.mock("../stores/providers", () => ({
  useProvidersStore: () => ({ providers: [] }),
}));

import UpdateSettingsPanel from "./UpdateSettingsPanel.vue";
import StatusCenter from "./StatusCenter.vue";
import { emptyUpdateState, useUpdateStore } from "../stores/update";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("设置里的版本与发布入口", () => {
  it("区分签名自动更新和手动安装的 GitHub 预览版", async () => {
    const store = useUpdateStore();
    vi.spyOn(store, "init").mockResolvedValue(undefined);
    store.apply({ ...emptyUpdateState(), stateSequence: 1, currentVersion: "0.1.3", status: "unsupported" });
    const wrapper = mount(UpdateSettingsPanel);

    expect(wrapper.text()).toContain("0.1.3");
    expect(wrapper.text()).toContain("当前运行方式不支持签名自动更新");
    expect(wrapper.text()).toContain("预览版需从发布页手动下载并安装");
    expect(wrapper.findAll("button").find((b) => b.text() === "检查签名更新")?.attributes("disabled")).toBeDefined();
    const release = wrapper.find('a[href="https://github.com/onehopeA10/pibuddy/releases"]');
    expect(release.exists()).toBe(true);
    expect(release.attributes("target")).toBe("_blank");
    expect(release.attributes("rel")).toBe("noreferrer");
    wrapper.unmount();
  });
});

describe("状态中心的更新标签", () => {
  it.each([
    ["idle", "尚未检查更新", "warn"],
    ["unsupported", "当前运行方式不支持自动更新", "warn"],
    ["not-available", "签名源无更新", "ok"],
  ] as const)("%s 显示 %s", async (status, text, level) => {
    const store = useUpdateStore();
    store.apply({ ...emptyUpdateState(), stateSequence: 1, status });
    const wrapper = mount(StatusCenter);
    const row = wrapper.find('[data-status-key="update"]');
    expect(row.text()).toContain(text);
    expect(row.attributes("data-status-level")).toBe(level);
    wrapper.unmount();
  });
});
