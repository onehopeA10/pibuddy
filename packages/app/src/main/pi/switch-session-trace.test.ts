import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@pibuddy/pi-sdk";
import {
  SWITCH_TRACE_STAGE_CAP,
  attachSwitchTrace,
  createSwitchTrace,
  eventTypeOf,
} from "./switch-session-trace.js";

describe("eventTypeOf", () => {
  it("已知事件用自身 type", () => {
    expect(eventTypeOf({ type: "agent_settled" })).toBe("agent_settled");
  });

  it("unknown 事件露出 raw.type，便于核对 session_start 是否上了 RPC 流", () => {
    expect(eventTypeOf({ type: "unknown", raw: { type: "session_start", reason: "resume" } })).toBe(
      "session_start"
    );
  });

  it("没有 raw.type 时仍记 unknown", () => {
    expect(eventTypeOf({ type: "unknown", raw: { foo: 1 } })).toBe("unknown");
  });
});

describe("createSwitchTrace", () => {
  it("两次 session_start 记 duplicate，并保留相对时间戳", () => {
    let clock = 1000;
    const trace = createSwitchTrace(() => clock);
    trace.observe({ type: "unknown", raw: { type: "session_start" } });
    clock = 1400;
    trace.observe({ type: "unknown", raw: { type: "session_start" } });
    const summary = trace.summary();
    expect(summary.sessionStartCount).toBe(2);
    expect(summary.initHint).toBe("duplicate_session_start");
    expect(summary.stages).toEqual([
      { t: 0, type: "session_start" },
      { t: 400, type: "session_start" },
    ]);
  });

  it("agent_settled / agent_end 记进收尾计数", () => {
    const trace = createSwitchTrace();
    trace.observe({ type: "agent_end", messages: [] });
    trace.observe({ type: "agent_settled" });
    const summary = trace.summary();
    expect(summary.teardownEventCount).toBe(2);
    expect(summary.sessionStartCount).toBe(0);
    expect(summary.initHint).toBe("session_start_not_on_rpc_stream");
  });

  it("阶段列表有上限", () => {
    const trace = createSwitchTrace();
    for (let i = 0; i < SWITCH_TRACE_STAGE_CAP + 5; i += 1) {
      trace.observe({ type: "agent_settled" });
    }
    const summary = trace.summary();
    expect(summary.eventCount).toBe(SWITCH_TRACE_STAGE_CAP + 5);
    expect(summary.stages).toHaveLength(SWITCH_TRACE_STAGE_CAP);
  });
});

describe("attachSwitchTrace", () => {
  it("stop 之后不再记账", () => {
    const bus = new EventEmitter();
    const attached = attachSwitchTrace(bus);
    bus.emit("event", { type: "agent_settled" } satisfies AgentEvent);
    const first = attached.stop();
    bus.emit("event", { type: "agent_settled" } satisfies AgentEvent);
    expect(first.eventCount).toBe(1);
    expect(first.teardownEventCount).toBe(1);
  });
});
