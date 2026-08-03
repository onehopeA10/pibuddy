// @vitest-environment happy-dom
/**
 * ChatView 换会话时传给 chat-window 的**字节上界**（SES-3）。
 *
 * 改造前这里写死 `win.reset(0)`，于是 `reachedTop` 在 reset 那一刻就是 true：
 * 「查看更早的消息」按钮根本不渲染，设计里那条 JSONL 反向分页一次都执行不到。
 * 三大门禁全绿 —— 只有在一个被压缩过的长会话里点一下才看得出来。
 *
 * 因此这条用例的判据必须落在**真实 DOM 与真实 IPC 调用**上：按钮存在、点下去
 * 之后 readHistoryBefore 收到的 beforeOffset 就是会话文件的字节数。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import type { SessionHistoryPage } from "@contract";

vi.mock("naive-ui", () => ({
  NButton: { inheritAttrs: false, template: `<button v-bind="$attrs"><slot /></button>` },
}));
vi.mock("./MessageItem.vue", () => ({
  default: { props: ["message", "messageKey", "streaming"], template: `<div class="msg" />` },
}));
vi.mock("./Welcome.vue", () => ({ default: { template: `<div class="welcome" />` } }));

import ChatView from "./ChatView.vue";
import { useAppStore } from "../stores/app";

let readHistoryBefore: ReturnType<typeof vi.fn>;

function page(entries: unknown[], nextBeforeOffset: number | null): SessionHistoryPage {
  return { entries, nextBeforeOffset, stale: false, skippedPartial: 0 } as SessionHistoryPage;
}

beforeEach(() => {
  setActivePinia(createPinia());
  readHistoryBefore = vi.fn(async () => page([], null));
  (window as unknown as { piBuddy: unknown }).piBuddy = {
    pi: {},
    sessions: { readHistoryBefore, query: vi.fn(async () => []), getDraft: vi.fn(async () => null) },
  };
});

describe("ChatView · 磁盘历史分页", () => {
  it("换会话后按真实字节数 reset，点「查看更早的消息」真的读磁盘", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    const wrapper = mount(ChatView);

    // 从会话列表打开一个 4096 字节的会话：字节数先落地，再换 currentSessionId
    store.currentSessionBytes = 4096;
    store.currentSessionId = "sess-1";
    store.items = [{ key: 1, message: { role: "user", content: "唯一一条" } }] as never;
    await nextTick();

    const button = wrapper.get('[aria-label="查看更早的消息"]');
    await button.trigger("click");
    await nextTick();

    expect(readHistoryBefore).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionId: "sess-1",
      beforeOffset: 4096,
      limit: 60,
    });
  });

  it("字节数为 0 的新会话不显示「查看更早的消息」，也不发请求", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    const wrapper = mount(ChatView);

    store.currentSessionBytes = 0;
    store.currentSessionId = "brand-new";
    store.items = [{ key: 1, message: { role: "user", content: "第一条" } }] as never;
    await nextTick();

    expect(wrapper.find('[aria-label="查看更早的消息"]').exists()).toBe(false);
    expect(readHistoryBefore).not.toHaveBeenCalled();
  });

  it("字节数迟到（开机直接恢复会话）时，按钮随后补出来", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    const wrapper = mount(ChatView);

    // currentSessionId 先变，字节数要等会话索引刷新完才知道
    store.currentSessionId = "resumed";
    store.items = [{ key: 1, message: { role: "user", content: "恢复出来的一条" } }] as never;
    await nextTick();
    expect(wrapper.find('[aria-label="查看更早的消息"]').exists()).toBe(false);

    store.currentSessionBytes = 8192;
    await nextTick();
    expect(wrapper.find('[aria-label="查看更早的消息"]').exists()).toBe(true);
  });
});
