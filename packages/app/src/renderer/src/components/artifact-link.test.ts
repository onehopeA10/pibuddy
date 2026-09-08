// @vitest-environment happy-dom
/**
 * 消息里的产物链接按 artifactId + version 解析（ART-102 / c[6] 的 UI 一半）。
 *
 * 磁盘那一半（文件挪走之后 resolveLink 仍然命中当时那一版）由
 * main/artifacts/artifact-store.test.ts 断言。这里断言的是渲染侧：
 *
 *   1. MessageItem 收到 artifacts 之后渲染出的是 ArtifactLink，
 *      **且渲染结果里不出现任何路径**；
 *   2. 产物在回收站里时给的是「点击恢复」，而不是一个死链或空白。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";
import type { AssistantMessage } from "@sdk";

vi.mock("../markdown", () => ({
  renderMarkdown: (s: string) => `<p>${s}</p>`,
  truncateToolOutput: (s: string) => s,
}));

import ArtifactLink from "./ArtifactLink.vue";
import MessageItem from "./MessageItem.vue";
import { useAppStore } from "../stores/app";

const RECORD = {
  id: "a-1",
  logicalKey: "reports/q1.docx",
  name: "季度报告.docx",
  kind: "document",
  sourceSessionId: "s1",
  sourceTurnId: "t1",
  sourceToolCallId: "c1",
  workspaceId: "w1",
  version: 1,
  sha256: "abc",
  createdAt: 1,
  updatedAt: 2,
  previewPath: null,
  exportPath: "reports/q1.docx",
  status: "ready",
  deletedAt: null,
  sizeBytes: 10,
};

function installBridge(items: unknown[], trashItems: unknown[] = []): void {
  (window as unknown as { piBuddy: unknown }).piBuddy = {
    artifacts: {
      query: vi.fn(async (params: { trashed?: boolean }) => ({
        items: params.trashed ? trashItems : items,
        total: params.trashed ? trashItems.length : items.length,
      })),
      restore: vi.fn(async () => ({ ok: true, record: { ...RECORD, status: "ready" } })),
    },
    preview: { convert: vi.fn(async () => ({})) },
    workspace: {
      changesets: vi.fn(async () => ({ entries: [], diffs: [] })),
      acceptChange: vi.fn(async () => ({ ok: true })),
      rejectChange: vi.fn(async () => ({ ok: true })),
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  // 产物库按 workspaceId 查；没有它就等于没有库可查，那是另一条分支。
  const app = useAppStore();
  app.workspaceId = "w1";
  app.currentSessionId = "s1";
});

describe("ArtifactLink", () => {
  it("按 artifactId + version 解析，界面上不出现任何路径", async () => {
    installBridge([RECORD]);
    const wrapper = mount(ArtifactLink, {
      props: { artifactId: "a-1", version: 1, name: "季度报告.docx" },
      global: { stubs: { NButton: false, NTag: false } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("季度报告.docx");
    expect(wrapper.text()).toContain("v1");
    // 路径绝不出现在链接上 —— 那是易失的，也是这条不变量存在的全部理由
    expect(wrapper.text()).not.toContain("reports/q1.docx");
  });

  it("同一 artifactId 的第 1 版被解析到，即便链上已经有第 2 版", async () => {
    const v2 = { ...RECORD, id: "a-2", version: 2, name: "季度报告.docx", sha256: "def" };
    installBridge([RECORD, v2]);
    const wrapper = mount(ArtifactLink, {
      props: { artifactId: "a-2", version: 1 },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("v1");
  });

  it("产物在回收站里时给的是「点击恢复」，而不是死链", async () => {
    installBridge([], [{ ...RECORD, status: "trashed", deletedAt: 9 }]);
    const wrapper = mount(ArtifactLink, {
      props: { artifactId: "a-1", version: 1 },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("已移入回收站，点击恢复");
  });

  it("产物整个找不到时如实说找不到，不静默渲染成空", async () => {
    installBridge([]);
    const wrapper = mount(ArtifactLink, {
      props: { artifactId: "missing", version: 1, name: "某个东西" },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("找不到这个产物");
  });

  it("同一会话多条链接只查一轮产物和变更，不各自扫全表", async () => {
    installBridge([RECORD]);
    const api = (
      window as unknown as {
        piBuddy: {
          artifacts: { query: ReturnType<typeof vi.fn> };
          workspace: { changesets: ReturnType<typeof vi.fn> };
        };
      }
    ).piBuddy;
    mount(ArtifactLink, { props: { artifactId: "a-1", version: 1 } });
    mount(ArtifactLink, { props: { artifactId: "a-1", version: 1 } });
    await flushPromises();
    expect(api.artifacts.query).toHaveBeenCalledTimes(2);
    expect(api.workspace.changesets).toHaveBeenCalledTimes(1);
  });
});

describe("MessageItem 里的产物链接", () => {
  it("工具生成文件时渲染 ArtifactLink（带 artifactId + version），而不是一行路径文本", async () => {
    installBridge([RECORD]);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "我把报告做好了。" }],
    } as unknown as AssistantMessage;

    const wrapper = mount(MessageItem, {
      props: {
        message,
        messageKey: 1,
        artifacts: [{ artifactId: "a-1", version: 1, name: "季度报告.docx" }],
      },
      global: { stubs: { NAlert: true, ToolActivity: true } },
    });
    await flushPromises();

    const link = wrapper.findComponent(ArtifactLink);
    expect(link.exists()).toBe(true);
    expect(link.props("artifactId")).toBe("a-1");
    expect(link.props("version")).toBe(1);
    expect(wrapper.text()).not.toContain("reports/q1.docx");
  });

  it("没有产物时不渲染任何链接（不留一个空行）", () => {
    installBridge([]);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "好的。" }],
    } as unknown as AssistantMessage;
    const wrapper = mount(MessageItem, {
      props: { message, messageKey: 2 },
      global: { stubs: { NAlert: true, ToolActivity: true } },
    });
    expect(wrapper.findComponent(ArtifactLink).exists()).toBe(false);
  });
});

describe("ArtifactLink 确认/撤回", () => {
  it("有 pending changeset 才出现留下/退回；查询带上 sessionId；路径仍不出现", async () => {
    installBridge([RECORD]);
    const api = (window as unknown as { piBuddy: { workspace: { changesets: ReturnType<typeof vi.fn> } } })
      .piBuddy;
    api.workspace.changesets.mockResolvedValueOnce({
      entries: [
        {
          id: "cs-1",
          sessionId: "s1",
          turnId: "t1",
          toolCallId: "c1",
          toolName: "write",
          kind: "write",
          relativePath: "reports/q1.docx",
          beforeSha256: "",
          afterSha256: "abc",
          status: "pending",
          createdAt: 1,
          sizeBytes: 10,
          binary: false,
          tooLarge: false,
        },
      ],
      diffs: [],
    });
    const wrapper = mount(ArtifactLink, {
      props: { artifactId: "a-1", version: 1, name: "季度报告.docx" },
    });
    await flushPromises();
    expect(api.workspace.changesets).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", sessionId: "s1" })
    );
    expect(wrapper.text()).toContain("留下这份");
    expect(wrapper.text()).toContain("退回这次");
    expect(wrapper.text()).not.toContain("reports/q1.docx");
  });

  it("留下失败时按钮还在，并说出原因", async () => {
    installBridge([RECORD]);
    const api = (
      window as unknown as {
        piBuddy: {
          workspace: {
            changesets: ReturnType<typeof vi.fn>;
            acceptChange: ReturnType<typeof vi.fn>;
          };
        };
      }
    ).piBuddy;
    api.workspace.changesets.mockResolvedValueOnce({
      entries: [
        {
          id: "cs-1",
          sessionId: "s1",
          turnId: "t1",
          toolCallId: "c1",
          toolName: "write",
          kind: "write",
          relativePath: "reports/q1.docx",
          beforeSha256: "",
          afterSha256: "abc",
          status: "pending",
          createdAt: 1,
          sizeBytes: 10,
          binary: false,
          tooLarge: false,
        },
      ],
      diffs: [],
    });
    api.workspace.acceptChange.mockRejectedValueOnce(new Error("hash conflict"));
    const wrapper = mount(ArtifactLink, {
      props: { artifactId: "a-1", version: 1, name: "季度报告.docx" },
    });
    await flushPromises();
    await wrapper.get('[aria-label="留下这份改动"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("留下这份");
    expect(wrapper.text()).toContain("这份后来又被动过，没法替你退回。");
  });
});
