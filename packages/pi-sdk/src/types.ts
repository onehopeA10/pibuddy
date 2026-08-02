// pi RPC 协议类型定义
// 参考 @earendil-works/pi-coding-agent docs/rpc.md 与 session-format.md

// ---------- 内容块 ----------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContent =
  | TextContent
  | ThinkingContent
  | ToolCallContent;

// ---------- 消息 ----------

export interface CostUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: CostUsage;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
  attachments?: unknown[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | "pending";
  errorMessage?: string;
  timestamp?: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  usage?: Usage;
  isError: boolean;
  timestamp?: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string | null;
  timestamp?: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | { role: string; [key: string]: unknown };

// ---------- 模型 ----------

export interface Model {
  id: string;
  name?: string;
  api?: string;
  provider: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

// ---------- 命令 ----------

export type StreamingBehavior = "steer" | "followUp";

export interface RpcCommandBase {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface AgentState {
  model: Model | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface CommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: "user" | "project" | "path";
  path?: string;
}

// ---------- 事件 ----------

export interface AssistantMessageEvent {
  type:
    | "start"
    | "text_start"
    | "text_delta"
    | "text_end"
    | "thinking_start"
    | "thinking_delta"
    | "thinking_end"
    | "toolcall_start"
    | "toolcall_delta"
    | "toolcall_end"
    | "done"
    | "error";
  contentIndex?: number;
  delta?: string;
  content?: string;
  reason?: string;
  toolCall?: ToolCallContent;
  partial?: AssistantMessage;
}

export interface ToolResultPayload {
  content: (TextContent | ImageContent)[];
  details?: unknown;
}

/**
 * pi 的全部事件类型（对齐 pi-coding-agent docs/rpc.md 的 Event Types 表）。
 *
 * 这里刻意**枚举全集**而不是留一个 `{ type: string; [k: string]: unknown }`
 * 兜底成员：那个兜底成员会让 `switch (e.type)` 完全失去判别式收窄能力 ——
 * 每个 case 里的 `e` 仍是整个联合，上层只能靠 `as` 强转，类型保护形同虚设。
 * 无法识别的事件统一归一为 `{ type: "unknown"; raw }`，它有自己的判别式，
 * 不污染其余成员的收窄。
 */
export const AGENT_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "bash_execution_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "extension_error",
] as const;

export type KnownAgentEventType = (typeof AGENT_EVENT_TYPES)[number];

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(AGENT_EVENT_TYPES);

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry?: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "bash_execution_update"; id?: string; delta: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: ToolResultPayload }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResultPayload; isError: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: string; result: unknown; aborted: boolean; willRetry?: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "summarization_retry_attempt_start"; source: "compaction" | "branchSummary"; reason?: string }
  | { type: "summarization_retry_finished" }
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
  /** 上游新增或本 SDK 尚未建模的事件；原始对象保留在 raw 里，不丢信息 */
  | { type: "unknown"; raw: unknown };

export function isKnownAgentEventType(type: unknown): type is KnownAgentEventType {
  return typeof type === "string" && KNOWN_EVENT_TYPES.has(type);
}

/**
 * 把一行原始 JSON 归一为 AgentEvent。
 * 识别不了的一律包成 `{ type: "unknown", raw }`，绝不硬转成某个具体成员。
 */
export function toAgentEvent(raw: unknown): AgentEvent {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const type = (raw as { type?: unknown }).type;
    if (isKnownAgentEventType(type)) return raw as AgentEvent;
  }
  return { type: "unknown", raw };
}

// ---------- Extension UI 子协议 ----------

export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
}

export interface ExtensionUiResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}
