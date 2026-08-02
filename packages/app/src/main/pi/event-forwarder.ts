/**
 * 全计划**唯一**的事件转发器（CT-03 / CT-04）。
 *
 * pi 流式输出时每个 token 都会产生一条 message_update，逐条走 IPC 会把渲染
 * 进程主线程打满。这里按 33ms 节拍合批，并折叠「累积型」事件。
 *
 * ## TASK-010：从「保留末帧」升级为「delta 累加」
 *
 * 改造前 message_update 是靠 `message` 全量累积快照渲染的，连续多条只保留
 * 最后一条不丢信息。渲染侧改成按 `assistantMessageEvent.delta` 拼帧之后，
 * 这条折叠规则就从无损优化**退化成静默丢字符** —— 不抛错、不失败类型检查、
 * 只在长回复偶发。因此这里同步改成：
 *
 *   - 只有**同类型、同 contentIndex 的 text_delta / thinking_delta**才合并；
 *   - 合并结果以**末帧为基底**（全量快照 message / partial、信封元数据
 *     sequence / occurredAt 都取最后一帧），只有 delta 是首尾累加；
 *   - text_start / text_end / thinking_start / thinking_end / toolcall_* /
 *     done / error 一律不合并 —— 它们是边界事件，合掉就少一个状态转移。
 *
 * 两条硬约束：
 *  1. **折叠只吃信封**。collapseEnvelopes 的入参类型锁死为
 *     `PiEnvelope<AgentEvent>[]`，判据读 `env.payload.type` 而不是裸事件上的
 *     同名字段 —— 否则加了信封之后判据恒为 undefined，折叠悄悄退化成透传，
 *     而单测照样全绿。
 *  2. **dispose 必须真的拆干净**：取消 batch timer、清空队列、摘掉源上的
 *     监听器。旧代际的 33ms timer 没人清，正是 RUN-002 里新会话被上一代
 *     事件污染的通道之一。
 */
import type { AgentEvent, AssistantMessageEvent } from "@pibuddy/pi-sdk";
import type { PiEnvelope } from "@pibuddy/contract";

/** 合批节拍。约等于 30fps，人眼看不出，主线程压力下降一到两个数量级。 */
export const BATCH_INTERVAL_MS = 33;

/**
 * 可以按 delta 累加的两种增量事件：'text_delta' 与 'thinking_delta'。
 *
 * 刻意只列这两个：toolcall_delta 的 delta 是 JSON 参数片段，拼起来无损但
 * 渲染侧并不消费；text_end / thinking_end 携带的是 content 全量而非增量，
 * 混进来会把「结束」这个状态转移吃掉。
 */
const MERGEABLE_DELTA_TYPES: ReadonlySet<string> = new Set(["text_delta", "thinking_delta"]);

/** 转发目标（生产是 Electron WebContents，测试是最小替身）。 */
export interface ForwarderTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** 事件来源（生产是 PiRpcClient，dispose 时需要把监听器全摘掉）。 */
export interface ForwarderSource {
  removeAllListeners(): unknown;
}

export interface Forwarder {
  push(envelope: PiEnvelope<AgentEvent>): void;
  /** 立即冲刷当前窗口内积压的事件（测试与停止流程使用） */
  flush(): void;
  dispose(): void;
}

function payloadType(env: PiEnvelope<AgentEvent>): string {
  return env.payload?.type ?? "";
}

function toolCallIdOf(env: PiEnvelope<AgentEvent>): string | undefined {
  return (env.payload as { toolCallId?: string } | undefined)?.toolCallId;
}

/**
 * 取信封里的流式增量事件。
 *
 * **判据路径必须是 payload.assistantMessageEvent**：信封先于折叠生成，
 * 直接读信封对象上的同名字段在这里恒为 undefined，折叠会静默退化成透传 ——
 * 性能回归，但不报错、不失败类型检查。
 */
function deltaEventOf(env: PiEnvelope<AgentEvent>): AssistantMessageEvent | undefined {
  const payload = env.payload as { assistantMessageEvent?: AssistantMessageEvent } | undefined;
  if (!payload) return undefined;
  return payload.assistantMessageEvent;
}

/**
 * 相邻两条能合则合，不能合返回 null。
 *
 * 合并结果一律以 `later`（后到的那一帧）为基底展开：
 *   - `message` 与 `assistantMessageEvent.partial` 是**全量累积快照**，
 *     必须取最后一帧，取首帧会把整段回复回退到第一个字符；
 *   - `sequence` / `occurredAt` 同理取最后一帧，否则渲染侧的按通道序号闸门
 *     会把整批当成「序号倒退」丢掉；
 *   - 唯独 `delta` 是增量，必须首尾相接地累加。
 */
function mergeAdjacent(
  earlier: PiEnvelope<AgentEvent>,
  later: PiEnvelope<AgentEvent>
): PiEnvelope<AgentEvent> | null {
  const laterType = payloadType(later);
  const earlierType = payloadType(earlier);

  if (laterType === "message_update" && earlierType === "message_update") {
    const prevDelta = deltaEventOf(earlier);
    const nextDelta = deltaEventOf(later);
    if (!prevDelta || !nextDelta) return null;
    if (prevDelta.type !== nextDelta.type) return null;
    if (!MERGEABLE_DELTA_TYPES.has(nextDelta.type)) return null;
    if (prevDelta.contentIndex !== nextDelta.contentIndex) return null;
    return {
      ...later,
      payload: {
        ...later.payload,
        assistantMessageEvent: {
          ...nextDelta,
          delta: (prevDelta.delta ?? "") + (nextDelta.delta ?? ""),
        },
      } as AgentEvent,
    };
  }

  if (
    laterType === "tool_execution_update" &&
    earlierType === "tool_execution_update" &&
    toolCallIdOf(later) === toolCallIdOf(earlier)
  ) {
    // partialResult 仍是累积快照语义，覆盖式折叠不丢信息。
    return later;
  }

  return null;
}

/**
 * 按 sequence 保序后折叠累积型事件。
 *
 * 入参类型锁死为信封数组：投喂裸 AgentEvent 在 typecheck 阶段就会失败，
 * 从而堵死「单测喂裸事件、生产喂信封」这条静默回归通道。
 */
export function collapseEnvelopes(input: PiEnvelope<AgentEvent>[]): PiEnvelope<AgentEvent>[] {
  // 保序：主进程内 push 顺序本就单调，但代际切换 / 重排后必须以 sequence 为准。
  const ordered = [...input].sort((a, b) => a.sequence - b.sequence);
  const collapsed: PiEnvelope<AgentEvent>[] = [];
  for (const current of ordered) {
    const prev = collapsed[collapsed.length - 1];
    if (!prev) {
      collapsed.push(current);
      continue;
    }
    const merged = mergeAdjacent(prev, current);
    if (merged) {
      collapsed[collapsed.length - 1] = merged;
      continue;
    }
    collapsed.push(current);
  }
  return collapsed;
}

/**
 * 建一个 33ms 合批转发器。
 *
 * `source` 只用于 dispose 时摘监听；转发器自身不订阅任何事件（由 supervisor
 * 把 client 的 event 回调接到 push 上），这样转发器可以脱离 Electron 单测。
 */
export function createForwarder(
  target: ForwarderTarget,
  source: ForwarderSource,
  channel = "pi:event"
): Forwarder {
  let queue: PiEnvelope<AgentEvent>[] = [];
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (disposed || queue.length === 0) {
      queue = [];
      return;
    }
    if (target.isDestroyed()) {
      queue = [];
      return;
    }
    const batch = collapseEnvelopes(queue);
    queue = [];
    for (const item of batch) target.send(channel, item);
  };

  return {
    push(envelope: PiEnvelope<AgentEvent>): void {
      if (disposed) return;
      queue.push(envelope);
      if (!timer) timer = setTimeout(flush, BATCH_INTERVAL_MS);
    },
    flush,
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      queue = [];
      source.removeAllListeners();
    },
  };
}
