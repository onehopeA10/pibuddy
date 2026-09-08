/**
 * 切换会话的分段观测（不改内置 Pi）。
 *
 * switch_session 在 Pi 里是一整段 RPC：钩子 → 打开目标 → 停旧会话 →
 * 关钩子 → createRuntime → bindExtensions。stdout 上看不到 session_start
 * 这类扩展钩子，但能看到 agent_settled / extension_error，以及万一漏到
 * JSONL 的 unknown.type。这里只记账，不解释因果。
 */
import type { AgentEvent } from "@pibuddy/pi-sdk";

/** 记进日志的事件条数上限，避免一次切换把诊断日志撑爆。 */
export const SWITCH_TRACE_STAGE_CAP = 40;

const SESSION_START_TYPES = new Set(["session_start"]);
const RESOURCES_DISCOVER_TYPES = new Set(["resources_discover"]);
const TEARDOWN_TYPES = new Set(["agent_settled", "agent_end", "session_shutdown"]);

export interface SwitchTraceStage {
  t: number;
  type: string;
}

export interface SwitchTraceSummary {
  eventCount: number;
  eventTypes: Record<string, number>;
  sessionStartCount: number;
  resourcesDiscoverCount: number;
  teardownEventCount: number;
  extensionErrorCount: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
  initHint:
    | "duplicate_session_start"
    | "single_session_start"
    | "session_start_not_on_rpc_stream";
  stages: SwitchTraceStage[];
}

export interface SwitchTrace {
  observe(event: AgentEvent): void;
  summary(): SwitchTraceSummary;
}

export function eventTypeOf(event: AgentEvent): string {
  if (event.type !== "unknown") return event.type;
  const raw = event.raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const type = (raw as { type?: unknown }).type;
    if (typeof type === "string" && type.length > 0) return type;
  }
  return "unknown";
}

export function createSwitchTrace(now: () => number = Date.now): SwitchTrace {
  const startedAt = now();
  const eventTypes: Record<string, number> = {};
  const stages: SwitchTraceStage[] = [];
  let eventCount = 0;
  let sessionStartCount = 0;
  let resourcesDiscoverCount = 0;
  let teardownEventCount = 0;
  let extensionErrorCount = 0;
  let firstEventMs: number | null = null;
  let lastEventMs: number | null = null;

  return {
    observe(event: AgentEvent): void {
      const type = eventTypeOf(event);
      const t = Math.max(0, now() - startedAt);
      eventCount += 1;
      eventTypes[type] = (eventTypes[type] ?? 0) + 1;
      if (firstEventMs === null) firstEventMs = t;
      lastEventMs = t;
      if (SESSION_START_TYPES.has(type)) sessionStartCount += 1;
      if (RESOURCES_DISCOVER_TYPES.has(type)) resourcesDiscoverCount += 1;
      if (TEARDOWN_TYPES.has(type)) teardownEventCount += 1;
      if (type === "extension_error") extensionErrorCount += 1;
      if (stages.length < SWITCH_TRACE_STAGE_CAP) stages.push({ t, type });
    },
    summary(): SwitchTraceSummary {
      return {
        eventCount,
        eventTypes,
        sessionStartCount,
        resourcesDiscoverCount,
        teardownEventCount,
        extensionErrorCount,
        firstEventMs,
        lastEventMs,
        initHint:
          sessionStartCount >= 2
            ? "duplicate_session_start"
            : sessionStartCount === 1
              ? "single_session_start"
              : "session_start_not_on_rpc_stream",
        stages,
      };
    },
  };
}

export function attachSwitchTrace(client: {
  on(event: "event", listener: (e: AgentEvent) => void): unknown;
  off(event: "event", listener: (e: AgentEvent) => void): unknown;
}): { stop: () => SwitchTraceSummary } {
  const trace = createSwitchTrace();
  const onEvent = (event: AgentEvent): void => {
    trace.observe(event);
  };
  client.on("event", onEvent);
  return {
    stop(): SwitchTraceSummary {
      client.off("event", onEvent);
      return trace.summary();
    },
  };
}
