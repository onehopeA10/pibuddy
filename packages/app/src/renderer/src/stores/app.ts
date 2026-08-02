import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
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
  PickedFile,
  PiEnvelope,
  PiExitPayload,
  SessionMeta,
} from "@contract";
import { parseEnvelope } from "@contract";

export interface ChatItem {
  key: number;
  message: AgentMessage;
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

export const useAppStore = defineStore("app", () => {
  // ---------- 基础状态 ----------
  const booting = ref(true);
  // init() 之前的占位：形状与 schema 默认值一致（piRuntimeMode 有默认值，不能是裸 {}）
  const settings = ref<AppSettings>({ piRuntimeMode: "bundled" });
  const startError = ref("");

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
  const sessions = shallowRef<SessionMeta[]>([]);

  const items = ref<ChatItem[]>([]);
  const liveAssistant = shallowRef<AssistantMessage | null>(null);
  const toolRuns = reactive<Record<string, ToolRun>>({});
  const queue = ref<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] });
  const statusTexts = reactive<Record<string, string>>({});

  const uiRequests = ref<ExtensionUiRequest[]>([]);
  const editorText = ref("");
  const settingsOpen = ref(false);
  /** 每次有会影响聊天区高度的更新时 +1，供 ChatView 轻量监听滚动（避免 deep watch） */
  const activityTick = ref(0);

  let notifier: Notifier | null = null;
  function setNotifier(n: Notifier): void {
    notifier = n;
  }
  function notify(kind: keyof Notifier, text: string): void {
    notifier?.[kind](text);
  }

  const workspace = computed(() => settings.value.workspace ?? "");
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
        void refreshSessions();
        void refreshState();
        break;
      case "message_start": {
        const msg = (e as { message: AgentMessage }).message;
        if (msg.role === "assistant") liveAssistant.value = msg as AssistantMessage;
        break;
      }
      case "message_update": {
        const msg = (e as { message: AgentMessage }).message;
        if (msg.role === "assistant") liveAssistant.value = { ...(msg as AssistantMessage) };
        break;
      }
      case "message_end": {
        const msg = (e as { message: AgentMessage }).message;
        if (msg.role === "assistant") {
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
    await window.piBuddy.pi.uiRespond({
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
    unsubscribes.push(window.piBuddy.pi.onEvent((e) => handleEventEnvelope(e)));
    unsubscribes.push(window.piBuddy.pi.onUiRequest((r) => handleUiRequestEnvelope(r)));
    unsubscribes.push(window.piBuddy.pi.onExit((e) => handleExitEnvelope(e)));
  }

  /** 解除全部推送订阅（窗口销毁 / 测试收尾）。 */
  function dispose(): void {
    while (unsubscribes.length) unsubscribes.pop()!();
    subscribed = false;
  }

  async function init(): Promise<void> {
    subscribeOnce();
    settings.value = await window.piBuddy.settings.get();
    booting.value = false;
    if (settings.value.workspace) {
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

  async function start(sessionPath?: string): Promise<void> {
    startError.value = "";
    started.value = false;
    streaming.value = false;
    liveAssistant.value = null;
    try {
      const result = await window.piBuddy.pi.start({
        workspace: workspace.value,
        session: sessionPath,
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

      // 恢复上次选择的模型与思考力度
      const saved = settings.value;
      if (
        saved.provider &&
        saved.modelId &&
        (result.state.model?.provider !== saved.provider ||
          result.state.model?.id !== saved.modelId)
      ) {
        await setModel(saved.provider, saved.modelId, false);
      }
      if (saved.thinkingLevel) {
        await window.piBuddy.pi.command({
          type: "set_thinking_level",
          level: saved.thinkingLevel,
        });
      }
      await refreshState();
      await refreshThinkingLevels();
      void refreshStats();
      void refreshSessions();
    } catch (err) {
      startError.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function refreshState(): Promise<void> {
    const resp = await window.piBuddy.pi.command<AgentState>({ type: "get_state" });
    if (resp.success && resp.data) {
      agentState.value = resp.data;
      adoptSession(resp.data.sessionId);
    }
  }

  async function refreshStats(): Promise<void> {
    const resp = await window.piBuddy.pi.command<SessionStats>({ type: "get_session_stats" });
    if (resp.success && resp.data) stats.value = resp.data;
  }

  async function refreshSessions(): Promise<void> {
    if (!workspace.value) return;
    sessions.value = await window.piBuddy.sessions.list(workspace.value);
  }

  async function refreshThinkingLevels(): Promise<void> {
    const resp = await window.piBuddy.pi.command<{ levels: ThinkingLevel[] }>({
      type: "get_available_thinking_levels",
    });
    thinkingLevels.value = resp.success && resp.data ? resp.data.levels : ["off"];
  }

  // ---------- 用户操作 ----------

  async function chooseWorkspace(): Promise<void> {
    const folder = await window.piBuddy.dialog.chooseFolder();
    if (!folder) return;
    settings.value = await window.piBuddy.settings.set({ workspace: folder });
    await start();
  }

  async function send(
    text: string,
    images: ImageContent[],
    files: PickedFile[]
  ): Promise<void> {
    let message = text.trim();
    const refs = files.filter((f) => f.kind !== "image");
    if (refs.length > 0) {
      message +=
        "\n\n[用户提供的文件]\n" + refs.map((f) => `- ${f.path}`).join("\n");
    }
    if (!message && images.length === 0) return;

    const wasStreaming = streaming.value;
    const resp = await window.piBuddy.pi.command({
      type: "prompt",
      message,
      ...(images.length ? { images } : {}),
      ...(wasStreaming ? { streamingBehavior: "steer" } : {}),
    });
    if (!resp.success) {
      notify("error", resp.error ?? "发送失败");
      return;
    }
    if (wasStreaming) notify("info", "已插话，助手会尽快处理你的新指令");

    const content: (TextContent | ImageContent)[] = [];
    if (message) content.push({ type: "text", text: message });
    content.push(...images);
    pushMessage({
      role: "user",
      content: content.length === 1 && content[0].type === "text" ? message : content,
      timestamp: Date.now(),
    } as UserMessage);
  }

  async function abortRun(): Promise<void> {
    await window.piBuddy.pi.command({ type: "abort" });
  }

  async function newTask(): Promise<void> {
    const resp = await window.piBuddy.pi.command({ type: "new_session" });
    if (!resp.success) {
      notify("error", resp.error ?? "无法开始新任务");
      return;
    }
    items.value = [];
    for (const key of Object.keys(toolRuns)) delete toolRuns[key];
    liveAssistant.value = null;
    stats.value = null;
    await refreshState();
    void refreshSessions();
  }

  async function openSession(meta: SessionMeta): Promise<void> {
    if (streaming.value) {
      notify("warning", "请先停止当前任务，再切换历史会话");
      return;
    }
    const resp = await window.piBuddy.pi.command({
      type: "switch_session",
      sessionPath: meta.path,
    });
    if (!resp.success) {
      notify("error", resp.error ?? "打开会话失败");
      return;
    }
    const messages = await window.piBuddy.pi.command<{ messages: AgentMessage[] }>({
      type: "get_messages",
    });
    if (messages.success && messages.data) loadMessages(messages.data.messages);
    await refreshState();
    void refreshStats();
  }

  async function setModel(
    provider: string,
    modelId: string,
    persist = true
  ): Promise<void> {
    const resp = await window.piBuddy.pi.command({ type: "set_model", provider, modelId });
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
    const resp = await window.piBuddy.pi.command({ type: "set_thinking_level", level });
    if (resp.success) {
      settings.value = await window.piBuddy.settings.set({ thinkingLevel: level });
      await refreshState();
    }
  }

  async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
    settings.value = await window.piBuddy.settings.set(patch);
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
    sessions,
    items,
    liveAssistant,
    toolRuns,
    streaming,
    queue,
    statusTexts,
    uiRequests,
    editorText,
    settingsOpen,
    activityTick,
    workspace,
    currentModel,
    busyStatus,
    extStatus,
    setNotifier,
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
    setModel,
    switchToBundledRuntime,
    setThinkingLevel,
    saveSettings,
    respondUi,
    refreshSessions,
  };
});
