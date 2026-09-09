// @vitest-environment happy-dom
/**
 * 信任决定必须提交给**弹窗里显示的那个项目**，而不是「当前工作目录」。
 *
 * 这两者会真的分开：describeTrust 的响应晚于一次工作目录切换时，弹窗里
 * 列的是旧项目的资源，store.workspaceId 已经是新项目。照 store.workspaceId
 * 提交，等于拿 A 项目的资源清单问用户、把答案写给 B 项目 —— 而勾了「记住」
 * 的决定会落进与终端 pi 共享的 trust.json，之后没有任何地方会提示。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import type { ProjectTrustState } from "@contract";
import ProjectTrustDialog from "./ProjectTrustDialog.vue";
import { useAppStore } from "../stores/app";
import { usePiResourcesStore } from "../stores/piResources";

const decideSpy = vi.fn(async (workspaceId: string) => ({
  ...shownTrust(workspaceId),
  saved: "allow" as const,
  effective: "allow" as const,
  needsPrompt: false,
}));

function shownTrust(workspaceId: string): ProjectTrustState {
  return {
    workspaceId,
    hasProjectResources: true,
    resources: [{ label: "项目技能 .pi/skills", path: `D:/${workspaceId}/.pi/skills` }],
    saved: "none",
    defaultProjectTrust: "ask",
    effective: "deny",
    needsPrompt: true,
    note: "信任不等于工具权限",
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  decideSpy.mockClear();
  (window as unknown as { piBuddy: unknown }).piBuddy = {
    pi: {},
    piResources: {
      trust: { describe: vi.fn(), decide: decideSpy },
    },
  };
});

/** 点弹窗页脚上那个按钮。NModal 的内容 teleport 到 body，所以从那里找。 */
async function clickFooter(label: string): Promise<void> {
  const button = [...document.body.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label)
  );
  if (!button) throw new Error(`按钮未渲染：${label}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
}

describe("ProjectTrustDialog", () => {
  it("提交给弹窗里显示的那个项目，而不是当前工作目录", async () => {
    const app = useAppStore();
    const piRes = usePiResourcesStore();
    // store 的权威上下文与弹窗快照都属于 A；这个组件单测不挂 AppShell，
    // 因此要显式建立上下文，不能只绕过 action 直接塞 trustState。
    piRes.setWorkspace("ws-A");
    // 弹窗里显示的是 A（describe 的响应属于 A）……
    piRes.trustState = shownTrust("ws-A");
    piRes.trustOpen = true;
    // ……而工作目录已经切到了 B
    app.workspaceId = "ws-B";

    mount(ProjectTrustDialog, { attachTo: document.body });
    await new Promise((r) => setTimeout(r, 0));

    await clickFooter("信任这个项目");

    expect(decideSpy).toHaveBeenCalledTimes(1);
    expect(decideSpy.mock.calls[0][0]).toBe("ws-A");
  });

  it("弹窗里列的资源就是那个项目的资源", async () => {
    const piRes = usePiResourcesStore();
    piRes.trustState = shownTrust("ws-A");
    piRes.trustOpen = true;

    mount(ProjectTrustDialog, { attachTo: document.body });
    await new Promise((r) => setTimeout(r, 0));

    expect(document.body.textContent).toContain("D:/ws-A/.pi/skills");
  });
});
