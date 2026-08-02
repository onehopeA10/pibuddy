/**
 * Extension UI 的渲染侧状态（CT-25：从 app store 迁出）。
 *
 * 迁出的理由不是「app.ts 太长」，而是所有权：弹窗队列、状态条、widget、
 * 标题这四样是同一个子协议的四个面，改造前它们散在 app store 里，
 * 「换会话要清哪些」只能靠手写字段枚举，漏一行就是上一会话的弹窗留在
 * 新会话里。迁出后本 store 自己注册自己的清空动作，清空语义与状态归属
 * 绑在一起。
 *
 * **清空语义逐字不变**：TASK-006 的 registerSessionScopedReset 仍是唯一
 * 入口，app store 的 resetSessionScopedState() 一调，这里的四样一起归零。
 */
import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import {
  UI_EXPIRED_HINT,
  type PiUiExpireAllPayload,
  type PiUiExpirePayload,
} from "@contract";
import type { ExtensionUiRequest } from "@sdk";
import { registerSessionScopedReset } from "./session-scope";

/** 顶栏标题的长度上限。扩展可以上报任意长度，不截断会静默撑破布局。 */
export const TITLE_MAX_CHARS = 60;
/** 产品前缀。标题是扩展说了算的，但「这是哪个应用」不是。 */
export const TITLE_PREFIX = "PiBuddy · ";

export interface ExtensionWidget {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

/**
 * 未知事件的计数快照（[静默丢弃根除]）。
 *
 * 上游每加一个事件类型，旧版本客户端都会遇到它。改造前 app.ts 的
 * `default: break` 让这件事**完全无声**：不报错、不记数、不留痕，
 * 只有对着 pi 的 changelog 逐条比对才能发现少处理了什么。
 */
const unknownEvents = reactive<Record<string, number>>({});

export function recordUnknownEvent(type: string): number {
  const key = type || "(empty)";
  unknownEvents[key] = (unknownEvents[key] ?? 0) + 1;
  return unknownEvents[key];
}

export function unknownEventSnapshot(): Record<string, number> {
  return { ...unknownEvents };
}

export function __resetUnknownEvents(): void {
  for (const key of Object.keys(unknownEvents)) delete unknownEvents[key];
}

export const useExtensionUiStore = defineStore("extensionUi", () => {
  /** 挂起的 dialog 队列。渲染 [0]，其余排队 —— 一次只问一个问题。 */
  const uiRequests = ref<ExtensionUiRequest[]>([]);
  /** 状态条：`ext:<key>` 是扩展上报的常驻状态，其余是本机运行态。 */
  const statusTexts = reactive<Record<string, string>>({});
  /** widget：稳定 key → 内容。widgetLines 缺席即删除该 key。 */
  const widgets = reactive(new Map<string, ExtensionWidget>());
  /** 扩展上报的原始标题（未加前缀、未截断） */
  const rawTitle = ref("");
  /** 最近一次失效提示，供界面给用户一句解释而不是让弹窗凭空消失 */
  const lastExpiredHint = ref("");

  registerSessionScopedReset(() => {
    uiRequests.value = [];
    for (const key of Object.keys(statusTexts)) delete statusTexts[key];
    widgets.clear();
    rawTitle.value = "";
    lastExpiredHint.value = "";
  }, "extensionUi");

  /**
   * 顶栏标题：产品前缀 + 截断。
   *
   * 截断在这里而不是在组件里：TopBar 与单测必须看到同一个值，放进组件
   * 模板意味着「改了模板、测试还绿」。
   */
  const displayTitle = computed(() =>
    rawTitle.value ? TITLE_PREFIX + rawTitle.value.slice(0, TITLE_MAX_CHARS) : ""
  );

  const aboveEditorWidgets = computed(() =>
    [...widgets.values()].filter((w) => w.placement === "aboveEditor")
  );
  const belowEditorWidgets = computed(() =>
    [...widgets.values()].filter((w) => w.placement === "belowEditor")
  );

  /** 运行相关的临时状态（压缩、重试、摘要重试），显示在输入框上方 */
  const busyStatus = computed(() =>
    Object.entries(statusTexts)
      .filter(([key, text]) => !key.startsWith("ext:") && text)
      .map(([, text]) => text)
      .join(" · ")
  );
  /** 扩展上报的常驻状态（如 AUTO/YOLO 模式），弱化显示在顶栏 */
  const extStatus = computed(() =>
    Object.entries(statusTexts)
      .filter(([key, text]) => key.startsWith("ext:") && text)
      .map(([, text]) => text)
      .join(" · ")
  );

  function setStatus(key: string, text: string | undefined): void {
    // rpc.md:1265：statusText 缺席 = 清除该 key，而不是显示一个空条目
    if (text === undefined || text === "") delete statusTexts[`ext:${key}`];
    else statusTexts[`ext:${key}`] = text;
  }

  /** 非扩展来源的状态（压缩 / 重试 / 摘要重试）。空串即清除。 */
  function setLocalStatus(key: string, text: string | undefined): void {
    if (text === undefined || text === "") delete statusTexts[key];
    else statusTexts[key] = text;
  }

  function setWidget(
    key: string,
    lines: string[] | undefined,
    placement: "aboveEditor" | "belowEditor" = "aboveEditor"
  ): void {
    // rpc.md:1283：widgetLines 缺席 = 清除该 widget。留一个空框在输入区上方
    // 会一直占着高度，而扩展那边认为它已经收拾干净了。
    if (lines === undefined) widgets.delete(key);
    else widgets.set(key, { key, lines, placement });
  }

  function setTitle(title: string | undefined): void {
    rawTitle.value = title ?? "";
  }

  function enqueue(request: ExtensionUiRequest): void {
    uiRequests.value = [...uiRequests.value, request];
  }

  function remove(id: string): void {
    uiRequests.value = uiRequests.value.filter((r) => r.id !== id);
  }

  /**
   * 主进程告知某条弹窗已失效。
   *
   * 必须给出提示：一个正在等你回答的框凭空消失，比它一直挂着还令人困惑。
   */
  function expire(payload: PiUiExpirePayload): boolean {
    const before = uiRequests.value.length;
    remove(payload.id);
    const hit = uiRequests.value.length < before;
    if (hit) lastExpiredHint.value = UI_EXPIRED_HINT;
    return hit;
  }

  function expireAll(_payload?: PiUiExpireAllPayload): number {
    const n = uiRequests.value.length;
    uiRequests.value = [];
    if (n > 0) lastExpiredHint.value = UI_EXPIRED_HINT;
    return n;
  }

  function clearExpiredHint(): void {
    lastExpiredHint.value = "";
  }

  /** 窗口 reload 后从主进程快照恢复。 */
  function adoptSnapshot(snapshot: {
    requests: ExtensionUiRequest[];
    statuses: { key: string; text: string }[];
    widgets: { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }[];
    title: string;
  }): void {
    uiRequests.value = [...snapshot.requests];
    for (const key of Object.keys(statusTexts)) {
      if (key.startsWith("ext:")) delete statusTexts[key];
    }
    for (const s of snapshot.statuses) setStatus(s.key, s.text);
    widgets.clear();
    for (const w of snapshot.widgets) setWidget(w.key, w.lines, w.placement);
    rawTitle.value = snapshot.title;
  }

  return {
    uiRequests,
    statusTexts,
    widgets,
    rawTitle,
    displayTitle,
    lastExpiredHint,
    aboveEditorWidgets,
    belowEditorWidgets,
    busyStatus,
    extStatus,
    setStatus,
    setLocalStatus,
    setWidget,
    setTitle,
    enqueue,
    remove,
    expire,
    expireAll,
    clearExpiredHint,
    adoptSnapshot,
    recordUnknownEvent,
    unknownEventSnapshot,
  };
});
