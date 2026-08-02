/**
 * 全计划**唯一**的事件转发器（CT-03 / CT-04）。
 *
 * pi 流式输出时每个 token 都会产生一条 message_update，逐条走 IPC 会把渲染
 * 进程主线程打满。这里按 33ms 节拍合批，并折叠「累积型」事件。
 *
 * 两条硬约束：
 *  1. **折叠只吃信封**。collapseEnvelopes 的入参类型锁死为
 *     `PiEnvelope<AgentEvent>[]`，判据读 `env.payload.type` 而不是裸事件的
 *     `.type` —— 否则加了信封之后判据恒为 undefined，折叠悄悄退化成透传，
 *     而单测照样全绿。
 *  2. **dispose 必须真的拆干净**：取消 batch timer、清空队列、摘掉源上的
 *     监听器。旧代际的 33ms timer 没人清，正是 RUN-002 里新会话被上一代
 *     事件污染的通道之一。
 */
import type { AgentEvent } from "@pibuddy/pi-sdk";
import type { PiEnvelope } from "@pibuddy/contract";

/** 合批节拍。约等于 30fps，人眼看不出，主线程压力下降一到两个数量级。 */
export const BATCH_INTERVAL_MS = 33;

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
 * 按 sequence 保序后折叠累积型事件。
 *
 * 本任务实现的是「保序 + 累积快照折叠」版本：message_update 与同一
 * toolCallId 的 tool_execution_update 都携带到目前为止的完整内容，连续多条
 * 只保留最后一条不丢信息。TASK-010 会把它升级成 delta 累加版本。
 */
export function collapseEnvelopes(input: PiEnvelope<AgentEvent>[]): PiEnvelope<AgentEvent>[] {
  // 保序：主进程内 push 顺序本就单调，但代际切换 / 重排后必须以 sequence 为准。
  const ordered = [...input].sort((a, b) => a.sequence - b.sequence);
  const collapsed: PiEnvelope<AgentEvent>[] = [];
  for (const env of ordered) {
    const prev = collapsed[collapsed.length - 1];
    if (!prev) {
      collapsed.push(env);
      continue;
    }
    const type = payloadType(env);
    const prevType = payloadType(prev);
    if (type === "message_update" && prevType === "message_update") {
      collapsed[collapsed.length - 1] = env;
      continue;
    }
    if (
      type === "tool_execution_update" &&
      prevType === "tool_execution_update" &&
      toolCallIdOf(env) === toolCallIdOf(prev)
    ) {
      collapsed[collapsed.length - 1] = env;
      continue;
    }
    collapsed.push(env);
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
    for (const env of batch) target.send(channel, env);
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
