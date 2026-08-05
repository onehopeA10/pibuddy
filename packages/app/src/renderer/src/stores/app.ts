import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef, watch } from "vue";
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
  ModelErrorKind,
  PiEnvelope,
  PiExitPayload,
  PiModelErrorPayload,
  PiUiExpireAllPayload,
  PiUiExpirePayload,
} from "@contract";
import { parseEnvelope, UI_EXPIRED_HINT } from "@contract";
import { retryStatusText, shouldSurfaceModelError } from "../model-error-advice";
import { useSessionsStore } from "./sessions";
// 静态引：workspace store 不反向依赖本文件，动态 import 只会让打包器
// 把同一个模块同时算进两种图里并报一条警告，收益为零。
import { useWorkspaceStore } from "./workspace";
import { clearChatUiState } from "./chat-ui";
import {
  assertImageCapable,
  imageBlockedMessage,
  type ImageCapabilityVerdict,
} from "./model-capability";
import { registerSessionScopedReset, resetSessionScopedState } from "./session-scope";
import { recordUnknownEvent, useExtensionUiStore } from "./extensionUi";

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

/** 输入区里的一张图（ImageContent + 供界面显示的文件名）。 */
export interface ComposerImage extends ImageContent {
  name: string;
}

/**
 * 输入区（composer）的**完整**状态，按 sessionId 归一化。
 *
 * 四样东西缺一不可：正文、图片、非图片附件、本地未发送队列。早先它们分居
 * 三处 —— 正文与队列是 store 上的全局 ref，图片与附件是 InputBar 的组件级
 * `ref([])`，而换会话时一处都不清。表现是：在 A 会话打了一半的字、贴的图、
 * 拖进来的文件，切到 B 之后原样还在输入框里，一按发送就发进了 B。
 *
 * 修法不是「切会话时清空」而是**按会话存**：清空会把用户没发完的内容直接
 * 丢掉，而按会话存既不串写，切回去还能接着写。草稿落盘同理 —— 防抖任务
 * 捕获发起时的 sessionId，到点从**那个** session 的 composer 取数，因此
 * 「A 打完字立刻切到 B，500ms 后定时器才触发」这条时序写下的是 A 的草稿。
 */
export interface ComposerState {
  text: string;
  images: ComposerImage[];
  attachments: AttachmentRef[];
  queue: LocalQueueItem[];
}

function emptyComposer(): ComposerState {
  return { text: "", images: [], attachments: [], queue: [] };
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

/**
 * 已经弹过提示的出错扩展名。
 *
 * 快速切换会话时每次都会新建 runtime、把用户级扩展重新加载一遍，同一个坏
 * 扩展会连报好几次；逐条弹提示会直接刷屏盖住界面。
 */
const reportedExtensionErrors = new Set<string>();

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

// 清空回调表住在 ./session-scope.ts（原地再导出，既有引用点零改动）。
// 抽出去的原因见那个文件的头注释：extensionUi store 要注册自己的清空动作，
// 而 app store 反过来要读 extensionUi 的状态做兼容代理。
export { registerSessionScopedReset, resetSessionScopedState };

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
   * 拼附件清单。现在只传 token：清单由主进程按结构化引用生成，工作区内的
   * 附件一律以 relativePath 呈现 —— 渲染进程从头到尾不知道这些文件在磁盘
   * 上的哪里，模型也拿不到本机的目录结构。
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

  // 图片能力守卫（PROV-101）。位置必须在**任何 RPC 之前**：事后补救意味着
  // 图片已经发出去了 —— 上游报一次错、用户被计一次费，而界面上只能显示
  // 一条看不懂的 API 错误。
  //
  // 判据是 get_available_models 返回的 `Model.input`，不是任何硬编码名单。
  // 这里 `return false` 而不是裸 `return`：send 的签名是 Promise<boolean>，
  // 裸 return 会返回 undefined，InputBar 那边 `if (await store.send(...))`
  // 于是不清空输入区 —— 行为碰巧对了，但类型是错的，且过不了 typecheck。
  const imageVerdict = assertImageCapable(store.currentModel, images.length, store.models);
  if (!imageVerdict.ok) {
    store.modelBlockedImages = imageVerdict;
    store.notify("warning", imageBlockedMessage(imageVerdict));
    return false;
  }
  store.modelBlockedImages = null;

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
    schemaVersion: 2,
    piRuntimeMode: "bundled",
    sttApiKeyConfigured: false,
    sttApiKeyLast4: "",
    // 崩溃转储的隐私选择从「没问过」开始，绝不臆造一个 allow。
    crashDumpConsent: "unset",
    workspaceDefaults: {},
    // 向导从第 0 步开始，且 onboardingCompletedAt **不设** ——
    // 首帧就说「已完成」会让主界面在真实设置到达之前闪一下，
    // 而那一瞬间连 workspace 都还没读到。
    onboardingStep: 0,
    notificationsEnabled: true,
    voiceEnabled: false,
  });
  const startError = ref("");
  /** 会话切换成功但消息拉取失败时的提示；非空时 ChatView 显示错误条与「重试」。 */
  const sessionLoadError = ref("");

  /**
   * 正在切入的会话 id；null 表示没有切换在进行。
   *
   * pi 的 `switch_session` 要把整个 JSONL 读进来重建上下文，**耗时由文件大小
   * 决定而不是可见消息数** —— 1.7MB 的会话实测 4679ms（裸 pi 进程直测，与本
   * 应用无关）。这段等待消不掉，但必须让用户看见：改造前点下去 5 秒内界面
   * 毫无反应，用户会以为没点上而反复点，每一下都再排队 5 秒。
   */
  const switchingSessionId = ref<string | null>(null);

  /**
   * 当前会话 .jsonl 的字节数 —— **向前翻页的初始游标**。
   *
   * 磁盘反向分页的唯一入口是「从文件末尾往回读」，因此这个数就是那条路的
   * 开关：为 0 时 chat-window 的 `reachedTop` 在 reset 那一刻就是 true，
   * 整条 JSONL 反向分页从此永不执行 —— 不报错、不失败类型检查，表现只是
   * 「压缩过的长会话，更早的消息怎么点都出不来」。
   *
   * 取数来自会话索引（列表行里本来就有 sizeBytes），不为它单开 IPC。
   */
  const currentSessionBytes = ref(0);

  /**
   * 最近一次被图片能力守卫拦下的判定（PROV-101）。
   *
   * 非空时 InputBar 把附件条目标成 `aria-disabled="true"`、禁用发送按钮，
   * 并给出「切换到支持图片的模型」的快捷动作。清空的时机只有两个：一次
   * 成功的发送，或用户换了模型。
   */
  const modelBlockedImages = ref<ImageCapabilityVerdict | null>(null);

  /**
   * 打开历史会话时发现「会话记录的模型 ≠ 当前默认」时的询问（PROV-101）。
   *
   * **只提示，不动作**。自动切走会丢掉「这条会话当时用的是什么」这个事实；
   * 自动不切又会让「我明明改了默认模型」变成一个说不清的现象。两个动作
   * （保持 / 切换）都由用户点。
   */
  const modelMismatchPrompt = ref<{
    sessionModelId: string;
    sessionProvider: string;
    targetModelId: string;
    targetProvider: string;
  } | null>(null);

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
   * 输入区状态，按 sessionId 归一化（见 ComposerState 的注释）。
   *
   * 换工作区时整表清空（adoptWorkspace）：不清的话，两个工作区里恰好同 id
   * 的会话会共用同一格 —— 而 sessionId 只在一个工作区之内唯一。
   */
  const composers = reactive<Record<string, ComposerState>>({
    [PENDING_SCOPE_KEY]: emptyComposer(),
  });

  function composer(sessionId: string = currentSessionId.value): ComposerState {
    let c = composers[sessionId];
    if (!c) {
      c = emptyComposer();
      composers[sessionId] = c;
    }
    return c;
  }

  /**
   * 当前会话的格子恒存在。
   *
   * 少了这一条，`editorText` 之类的 computed 就得在 **getter 里**建格子 ——
   * 那是一次「读的时候顺手改了自己依赖的响应式数据」，Vue 会因此多跑一轮
   * 求值与重渲染。`flush: "sync"` 是必需的：测试与代码里都有直接写
   * `currentSessionId` 的地方，默认的 pre 刷新要等到下一个 tick 才建格子。
   */
  watch(
    currentSessionId,
    (id) => {
      if (!composers[id]) composers[id] = emptyComposer();
    },
    { immediate: true, flush: "sync" }
  );

  /**
   * 会话 ID 变化时把当前 scope 的运行状态搬到新 key 上。
   *
   * 不搬的话 started 会在 refreshState 之后瞬间读到一个全新的空 scope、
   * 回落为 false，输入框被禁用且不报任何错。M0 同时只有一个 pi 进程，
   * switch_session 不换进程，因此原样搬运就是正确语义。
   */
  function adoptSession(sessionId: string | undefined): void {
    const id = sessionId || PENDING_SCOPE_KEY;
    const prevKey = currentSessionId.value;
    if (id === prevKey) return;
    const prev = scope();
    runtimeScope[id] = { ...prev };
    // 占位 key → 真 id：会话 id 在 start 返回之前是未知的，此前用户在输入框里
    // 打的字记在占位格上。真 id 一到就整格搬过去，否则那段内容会留在一个再也
    // 读不到的桶里（界面上表现为「刚打的字自己没了」）。
    //
    // **只搬这一种转移**。A → B 是换会话，把 A 的输入区搬到 B 就是串写本身。
    if (prevKey === PENDING_SCOPE_KEY && id !== PENDING_SCOPE_KEY) {
      composers[id] = composers[PENDING_SCOPE_KEY] ?? emptyComposer();
      composers[PENDING_SCOPE_KEY] = emptyComposer();
    }
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

  /**
   * 本地**未提交**队列。
   *
   * 与 `queue`（pi 经 queue_update 下发的已提交队列）严格分开：pi 的
   * queue_update 只给字符串数组、没有稳定 id，协议里也没有「撤回队列项」
   * 的命令 —— 已提交的东西删不掉是上游能力缺失，不能用一个假的删除按钮
   * 冒充。只有还在这个数组里的条目可以编辑、可以删除。
   *
   * 与正文、图片、附件一样住在**当前会话的 composer 格子**里：同名代理让
   * 既有的 `store.localQueue` 读写点一个字都不用改。
   */
  const localQueue = computed<LocalQueueItem[]>({
    get: () => composer().queue,
    set: (v) => {
      composer().queue = v;
    },
  });
  let localQueueSeq = 0;

  /**
   * 扩展 UI 的四样状态（弹窗队列 / 状态条 / widget / 标题）现在归
   * extensionUi store 所有。这里保留同名代理是为了让既有组件与测试零改动 ——
   * 迁移不该顺手改掉一堆读点，那样一次改动会同时验证两件事。
   */
  const extUi = useExtensionUiStore();
  const uiRequests = computed(() => extUi.uiRequests);
  const statusTexts = extUi.statusTexts;
  /** 输入区正文。同名代理，落在当前会话的 composer 格子上。 */
  const editorText = computed<string>({
    get: () => composer().text,
    set: (v) => {
      composer().text = v;
    },
  });
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
    // 输入区（正文 / 图片 / 附件 / 本地队列）**不在这里清**：它按 sessionId
    // 存放，换会话时读到的自然就是新会话那一格。而这个回调是在
    // currentSessionId **还指着旧会话**的时候跑的（openSession / newTask 都
    // 先 reset 再 refreshState），在这里清等于把用户刚打的字从旧会话里抹掉。
    // statusTexts / uiRequests 的清空由 extensionUi store 自己注册的那一条
    // 回调负责（CT-25）：状态归谁所有，清空就归谁写。
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
    const nextId = ref_?.workspaceId ?? "";
    // 换工作区 = 输入区整表作废。sessionId 只在一个工作区之内唯一，留着上一个
    // 工作区的格子，两边恰好同 id 的会话就会共用同一份草稿。
    if (nextId !== workspaceId.value) {
      for (const key of Object.keys(composers)) delete composers[key];
      composers[PENDING_SCOPE_KEY] = emptyComposer();
    }
    workspaceId.value = nextId;
    displayPath.value = ref_?.displayPath ?? "";
  }
  const currentModel = computed(() => agentState.value?.model ?? null);
  /** 运行相关的临时状态（压缩、重试、摘要重试），显示在输入框上方 */
  const busyStatus = computed(() => extUi.busyStatus);
  /** 扩展上报的常驻状态（如 AUTO/YOLO 模式），弱化显示在顶栏 */
  const extStatus = computed(() => extUi.extStatus);

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
        // 新一轮开始 = 上一轮那条「该怎么办」的横幅已经过时。留着它的话，
        // 用户会以为刚发出去的这句话也失败了。
        clearModelError();
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
          // 模型这一轮以错误收场：计入用量页的失败率
          if ((msg as AssistantMessage).stopReason === "error") noteFailure();
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
        extUi.setLocalStatus("compaction", "正在整理对话记忆…");
        break;
      case "compaction_end":
        extUi.setLocalStatus("compaction", "");
        break;
      case "auto_retry_start": {
        const ev = e as Extract<AgentEvent, { type: "auto_retry_start" }>;
        // 文案按归一化后的类别措辞。收敛前这里恒为「网络繁忙」，而实际触发
        // 重试的绝大多数是服务商限流 —— 那句话会把用户引去查自己的网络。
        extUi.setLocalStatus(
          "retry",
          retryStatusText(retryKind.value, ev.attempt, ev.maxAttempts)
        );
        break;
      }
      case "auto_retry_end": {
        const ev = e as Extract<AgentEvent, { type: "auto_retry_end" }>;
        extUi.setLocalStatus("retry", "");
        retryKind.value = "unknown";
        if (!ev.success && ev.finalError) {
          // 用量页的失败率来自这里与 assistant.stopReason==='error' 两处
          noteFailure();
          notify("error", "多次重试仍失败，请稍后再试");
        }
        break;
      }

      // ---- 早先落进 default 分支被静默丢弃的五类事件 ----
      //
      // turn_start / turn_end 是一轮内的边界，本身不改变界面，但必须显式
      // 列出来：写成 default 的话，「我们决定不处理它」和「我们不知道有
      // 这个事件」在代码里长得一模一样。
      case "turn_start":
      case "turn_end":
        break;
      case "agent_end": {
        // agent_end 带 willRetry 时后面还有一轮，此时把 streaming 收掉会让
        // 输入框以为可以正常发消息，而 pi 那边仍在处理（插话会被拒）。
        const ev = e as Extract<AgentEvent, { type: "agent_end" }>;
        if (!ev.willRetry) streaming.value = false;
        break;
      }
      case "bash_execution_update": {
        // 内置 bash 工具的流式输出。归到对应的工具卡片上；找不到卡片
        // （id 缺席）时不新建，避免凭空冒出一张没有标题的卡。
        const ev = e as Extract<AgentEvent, { type: "bash_execution_update" }>;
        const run = ev.id ? toolRuns[ev.id] : undefined;
        if (run) {
          run.output += ev.delta ?? "";
          activityTick.value++;
        }
        break;
      }
      case "summarization_retry_scheduled": {
        const ev = e as Extract<AgentEvent, { type: "summarization_retry_scheduled" }>;
        extUi.setLocalStatus(
          "summarization",
          `整理记忆失败，${Math.round((ev.delayMs ?? 0) / 1000)} 秒后重试 (${ev.attempt}/${ev.maxAttempts})…`
        );
        break;
      }
      case "summarization_retry_attempt_start": {
        const ev = e as Extract<AgentEvent, { type: "summarization_retry_attempt_start" }>;
        const what = ev.source === "branchSummary" ? "分支摘要" : "对话记忆";
        extUi.setLocalStatus("summarization", `正在重试整理${what}…`);
        break;
      }
      case "summarization_retry_finished":
        extUi.setLocalStatus("summarization", "");
        break;

      case "extension_error": {
        // 早先这里只说「扩展出现问题」，既不说哪个扩展也不说什么错 ——
        // 用户既判断不了该不该管，也没有任何线索去修。至少把扩展名报出来。
        const ev = e as Extract<AgentEvent, { type: "extension_error" }>;
        const name =
          (ev.extensionPath ?? "").split(/[\\/]/).pop()?.replace(/\.[tj]s$/, "") ||
          "未知扩展";
        // 同一个扩展在快速切换会话时会连报多次（每次新建 runtime 都重新加载
        // 一遍），逐条弹提示会刷屏。同名只提示一次，后续只记日志。
        if (!reportedExtensionErrors.has(name)) {
          reportedExtensionErrors.add(name);
          notify(
            "warning",
            `扩展「${name}」出错了，不影响继续使用；可在「🧩 资源」里停用它`
          );
        }
        console.warn("[extension_error]", ev.extensionPath, ev.event, ev.error);
        break;
      }
      // `unknown` 是 pi-sdk 对未建模事件的归一化形式；default 兜住那些连
      // 归一化都没经过的（比如直接投喂进来的原始对象）。
      case "unknown":
      default: {
        // 裸 `break` 会让新版本 pi 新增的事件永久静默消失：不报错、不记数、
        // 不留痕。这里至少留下一个计数与一份 debug 快照 —— 下次「怎么少了
        // 一块提示」有地方可查。
        const type = (e as { type?: string }).type ?? "";
        const raw = type === "unknown" ? (e as { raw?: unknown }).raw : undefined;
        const rawType =
          raw && typeof raw === "object" ? String((raw as { type?: unknown }).type ?? "") : "";
        extUi.recordUnknownEvent(rawType || type);
        break;
      }
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

  /**
   * 最近一条**需要用户处理**的模型错误（MDL-101）。
   *
   * 会话级而不是挂在某条消息上：归一化结论走 `pi:model-error`（立即发出），
   * 消息本身走 `pi:event`（33ms 合批），两者到达顺序不固定。挂消息就得先解
   * 决一个本不存在的对齐问题，而用户真正要的只是「现在该做什么」。
   *
   * 自动重试中的报告（source==='retry'）不进这里，只更新状态条 —— 系统正在
   * 自愈时弹一个带按钮的横幅，等于催用户在不必动手的时候动手。
   */
  const modelError = ref<PiModelErrorPayload | null>(null);
  /** 本轮自动重试的类别，供状态条措辞用；重试收场即清。 */
  const retryKind = ref<ModelErrorKind>("unknown");

  function clearModelError(): void {
    modelError.value = null;
  }

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
   * `pi:model-error` 的入口：主进程归一化后的模型失败结论。
   *
   * 这条通道**只加解释，不改原文**：消息卡上那段 provider 原话一个字节都没
   * 变，这里额外给出的是一个 kind，界面据此给出可操作的下一步。
   */
  function handleModelErrorEnvelope(raw: unknown): void {
    const env = acceptEnvelope(raw, "pi:model-error");
    if (!env) return;
    const payload = env.payload as PiModelErrorPayload;
    if (!payload?.kind) return;
    if (payload.source === "retry") {
      // 重试中：只记类别，横幅留给终态。状态条文案由 auto_retry_start 落地
      // ——它比本通道晚到（合批 33ms），届时 retryKind 已经是准确值。
      retryKind.value = payload.kind;
      return;
    }
    if (!shouldSurfaceModelError(payload.source, payload.kind)) return;
    modelError.value = payload;
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

  /**
   * 九个 method 全覆盖（rpc.md:1170-1310）。
   *
   * 改造前只有七个 case，setWidget / setTitle 落进那条裸的 default 分支被静默
   * 丢弃 —— 它们是 fire-and-forget，丢了不会挂起任何东西，所以既不报错也
   * 不失败，只是扩展写出来的东西永远显示不出来。
   *
   * switch 上没有 default：新增一个上游 method 时，`method` 的联合类型会
   * 让 `never` 断言在 typecheck 阶段失败，而不是等到用户报「按钮没反应」。
   */
  function handleUiRequest(r: ExtensionUiRequest): void {
    switch (r.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        extUi.enqueue(r);
        break;
      case "notify": {
        const kind =
          r.notifyType === "error" ? "error" : r.notifyType === "warning" ? "warning" : "info";
        notify(kind, r.message ?? "");
        break;
      }
      case "setStatus":
        extUi.setStatus(r.statusKey ?? "", r.statusText);
        break;
      case "setWidget":
        extUi.setWidget(r.widgetKey ?? "", r.widgetLines, r.widgetPlacement ?? "aboveEditor");
        break;
      case "setTitle":
        extUi.setTitle(r.title);
        break;
      case "set_editor_text":
        editorText.value = r.text ?? "";
        break;
    }
  }

  /** 主进程告知某条弹窗已失效（超时 / 代际作废）。 */
  function handleUiExpireEnvelope(raw: unknown): void {
    const env = acceptEnvelope(raw, "pi:ui-expire");
    if (!env) return;
    const payload = env.payload as PiUiExpirePayload;
    if (extUi.expire(payload)) notify("info", UI_EXPIRED_HINT);
  }

  function handleUiExpireAllEnvelope(raw: unknown): void {
    const env = acceptEnvelope(raw, "pi:ui-expire-all");
    if (!env) return;
    const n = extUi.expireAll(env.payload as PiUiExpireAllPayload);
    if (n > 0) notify("info", UI_EXPIRED_HINT);
  }

  /**
   * 回答一条弹窗。
   *
   * **必须看返回值**：主进程会因为「这条已经过期」或「runtime 已经没了」
   * 而拒绝转发。改造前这条路径返回 void、失败静默吞掉，用户点了确定、
   * 弹窗关了，助手那边什么都没发生，界面上没有任何线索。
   */
  async function respondUi(
    request: ExtensionUiRequest,
    payload: { value?: string; confirmed?: boolean; cancelled?: boolean }
  ): Promise<{ ok: boolean; reason?: string }> {
    extUi.remove(request.id);
    try {
      const result = await window.piBuddy.pi.extensionUi.respond({
        type: "extension_ui_response",
        id: request.id,
        ...payload,
      });
      if (!result?.ok) {
        notify(
          "warning",
          result?.reason === "no-runtime"
            ? "助手已经停止了，这个回答没能送出去"
            : UI_EXPIRED_HINT
        );
      }
      return result ?? { ok: false, reason: "unknown" };
    } catch (err) {
      // clientFor 抛错曾经在这里变成一条未处理的 promise rejection
      notify("warning", UI_EXPIRED_HINT);
      return { ok: false, reason: (err as Error).message };
    }
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
    unsubscribes.push(
      window.piBuddy.pi.events.onModelError((e) => handleModelErrorEnvelope(e))
    );
    unsubscribes.push(window.piBuddy.pi.events.onUiExpire((e) => handleUiExpireEnvelope(e)));
    unsubscribes.push(
      window.piBuddy.pi.events.onUiExpireAll((e) => handleUiExpireAllEnvelope(e))
    );
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

  /**
   * 原始 JSONL 条目 → AgentMessage[]。
   *
   * 会话文件里除了 message 还有 model_change / thinking_level_change /
   * session_info / compaction 等条目，取数时一并读了出来，这里只挑消息。
   * 形状见 pi 的 docs/session-format.md：`{type:"message", message:{role,...}}`。
   */
  function entriesToMessages(entries: unknown[]): AgentMessage[] {
    const out: AgentMessage[] = [];
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as { type?: string; message?: AgentMessage };
      if (e.type !== "message" || !e.message) continue;
      out.push(e.message);
    }
    return out;
  }

  /**
   * 一条消息的去重签名。
   *
   * 只用 role + timestamp + 正文前缀：这三样在同一个会话文件里已经足够区分，
   * 而 JSON.stringify 整条消息会把 pi 与磁盘两条路径上**同一条消息**的字段
   * 顺序差异算成两条不同的消息。
   */
  function messageSignature(msg: AgentMessage): string {
    const ts = (msg as { timestamp?: number }).timestamp ?? 0;
    const content = (msg as { content?: unknown }).content;
    const text =
      typeof content === "string" ? content : textOf(content as { type: string }[] | undefined);
    return `${msg.role}|${ts}|${text.slice(0, 200)}`;
  }

  /**
   * 把更早的消息**接在前面**（向前翻页用）。
   *
   * 改造前 chat-window 把读到的条目塞进自己的 `earlier` 数组，而 ChatView
   * 渲染的是 `items` —— 全项目没有第二处引用 `earlier`。结果是：内存里的铺
   * 完之后再点「查看更早的消息」，磁盘确实读了、游标确实前进了，**界面上
   * 一条都不会多出来**。不报错、不失败类型检查，纯粹静默。
   *
   * 返回**真正接上去**的条数。两条取数路径会重叠：`items` 由 pi 的
   * get_messages 填充，而首屏的 beforeOffset 就是文件长度，于是第一页磁盘
   * 数据必然与内存里已有的那一段是同一批消息。不去重就是同一条消息在界面上
   * 出现两遍 —— 而且是「点一次多一份」，越点越多。
   */
  function prependMessages(messages: AgentMessage[]): number {
    const seen = new Set(items.value.map((i) => messageSignature(i.message)));
    const prepended: ChatItem[] = [];
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        recordToolResult(msg as ToolResultMessage);
        continue;
      }
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const sig = messageSignature(msg);
      if (seen.has(sig)) continue;
      seen.add(sig);
      prepended.push({ key: ++keySeq, message: msg });
    }
    if (prepended.length > 0) items.value = [...prepended, ...items.value];
    return prepended.length;
  }

  async function start(sessionId?: string): Promise<void> {
    startError.value = "";
    sessionLoadError.value = "";
    started.value = false;
    streaming.value = false;
    // 字节上界由收尾处的 refreshSessions → adoptSessionBytes 从索引里补齐。
    currentSessionBytes.value = 0;
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
        // 恢复历史会话：**一次 setModel 都不发**。会话文件里记着的模型是一个
        // 事实，覆盖它等于用户每打开一个旧会话都被悄悄换成另一个模型。
        //
        // 只在会话模型与「若无会话层则会生效的那一层」不同时置提示，由
        // TopBar 问用户「这个会话原来用的是 X，是否切换？」，两个动作都由
        // 用户点。这一段里不允许出现 setModel 调用。
        const sessionModel = result.state.model;
        const wsDefault = saved.workspaceDefaults?.[workspaceId.value];
        const target =
          wsDefault ??
          (saved.provider && saved.modelId
            ? { provider: saved.provider, modelId: saved.modelId }
            : null);
        if (
          sessionModel &&
          target &&
          (sessionModel.provider !== target.provider || sessionModel.id !== target.modelId)
        ) {
          modelMismatchPrompt.value = {
            sessionModelId: sessionModel.id,
            sessionProvider: sessionModel.provider,
            targetModelId: target.modelId,
            targetProvider: target.provider,
          };
        } else {
          modelMismatchPrompt.value = null;
        }
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

  /**
   * 待计入下一次上报的失败次数。
   *
   * 失败发生在事件流里（agent_settled 之前），而上报只在拿到 session stats
   * 之后才做得了 —— 中间攒在这里。上报成功即清零，避免同一次失败被计两遍。
   */
  let pendingFailures = 0;

  async function refreshStats(): Promise<void> {
    const resp = await window.piBuddy.pi.getSessionStats();
    if (!resp.success || !resp.data) return;
    stats.value = resp.data;
    await recordUsage(resp.data);
  }

  /**
   * 把这一轮的用量上报给主进程（PROV-101）。
   *
   * **必须挂在这里**：`get_session_stats` 是唯一给出 token 与 cost 的地方，
   * 而它只在 agent_settled 之后有新值。没有这一步的话，用量页会永远是空的 ——
   * 表格渲染得好好的、导出按钮点了也有反应、typecheck 与单测全绿，只是
   * 一行数据都没有。这正是真机验证抓到的形态。
   *
   * 主进程按 sessionId 记 last_seen_total 做差值，因此这里送的是**会话累计
   * 快照**而不是增量；重复上报同一份快照的增量为 0，是幂等的。
   */
  async function recordUsage(snapshot: SessionStats): Promise<void> {
    const model = agentState.value?.model;
    const sessionId = snapshot.sessionId ?? currentSessionId.value;
    // 模型未知时不记：一条 provider/model 为空的用量行对用户没有任何意义，
    // 还会在按模型汇总时多出一行看不懂的空白。
    if (!model || !sessionId) return;
    const failed = pendingFailures > 0;
    try {
      await window.piBuddy.providers.usage.record({
        sessionId,
        workspaceId: workspaceId.value,
        provider: model.provider,
        modelId: model.id,
        inputTokens: snapshot.tokens?.input ?? 0,
        outputTokens: snapshot.tokens?.output ?? 0,
        cost: snapshot.cost ?? 0,
        contextTokens: snapshot.contextUsage?.tokens ?? 0,
        failed,
      });
      if (failed) pendingFailures = 0;
    } catch (err) {
      // 用量记不上不该打断对话，但**不能静默**：空 catch 会让「用量页一直
      // 是空的」变成一个查不出原因的现象（就是这条实测出来的）。
      lastUsageError.value = err instanceof Error ? err.message : String(err);
    }
  }

  /** 上一次用量上报失败的原因；不展示给用户，只用于诊断与单测。 */
  const lastUsageError = ref("");

  /** 事件流里记一次失败，等下一次 stats 刷新时一并上报。 */
  function noteFailure(): void {
    pendingFailures++;
  }

  /**
   * 会话列表的刷新委托给 sessions store —— 列表的查询条件、分页、整理动作
   * 全在那边，这里只负责在合适的时机（agent_settled / 启动 / 换会话）触发。
   */
  async function refreshSessions(): Promise<void> {
    if (!workspaceId.value) return;
    await useSessionsStore().refresh(workspaceId.value);
    adoptSessionBytes();
  }

  /**
   * 从刚刷新的会话索引里取当前会话的字节数。
   *
   * 挂在 refreshSessions 之后是唯一必要的落点：开机恢复上一个会话、新建
   * 会话写下第一条消息、agent_settled 之后文件变长 —— 三条路径全都以一次
   * refreshSessions 收尾。少了这一步，只有「从列表里点开」的会话才有字节
   * 上界，开机直接进来的那个会话永远翻不了页。
   */
  function adoptSessionBytes(): void {
    const row = useSessionsStore().rowOf(currentSessionId.value);
    if (row) currentSessionBytes.value = row.sizeBytes;
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
    // 换工作区会把编辑器 tab 全部清掉。先问一次「未保存的编辑怎么办」，
    // 用户点取消就到此为止 —— 中止必须是真的中止，不能问完还是照切。
    // 问在 chooseFolder 之后：先弹一个和目录无关的对话框，用户根本不知道
    // 自己是在为哪次操作做决定。
    if (chosen.workspaceId !== workspaceId.value) {
      if (!(await useWorkspaceStore().confirmLeave())) return;
    }
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
    // 新会话磁盘上还没有文件，更谈不上「更早的消息」。
    currentSessionBytes.value = 0;
    await refreshState();
    void refreshSessions();
  }

  /**
   * 手动整理一次对话记忆（MDL-101 的 context_overflow 出口）。
   *
   * 上下文溢出是**唯一**一类「用户点一下就能修」的模型错误，此前界面上没有
   * 任何入口 —— 只有 pi 自己在检测到溢出时的自动压缩，而它失败之后用户就
   * 无路可走了。成功即清掉横幅：修好了还挂着提示，等于让用户怀疑没修好。
   */
  async function compactSession(): Promise<void> {
    if (streaming.value) {
      notify("warning", "请先等这一轮结束，再整理对话记忆");
      return;
    }
    try {
      const resp = await window.piBuddy.pi.compact();
      if (!resp?.success) {
        notify("error", resp?.error ?? "整理对话记忆失败");
        return;
      }
      clearModelError();
      notify("info", "已整理对话记忆，可以继续了");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "整理对话记忆失败");
    }
  }

  /**
   * 打开一个历史会话。
   *
   * 入参是**不透明 sessionId**：JSONL 的绝对路径全程留在主进程，由会话索引
   * 反查（CT-15）。渲染进程连一个路径字符串都拿不到，也就无从伪造。
   */
  async function openSession(target: {
    sessionId: string;
    /** 会话文件字节数，用于本地抢先渲染；列表行里本来就有 */
    sizeBytes?: number;
  }): Promise<void> {
    if (streaming.value) {
      notify("warning", "请先停止当前任务，再切换历史会话");
      return;
    }
    // 已经在这个会话里：pi 那边照样要重读整个文件，白等好几秒换来同样的界面
    if (target.sessionId === currentSessionId.value) return;
    // 一次只切一个。少了这道闸，用户在 5 秒空窗里连点几下，就会排起几个
    // 各自 5 秒的切换，最后落在哪个会话上取决于返回顺序。
    if (switchingSessionId.value !== null) return;

    switchingSessionId.value = target.sessionId;
    // 先于 currentSessionId 变化写入：ChatView 在 currentSessionId 一变就
    // 用它 reset 翻页游标，晚一步写就等于用 0 去 reset（= 直接判定已到文件头）。
    currentSessionBytes.value = target.sizeBytes ?? 0;
    try {
      // 先用本地 JSONL 把内容铺出来（10ms 级），不等 pi。
      //
      // pi 的 switch_session 要重建整个上下文，实测 1.7MB 会话 4679ms，且耗
      // 时由文件大小决定而非消息数。那段等待消不掉，但没有理由让用户连"这
      // 个会话里有什么"都看不到 —— 消息内容就在磁盘上，我们自己的索引按字节
      // offset 读它只要几毫秒。pi 那边跑完之前只是不能发新消息而已。
      void previewSessionLocally(target.sessionId, target.sizeBytes);

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
    } finally {
      switchingSessionId.value = null;
    }
  }

  /**
   * 切换会话时的**本地抢先渲染**。
   *
   * 直接按 JSONL 字节 offset 读会话尾部若干条渲染出来，不经 pi。等 pi 的
   * switch_session 回来后 reloadMessages 会用权威数据整体覆盖，因此这里读到
   * 的哪怕不完整也无妨 —— 它的唯一职责是把「点开后好几秒的空白」变成
   * 「立刻能看到这个会话聊过什么」。
   *
   * 失败一律吞掉：这是锦上添花的路径，出问题不该盖住真正的切换流程。
   */
  async function previewSessionLocally(sessionId: string, sizeBytes?: number): Promise<void> {
    // sizeBytes 由调用方从已加载的会话行里带过来：列表本来就有这个字段，
    // 为它单开一条 IPC 通道既多一次往返，也多一处要校验的接口面。
    if (typeof sizeBytes !== "number" || sizeBytes <= 0) return;
    try {
      const page = await window.piBuddy.sessions.readHistoryBefore({
        workspaceId: workspaceId.value,
        sessionId,
        beforeOffset: sizeBytes,
        limit: 60,
      });
      // 期间用户可能又切走了：过期结果绝不能盖到新会话头上
      if (switchingSessionId.value !== sessionId) return;
      const msgs = entriesToMessages(page.entries);
      if (msgs.length > 0) loadMessages(msgs);
    } catch {
      /* 抢先渲染失败就等 pi 的权威数据，不打扰用户 */
    }
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

  /**
   * 草稿里的附件条目（能力凭证，不含路径）与图片。
   *
   * 早先这两样是 InputBar 的组件级 `ref([])` —— 组件不随会话重建，于是切走
   * 之后图片和文件原样留在输入框里，下一次发送就把它们发进了另一个会话。
   * 现在归 composer 所有，InputBar 只作同名代理。
   */
  const draftAttachments = computed<AttachmentRef[]>({
    get: () => composer().attachments,
    set: (v) => {
      composer().attachments = v;
    },
  });
  const draftImages = computed<ComposerImage[]>({
    get: () => composer().images,
    set: (v) => {
      composer().images = v;
    },
  });

  /**
   * 从文件树「加入输入框附件」推过来的结构化引用，由 InputBar 取走后清空。
   *
   * 走一个中转队列而不是让文件树直接写 InputBar 的局部 `files`：跨组件
   * 直接改对方的 ref 会让「附件到底归谁所有」变成一个要读两个文件才能
   * 回答的问题，而那种所有权含糊的状态最后一定会出现「清空了一边、另一边
   * 还留着」的不一致。
   */
  const inboundAttachments = ref<AttachmentRef[]>([]);

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
  /**
   * 每个会话一个防抖句柄。
   *
   * 单个全局句柄有两处会错：在 A 打完字立刻切到 B 再打字，B 的 schedule 会
   * `clearTimeout` 掉 A 那一次，A 的草稿从此再也不写；而如果不清，到点的
   * 回调又是**触发时**才读 currentSessionId —— 那时已经是 B，于是 A 的正文
   * 被写进 B 的草稿。按会话各记各的，两条都不成立。
   */
  const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 尾沿防抖 500ms 写草稿。
   *
   * 不防抖的话长输入是「每按一个键一次 IPC + 一次 SQLite 写」，UI 上没有
   * 任何征兆，只有主进程在闷头刷盘。
   *
   * **在这里捕获 sessionId**，落盘时按捕获到的那个会话取数 —— 定时器触发
   * 时才读「当前会话」正是跨会话串写的根因。
   */
  function scheduleSaveDraft(): void {
    const sessionId = currentSessionId.value;
    if (!sessionId) return;
    const pending = draftTimers.get(sessionId);
    if (pending) clearTimeout(pending);
    draftTimers.set(
      sessionId,
      setTimeout(() => {
        draftTimers.delete(sessionId);
        void saveDraftNow(sessionId);
      }, DRAFT_DEBOUNCE_MS)
    );
  }

  async function saveDraftNow(sessionId: string = currentSessionId.value): Promise<void> {
    if (!sessionId) return;
    // 按**捕获到的会话**取数，不是「当前会话」。这一格在 composers 里存在与否
    // 就是判据：不存在说明这个会话从没被编辑过，此时写一份空草稿只会把磁盘上
    // 已有的那份抹掉。
    const c = composers[sessionId];
    if (!c) return;
    const draft: DraftRecord = {
      text: c.text,
      attachments: c.attachments,
      queue: {
        steering: c.queue.filter((i) => i.mode === "steer").map((i) => i.text),
        followUp: c.queue.filter((i) => i.mode === "followUp").map((i) => i.text),
      },
      updatedAt: Date.now(),
    };
    try {
      await window.piBuddy.sessions.saveDraft(workspaceId.value, sessionId, plainCopy(draft));
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
      draft = await window.piBuddy.sessions.getDraft(workspaceId.value, sessionId);
    } catch {
      return;
    }
    if (!draft) return;
    // 写进**发起这次恢复的那个会话**的格子，而不是「现在打开的那个」：
    // getDraft 是一次 IPC 往返，期间用户完全可能又切走了。
    const c = composer(sessionId);
    c.text = draft.text ?? "";
    // attachments 在契约里是 unknown[]（DraftRecord 不解释凭证的形状），
    // 到这一层才收窄回 AttachmentRef[] —— 它就是 InputBar 存进去的那批。
    c.attachments = (draft.attachments ?? []) as AttachmentRef[];
    c.queue = [
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
    // 换了模型 = 上一次的图片拦截判定作废。不清的话，用户切到支持图片的
    // 模型之后附件条目仍然是灰的、发送键仍然是禁用的 —— 一个点了没反应的界面。
    modelBlockedImages.value = null;
    modelMismatchPrompt.value = null;
    await refreshState();
    await refreshThinkingLevels();
  }

  /** 「保持这个会话原来的模型」——只关掉提示条，不发任何 RPC。 */
  function keepSessionModel(): void {
    modelMismatchPrompt.value = null;
  }

  /** 「切换到默认模型」——这是用户的显式选择，此时才允许发 set_model。 */
  async function switchToPromptedModel(): Promise<void> {
    const prompt = modelMismatchPrompt.value;
    if (!prompt) return;
    modelMismatchPrompt.value = null;
    await setModel(prompt.targetProvider, prompt.targetModelId, false);
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
   * 切换 Pi 运行时来源（SEC-005）。
   *
   * 渲染进程能表达的极限就是这个 mode 枚举 —— 外部命令的路径由主进程弹
   * 原生文件选择框 + 确认框当面取得，这里既给不出路径，也读不到用户在
   * 对话框里做了什么，只知道最终 applied 与否。
   *
   * 返回是否真的落盘：用户在任一个对话框上取消时为 false，界面据此提示
   * 「已取消」而不是谎报保存成功。
   */
  async function setPiRuntime(mode: "bundled" | "external"): Promise<boolean> {
    const result = await window.piBuddy.settings.setPiRuntime(mode);
    settings.value = result.settings;
    return result.applied;
  }

  /**
   * 从 external 运行时切回内置。
   *
   * 只有用户点这个按钮才写设置 —— external 启动失败本身绝不自动改写
   * piRuntimeMode，否则用户的显式选择会在一次失败后被悄悄抹掉。
   * 切回内置是降权，主进程不会为它弹确认框。
   */
  async function switchToBundledRuntime(): Promise<void> {
    await setPiRuntime("bundled");
    await start();
  }

  return {
    booting,
    settings,
    started,
    startError,
    sessionLoadError,
    switchingSessionId,
    currentSessionBytes,
    entriesToMessages,
    prependMessages,
    currentSessionId,
    runtimeScope,
    composers,
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
    draftImages,
    inboundAttachments,
    statusTexts,
    uiRequests,
    editorText,
    settingsOpen,
    activityTick,
    workspace,
    workspaceId,
    displayPath,
    adoptWorkspace,
    currentModel,
    busyStatus,
    extStatus,
    setNotifier,
    notify,
    handleEvent,
    handleEventEnvelope,
    handleUiRequest,
    handleUiRequestEnvelope,
    handleUiExpireEnvelope,
    handleUiExpireAllEnvelope,
    handleExitEnvelope,
    handleModelErrorEnvelope,
    modelError,
    retryKind,
    clearModelError,
    dispose,
    init,
    start,
    chooseWorkspace,
    send,
    abortRun,
    newTask,
    compactSession,
    openSession,
    reloadMessages,
    setModel,
    modelBlockedImages,
    modelMismatchPrompt,
    keepSessionModel,
    switchToPromptedModel,
    setPiRuntime,
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
    lastUsageError,
    restoreDraft,
    flushStream,
    resetStream,
  };
});
