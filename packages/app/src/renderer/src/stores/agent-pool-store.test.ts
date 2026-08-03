/**
 * agent-pool store 的单测（AGT-101）。
 *
 * 钉两件事：
 *   1. **snapshot + sequence 订阅**：晚到的旧快照被序号闸门丢弃，只保留最新的
 *      全量真相。这是与 app store 同源的丢弃规则（`shouldAcceptEnvelope`），
 *      对拍：把闸门去掉 → 旧快照会覆盖新快照，`droppedSnapshots` 恒为 0 且
 *      sessions 回退。
 *   2. **只读投影**：applySnapshot 原样承载主进程的真相，不本地臆造状态。
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  POOL_ENVELOPE_GENERATION,
  POOL_ENVELOPE_ID,
  type PiEnvelope,
  type PoolSnapshot,
} from "@pibuddy/contract";
import { useAgentPoolStore } from "./agent-pool.js";

function snapshot(sequence: number, sessionIds: string[]): PoolSnapshot {
  return {
    sequence,
    caps: { maxConcurrent: 4, maxPerWorkspace: 3, memoryCeilingMb: 1600, costCeilingUsd: 20 },
    sessions: sessionIds.map((id) => ({
      sessionId: id,
      workspaceId: "ws",
      runtimeId: `rt-${id}`,
      generation: 1,
      runState: "background" as const,
      listState: "idle" as const,
      unread: false,
      memoryMb: 0,
      costUsd: 0,
      crashCount: 0,
      lastActivityAt: 0,
      queued: false,
    })),
    activeCount: sessionIds.length,
    queuedCount: 0,
    totalMemoryMb: 0,
    totalCostUsd: 0,
    inbox: [],
  };
}

function envelope(snap: PoolSnapshot): PiEnvelope<PoolSnapshot> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: POOL_ENVELOPE_ID,
    sessionId: POOL_ENVELOPE_ID,
    runtimeId: POOL_ENVELOPE_ID,
    generation: POOL_ENVELOPE_GENERATION,
    sequence: snap.sequence,
    occurredAt: snap.sequence,
    payload: snap,
  };
}

describe("agent-pool store：snapshot + sequence 订阅", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("较新的快照被采纳，晚到的旧快照被序号闸门丢弃", () => {
    const store = useAgentPoolStore();
    store.acceptEnvelope(envelope(snapshot(1, ["A"])));
    expect(store.sessions.map((s) => s.sessionId)).toEqual(["A"]);

    store.acceptEnvelope(envelope(snapshot(3, ["A", "B"])));
    expect(store.sessions.map((s) => s.sessionId)).toEqual(["A", "B"]);

    // 序号回退（旧快照迟到）→ 丢弃，不回退列表。
    store.acceptEnvelope(envelope(snapshot(2, ["A"])));
    expect(store.sessions.map((s) => s.sessionId)).toEqual(["A", "B"]);
    expect(store.droppedSnapshots).toBe(1);
  });

  it("坏信封被丢弃并计数，不污染状态", () => {
    const store = useAgentPoolStore();
    store.acceptEnvelope(envelope(snapshot(1, ["A"])));
    store.acceptEnvelope({ not: "an envelope" });
    expect(store.droppedSnapshots).toBe(1);
    expect(store.sessions.map((s) => s.sessionId)).toEqual(["A"]);
  });

  it("派生量：未读会话与等待授权计数", () => {
    const store = useAgentPoolStore();
    const snap = snapshot(1, ["A", "B"]);
    snap.sessions[0].unread = true;
    snap.sessions[1].listState = "waiting_permission";
    store.applySnapshot(snap);
    expect(store.unreadSessions.map((s) => s.sessionId)).toEqual(["A"]);
    expect(store.waitingPermissionCount).toBe(1);
  });
});
