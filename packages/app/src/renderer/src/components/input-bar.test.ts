// @vitest-environment happy-dom
/**
 * 发送模式分流按钮与草稿防抖（TASK-010 c[8] / c[16]）。
 *
 * 草稿不防抖的话，长输入就是「每按一个键一次 IPC + 一次 SQLite 写」——
 * UI 上没有任何征兆，只有主进程在闷头刷盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { isReactive } from "vue";

const messageWarning = vi.hoisted(() => vi.fn());

// naive-ui 的 useMessage 需要祖先 provider；这里整体换成最小替身，
// 顺带让 aria-label 直接落到真实的 <button> 上便于断言。
vi.mock("naive-ui", () => ({
  NButton: { inheritAttrs: false, template: `<button v-bind="$attrs"><slot /></button>` },
  NInput: {
    inheritAttrs: false,
    props: ["value"],
    emits: ["update:value"],
    template: `<textarea v-bind="$attrs" :value="value" />`,
  },
  NSpin: { template: `<span class="spin" />` },
  NSelect: { inheritAttrs: false, template: `<div class="n-select" v-bind="$attrs" />` },
  NTag: { inheritAttrs: false, template: `<span v-bind="$attrs"><slot /></span>` },
  NTooltip: { template: `<span><slot /><slot name="trigger" /></span>` },
  useMessage: () => ({ info: vi.fn(), success: vi.fn(), warning: messageWarning, error: vi.fn() }),
}));

import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENT_TOKENS,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_TOTAL_ATTACHMENT_BYTES,
  MAX_PROMPT_TOTAL_IMAGE_BYTES,
} from "@contract";
import { nextTick } from "vue";
import InputBar from "./InputBar.vue";
import { useAppStore } from "../stores/app";

let saveDraft: ReturnType<typeof vi.fn>;
let fromDrop: ReturnType<typeof vi.fn>;
let chooseFiles: ReturnType<typeof vi.fn>;
let readImage: ReturnType<typeof vi.fn>;
const mountedWrappers: ReturnType<typeof mount>[] = [];
const NativeFileReader = globalThis.FileReader;

function mountInputBar(): ReturnType<typeof mount> {
  const wrapper = mount(InputBar);
  mountedWrappers.push(wrapper);
  return wrapper;
}

function ariaLabels(wrapper: ReturnType<typeof mount>): (string | undefined)[] {
  return wrapper.findAll("button").map((b) => b.attributes("aria-label"));
}

const PNG_DATA = "iVBORw0KGgo=";

function fileWithSize(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array([1])], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function dispatchDrop(files: File[]): void {
  const event = new Event("drop", { cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  window.dispatchEvent(event);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dispatchPaste(wrapper: ReturnType<typeof mount>, files: File[]): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      })),
    },
  });
  wrapper.find(".composer").element.dispatchEvent(event);
}

class ControlledFileReader {
  static instances: ControlledFileReader[] = [];
  static aborts = 0;
  result: string | ArrayBuffer | null = null;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onabort: ((event: ProgressEvent<FileReader>) => void) | null = null;

  constructor() {
    ControlledFileReader.instances.push(this);
  }

  readAsDataURL(): void {}

  abort(): void {
    ControlledFileReader.aborts++;
    this.onabort?.(new ProgressEvent("abort") as ProgressEvent<FileReader>);
  }

  complete(mimeType = "image/png"): void {
    this.result = `data:${mimeType};base64,${PNG_DATA}`;
    this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
  }
}

describe("InputBar", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    messageWarning.mockReset();
    ControlledFileReader.instances = [];
    ControlledFileReader.aborts = 0;
    mountedWrappers.length = 0;
    saveDraft = vi.fn(async () => true);
    fromDrop = vi.fn(async (file: File) => ({
      token: `token-${file.name}`,
      name: file.name,
      size: file.size,
      kind: "other" as const,
    }));
    chooseFiles = vi.fn(async () => []);
    readImage = vi.fn();
    (window as unknown as { piBuddy: unknown }).piBuddy = {
      pi: {},
      dialog: { chooseFiles },
      file: { fromDrop, readImage },
      sessions: { saveDraft, getDraft: vi.fn(async () => null) },
    };
  });

  afterEach(() => {
    for (const wrapper of mountedWrappers) wrapper.unmount();
    globalThis.FileReader = NativeFileReader;
    vi.useRealTimers();
  });

  it("助手输出中途，发送键旁同时给出「立即插话」与「下一轮处理」", () => {
    const store = useAppStore();
    store.started = true;
    store.streaming = true;
    const wrapper = mountInputBar();
    const labels = ariaLabels(wrapper);
    expect(labels).toContain("立即插话");
    expect(labels).toContain("下一轮处理");
  });

  it("助手空闲时只有普通发送键", () => {
    const store = useAppStore();
    store.started = true;
    store.streaming = false;
    const wrapper = mountInputBar();
    const labels = ariaLabels(wrapper);
    expect(labels).not.toContain("立即插话");
    expect(labels).not.toContain("下一轮处理");
  });

  it("10 次连续 keystroke 后推进 500ms，saveDraft 恰被调用 1 次", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    // 顺序不能反：started 落在 currentSessionId 对应的 runtimeScope 上，
    // 先写 started 再换 session 会让它落到旧 scope 上、输入框保持禁用，
    // 而 VTU 的 trigger() 对 disabled 元素直接不派发事件。
    store.currentSessionId = "sess-1";
    store.started = true;
    const wrapper = mountInputBar();
    const input = wrapper.find("textarea");

    for (let i = 0; i < 10; i++) {
      store.editorText += "字";
      await input.trigger("keydown", { key: "a" });
      vi.advanceTimersByTime(20);
    }
    expect(saveDraft).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    // saveDraft(workspaceId, sessionId, draft)：会话 id 只在工作区内唯一
    expect(saveDraft.mock.calls[0][1]).toBe("sess-1");
    expect(saveDraft.mock.calls[0][2]).toMatchObject({ text: "字".repeat(10) });
    vi.useRealTimers();
  });

  it("交给 IPC 的草稿是纯数据，不含 Vue 响应式代理", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    store.currentSessionId = "sess-1";
    store.started = true;
    store.enqueueLocal("先攒着的一条", "followUp");
    mountInputBar();
    store.editorText = "草稿正文";
    await Promise.resolve();
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    const payload = saveDraft.mock.calls.at(-1)![2];
    // Electron 的 IPC 用结构化克隆，响应式代理会以
    // "An object could not be cloned." 失败 —— 而这个异常只在 await 处冒出来，
    // 界面上没有任何征兆，表现就是「草稿永远存不上」。
    expect(isReactive(payload)).toBe(false);
    expect(isReactive(payload.attachments)).toBe(false);
    expect(isReactive(payload.queue)).toBe(false);
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload.queue.followUp).toEqual(["先攒着的一条"]);
    vi.useRealTimers();
  });

  /**
   * 图片与文件附件早先是 InputBar 的组件级 `ref([])`。组件不随会话重建 ——
   * 在 A 会话贴的图、拖进来的文件切到 B 之后原样留在输入框里，一按发送就
   * 发进了 B。这条用例的判据落在真实 DOM 上：附件条目要真的消失。
   */
  it("图片数量和单图大小在创建 FileReader 前就被拒绝", () => {
    globalThis.FileReader = ControlledFileReader as unknown as typeof FileReader;
    const store = useAppStore();
    store.started = true;
    store.draftImages = Array.from({ length: MAX_PROMPT_IMAGES }, (_, index) => ({
      type: "image" as const,
      data: "AAAA",
      mimeType: "image/png",
      name: `${index}.png`,
    }));
    mountInputBar();

    dispatchDrop([fileWithSize("extra.png", "image/png", 10)]);
    expect(ControlledFileReader.instances).toHaveLength(0);
    expect(messageWarning).toHaveBeenCalledWith(`图片最多添加 ${MAX_PROMPT_IMAGES} 张`);

    store.draftImages = [];
    dispatchDrop([fileWithSize("huge.png", "image/png", MAX_PROMPT_IMAGE_BYTES + 1)]);
    expect(ControlledFileReader.instances).toHaveLength(0);
    expect(messageWarning).toHaveBeenCalledWith("单张图片不能超过 10 MB");
  });

  it("并发粘贴与拖放会预留图片配额，不能竞态越过数量和总字节上限", async () => {
    globalThis.FileReader = ControlledFileReader as unknown as typeof FileReader;
    const store = useAppStore();
    store.started = true;
    const wrapper = mountInputBar();

    const five = Array.from({ length: 5 }, (_, index) =>
      fileWithSize(`paste-${index}.png`, "image/png", 1)
    );
    dispatchPaste(wrapper, five);
    dispatchDrop(
      Array.from({ length: 5 }, (_, index) =>
        fileWithSize(`drop-${index}.png`, "image/png", 1)
      )
    );
    expect(ControlledFileReader.instances).toHaveLength(MAX_PROMPT_IMAGES);

    for (const reader of [...ControlledFileReader.instances].reverse()) reader.complete();
    await nextTick();
    expect(store.draftImages).toHaveLength(MAX_PROMPT_IMAGES);
    expect(messageWarning).toHaveBeenCalledWith(`图片最多添加 ${MAX_PROMPT_IMAGES} 张`);

    store.draftImages = [];
    ControlledFileReader.instances = [];
    const half = MAX_PROMPT_TOTAL_IMAGE_BYTES / 2;
    dispatchDrop([
      fileWithSize("a.png", "image/png", half),
      fileWithSize("b.png", "image/png", half),
      fileWithSize("c.png", "image/png", 1),
    ]);
    expect(ControlledFileReader.instances).toHaveLength(2);
    expect(messageWarning).toHaveBeenCalledWith("图片总大小不能超过 16 MB");
  });

  it("非图片附件受共享数量、单文件与总字节限制，超限时不调用 preload", () => {
    const store = useAppStore();
    store.started = true;
    store.draftAttachments = Array.from(
      { length: MAX_PROMPT_ATTACHMENT_TOKENS },
      (_, index) => ({ token: `t-${index}`, name: `${index}.txt`, size: 1, kind: "other" as const })
    );
    mountInputBar();

    dispatchDrop([fileWithSize("extra.txt", "text/plain", 1)]);
    expect(fromDrop).not.toHaveBeenCalled();
    expect(messageWarning).toHaveBeenCalledWith(
      `文件最多添加 ${MAX_PROMPT_ATTACHMENT_TOKENS} 个`
    );

    store.draftAttachments = [];
    dispatchDrop([
      fileWithSize("huge.txt", "text/plain", MAX_PROMPT_ATTACHMENT_BYTES + 1),
    ]);
    expect(fromDrop).not.toHaveBeenCalled();
    expect(messageWarning).toHaveBeenCalledWith("单个文件不能超过 10 MB");

    const halfPlusOne = Math.floor(MAX_PROMPT_TOTAL_ATTACHMENT_BYTES / 2) + 1;
    store.draftAttachments = [
      { token: "existing", name: "existing.txt", size: halfPlusOne, kind: "other" },
    ];
    dispatchDrop([fileWithSize("total.txt", "text/plain", halfPlusOne)]);
    expect(fromDrop).not.toHaveBeenCalled();
    expect(messageWarning).toHaveBeenCalledWith("文件总大小不能超过 16 MB");
  });

  it("A 会话的待完成 FileReader 不占 B 配额，完成结果也不会追加到 B", async () => {
    globalThis.FileReader = ControlledFileReader as unknown as typeof FileReader;
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";
    store.started = true;
    mountInputBar();

    dispatchDrop(
      Array.from({ length: MAX_PROMPT_IMAGES }, (_, index) =>
        fileWithSize(`a-${index}.png`, "image/png", 1)
      )
    );
    expect(ControlledFileReader.instances).toHaveLength(MAX_PROMPT_IMAGES);

    store.currentSessionId = "sess-B";
    dispatchDrop([fileWithSize("b.png", "image/png", 1)]);
    expect(ControlledFileReader.instances).toHaveLength(MAX_PROMPT_IMAGES + 1);

    ControlledFileReader.instances[0].complete();
    ControlledFileReader.instances[MAX_PROMPT_IMAGES].complete();
    await nextTick();
    expect(store.draftImages.map((image) => image.name)).toEqual(["b.png"]);

    store.currentSessionId = "sess-A";
    expect(store.draftImages).toHaveLength(0);
  });

  it("A 会话的延迟 drop 与 pick 结果不会写入 B", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";
    store.started = true;
    const wrapper = mountInputBar();

    const dropped = deferred<{ token: string; name: string; size: number; kind: "other" }>();
    fromDrop.mockReturnValueOnce(dropped.promise);
    dispatchDrop([fileWithSize("a.txt", "text/plain", 1)]);
    await Promise.resolve();
    expect(fromDrop).toHaveBeenCalledTimes(1);

    const pickedImage = {
      token: "picked-image",
      name: "picked.png",
      size: 1,
      kind: "image" as const,
    };
    chooseFiles.mockResolvedValueOnce([pickedImage]);
    const imageRead = deferred<{ data: string; mimeType: string }>();
    readImage.mockReturnValueOnce(imageRead.promise);
    const fileButton = wrapper.findAll("button").find((button) => button.text().includes("文件"))!;
    await fileButton.trigger("click");
    await Promise.resolve();
    expect(readImage).toHaveBeenCalledWith("picked-image");

    store.currentSessionId = "sess-B";
    dropped.resolve({ token: "drop-a", name: "a.txt", size: 1, kind: "other" });
    imageRead.resolve({ data: PNG_DATA, mimeType: "image/png" });
    await Promise.resolve();
    await nextTick();

    expect(store.draftAttachments).toEqual([]);
    expect(store.draftImages).toEqual([]);
  });

  it("有效切换已清 token 但 sessionId 尚未刷新时，旧 epoch 的完成结果仍被丢弃", async () => {
    globalThis.FileReader = ControlledFileReader as unknown as typeof FileReader;
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";
    store.started = true;
    mountInputBar();

    dispatchDrop([fileWithSize("late.png", "image/png", 1)]);
    expect(ControlledFileReader.instances).toHaveLength(1);
    // 对应 main 已成功切换并 revokeAll、renderer 尚未 refreshState 改 sessionId 的窗口。
    store.composerAttachmentEpoch++;
    ControlledFileReader.instances[0].complete();
    await nextTick();
    expect(store.draftImages).toEqual([]);
  });

  it("卸载会中止 FileReader 并清理 reservation，迟到完成不再写状态", async () => {
    globalThis.FileReader = ControlledFileReader as unknown as typeof FileReader;
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";
    store.started = true;
    const wrapper = mountInputBar();

    dispatchDrop([fileWithSize("pending.png", "image/png", 1)]);
    expect(ControlledFileReader.instances).toHaveLength(1);
    wrapper.unmount();
    expect(ControlledFileReader.aborts).toBe(1);

    ControlledFileReader.instances[0].complete();
    await nextTick();
    expect(store.draftImages).toEqual([]);
  });

  it("切走之后上一会话的图片与附件不留在输入框里，切回来又原样在", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";
    store.started = true;
    const wrapper = mountInputBar();

    store.draftImages = [
      { type: "image", data: "AAAA", mimeType: "image/png", name: "截图.png" },
    ];
    store.draftAttachments = [
      { token: "tok-1", name: "报表.xlsx", size: 10, kind: "other" },
    ];
    await nextTick();
    expect(wrapper.findAll('[data-testid="image-attachment"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("报表.xlsx");

    store.currentSessionId = "sess-B";
    await nextTick();
    expect(wrapper.findAll('[data-testid="image-attachment"]')).toHaveLength(0);
    expect(wrapper.text()).not.toContain("报表.xlsx");

    // 按会话存放而不是一刀清空：回到 A 内容还在
    store.currentSessionId = "sess-A";
    await nextTick();
    expect(wrapper.findAll('[data-testid="image-attachment"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("报表.xlsx");
  });
});
