import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AssistantContent,
  AssistantMessage,
  ExtensionUiRequest,
  ImageContent,
  Model,
  SessionStats,
  TextContent,
  ThinkingLevel,
  ToolResultMessage,
  UserMessage,
} from "@sdk";
import type {
  AppSettings,
  AttachmentRef,
  DraftRecord,
  PiEnvelope,
  PiExitPayload,
} from "@contract";
import { parseEnvelope } from "@contract";
import { useSessionsStore } from "./sessions";
import { clearChatUiState } from "./chat-ui";

export interface ChatItem {
  key: number;
  message: AgentMessage;
}

/** 本地未提交的队列项。`id` 是渲染侧自增序号，pi 那边并不知道它。 */
export interface LocalQueueItem {
  id: number;
  text: string;
  mode: "steer" | "followUp";
}

export interface ToolRun {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  output: string;
  images: ImageContent[];
}

/**
 * 按 sessionId 归一化的运行时 / 生命周期状态。
 *
 * M0 只归一化这四项：它们是 M1 代际治理（RUN-002）的落点。items / toolRuns /
 * queue / statusTexts 刻意保持全局 —— 一次性全改会触碰 ToolActivity.vue 的
 * 卡片渲染闭环（查不到 run 就永久转圈），不值得。
 */
export interface RuntimeScope {
  started: boolean;
  streaming: boolean;
  runtimeId: string;
  generation: number;
}

/** 会话 ID 在 start 返回之前是未知的，此期间的状态先记在这个占位 key 上。 */
const PENDING_SCOPE_KEY = "";

function emptyScope(): RuntimeScope {
  return { started: false, streaming: false, runtimeId: "", generation: 0 };
}

export type Notifier = {
  info: (s: string) => void;
  success: (s: string) => void;
  warning: (s: string) => void;
  error: (s: string) => void;
};

function textOf(content: { type: string }[] | undefined): string {
  if (!content) return "";
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function imagesOf(content: { type: string }[] | undefined): ImageContent[] {
  if (!content) return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

let keySeq = 0;

// ---------------------------------------------------- 流式 delta 缓冲（SES-102）
//
// message_update 现在按 `assistantMessageEvent.delta` 拼帧，而不是每帧重写
// 一份全量累积消息。全量重写的代价是 O(n²)：第 n 个 token 到达时要再传一遍
// 前面 n-1 个字符、再解析一遍整段 Markdown，长回复到后段肉眼可见地卡。
//
// 缓冲区按 animation frame 落地：33ms 合批之后每帧最多一条 message_update，
// 再叠一层 rAF 保证「一次重绘至多写一次响应式状态」。
//
// **跨会话必须清干净**：残留的缓冲会把上一会话的尾字符渗进新会话的首条
// 消息里，typecheck 与构建都不会报错，只有肉眼能看出来。
let streamBuffer = "";
let streamContentIndex = 0;
let streamKind: "text" | "thinking" = "text";
let rafId: number | null = null;

/** 仅供单测：rAF 句柄与缓冲区当前值。 */
export function __streamState(): { rafId: number | null; streamBuffer: string } {
  return { rafId, streamBuffer };
}

/** Node 侧单测没有 rAF，回落到 ~60fps 的定时器，语义等价。 */
function scheduleFrame(cb: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(() => cb());
  return setTimeout(cb, 16) as unknown as number;
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

/**
 * agent_settled 到会话列表刷新之间的防抖窗口。
 *
 * agent_settled 在一次任务里会连续来很多条，早先每条都直接触发一次全量目录
 * 扫描。常量放在这里而不是 sessions store 里：刷新时机由本 store 的事件
 * reducer 决定，归属跟着触发点走。
 */
const REFRESH_SESSIONS_DEBOUNCE_MS = 2000;

/**
 * 会话级状态的清空回调表（CT-25）。
 *
 * 「换会话要清哪些东西」是一条语义，不该是散落在 start / newTask 里的手写
 * 字段枚举 —— 每加一块会话级状态就得记得去补一行，漏了就是上一次会话的
 * 工具卡片、扩展弹窗留在新会话里。各 store 自己注册自己的清空动作，
 * 状态归属和清空语义就此解耦。
 *
 * key 用于去重：store 在测试里会被反复重建，不去重的话注册表里会堆满
 * 指向旧实例的死闭包。
 */
const sessionScopedResets = new Map<string, () => void>();
let anonymousResetSeq = 0;

export function registerSessionScopedReset(
  reset: () => void,
  key = `anonymous:${++anonymousResetSeq}`
): void {
  sessionScopedResets.set(key, reset);
}

/** 依次执行全部已注册的清空回调。 */
export function resetSessionScopedState(): void {
  for (const reset of sessionScopedResets.values()) reset();
}

/**
 * 助手正在输出时，用户新指令的两种**产品语义**。
 *
 *   - `steer`（立即插话）：当前这一轮的工具调用跑完、下一次调用模型之前投递；
 *   - `followUp`（下一轮处理）：当前这一轮整体结束之后再投递。
 */
export type SendMode = "steer" | "followUp";

/**
 * 产品语义 → 传输参数的**唯一**映射表。
 *
 * 两种语义都经 `prompt` 命令传输，靠 streamingBehavior 取值区分，**不发**
 * 原生 `{type:"steer"}` / `{type:"follow_up"}` 命令。三条依据（rpc.md 原文）：
 *
 *  1. 投递语义逐字相同 —— rpc.md:62 描述 prompt 的 streamingBehavior:"steer"
 *     与 rpc.md:82 描述原生 steer 用的是同一句话，一字不差；
 *  2. 原生命令有净损失 —— rpc.md:82 / :104 明文 "Extension commands are not
 *     allowed (use `prompt` instead)"，而 rpc.md:67 规定 prompt 路径下扩展
 *     命令 "executes immediately even during streaming"。改原生命令 =
 *     用户在助手运行期间用不了斜杠命令，且无任何补偿收益；
 *  3. 两者进入同一对内部队列（agent-session.js:832-838 的
 *     `_queueFollowUp` / `_queueSteer`），set_steering_mode 与 queue_update
 *     对二者一致适用。
 *
 * 写成字面量表而不是 `{ streamingBehavior: mode }`，是为了让两个取值在源码
 * 里各留一处可 grep 的锚点 —— 「下一轮处理」被悄悄删掉时静态断言会失败。
 */
const STREAMING_BEHAVIOR: Record<SendMode, { streamingBehavior: SendMode }> = {
  steer: { streamingBehavior: "steer" },
  followUp: { streamingBehavior: "followUp" },
};

export interface SendOptions {
  text?: string;
  images?: ImageContent[];
  /**
   * 非图片附件的能力凭证。
   *
   * 早先这里是 `files: PickedFile[]`，渲染进程拿着绝对路径自己往提示词里
   * 拼「[用户提供的文件]」块。现在只传 token，路径由主进程换回来后拼接 ——
   * 渲染进程从头到尾不知道这些文件在磁盘上的哪里。
   */
  attachments?: AttachmentRef[];
  /**
   * 助手正在输出时必填。
   *
   * 缺失即抛错、**一次 RPC 都不发**：rpc.md:65 规定 streaming 中不带
   * streamingBehavior 的裸 prompt 直接返回 error，与其让用户看到一句
   * 「Agent is already processing」，不如在调用点就暴露出来。
   */
  mode?: SendMode;
}

/**
 * 发送用户输入。**返回值是「RPC 是否已接受」，调用方据此决定是否清空输入区。**
 *
 * 早先这里失败时只是 `return`（正常 resolve），InputBar 里 await 之后的三行
 * 照常执行，于是文本、图片、文件附件在一次网络抖动里全丢。rpc.md 明确
 * success:true 即表示已接受/已入队，因此它是唯一可以清空草稿的判据。
 *
 * 签名被 TASK-006/007/010/014/015 共同依赖，改写前先看那几条收敛条件。
 */
export async function send(opts: SendOptions = {}): Promise<boolean> {
  const store = useAppStore();
  const images = opts.images ?? [];
  const attachments = opts.attachments ?? [];
  const message = (opts.text ?? store.editorText).trim();
  // 非图片附件的路径由主进程凭 token 换回后拼进提示词
  const attachmentTokens = attachments
    .filter((a) => a.kind !== "image")
    .map((a) => a.token);
  if (!message && images.length === 0 && attachmentTokens.length === 0) return false;

  const wasStreaming = store.streaming;
  // streaming 中必须明确产品语义。这里在发 RPC **之前**抛，保证
  // 「mode 缺失 → 底层 RPC 发出次数为 0」。
  if (wasStreaming && !opts.mode) {
    throw new Error("助手正在输出，请选择「立即插话」或「下一轮处理」");
  }
  let resp: { success: boolean; error?: string };
  try {
    resp = await window.piBuddy.pi.prompt({
      message,
      ...(images.length ? { images } : {}),
      ...(attachmentTokens.length ? { attachmentTokens } : {}),
      // 传输命令恒为 prompt，产品语义由 streamingBehavior 取值区分
      ...(wasStreaming ? STREAMING_BEHAVIOR[opts.mode!] : {}),
    });
  } catch (err) {
    store.notify("error", err instanceof Error ? err.message : "发送失败");
    return false;
  }
  if (!resp.success) {
    store.notify("error", resp.error ?? "发送失败");
    return false;
  }
  if (wasStreaming) {
    store.notify(
      "info",
      opts.mode === "followUp"
        ? "已排队，助手做完这一轮就处理你的新指令"
        : "已插话，助手会尽快处理你的新指令"
    );
  }

  const content: (TextContent | ImageContent)[] = [];
  if (message) content.push({ type: "text", text: message });
  content.push(...images);
  store.items.push({
    key: ++keySeq,
    message: {
      role: "user",
      content: content.length === 1 && content[0].type === "text" ? message : content,
      timestamp: Date.now(),
    } as UserMessage,
  });
  store.activityTick++;
  return true;
}

export const useAppStore = defineStore("app", () => {
  // ---------- 基础状态 ----------
  const booting = ref(true);
  // init() 之前的占位：形状与 schema 默认值一致（piRuntimeMode 有默认值，不能是裸 {}）
  // 首帧的占位值：真正的设置由 boot() 里的 settings.get() 覆盖。
  // 密钥的两个展示位从「未配置」开始，绝不臆造一个 configured:true。
  const settings = ref<AppSettings>({
    schemaVersion: 1,
    piRuntimeMode: "bundled",
    sttApiKeyConfigured: false,
    sttApiKeyLast4: "",
  });
  const startError = ref("");
  /** 会话切换成功但消息拉取失败时的提示；非空时 ChatView 显示错误条与「重试」。 */
  const sessionLoadError = ref("");

  // ---------- 运行时状态（按 sessionId 归一化） ----------
  const currentSessionId = ref(PENDING_SCOPE_KEY);
  const runtimeScope = reactive<Record<string, RuntimeScope>>({
    [PENDING_SCOPE_KEY]: emptyScope(),
  });

  function scope(): RuntimeScope {
    const key = currentSessionId.value;
    let s = runtimeScope[key];
    if (!s) {
      s = emptyScope();
      runtimeScope[key] = s;
    }
    return s;
  }

  /**
   * 会话 ID 变化时把当前 scope 的运行状态搬到新 key 上。
   *
   * 不搬的话 started 会在 refreshState 之后瞬间读到一个全新的空 scope、
   * 回落为 false，输入框被禁用且不报任何错。M0 同时只有一个 pi 进程，
   * switch_session 不换进程，因此原样搬运就是正确语义。
   */
  function adoptSession(sessionId: string | undefined): void {
    const id = sessionId || PENDING_SCOPE_KEY;
    if (id === currentSessionId.value) return;
    const prev = scope();
    runtimeScope[id] = { ...prev };
    currentSessionId.value = id;
  }

  /** 同名代理，组件调用点（store.started / store.streaming）零改动。 */
  const started = computed({
    get: () => scope().started,
    set: (v: boolean) => {
      scope().started = v;
    },
  });
  const streaming = computed({
    get: () => scope().streaming,
    set: (v: boolean) => {
      scope().streaming = v;
    },
  });

  const agentState = shallowRef<AgentState | null>(null);
  const models = shallowRef<Model[]>([]);
  const thinkingLevels = shallowRef<ThinkingLevel[]>(["off"]);
  const stats = shallowRef<SessionStats | null>(null);

  const items = ref<ChatItem[]>([]);
  const liveAssistant = shallowRef<AssistantMessage | null>(null);
  const toolRuns = reactive<Record<string, ToolRun>>({});
  const queue = ref<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] });
  const statusTexts = reactive<Record<string, string>>({});

  /**
   * 本地**未提交**队列。
   *
   * 与 `queue`（pi 经 queue_update 下发的已提交队列）严格分开：pi 的
   * queue_update 只给字符串数组、没有稳定 id，协议里也没有「撤回队列项」
   * 的命令 —— 已提交的东西删不掉是上游能力缺失，不能用一个假的删除按钮
   * 冒充。只有还在这个数组里的条目可以编辑、可以删除。
   */
  const localQueue = ref<LocalQueueItem[]>([]);
  let localQueueSeq = 0;

  const uiRequests = ref<ExtensionUiRequest[]>([]);
  const editorText = ref("");
  const settingsOpen = ref(false);
  /** 每次有会影响聊天区高度的更新时 +1，供 ChatView 轻量监听滚动（避免 deep watch） */
  const activityTick = ref(0);

  // 本 store 持有的会话级状态：换会话时必须一起清干净。
  // TASK-012 把 uiRequests / statusTexts 迁到 extensionUi store 后，由那个
  // store 自行注册，这里删掉对应两行即可，清空语义本身不动。
  registerSessionScopedReset(() => {
    items.value = [];
    for (const key of Object.keys(toolRuns)) delete toolRuns[key];
    queue.value = { steering: [], followUp: [] };
    localQueue.value = [];
    for (const key of Object.keys(statusTexts)) delete statusTexts[key];
    uiRequests.value = [];
    liveAssistant.value = null;
    // 流式缓冲与挂起的 rAF 也是会话级状态：不清就会把上一会话的尾字符
    // 渗进新会话的首条消息（三大门禁全绿，只有肉眼能发现）。
    resetStream();
    // 展开态按 `${messageKey}:${blockIndex}` 归一化，换会话后会错配到同序号
    // 的另一条消息上。
    clearChatUiState();
  }, "app");

  let notifier: Notifier | null = null;
  function setNotifier(n: Notifier): void {
    notifier = n;
  }
  function notify(kind: keyof Notifier, text: string): void {
    notifier?.[kind](text);
  }

  /**
   * 工作目录的不透明标识与显示名。
   *
   * 渲染进程只持有 `workspaceId`（sha256(canonical realpath) 派生，跨重启稳定），
   * 所有需要工作目录的 IPC 都只传它。`displayPath` 是**单向下发**的展示字段 ——
   * 它可以出现在界面上，但绝不能作为任何 IPC 的入参回传给主进程，否则
   * capability 化就等于白做。
   */
  const workspaceId = ref("");
  const displayPath = ref("");
  /** 同名代理：既有组件读 store.workspace 拿显示路径，零改动。 */
  const workspace = computed(() => displayPath.value);

  function adoptWorkspace(ref_: { workspaceId: string; displayPath: string } | null): void {
    workspaceId.value = ref_?.workspaceId ?? "";
    displayPath.value = ref_?.displayPath ?? "";
  }
  const currentModel = computed(() => agentState.value?.model ?? null);
  /** 运行相关的临时状态（压缩、重试），显示在输入框上方 */
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

  // ---------- 事件处理 ----------

  function pushMessage(message: AgentMessage): void {
    items.value.push({ key: ++keySeq, message });
  }

  // ---------- 流式缓冲的落地 / 清空 ----------

  /** rAF 回调：把攒下的 delta 一次性追加到 liveAssistant 的目标内容块上。 */
  function applyStreamBuffer(): void {
    rafId = null;
    const chunk = streamBuffer;
    streamBuffer = "";
    if (!chunk) return;
    const live = liveAssistant.value;
    if (!live) return;
    const content = [...((live.content ?? []) as AssistantContent[])];
    while (content.length <= streamContentIndex) {
      content.push(
        streamKind === "thinking"
          ? ({ type: "thinking", thinking: "" } as AssistantContent)
          : ({ type: "text", text: "" } as AssistantContent)
      );
    }
    const block = content[streamContentIndex];
    if (streamKind === "thinking" && block?.type === "thinking") {
      content[streamContentIndex] = { ...block, thinking: (block.thinking ?? "") + chunk };
    } else if (streamKind === "text" && block?.type === "text") {
      content[streamContentIndex] = { ...block, text: (block.text ?? "") + chunk };
    } else {
      content[streamContentIndex] = (
        streamKind === "thinking"
          ? { type: "thinking", thinking: chunk }
          : { type: "text", text: chunk }
      ) as AssistantContent;
    }
    liveAssistant.value = { ...live, content };
    activityTick.value++;
  }

  /** 立刻落地（切换内容块、边界事件、会话结束时调用）。 */
  function flushStream(): void {
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    applyStreamBuffer();
  }

  /** 丢弃缓冲并取消挂起的帧 —— 换会话 / 卸载时必须调，否则跨会话渗字符。 */
  function resetStream(): void {
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    streamBuffer = "";
    streamContentIndex = 0;
    streamKind = "text";
  }

  function recordToolResult(msg: ToolResultMessage): void {
    const existing = toolRuns[msg.toolCallId];
    toolRuns[msg.toolCallId] = {
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      args: existing?.args ?? {},
      status: msg.isError ? "error" : "done",
      output: textOf(msg.content),
      images: imagesOf(msg.content),
    };
  }

  function handleEvent(e: AgentEvent): void {
    if (
      e.type === "message_start" ||
      e.type === "message_update" ||
      e.type === "message_end" ||
      e.type === "tool_execution_start" ||
      e.type === "tool_execution_update" ||
      e.type === "tool_execution_end"
    ) {
      activityTick.value++;
    }
    switch (e.type) {
      case "agent_start":
        streaming.value = true;
        break;
      case "agent_settled":
        streaming.value = false;
        liveAssistant.value = null;
        void refreshStats();
        scheduleRefreshSessions();
        void refreshState();
        break;
      case "message_start": {
        const msg = (e as { message: AgentMessage }).message;
        resetStream();
        if (msg.role === "assistant") liveAssistant.value = msg as AssistantMessage;
        break;
      }
      case "message_update": {
        const ev = e as Extract<AgentEvent, { type: "message_update" }>;
        const delta = ev.assistantMessageEvent;
        const kind = delta?.type;
        if (kind === "text_delta" || kind === "thinking_delta") {
          const index = delta.contentIndex ?? 0;
          const nextKind = kind === "thinking_delta" ? "thinking" : "text";
          // 换了内容块就先把上一块落地，否则文字会串到另一个块里
          if (index !== streamContentIndex || nextKind !== streamKind) {
            flushStream();
            streamContentIndex = index;
            streamKind = nextKind;
          }
          streamBuffer += delta.delta ?? "";
          if (rafId === null) rafId = scheduleFrame(applyStreamBuffer);
          break;
        }
        // 边界事件（text_start / text_end / toolcall_* / done / error）：
        // 先把缓冲落地，再用事件携带的**全量累积快照**对齐一次 —— 这一步
        // 让任何拼接漂移在每个内容块的边界上自愈，而不是攒到整段结束。
        flushStream();
        if (ev.message?.role === "assistant") {
          liveAssistant.value = { ...(ev.message as AssistantMessage) };
        }
        break;
      }
      case "message_end": {
        const msg = (e as { message: AgentMessage }).message;
        if (msg.role === "assistant") {
          // 缓冲直接丢弃：message_end 携带的是最终全量消息，比拼接结果权威。
          resetStream();
          liveAssistant.value = null;
          pushMessage(msg);
        } else if (msg.role === "toolResult") {
          recordToolResult(msg as ToolResultMessage);
        } else if (msg.role === "user") {
          // steering / follow-up 被投递时会出现 user message_end；
          // 本地乐观插入过的不重复显示
          const last = [...items.value]
            .reverse()
            .find((i) => i.message.role === "user");
          const text =
            typeof (msg as UserMessage).content === "string"
              ? ((msg as UserMessage).content as string)
              : textOf((msg as UserMessage).content as { type: string }[]);
          const lastText = last
            ? typeof (last.message as UserMessage).content === "string"
              ? ((last.message as UserMessage).content as string)
              : textOf((last.message as UserMessage).content as { type: string }[])
            : "";
          if (text !== lastText) pushMessage(msg);
        }
        break;
      }
      case "tool_execution_start": {
        const ev = e as Extract<AgentEvent, { type: "tool_execution_start" }>;
        toolRuns[ev.toolCallId] = {
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          args: ev.args ?? {},
          status: "running",
          output: "",
          images: [],
        };
        break;
      }
      case "tool_execution_update": {
        const ev = e as Extract<AgentEvent, { type: "tool_execution_update" }>;
        const run = toolRuns[ev.toolCallId];
        if (run) run.output = textOf(ev.partialResult?.content);
        break;
      }
      case "tool_execution_end": {
        const ev = e as Extract<AgentEvent, { type: "tool_execution_end" }>;
        toolRuns[ev.toolCallId] = {
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          args: toolRuns[ev.toolCallId]?.args ?? {},
          status: ev.isError ? "error" : "done",
          output: textOf(ev.result?.content),
          images: imagesOf(ev.result?.content),
        };
        break;
      }
      case "queue_update": {
        const ev = e as Extract<AgentEvent, { type: "queue_update" }>;
        queue.value = { steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
        break;
      }
      case "compaction_start":
        statusTexts.compaction = "正在整理对话记忆…";
        break;
      case "compaction_end":
        statusTexts.compaction = "";
        break;
      case "auto_retry_start": {
        const ev = e as Extract<AgentEvent, { type: "auto_retry_start" }>;
        statusTexts.retry = `网络繁忙，正在重试 (${ev.attempt}/${ev.maxAttempts})…`;
        break;
      }
      case "auto_retry_end": {
        const ev = e as Extract<AgentEvent, { type: "auto_retry_end" }>;
        statusTexts.retry = "";
        if (!ev.success && ev.finalError) notify("error", "多次重试仍失败，请稍后再试");
        break;
      }
      case "extension_error":
        notify("warning", "扩展出现问题，但不影响继续使用");
        break;
      default:
        break;
    }
  }

  // ---------- 代际 / 序号闸门（RUN-002 第二层防御） ----------
  //
  // 主进程只转发当前代际，这里再挡一次：IPC 是异步的，主进程判定「当前代际」
  // 与渲染进程读到消息之间存在窗口，重启密集时上一代的消息仍可能挤进来。
  //
  // 规则（顺序不可换）：
  //   generation <  current → 丢弃（上一代迟到）
  //   generation >  current → 采纳新代际，全部序号线重置
  //   generation == current → 本通道的 sequence 必须严格递增，否则丢弃
  //
  // **序号单调性必须按通道判定，不能全局判**：三条 push 通道共用同一个
  // 单调计数器，但 pi:event 走 33ms 合批、pi:ui-request 与 pi:exit 立即发出。
  // 于是一条 ui-request 会带着更大的 sequence 先于队列里的事件到达，若用
  // 全局闸门，紧随其后的一整批事件都会被误判为「序号倒退」而丢弃 ——
  // 实测表现是 agent_start 被吃掉、streaming 恒为 false、插话因此退化成普通
  // prompt 并被 pi 以 "Agent is already processing" 拒绝。
  // 同一通道内部的子序列仍然严格递增，所以按通道判定既安全又够用。
  const currentRuntimeId = ref("");
  const currentGeneration = ref(0);
  const lastSeqByChannel = reactive<Record<string, number>>({});
  /** 兼容既有读点：单说「上一个序号」时指的是事件通道。 */
  const lastSequence = computed(() => lastSeqByChannel["pi:event"] ?? -1);
  /** 被闸门丢掉的消息计数，UI 不展示，只用于诊断与单测。 */
  const droppedEnvelopes = ref(0);

  function acceptEnvelope(raw: unknown, channel: string): PiEnvelope<unknown> | null {
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) {
      droppedEnvelopes.value++;
      return null;
    }
    const env = parsed.envelope;
    if (env.generation < currentGeneration.value) {
      droppedEnvelopes.value++;
      return null;
    }
    if (env.generation > currentGeneration.value) {
      currentGeneration.value = env.generation;
      currentRuntimeId.value = env.runtimeId;
      for (const key of Object.keys(lastSeqByChannel)) delete lastSeqByChannel[key];
    } else if (env.sequence <= (lastSeqByChannel[channel] ?? -1)) {
      droppedEnvelopes.value++;
      return null;
    }
    lastSeqByChannel[channel] = env.sequence;
    if (!currentRuntimeId.value) currentRuntimeId.value = env.runtimeId;
    return env;
  }

  /** pi:event 的入口：先过闸门解包，再进原有 switch reducer。 */
  function handleEventEnvelope(raw: unknown): void {
    const env = acceptEnvelope(raw, "pi:event");
    if (!env) return;
    handleEvent(env.payload as AgentEvent);
  }

  function handleUiRequestEnvelope(raw: unknown): void {
    const env = acceptEnvelope(raw, "pi:ui-request");
    if (!env) return;
    handleUiRequest(env.payload as ExtensionUiRequest);
  }

  /**
   * pi:exit 的入口。
   *
   * 这里就是「刚启动成功的新会话被上一代进程的 exit 打成 started=false」的
   * 修复点：闸门先按代际丢弃，随后再按 reason 区分主动停止与崩溃 ——
   * 主动停止不该弹错误提示。
   */
  function handleExitEnvelope(raw: unknown): void {
    const env = acceptEnvelope(raw, "pi:exit");
    if (!env) return;
    const payload = env.payload as PiExitPayload;
    if (!started.value) return;
    started.value = false;
    streaming.value = false;
    if (payload?.reason === "expected-stop") return;
    notify(
      "error",
      payload?.error
        ? `智能体进程意外退出：${payload.error}`
        : "智能体进程意外退出，请重新开始"
    );
  }

  function handleUiRequest(r: ExtensionUiRequest): void {
    switch (r.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        uiRequests.value = [...uiRequests.value, r];
        break;
      case "notify": {
        const kind =
          r.notifyType === "error" ? "error" : r.notifyType === "warning" ? "warning" : "info";
        notify(kind, r.message ?? "");
        break;
      }
      case "setStatus":
        statusTexts[`ext:${r.statusKey ?? ""}`] = r.statusText ?? "";
        break;
      case "set_editor_text":
        editorText.value = r.text ?? "";
        break;
      default:
        break;
    }
  }

  async function respondUi(
    request: ExtensionUiRequest,
    payload: { value?: string; confirmed?: boolean; cancelled?: boolean }
  ): Promise<void> {
    uiRequests.value = uiRequests.value.filter((r) => r.id !== request.id);
    await window.piBuddy.pi.extensionUi.respond({
      type: "extension_ui_response",
      id: request.id,
      ...payload,
    });
  }

  // ---------- 生命周期 ----------

  let subscribed = false;
  /**
   * 三个 on* 返回的 unsubscribe 闭包。
   * 早先它们被直接丢弃，窗口重载后同一 channel 上会挂着好几代回调。
   */
  const unsubscribes: (() => void)[] = [];

  function subscribeOnce(): void {
    if (subscribed) return;
    subscribed = true;
    unsubscribes.push(window.piBuddy.pi.events.onEvent((e) => handleEventEnvelope(e)));
    unsubscribes.push(window.piBuddy.pi.events.onUiRequest((r) => handleUiRequestEnvelope(r)));
    unsubscribes.push(window.piBuddy.pi.events.onExit((e) => handleExitEnvelope(e)));
  }

  /** 解除全部推送订阅（窗口销毁 / 测试收尾）。 */
  function dispose(): void {
    while (unsubscribes.length) unsubscribes.pop()!();
    subscribed = false;
  }

  async function init(): Promise<void> {
    subscribeOnce();
    settings.value = await window.piBuddy.settings.get();
    // 工作目录经 workspace.current() 取不透明 id + 显示名，
    // 而不是从 settings 里读一条绝对路径自己用
    adoptWorkspace(await window.piBuddy.dialog.currentWorkspace());
    booting.value = false;
    if (workspaceId.value) {
      await start();
    }
  }

  function loadMessages(messages: AgentMessage[]): void {
    items.value = [];
    for (const key of Object.keys(toolRuns)) delete toolRuns[key];
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        pushMessage(msg);
      } else if (msg.role === "toolResult") {
        recordToolResult(msg as ToolResultMessage);
      }
    }
  }

  async function start(sessionId?: string): Promise<void> {
    startError.value = "";
    sessionLoadError.value = "";
    started.value = false;
    streaming.value = false;
    resetSessionScopedState();
    try {
      const result = await window.piBuddy.pi.runtime.start({
        workspaceId: workspaceId.value,
        sessionId,
      });
      agentState.value = result.state;
      models.value = result.models;
      loadMessages(result.messages);

      // 新的一代 runtime：generation 单调递增，供 M1 丢弃上一代迟到事件
      const sc = scope();
      sc.generation += 1;
      sc.runtimeId = `rt-${Date.now().toString(36)}-${sc.generation}`;
      adoptSession(result.state.sessionId);
      started.value = true;

      // 只有**新会话**才套用全局设置里的模型与思考力度。
      // 恢复历史会话时会话文件里已经记着它自己的 model / thinkingLevel，
      // 无条件覆盖等于用户每打开一个旧会话都被悄悄换成另一个模型。
      const saved = settings.value;
      if (sessionId === undefined) {
        if (
          saved.provider &&
          saved.modelId &&
          (result.state.model?.provider !== saved.provider ||
            result.state.model?.id !== saved.modelId)
        ) {
          await setModel(saved.provider, saved.modelId, false);
        }
        // 已经是目标等级就不要再发一次命令：多余的 set_thinking_level 会在
        // 会话里多写一条 thinking_level_change 记录。
        if (saved.thinkingLevel && result.state.thinkingLevel !== saved.thinkingLevel) {
          await window.piBuddy.pi.setThinkingLevel(saved.thinkingLevel as ThinkingLevel);
        }
      } else {
        // 恢复历史会话：沿用会话自身记录的模型与思考等级，这里什么都不做。
        // TASK-014 的 modelMismatchPrompt（提示用户当前会话模型与默认不同）
        // 就落在这个分支里。
      }
      await refreshState();
      await refreshThinkingLevels();
      void refreshStats();
      // 草稿恢复必须**排在会话索引同步之后**：新会话的 .jsonl 刚落地，
      // sessions:get-draft 反查 sessionId 会以 SESSION_UNKNOWN 失败 ——
      // 渲染侧吞掉了异常，用户看不到，但主进程每次启动都记一条 ipc_rejected。
      void refreshSessions().then(() => restoreDraft());
    } catch (err) {
      startError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function refreshState(): Promise<void> {
    const resp = await window.piBuddy.pi.getState();
    if (resp.success && resp.data) {
      agentState.value = resp.data;
      adoptSession(resp.data.sessionId);
    }
  }

  async function refreshStats(): Promise<void> {
    const resp = await window.piBuddy.pi.getSessionStats();
    if (resp.success && resp.data) stats.value = resp.data;
  }

  /**
   * 会话列表的刷新委托给 sessions store —— 列表的查询条件、分页、整理动作
   * 全在那边，这里只负责在合适的时机（agent_settled / 启动 / 换会话）触发。
   */
  async function refreshSessions(): Promise<void> {
    if (!workspaceId.value) return;
    await useSessionsStore().refresh(workspaceId.value);
  }

  let refreshSessionsTimer: ReturnType<typeof setTimeout> | null = null;
  /** 尾沿防抖：连续 N 次 agent_settled 只在安静 2000ms 之后扫一次目录。 */
  function scheduleRefreshSessions(): void {
    if (refreshSessionsTimer) clearTimeout(refreshSessionsTimer);
    refreshSessionsTimer = setTimeout(() => {
      refreshSessionsTimer = null;
      void refreshSessions();
    }, REFRESH_SESSIONS_DEBOUNCE_MS);
  }

  async function refreshThinkingLevels(): Promise<void> {
    const resp = await window.piBuddy.pi.getAvailableThinkingLevels();
    thinkingLevels.value = resp.success && resp.data ? resp.data.levels : ["off"];
  }

  // ---------- 用户操作 ----------

  async function chooseWorkspace(): Promise<void> {
    // 主进程自己把绝对路径写进设置并注册工作区，这里只收到不透明 id + 显示名
    const chosen = await window.piBuddy.dialog.chooseFolder();
    if (!chosen) return;
    adoptWorkspace(chosen);
    settings.value = await window.piBuddy.settings.get();
    await start();
  }

  async function abortRun(): Promise<void> {
    await window.piBuddy.pi.abort();
  }

  async function newTask(): Promise<void> {
    const resp = await window.piBuddy.pi.newSession();
    if (!resp.success) {
      notify("error", resp.error ?? "无法开始新任务");
      return;
    }
    // 扩展可以否决新建（rpc.md：success:true 且 data.cancelled:true）。
    // 只看 success 的话界面会清成一片假空白，而 pi 那边根本没换会话。
    if (resp.data?.cancelled === true) {
      notify("warning", "扩展取消了「开始新任务」，当前会话保持不变");
      return;
    }
    sessionLoadError.value = "";
    resetSessionScopedState();
    stats.value = null;
    await refreshState();
    void refreshSessions();
  }

  /**
   * 打开一个历史会话。
   *
   * 入参是**不透明 sessionId**：JSONL 的绝对路径全程留在主进程，由会话索引
   * 反查（CT-15）。渲染进程连一个路径字符串都拿不到，也就无从伪造。
   */
  async function openSession(target: { sessionId: string }): Promise<void> {
    if (streaming.value) {
      notify("warning", "请先停止当前任务，再切换历史会话");
      return;
    }
    const resp = await window.piBuddy.pi.switchSession(target.sessionId);
    if (!resp.success) {
      notify("error", resp.error ?? "打开会话失败");
      return;
    }
    // 同 new_session：扩展否决时保持原样，不能拿一个空会话冒充切换成功。
    if (resp.data?.cancelled === true) {
      notify("warning", "扩展取消了会话切换，当前会话保持不变");
      return;
    }
    // 切换已经生效：旧会话的消息、工具卡片、扩展弹窗全部作废。哪怕下面
    // 拉消息失败，也绝不能把旧消息留在界面上冒充新会话的内容。
    resetSessionScopedState();
    await reloadMessages();
    await refreshState();
    void restoreDraft();
    void refreshStats();
  }

  /**
   * 拉取当前会话的完整消息列表。失败时只设 sessionLoadError，
   * 由 ChatView 的「重试」按钮再调一次，绝不静默留白。
   */
  async function reloadMessages(): Promise<void> {
    sessionLoadError.value = "";
    let resp: { success: boolean; error?: string; data?: { messages: AgentMessage[] } };
    try {
      resp = await window.piBuddy.pi.getMessages();
    } catch (err) {
      sessionLoadError.value =
        err instanceof Error ? err.message : "加载会话消息失败，请重试";
      return;
    }
    if (resp.success && resp.data) {
      loadMessages(resp.data.messages);
      return;
    }
    sessionLoadError.value = resp.error ?? "加载会话消息失败，请重试";
  }

  // ---------- 本地队列 + 草稿持久化（SES-102） ----------

  function enqueueLocal(text: string, mode: SendMode): LocalQueueItem {
    const item: LocalQueueItem = { id: ++localQueueSeq, text, mode };
    localQueue.value = [...localQueue.value, item];
    scheduleSaveDraft();
    return item;
  }

  function updateLocalQueueItem(id: number, text: string): void {
    localQueue.value = localQueue.value.map((i) => (i.id === id ? { ...i, text } : i));
    scheduleSaveDraft();
  }

  function removeLocalQueueItem(id: number): void {
    localQueue.value = localQueue.value.filter((i) => i.id !== id);
    scheduleSaveDraft();
  }

  /** 草稿里的附件条目（能力凭证，不含路径）。由 InputBar 同步过来。 */
  const draftAttachments = ref<unknown[]>([]);

  /** 上一次草稿写入失败的原因；不展示给用户，只用于诊断与单测。 */
  const lastDraftError = ref("");

  /**
   * 剥掉 Vue 的响应式代理，得到可结构化克隆的纯数据。
   *
   * 直接把 `ref([...]).value` 交给 Electron IPC 会以
   * "An object could not be cloned." 失败 —— 而这个异常只在 await 处冒出来，
   * 界面上没有任何征兆、主进程也不记一行日志，表现就是「草稿永远存不上」。
   * 草稿是纯数据记录，一次 JSON 往返最省事，也不会漏掉嵌套层里的代理。
   */
  function plainCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  const DRAFT_DEBOUNCE_MS = 500;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 尾沿防抖 500ms 写草稿。
   *
   * 不防抖的话长输入是「每按一个键一次 IPC + 一次 SQLite 写」，UI 上没有
   * 任何征兆，只有主进程在闷头刷盘。
   */
  function scheduleSaveDraft(): void {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      void saveDraftNow();
    }, DRAFT_DEBOUNCE_MS);
  }

  async function saveDraftNow(): Promise<void> {
    const sessionId = currentSessionId.value;
    if (!sessionId) return;
    const draft: DraftRecord = {
      text: editorText.value,
      attachments: draftAttachments.value,
      queue: {
        steering: localQueue.value.filter((i) => i.mode === "steer").map((i) => i.text),
        followUp: localQueue.value.filter((i) => i.mode === "followUp").map((i) => i.text),
      },
      updatedAt: Date.now(),
    };
    try {
      await window.piBuddy.sessions.saveDraft(sessionId, plainCopy(draft));
    } catch (err) {
      // 草稿写失败不该打断输入（下一次输入会再试一次），但**不能静默**：
      // 空 catch 会让「草稿一直存不下来」变成一个查不出原因的现象。
      // 空 catch 会让「草稿一直存不下来」变成一个查不出原因的现象：
      // 结构化克隆失败时 UI 上没有任何征兆，主进程也不会记一行日志。
      lastDraftError.value = err instanceof Error ? err.message : String(err);
    }
  }

  /** 打开会话后恢复草稿：文本、附件条目、未发送队列。 */
  async function restoreDraft(): Promise<void> {
    const sessionId = currentSessionId.value;
    if (!sessionId) return;
    // **全新会话在 pi 写下第一条消息之前根本没有 .jsonl 文件**，因而也不可能
    // 在索引里。直接问 getDraft 会拿到 SESSION_UNKNOWN：渲染侧吞得下，但
    // 主进程每次启动都会记一条 ipc_rejected + 一段 handler 异常栈。
    // 没有会话文件就一定没有草稿，先在索引里确认存在再问。
    if (!useSessionsStore().rows.some((r) => r.sessionId === sessionId)) return;
    let draft: DraftRecord | null = null;
    try {
      draft = await window.piBuddy.sessions.getDraft(sessionId);
    } catch {
      return;
    }
    if (!draft) return;
    editorText.value = draft.text ?? "";
    draftAttachments.value = draft.attachments ?? [];
    localQueue.value = [
      ...(draft.queue?.steering ?? []).map((text) => ({
        id: ++localQueueSeq,
        text,
        mode: "steer" as SendMode,
      })),
      ...(draft.queue?.followUp ?? []).map((text) => ({
        id: ++localQueueSeq,
        text,
        mode: "followUp" as SendMode,
      })),
    ];
  }

  async function setModel(
    provider: string,
    modelId: string,
    persist = true
  ): Promise<void> {
    const resp = await window.piBuddy.pi.setModel(provider, modelId);
    if (!resp.success) {
      notify("error", resp.error ?? "切换模型失败");
      return;
    }
    if (persist) {
      settings.value = await window.piBuddy.settings.set({ provider, modelId });
    }
    await refreshState();
    await refreshThinkingLevels();
  }

  async function setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const resp = await window.piBuddy.pi.setThinkingLevel(level);
    if (resp.success) {
      settings.value = await window.piBuddy.settings.set({ thinkingLevel: level });
      await refreshState();
    }
  }

  async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
    // 不吞异常：端点地址被 SSRF 判定拒绝时，界面要拿到那句可读的原因
    settings.value = await window.piBuddy.settings.set(patch);
  }

  /**
   * 写语音识别密钥。明文只在这一次调用里存在于渲染进程，之后由主进程的
   * safeStorage 保管；回来的只有 {configured, last4}。
   */
  async function saveSttSecret(value: string): Promise<void> {
    await window.piBuddy.settings.setSecret("stt", value);
    settings.value = await window.piBuddy.settings.get();
  }

  /**
   * 从 external 运行时切回内置。
   *
   * 只有用户点这个按钮才写设置 —— external 启动失败本身绝不自动改写
   * piRuntimeMode，否则用户的显式选择会在一次失败后被悄悄抹掉。
   */
  async function switchToBundledRuntime(): Promise<void> {
    settings.value = await window.piBuddy.settings.set({ piRuntimeMode: "bundled" });
    await start();
  }

  return {
    booting,
    settings,
    started,
    startError,
    sessionLoadError,
    currentSessionId,
    runtimeScope,
    currentRuntimeId,
    currentGeneration,
    lastSequence,
    droppedEnvelopes,
    agentState,
    models,
    thinkingLevels,
    stats,
    items,
    liveAssistant,
    toolRuns,
    streaming,
    queue,
    localQueue,
    draftAttachments,
    statusTexts,
    uiRequests,
    editorText,
    settingsOpen,
    activityTick,
    workspace,
    workspaceId,
    displayPath,
    currentModel,
    busyStatus,
    extStatus,
    setNotifier,
    notify,
    handleEventEnvelope,
    handleUiRequestEnvelope,
    handleExitEnvelope,
    dispose,
    init,
    start,
    chooseWorkspace,
    send,
    abortRun,
    newTask,
    openSession,
    reloadMessages,
    setModel,
    switchToBundledRuntime,
    setThinkingLevel,
    saveSettings,
    saveSttSecret,
    respondUi,
    refreshSessions,
    enqueueLocal,
    updateLocalQueueItem,
    removeLocalQueueItem,
    scheduleSaveDraft,
    saveDraftNow,
    lastDraftError,
    restoreDraft,
    flushStream,
    resetStream,
  };
});
