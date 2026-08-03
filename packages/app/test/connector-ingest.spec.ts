import { describe, expect, it } from "vitest";

/**
 * 入站准入守卫的可证伪判据（连接器 v1 / CON-101）。
 *
 * 四道关每一道都做对拍（把触发条件真的制造出来 → 拒；换成正常消息 → 收），
 * 而不是断言某个函数被调用：
 *
 *   - **防回环**：带自我标记的消息被丢，否则一条 Agent 回复会自我循环。
 *   - **去重**：同一 messageId 第二次投递被丢（accept 才占去重环）。
 *   - **限速**：一个连接器在窗口内超额被丢，换个连接器 / 过了窗口又能收。
 *   - **附件 / 尺寸上限**：超限被拒。
 */
import {
  IngestGuard,
  INGEST_RATE_LIMIT,
  MAX_INBOUND_ATTACHMENTS,
  MAX_INBOUND_TEXT,
  type InboundMessage,
} from "../src/main/connector/connector-ingest.js";

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    connectorId: "c1",
    messageId: "m1",
    workspaceId: "ws1",
    fromSelf: false,
    text: "hi",
    attachmentCount: 0,
    attachmentBytes: 0,
    at: 1_000_000,
    ...over,
  };
}

describe("防回环", () => {
  it("带自我标记（fromSelf）的消息被丢，且不占去重环", () => {
    const g = new IngestGuard();
    const self = g.accept(msg({ fromSelf: true, messageId: "loop" }));
    expect([self.accepted, self.reason]).toEqual([false, "loop"]);
    // 对拍：同一个 messageId 换成非自我消息，应当被接受（说明上面那条没占去重环）
    const real = g.accept(msg({ fromSelf: false, messageId: "loop" }));
    expect(real.accepted).toBe(true);
  });
});

describe("去重", () => {
  it("同一 messageId 第二次投递被丢；不同 messageId 放行", () => {
    const g = new IngestGuard();
    expect(g.accept(msg({ messageId: "a" })).accepted).toBe(true);
    const dup = g.accept(msg({ messageId: "a" }));
    expect([dup.accepted, dup.reason]).toEqual([false, "duplicate"]);
    expect(g.accept(msg({ messageId: "b" })).accepted).toBe(true);
  });

  it("forget 之后同一 messageId 又能收（删除连接器 → 状态清空）", () => {
    const g = new IngestGuard();
    g.accept(msg({ messageId: "a" }));
    g.forget("c1");
    expect(g.accept(msg({ messageId: "a" })).accepted).toBe(true);
  });
});

describe("限速", () => {
  it("窗口内超额被丢，另一个连接器不受影响", () => {
    const g = new IngestGuard();
    for (let i = 0; i < INGEST_RATE_LIMIT; i++) {
      expect(g.accept(msg({ messageId: `m${i}`, at: 1_000_000 + i })).accepted).toBe(true);
    }
    const over = g.accept(msg({ messageId: "over", at: 1_000_100 }));
    expect([over.accepted, over.reason]).toEqual([false, "rate"]);
    // 另一个连接器有自己的窗口
    expect(g.accept(msg({ connectorId: "c2", messageId: "x", at: 1_000_100 })).accepted).toBe(true);
  });

  it("对拍：过了窗口，同一连接器又能收", () => {
    const g = new IngestGuard();
    for (let i = 0; i < INGEST_RATE_LIMIT; i++) {
      g.accept(msg({ messageId: `m${i}`, at: 1_000_000 + i }));
    }
    // 窗口是 60s，跨过它之后旧的时间戳全部出窗
    const later = g.accept(msg({ messageId: "later", at: 1_000_000 + 60_001 }));
    expect(later.accepted).toBe(true);
  });
});

describe("尺寸 / 附件上限", () => {
  it("正文超长被拒", () => {
    const g = new IngestGuard();
    const v = g.accept(msg({ text: "x".repeat(MAX_INBOUND_TEXT + 1) }));
    expect([v.accepted, v.reason]).toEqual([false, "oversize"]);
  });

  it("附件数超限被拒", () => {
    const g = new IngestGuard();
    const v = g.accept(msg({ attachmentCount: MAX_INBOUND_ATTACHMENTS + 1 }));
    expect([v.accepted, v.reason]).toEqual([false, "oversize"]);
  });
});
