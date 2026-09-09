// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiResourceScanResult, ProjectTrustState } from "@contract";

const { warningSpy } = vi.hoisted(() => ({ warningSpy: vi.fn() }));

vi.mock("naive-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("naive-ui")>();
  return {
    ...actual,
    useDialog: () => ({ warning: warningSpy }),
  };
});

import McpPanel from "./McpPanel.vue";
import PiResourcesPanel from "./PiResourcesPanel.vue";
import { useAppStore } from "../stores/app";
import { usePiResourcesStore } from "../stores/piResources";

const removeSpy = vi.fn();
const trust: ProjectTrustState = {
  workspaceId: "ws-A",
  hasProjectResources: false,
  resources: [],
  saved: "none",
  defaultProjectTrust: "ask",
  effective: "deny",
  needsPrompt: false,
  note: "",
};
const scan: PiResourceScanResult = {
  resources: [
    {
      id: "package-alpha",
      kind: "package",
      name: "alpha",
      path: "D:/ws-A/.pi/settings.json",
      source: "project",
      enabled: true,
      version: "1.0.0",
      pinned: true,
      spec: "npm:alpha",
      conflictWith: [],
      diagnostics: [],
    },
  ],
  trust,
  mcp: { implemented: false, note: "" },
  scannedAt: 1,
  errors: [],
};

async function settle(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  setActivePinia(createPinia());
  warningSpy.mockReset();
  removeSpy.mockReset();
  removeSpy.mockResolvedValue({ ok: true, output: "" });
  document.body.innerHTML = "";
  (window as unknown as { piBuddy: unknown }).piBuddy = {
    piResources: {
      scan: vi.fn(async () => scan),
      setEnabled: vi.fn(async () => scan),
      install: vi.fn(),
      remove: removeSpy,
      openDir: vi.fn(),
      trust: { describe: vi.fn(), decide: vi.fn() },
    },
    mcp: {
      list: vi.fn(async () => ({ servers: [], errors: [], scannedAt: 1 })),
      save: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
  };
});

describe("workspace-bound renderer actions", () => {
  it("卸载确认打开后切到 B，不会拿 A 的资源去卸载 B", async () => {
    const app = useAppStore();
    const piRes = usePiResourcesStore();
    app.workspaceId = "ws-A";
    piRes.setWorkspace("ws-A");
    piRes.scan = scan;
    piRes.trustState = trust;
    piRes.panelOpen = true;

    mount(PiResourcesPanel, { attachTo: document.body });
    await settle();
    const removeButton = [...document.body.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("卸载")
    );
    expect(removeButton).toBeTruthy();
    removeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(warningSpy).toHaveBeenCalledTimes(1);

    app.workspaceId = "ws-B";
    await warningSpy.mock.calls[0][0].onPositiveClick();

    expect(removeSpy).not.toHaveBeenCalled();
    expect(piRes.lastError).toContain("工作目录已经切换");
  });

  it("MCP 新建表单在工作区切换时关闭并清空", async () => {
    const app = useAppStore();
    app.workspaceId = "ws-A";
    const wrapper = mount(McpPanel, { attachTo: document.body });
    await settle();

    const newButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("新建服务器"));
    expect(newButton).toBeTruthy();
    await newButton!.trigger("click");
    await settle();
    const nameInput = wrapper.find('input[placeholder="filesystem"]');
    expect(nameInput.exists()).toBe(true);
    await nameInput.setValue("alpha");

    app.workspaceId = "ws-B";
    await settle();
    expect(wrapper.find('input[placeholder="filesystem"]').exists()).toBe(false);

    const reopenButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("新建服务器"));
    await reopenButton!.trigger("click");
    await settle();
    expect(wrapper.find<HTMLInputElement>('input[placeholder="filesystem"]').element.value).toBe("");
  });
});
