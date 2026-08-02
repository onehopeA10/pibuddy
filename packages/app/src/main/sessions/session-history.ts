/**
 * 向更早历史翻页（CRITICAL-1）——**本地按字节 offset 反向读取，不经 pi RPC**。
 *
 * ## 为什么不能走 RPC
 *
 * rpc.md:694 起的那条取条目命令只有一个 `since` 参数，原文第 696 行写的是
 * "get only entries **strictly after** it"。全协议没有 `before`，也没有
 * `limit` —— 也就是说「往回翻」这件事在 pi 0.83 的协议层根本不存在。
 * 把它改回 RPC 不会报错，只会让「加载更早的消息」永远返回空。
 * 因此本文件**不含任何 pi RPC 调用**，一条都没有。
 *
 * 因此这里直接读 JSONL：它本来就是真相源，而且是**只增不改**的追加日志，
 * 按字节 offset 反向切片是安全的。
 *
 * ## 半行与新鲜度
 *
 *   - `beforeOffset` 是调用方给的字节上界。它多半落在某一行的中间（上一页
 *     的第一行行首就是这次的上界，那当然是行首 —— 但首屏用的是文件长度，
 *     而 pi 可能正写到一半）。被截断的那半行**原样丢弃**并计入
 *     `skippedPartial`，绝不喂给 JSON.parse 去凑一个假的解析失败。
 *   - 读之前重新 statSync 一次，与索引记录的 mtime/size 比对。不一致说明
 *     两次调用之间文件被追加过，此时返回 `stale: true`，由调用方先
 *     syncWorkspace 再重试一次 —— 拿着过期的 offset 去切字节，切出来的
 *     是错位的半行，而那种错误在日志里长得和「会话损坏」一模一样。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { SessionHistoryPage } from "@pibuddy/contract";

/** 反向回溯的块大小。 */
const CHUNK_BYTES = 64 * 1024;

/** 单次调用的字节读取量（仅供单测断言「不是整文件读入」）。 */
let lastReadBytes = 0;

/** 仅供单测：上一次 readEntriesBefore 实际从磁盘读了多少字节。 */
export function __lastReadBytes(): number {
  return lastReadBytes;
}

function readRange(file: string, start: number, end: number): Promise<Buffer> {
  if (end < start) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(file, { start, end });
    stream.on("data", (c) => {
      lastReadBytes += (c as Buffer).length;
      chunks.push(c as Buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export interface ReadEntriesBeforeArgs {
  /** JSONL 文件绝对路径（main 内部标识，绝不跨进程） */
  sourcePath: string;
  /** 字节上界，只返回**完全落在它之前**的完整行 */
  beforeOffset: number;
  limit: number;
  /**
   * 索引里记的新鲜度依据。给了就比对，不一致直接返回 stale。
   * 不给（例如索引刚重建）则跳过比对，按当前磁盘状态尽力返回。
   */
  expect?: { mtimeMs: number; sizeBytes: number };
}

/**
 * 反向读取 `beforeOffset` 之前的最多 `limit` 条完整 entry，按**文件中的
 * 原始先后顺序**返回（最早的在前）。
 *
 * `nextBeforeOffset` 是本页第一条 entry 的行首字节偏移，直接拿去做下一页的
 * `beforeOffset`；已经读到文件头时为 null。
 */
export async function readEntriesBefore(
  args: ReadEntriesBeforeArgs
): Promise<SessionHistoryPage> {
  const { sourcePath, beforeOffset, limit } = args;
  lastReadBytes = 0;

  const empty: SessionHistoryPage = {
    entries: [],
    nextBeforeOffset: null,
    stale: false,
    skippedPartial: 0,
  };

  let st;
  try {
    st = await stat(sourcePath);
  } catch {
    return empty;
  }

  if (args.expect && (args.expect.mtimeMs !== st.mtimeMs || args.expect.sizeBytes !== st.size)) {
    // 索引过期：不猜、不硬读，交回给调用方走 syncWorkspace → 重试一次。
    return { entries: [], nextBeforeOffset: beforeOffset, stale: true, skippedPartial: 0 };
  }

  const upper = Math.min(beforeOffset, st.size);
  if (upper <= 0 || limit <= 0) return empty;

  // 从 upper 往回按块累积，直到攒够 limit 个完整行或者到了文件头。
  // 用 Buffer 而不是字符串拼接：块边界可能把一个 UTF-8 字符劈成两半，
  // 先解码再拼会得到两个替换字符，而那一行从此再也 parse 不出来。
  let regionStart = upper;
  let region = Buffer.alloc(0);
  let newlines: number[] = [];
  for (;;) {
    const nextStart = Math.max(0, regionStart - CHUNK_BYTES);
    const chunk = await readRange(sourcePath, nextStart, regionStart - 1);
    region = Buffer.concat([chunk, region]);
    regionStart = nextStart;

    newlines = [];
    for (let i = 0; i < region.length; i++) {
      if (region[i] === 0x0a) newlines.push(i);
    }
    // regionStart > 0 时，region 里第一个换行符之前的那段是被块边界切开的
    // 左半行，不算完整行。
    const complete = regionStart === 0 ? newlines.length : Math.max(0, newlines.length - 1);
    if (complete >= limit || regionStart === 0) break;
  }

  // 最后一个换行符之后还有字节 = 被 beforeOffset 从中间截断的半行。
  const lastNl = newlines.length > 0 ? newlines[newlines.length - 1] : -1;
  const skippedPartial = lastNl < region.length - 1 ? 1 : 0;

  // 完整行的 [起, 止) 区间（相对 region）。
  const spans: { from: number; to: number }[] = [];
  for (let i = 0; i < newlines.length; i++) {
    const from = i === 0 ? 0 : newlines[i - 1] + 1;
    if (i === 0 && regionStart > 0) continue; // 左半行，丢
    spans.push({ from, to: newlines[i] });
  }

  const taken = spans.slice(Math.max(0, spans.length - limit));
  const entries: { type: string }[] = [];
  for (const span of taken) {
    const text = region.subarray(span.from, span.to).toString("utf8").trim();
    if (!text) continue;
    try {
      entries.push(JSON.parse(text) as { type: string });
    } catch {
      // 单行坏掉只丢这一行：整页因为一行残缺而消失，比少一条难查得多。
    }
  }

  const firstAbs = taken.length > 0 ? regionStart + taken[0].from : 0;
  return {
    entries,
    nextBeforeOffset: firstAbs > 0 ? firstAbs : null,
    stale: false,
    skippedPartial,
  };
}
