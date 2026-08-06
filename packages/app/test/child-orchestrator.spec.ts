import { beforeEach, describe, expect, it, vi } from "vitest";

import { childSpecSchema } from "@pibuddy/contract";

const mocks = vi.hoisted(() => {
  const operations: string[] = [];
  const pool = {
    requestSession: vi.fn((input: { sessionId: string }) => {
      operations.push(`request:${input.sessionId}`);
    }),
    stopSession: vi.fn((sessionId: string) => {
      operations.push(`stop:${sessionId}`);
    }),
  };
  const runtimeHost = {
    setChildEventSink: vi.fn((sink: unknown) => operations.push(`event:${sink === null ? "off" : "on"}`)),
    setChildReadySink: vi.fn((sink: unknown) => operations.push(`ready:${sink === null ? "off" : "on"}`)),
    setChildExitSink: vi.fn((sink: unknown) => operations.push(`exit:${sink === null ? "off" : "on"}`)),
    deliverConfirmed: vi.fn(async () => true),
  };
  return {
    operations,
    pool,
    runtimeHost,
    agentPool: vi.fn(() => pool),
    poolRuntimeHost: vi.fn(() => runtimeHost),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../src/main/agent-pool/pool.js", () => ({
  agentPool: mocks.agentPool,
  poolRuntimeHost: mocks.poolRuntimeHost,
}));

import {
  __resetChildOrchestration,
  childAgent,
  disposeChildOrchestration,
} from "../src/main/child-agent/child-orchestrator.js";

beforeEach(() => {
  __resetChildOrchestration();
  mocks.operations.length = 0;
  vi.clearAllMocks();
});

describe("disposeChildOrchestration", () => {
  it("没有既有 core 时不会仅为 dispose 实例化 core", () => {
    disposeChildOrchestration();
    expect(mocks.agentPool).not.toHaveBeenCalled();
  });

  it("先停止并取消活跃 child，再摘除 runtime sinks", () => {
    const core = childAgent();
    const nodeId = core.createChild(
      null,
      childSpecSchema.parse({ goal: "active", workspaceId: "ws" }),
      0
    ).nodeId;
    mocks.operations.length = 0;

    disposeChildOrchestration();

    expect(core.snapshot().nodes.find((node) => node.nodeId === nodeId)?.status).toBe("cancelled");
    expect(mocks.pool.stopSession).toHaveBeenCalledWith(nodeId);
    expect(mocks.operations).toEqual([
      `stop:${nodeId}`,
      "event:off",
      "ready:off",
      "exit:off",
    ]);
  });
});
