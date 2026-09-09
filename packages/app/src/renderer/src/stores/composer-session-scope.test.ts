/**
 * 输入区（composer）与草稿的**会话归属**（SES-1）。
 *
 * 被实测出来的缺陷是一条时序：在 A 会话打字触发 500ms 防抖，还没到点就切到
 * B —— 定时器**触发时才读 currentSessionId**，于是 A 打的那段字被写进了 B 的
 * 草稿。同一根源还有两个表现：正文与本地队列是全局 ref、图片与文件附件是
 * InputBar 的组件级 ref，换会话时一处都不清。
 *
 * 因此下面每一条都必须真的制造出「切走之后定时器才触发」的时序，而不是
 * 「切走时顺手 flush 一次」—— 后者在坏代码上也是绿的。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AttachmentRef } from "@contract";
import { useAppStore } from "./app";

let saveDraft: ReturnType<typeof vi.fn>;
let getDraft: ReturnType<typeof vi.fn>;

function attachment(name: string): AttachmentRef {
  return { token: `tok-${name}`, name, size: 1, kind: "other" };
}

beforeEach(() => {
  setActivePinia(createPinia());
  saveDraft = vi.fn(async () => true);
  getDraft = vi.fn(async () => null);
  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: { pi: {}, sessions: { saveDraft, getDraft } },
  };
});

describe("草稿防抖捕获发起时的 sessionId", () => {
  it("A 打完字立刻切到 B，到点写下的仍是 A 的会话与 A 的正文", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";

    store.editorText = "只属于 A 的一段话";
    store.draftAttachments = [attachment("not-durable.txt")];
    store.scheduleSaveDraft();

    // ——— 时序的要害：防抖窗口只走了 200ms，定时器还没触发 ———
    vi.advanceTimersByTime(200);
    expect(saveDraft).toHaveBeenCalledTimes(0);

    // 用户切到 B，并且立刻在 B 里打了别的字
    store.currentSessionId = "sess-B";
    expect(store.editorText).toBe("");
    store.editorText = "只属于 B 的一段话";

    // 现在才让 A 的定时器到点
    vi.advanceTimersByTime(500);
    await Promise.resolve();

    expect(saveDraft).toHaveBeenCalledTimes(1);
    const [workspaceId, sessionId, draft] = saveDraft.mock.calls[0];
    expect(workspaceId).toBe("ws-1");
    expect(sessionId).toBe("sess-A");
    expect(draft.text).toBe("只属于 A 的一段话");
    expect(draft.attachments).toEqual([]);
    vi.useRealTimers();
  });

  it("两个会话各自的防抖互不吞并：切走后再在新会话打字，两份草稿都写得下来", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    store.workspaceId = "ws-1";

    store.currentSessionId = "sess-A";
    store.editorText = "A 的草稿";
    store.scheduleSaveDraft();

    vi.advanceTimersByTime(100);
    store.currentSessionId = "sess-B";
    store.editorText = "B 的草稿";
    store.scheduleSaveDraft();

    vi.advanceTimersByTime(600);
    await Promise.resolve();

    const written = saveDraft.mock.calls.map((c) => [c[1], c[2].text]);
    expect(written).toEqual([
      ["sess-A", "A 的草稿"],
      ["sess-B", "B 的草稿"],
    ]);
    vi.useRealTimers();
  });

  it("从未编辑过的会话不会被写一份空草稿盖掉磁盘上已有的那份", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";
    // 直接对一个没有 composer 格子的会话落盘
    await store.saveDraftNow("sess-never-touched");
    expect(saveDraft).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });
});

describe("composer 四样状态都按会话存放", () => {
  it("正文 / 图片 / 附件 / 本地队列切走都不跟过去，切回来原样还在", () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";

    store.editorText = "A 的正文";
    store.draftImages = [{ type: "image", data: "AAAA", mimeType: "image/png", name: "a.png" }];
    store.draftAttachments = [attachment("a.txt")];
    store.enqueueLocal("A 先攒着的一条", "followUp");

    store.currentSessionId = "sess-B";
    expect(store.editorText).toBe("");
    expect(store.draftImages).toHaveLength(0);
    expect(store.draftAttachments).toHaveLength(0);
    expect(store.localQueue).toHaveLength(0);

    store.currentSessionId = "sess-A";
    expect(store.editorText).toBe("A 的正文");
    expect(store.draftImages).toHaveLength(1);
    expect(store.draftAttachments[0].name).toBe("a.txt");
    expect(store.localQueue).toHaveLength(1);
  });

  it("会话 id 未知时打的字，在 id 到手之后跟着搬到真 id 上（而不是凭空消失）", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    // currentSessionId 初始是占位空串 —— pi 还没回报会话 id
    expect(store.currentSessionId).toBe("");
    store.editorText = "开机就打的一段话";
    store.draftImages = [{ type: "image", data: "AAAA", mimeType: "image/png", name: "a.png" }];
    store.draftAttachments = [attachment("ephemeral.txt")];
    store.enqueueLocal("稍后发送", "followUp");

    // newTask → refreshState → adoptSession("s-real")，走真实路径
    const piBuddy = (globalThis as unknown as { window: { piBuddy: Record<string, unknown> } })
      .window.piBuddy;
    piBuddy.pi = {
      newSession: vi.fn(async () => ({ success: true, data: { cancelled: false } })),
      getState: vi.fn(async () => ({ success: true, data: { sessionId: "s-real" } })),
    };
    (piBuddy.sessions as Record<string, unknown>).query = vi.fn(async () => []);

    await store.newTask();

    expect(store.currentSessionId).toBe("s-real");
    expect(store.editorText).toBe("开机就打的一段话");
    expect(store.draftImages).toHaveLength(1);
    expect(store.localQueue.map((item) => item.text)).toEqual(["稍后发送"]);
    expect(store.draftAttachments).toHaveLength(0);
  });

  it("换工作区时输入区整表作废（两个工作区可能有同 id 的会话）", () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "dup-id";
    store.editorText = "ws-1 里的草稿";

    store.adoptWorkspace({ workspaceId: "ws-2", displayPath: "/w2" });
    expect(store.editorText).toBe("");
  });
});

describe("restoreDraft 写进发起恢复的那个会话", () => {
  it("IPC 往返期间用户切走了，恢复出来的草稿不会盖到新会话头上", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";
    // 让索引里有这条会话（restoreDraft 先要在列表里确认存在）
    const { useSessionsStore } = await import("./sessions");
    useSessionsStore().rows = [{ sessionId: "sess-A" } as never];

    let release: (v: unknown) => void = () => undefined;
    getDraft.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    const pending = store.restoreDraft();
    // 还没回来就切走
    store.currentSessionId = "sess-B";
    store.editorText = "B 里正在打的字";
    release({
      text: "A 的旧草稿",
      attachments: [attachment("stale.txt")],
      queue: { steering: [], followUp: [] },
      updatedAt: 1,
    });
    await pending;

    expect(store.editorText).toBe("B 里正在打的字");
    store.currentSessionId = "sess-A";
    expect(store.editorText).toBe("A 的旧草稿");
    expect(store.draftAttachments).toHaveLength(0);
  });
});
