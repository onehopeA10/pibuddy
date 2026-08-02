import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  createEnvelopeSequencer,
  createSequenceGate,
  parseEnvelope,
  wrapEnvelope,
} from "../src/envelope.js";

/**
 * envelope 的关键路径断言（不做穷举矩阵）：
 *   1. 未知协议版本 fail closed
 *   2. 缺字段 fail closed
 *   3. sequence 非单调被闸门拒绝
 *   4. wrapEnvelope 产出的信封能被 parseEnvelope 接受（往返闭合）
 */

const ctx = {
  workspaceId: "ws-1",
  sessionId: "sess-1",
  runtimeId: "rt-1",
  generation: 3,
};

function validRaw(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: "ws-1",
    sessionId: "sess-1",
    runtimeId: "rt-1",
    generation: 3,
    sequence: 7,
    occurredAt: 1_700_000_000_000,
    payload: { type: "agent_start" },
  };
}

describe("parseEnvelope", () => {
  it("接受本版本的合法信封", () => {
    const result = parseEnvelope(validRaw());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.sequence).toBe(7);
      expect(result.envelope.payload).toEqual({ type: "agent_start" });
    }
  });

  it("未知协议版本 fail closed，且不进入结构校验", () => {
    const result = parseEnvelope({ ...validRaw(), protocolVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("protocol-version-mismatch");
  });

  it("缺 protocolVersion 也按版本不匹配拒绝（而不是当成 v1 放行）", () => {
    const raw = validRaw();
    delete raw.protocolVersion;
    const result = parseEnvelope(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("protocol-version-mismatch");
  });

  it("缺 sequence 字段时拒绝", () => {
    const raw = validRaw();
    delete raw.sequence;
    const result = parseEnvelope(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed-envelope");
      expect(result.detail).toContain("sequence");
    }
  });

  it("非对象输入被拒绝", () => {
    expect(parseEnvelope(null).ok).toBe(false);
    expect(parseEnvelope("x").ok).toBe(false);
    expect(parseEnvelope([]).ok).toBe(false);
  });
});

describe("wrapEnvelope / createEnvelopeSequencer", () => {
  it("包出来的信封能被 parseEnvelope 接受，8 个字段齐全", () => {
    const env = wrapEnvelope(ctx, 0, { type: "agent_start" }, 1_700_000_000_000);
    expect(Object.keys(env).sort()).toEqual(
      [
        "generation",
        "occurredAt",
        "payload",
        "protocolVersion",
        "runtimeId",
        "sequence",
        "sessionId",
        "workspaceId",
      ].sort()
    );
    expect(parseEnvelope(env).ok).toBe(true);
  });

  it("sequencer 产出的序号从 0 起单调递增", () => {
    const seq = createEnvelopeSequencer(ctx);
    expect([seq.next(1).sequence, seq.next(2).sequence, seq.next(3).sequence]).toEqual([0, 1, 2]);
  });
});

describe("createSequenceGate", () => {
  it("拒绝回退与重复的序号，代际切换后重新计数", () => {
    const gate = createSequenceGate();
    const at = (generation: number, sequence: number) =>
      wrapEnvelope({ ...ctx, generation }, sequence, null, 0);

    expect(gate(at(3, 0))).toBe(true);
    expect(gate(at(3, 1))).toBe(true);
    // 上一代迟到事件 / 重放
    expect(gate(at(3, 1))).toBe(false);
    expect(gate(at(3, 0))).toBe(false);
    // 新代际独立计数
    expect(gate(at(4, 0))).toBe(true);
  });
});
