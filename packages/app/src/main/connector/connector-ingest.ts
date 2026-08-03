/**
 * 入站消息的准入守卫（连接器 v1 / CON-101）—— **纯逻辑，不 import electron**。
 *
 * ## 入站是连接器的另一半，也是回环与放大的入口
 *
 * 「外部消息 → 触发 Agent → 回复」这条链路里，同一条外部消息如果被处理两次、
 * 或者 Agent 的回复又被当成一条新的外部消息灌回来，代价不是一条多余的日志，
 * 而是**一轮不会停的自我对话**：Agent 回复 → 平台推送我们自己的回复 → 又触发
 * 一次 Agent → …。因此入站在真正把消息交给 Agent 之前必须连过四道判定：
 *
 *   1. **防回环**：带我们出站标记（`x-pibuddy-connector`）或来自本机器人自己的
 *      消息一律丢弃。这是回环的第一道、也是最关键的一道闸。
 *   2. **去重**：平台会因重试 / 网络抖动重复投递同一条消息（同一 messageId）。
 *      按 messageId 去重，重复的直接丢——「幂等」在这里是**不重复触发 Agent**。
 *   3. **限速**：单个连接器在一个窗口内能触发的 Agent 次数有上界，防一条被刷爆
 *      的 webhook 把后台会话池打满。
 *   4. **尺寸 / 附件上限**：正文与附件都有上限，超了截断或拒——一条几十 MB 的
 *      入站消息不该被原样塞进提示词。
 *
 * ## 为什么按 workspace 隔离
 *
 * 每个连接器实例绑一个 workspace，入站消息带着它自己的 workspaceId 进来。去重
 * 环、限速窗口都按 connectorId 分桶，一个连接器的流量不影响另一个；交给 Agent
 * 时也只落到它绑定的那个 workspace。
 */

/** 单条入站正文上限。超过即拒（截断会丢掉用户可能在意的内容，拒更诚实）。 */
export const MAX_INBOUND_TEXT = 32 * 1024;
/** 单条消息附件数上限。 */
export const MAX_INBOUND_ATTACHMENTS = 8;
/** 单条消息附件字节总和上限。 */
export const MAX_INBOUND_ATTACHMENT_BYTES = 16 * 1024 * 1024;
/** 限速窗口长度（ms）。 */
export const INGEST_RATE_WINDOW_MS = 60_000;
/** 一个窗口内单个连接器最多触发的 Agent 次数。 */
export const INGEST_RATE_LIMIT = 30;
/** 去重环每个连接器记住的最近 messageId 数。 */
export const DEDUP_RING = 512;

/** 一条规范化后的入站消息。 */
export interface InboundMessage {
  connectorId: string;
  /** 平台侧消息 id，去重键 */
  messageId: string;
  /** 该连接器绑定的 workspace（隔离键） */
  workspaceId: string;
  /**
   * 这条消息是不是我们自己发出去的（带我们的出站标记 / 来自本机器人）。
   * 由适配层判定后填进来——防回环判据只认这一个布尔，不在守卫里猜。
   */
  fromSelf: boolean;
  text: string;
  attachmentCount: number;
  attachmentBytes: number;
  /** 到达时间（ms） */
  at: number;
}

export type IngestReason = "loop" | "duplicate" | "rate" | "oversize";

export interface IngestVerdict {
  accepted: boolean;
  /** 被拒时的原因分类；接受时为 null */
  reason: IngestReason | null;
  /** 给审计 / 界面的一句可读说明 */
  detail: string;
}

/**
 * 有状态的入站守卫。去重环与限速窗口都按 connectorId 分桶。
 *
 * 状态全在内存里（禁用能力时 `disposeConnectorResources` 会清掉），因此它是
 * `runtime.teardown: ["listener"]` 里那份「还占着内存」的东西之一。
 */
export class IngestGuard {
  /** connectorId → 最近见过的 messageId（有序，超过 DEDUP_RING 从头淘汰）。 */
  private readonly seen = new Map<string, string[]>();
  /** connectorId → 最近触发时间戳（滑动窗口）。 */
  private readonly hits = new Map<string, number[]>();

  /**
   * 判定一条入站消息能否交给 Agent。**只读判定不改状态**由 accept 分开：
   * 一条消息可能在多道闸上被拒，只有真正接受时才该占用去重环与限速额度。
   */
  evaluate(msg: InboundMessage): IngestVerdict {
    // 关 1：防回环。放在最前——我们自己发出去的消息连去重环都不该占。
    if (msg.fromSelf) {
      return { accepted: false, reason: "loop", detail: "这是本连接器自己发出的消息，已忽略（防回环）" };
    }

    // 关 2：去重。
    const ring = this.seen.get(msg.connectorId) ?? [];
    if (ring.includes(msg.messageId)) {
      return { accepted: false, reason: "duplicate", detail: "重复投递的消息，已忽略（去重）" };
    }

    // 关 3：尺寸 / 附件上限（放在限速之前——一条超大消息不该占用限速额度后再被拒）。
    if (msg.text.length > MAX_INBOUND_TEXT) {
      return { accepted: false, reason: "oversize", detail: `正文超过上限（${MAX_INBOUND_TEXT} 字）` };
    }
    if (msg.attachmentCount > MAX_INBOUND_ATTACHMENTS) {
      return { accepted: false, reason: "oversize", detail: `附件数超过上限（${MAX_INBOUND_ATTACHMENTS}）` };
    }
    if (msg.attachmentBytes > MAX_INBOUND_ATTACHMENT_BYTES) {
      return { accepted: false, reason: "oversize", detail: "附件总大小超过上限" };
    }

    // 关 4：限速。
    const cutoff = msg.at - INGEST_RATE_WINDOW_MS;
    const recent = (this.hits.get(msg.connectorId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= INGEST_RATE_LIMIT) {
      return {
        accepted: false,
        reason: "rate",
        detail: `超过 ${INGEST_RATE_LIMIT} 条/${INGEST_RATE_WINDOW_MS}ms，已限流`,
      };
    }

    return { accepted: true, reason: null, detail: "已接受，交给 Agent" };
  }

  /**
   * 判定并在接受时记账（占去重环 + 限速额度）。返回同一个裁决。
   *
   * 这是入站路径实际该调用的入口：evaluate 是纯判定（便于单测反复问同一条），
   * accept 才推进状态。
   */
  accept(msg: InboundMessage): IngestVerdict {
    const verdict = this.evaluate(msg);
    if (!verdict.accepted) return verdict;

    const ring = this.seen.get(msg.connectorId) ?? [];
    ring.push(msg.messageId);
    if (ring.length > DEDUP_RING) ring.splice(0, ring.length - DEDUP_RING);
    this.seen.set(msg.connectorId, ring);

    const cutoff = msg.at - INGEST_RATE_WINDOW_MS;
    const recent = (this.hits.get(msg.connectorId) ?? []).filter((t) => t > cutoff);
    recent.push(msg.at);
    this.hits.set(msg.connectorId, recent);

    return verdict;
  }

  /** 清掉某个连接器的入站状态（删除连接器时）。 */
  forget(connectorId: string): void {
    this.seen.delete(connectorId);
    this.hits.delete(connectorId);
  }

  /** 清空全部入站状态（能力禁用 / 退出时）。 */
  reset(): void {
    this.seen.clear();
    this.hits.clear();
  }
}
