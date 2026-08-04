/**
 * 用量汇总的纯函数（REQ-0001 R5.2）。
 *
 * 输入是 usage:query 返回的按日聚合行，输出「今日 / 近 7 日 / 累计」三档
 * 的 input/output token 与花费。刻意做成无副作用的纯函数：跨月边界、
 * 「近 7 日含今天」这类口径问题只有在这里可以被单测钉死。
 */

/** 汇总的一档：输入 / 输出 token 与花费。 */
export interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageSummary {
  today: UsageBucket;
  last7: UsageBucket;
  total: UsageBucket;
}

/** 汇总只依赖这四个字段，签名收窄以便测试给最小样本。 */
export interface UsageDailyLike {
  day: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** 本地时区的 `YYYY-MM-DD`，与主进程 usage-store 的 localDay 同一口径。 */
export function localDayOf(at: number = Date.now()): string {
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** `day` 往前挪 `n` 天（本地时区语义，用 Date 做进位，跨月跨年都对）。 */
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d + n);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function emptyBucket(): UsageBucket {
  return { inputTokens: 0, outputTokens: 0, cost: 0 };
}

function add(bucket: UsageBucket, row: UsageDailyLike): void {
  bucket.inputTokens += row.inputTokens;
  bucket.outputTokens += row.outputTokens;
  bucket.cost += row.cost;
}

/**
 * 汇总今日 / 近 7 日（含今天，共 7 个自然日）/ 累计。
 *
 * `YYYY-MM-DD` 字符串的字典序即日期序，直接比较，不引入时区换算。
 */
export function summarizeUsage(rows: UsageDailyLike[], today: string): UsageSummary {
  const weekStart = shiftDay(today, -6);
  const summary: UsageSummary = {
    today: emptyBucket(),
    last7: emptyBucket(),
    total: emptyBucket(),
  };
  for (const row of rows) {
    add(summary.total, row);
    if (row.day >= weekStart && row.day <= today) add(summary.last7, row);
    if (row.day === today) add(summary.today, row);
  }
  return summary;
}
