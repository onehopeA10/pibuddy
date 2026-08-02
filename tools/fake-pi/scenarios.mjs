/**
 * fake Pi RPC 进程的场景数据。
 *
 * 事件形状以 pi 自身 docs/rpc.md 的 "Events" 章节为准
 * （@earendil-works/pi-coding-agent 0.83.0，docs/rpc.md）。
 * 测试与 fixture 共用这里的常量，避免两侧硬编码字符串各自漂移。
 */

/** 全部支持的场景字面量。argv 传入的 --scenario 必须命中其一。 */
export const SCENARIOS = [
  "normal",
  "malformed-json",
  "timeout",
  "stderr-noise",
  "exit-immediately",
  "crash-mid-stream",
  "extension-ui",
  "stale-generation",
  "oversized-line",
];

/** normal 场景吐出的文本增量，拼接后即最终回复。 */
export const NORMAL_TEXT_DELTAS = ["你好", "，", "世界"];
export const NORMAL_TEXT = NORMAL_TEXT_DELTAS.join("");

/** normal 场景吐出的 thinking 增量。 */
export const NORMAL_THINKING_DELTAS = ["先看看目录", "……"];

/** normal 场景的 tool call 卡片信息。 */
export const NORMAL_TOOL_CALL_ID = "call_fake_001";
export const NORMAL_TOOL_NAME = "bash";
export const NORMAL_TOOL_ARGS = { command: "ls -la" };
export const NORMAL_TOOL_OUTPUT = "total 0\n";

/** malformed-json 场景故意写出的截断行（不是合法 JSON）。 */
export const MALFORMED_LINE = '{"type":"message_update"';

/** oversized-line 场景单行 JSON 的目标字节数。 */
export const OVERSIZED_BYTES = 16 * 1024 * 1024;

/** stale-generation 场景在 abort 响应之后延迟多久再吐出旧代际事件。 */
export const STALE_DELAY_MS = 300;

/** crash-mid-stream 场景在吐出几个增量后崩溃，退出码固定为 1。 */
export const CRASH_EXIT_CODE = 1;

/** extension-ui 场景发出的 select 请求 id。 */
export const EXTENSION_UI_REQUEST_ID = "ui-req-1";

/**
 * normal 场景的完整事件序列（不含 response）。
 * 覆盖：流式文本增量 / thinking 折叠 / tool call 卡片三类 UI 回归判定点。
 */
export function normalEventSequence() {
  const partial = { role: "assistant", content: [] };
  const events = [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: partial },
    mu({ type: "thinking_start", contentIndex: 0, partial }),
  ];
  for (const delta of NORMAL_THINKING_DELTAS) {
    events.push(mu({ type: "thinking_delta", contentIndex: 0, delta, partial }));
  }
  events.push(
    mu({
      type: "thinking_end",
      contentIndex: 0,
      content: NORMAL_THINKING_DELTAS.join(""),
      partial,
    }),
    mu({ type: "text_start", contentIndex: 1, partial })
  );
  for (const delta of NORMAL_TEXT_DELTAS) {
    events.push(mu({ type: "text_delta", contentIndex: 1, delta, partial }));
  }
  events.push(
    mu({ type: "text_end", contentIndex: 1, content: NORMAL_TEXT, partial }),
    mu({
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: {
        id: NORMAL_TOOL_CALL_ID,
        name: NORMAL_TOOL_NAME,
        args: NORMAL_TOOL_ARGS,
      },
      partial,
    }),
    {
      type: "tool_execution_start",
      toolCallId: NORMAL_TOOL_CALL_ID,
      toolName: NORMAL_TOOL_NAME,
      args: NORMAL_TOOL_ARGS,
    },
    {
      type: "tool_execution_end",
      toolCallId: NORMAL_TOOL_CALL_ID,
      toolName: NORMAL_TOOL_NAME,
      args: NORMAL_TOOL_ARGS,
      result: { content: [{ type: "text", text: NORMAL_TOOL_OUTPUT }] },
    },
    { type: "message_end", message: partial },
    { type: "turn_end", message: partial, toolResults: [] },
    { type: "agent_end", messages: [partial], willRetry: false },
    { type: "agent_settled" }
  );
  return events;
}

/** 包一层 message_update 信封。 */
function mu(assistantMessageEvent) {
  return {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent,
  };
}
