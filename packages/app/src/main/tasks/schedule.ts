/**
 * 计划 → 下一次绝对运行时刻的解析（Durable Tasks 的核心难点）。
 *
 * ## 为什么存墙钟 + 时区，而不是一个绝对 epoch
 *
 * 「每天 9:00」在 DST 边界上对应的 epoch 每年变两次。把它冻成一个绝对时刻，
 * 一到切换那天就错点。因此 `daily` / `weekly` / `cron` 存的是墙钟时间 +
 * IANA 时区，绝对时刻在**每次调度时**按时区重新解出来。
 *
 * ## 时区换算不引第三方库
 *
 * 本仓「未新增任何运行时依赖」是一贯约束。时区换算全部走 Node 自带的
 * `Intl.DateTimeFormat`（full-ICU，Electron / Node 默认带）：`zonedParts` 把
 * 一个 epoch 投影成某时区的墙钟分量，`wallToEpoch` 反向解出 epoch，并显式
 * 处理 DST 的两种病态：
 *
 *   - **gap（春季前跳）**：某个墙钟时间不存在（2:30 被跳过）。策略：滚到
 *     紧随其后的有效时刻（不会永远卡住，也不会静默丢掉这次运行）。
 *   - **overlap（秋季回拨）**：某个墙钟时间出现两次（1:30 来两遍）。策略：
 *     取**较早**的那一次，且只算一次——绝不因为回拨就把同一个墙钟槽位跑两遍。
 *
 * 这两条策略都是可证伪的：DST 测试用 America/New_York 的真实切换日制造那个
 * 时序，断言解出来的 epoch 是具体的哪一个，而不是「函数被调用了」。
 */
import type { TaskSchedule } from "@pibuddy/contract";

import { cronDayMatches, cronMatches, parseCron, type CronExpr } from "./cron.js";

/** 某时区墙钟的分量。 */
export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** 0-59 */
  second: number;
  /** 0=周日 … 6=周六 */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** DateTimeFormat 实例按时区缓存：每次调度都建一个新实例会很快成为热点。 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** 一个 epoch 在某时区里的墙钟分量。非法时区会让 Intl 抛错——那是配置错误，不该吞。 */
export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
  };
}

/**
 * 某时区在某个瞬间相对 UTC 的偏移（ms）。
 *
 * 把该瞬间的墙钟分量**当作 UTC** 反算回一个 epoch，与真实 epoch 的差就是
 * 偏移。北京（UTC+8）恒为 +8h；纽约在 EST 是 -5h、EDT 是 -4h。
 */
function tzOffsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - epochMs;
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface WallToEpochResult {
  epoch: number;
  /** 该墙钟时间在这个时区是否真实存在（DST gap 时为 false） */
  exists: boolean;
}

/** 某 epoch 的墙钟分量是否等于目标墙钟（到秒）。 */
function partsMatch(p: ZonedParts, w: WallTime): boolean {
  return (
    p.year === w.year &&
    p.month === w.month &&
    p.day === w.day &&
    p.hour === w.hour &&
    p.minute === w.minute &&
    p.second === w.second
  );
}

/**
 * 墙钟时间 + 时区 → epoch，显式处理 DST 的 gap 与 overlap。
 *
 * 做法：先把墙钟分量当作 UTC 得到一个猜测，再用该猜测处的偏移把它拉回来，
 * 迭代一次覆盖偏移在猜测点与候选点之间发生变化的情形（DST 边界）。
 *   - 两个候选都成立 ⇒ overlap（回拨），取较早；
 *   - 只有一个成立 ⇒ 唯一解；
 *   - 都不成立 ⇒ gap（前跳），滚到紧随其后的有效时刻。
 */
export function wallToEpoch(w: WallTime, timeZone: string): WallToEpochResult {
  const guessUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const off1 = tzOffsetMs(guessUtc, timeZone);
  const cand1 = guessUtc - off1;
  const off2 = tzOffsetMs(cand1, timeZone);
  const cand2 = guessUtc - off2;

  const c1ok = partsMatch(zonedParts(cand1, timeZone), w);
  const c2ok = partsMatch(zonedParts(cand2, timeZone), w);

  if (c1ok && c2ok) {
    // 唯一（cand1===cand2）或 overlap（回拨，取较早那一次）。
    return { epoch: Math.min(cand1, cand2), exists: true };
  }
  if (c1ok) return { epoch: cand1, exists: true };
  if (c2ok) return { epoch: cand2, exists: true };

  // gap：这个墙钟时间被 DST 前跳吃掉了（2:30 在春季前跳那天不存在）。滚到
  // 紧随其后的有效时刻——两个候选里 epoch 较大的那个，其本地时间正是「原墙钟
  // + DST 跳幅」（2:30 → 3:30），即 gap 之后的第一个对应时刻。绝不静默丢掉。
  return { epoch: Math.max(cand1, cand2), exists: false };
}

/** 纯日历加天（在 UTC 上做，y/m/d 与时区无关）。 */
function addCalendarDays(w: { year: number; month: number; day: number }, days: number): {
  year: number;
  month: number;
  day: number;
} {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 某个日历日期是星期几（0=周日）。日期本身与时区无关。 */
function weekdayOf(w: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

function parseHm(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(":");
  return { hour: Number(h), minute: Number(m) };
}

/**
 * daily / weekly 的下一次：从 fromMs 所在日历日起逐日扫描，命中墙钟时间且
 * 严格晚于 fromMs 的第一个 epoch。
 *
 * weekdays 为 null 表示每天（daily）；否则只在集合内的星期几触发（weekly）。
 * 扫描上限 370 天足以覆盖「weekly 只选了一个很靠后的星期几 + 跨闰年」。
 */
function nextDailyOccurrence(
  fromMs: number,
  timeZone: string,
  time: string,
  weekdays: ReadonlySet<number> | null
): number | null {
  const { hour, minute } = parseHm(time);
  const start = zonedParts(fromMs, timeZone);
  let cursor = { year: start.year, month: start.month, day: start.day };
  for (let i = 0; i <= 370; i++) {
    if (weekdays === null || weekdays.has(weekdayOf(cursor))) {
      const { epoch } = wallToEpoch({ ...cursor, hour, minute, second: 0 }, timeZone);
      if (epoch > fromMs) return epoch;
    }
    cursor = addCalendarDays(cursor, 1);
  }
  return null;
}

/** 墙钟分钟（秒恒为 0，cron 的精度）。 */
interface WallMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** 墙钟分钟 +1，进位走纯日历运算（与时区无关）。 */
function addWallMinute(w: WallMinute): WallMinute {
  if (w.minute < 59) return { ...w, minute: w.minute + 1 };
  if (w.hour < 23) return { ...w, hour: w.hour + 1, minute: 0 };
  return { ...addCalendarDays(w, 1), hour: 0, minute: 0 };
}

/** 同一时区内比较墙钟先后用的伪 epoch（仅作全序键，不是真实时刻）。 */
function wallKey(w: WallMinute): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
}

/**
 * cron 的下一次：在**墙钟空间**逐分钟推进（与 daily 的逐日墙钟扫描同构），
 * 命中经 `wallToEpoch` 归一成 epoch——gap / overlap 策略因此与 daily 共用
 * 同一处实现，语义不再分叉：
 *
 *   - gap（春季前跳）里的墙钟分钟（`30 2 * * *` 的 2:30 在切换日不存在）
 *     不再被静默跳过，而是与 daily 一样补偿到「原墙钟 + 跳幅」（3:30）。
 *     补偿时刻不立即返回：gap 结束到补偿时刻之间的**真实**命中分钟（若有）
 *     更早，取两者中 epoch 较小者；同一时刻只算一次。
 *   - overlap（秋季回拨）取较早一次；fromMs 已过较早一次时，同一墙钟槽位
 *     不在回拨后的第二遍重跑（`epoch > fromMs` 判到的是归一后的较早时刻）。
 *
 * 不做「逐分钟 +1 一直扫到匹配」（Feb 30 那种永不匹配的表达式会扫穷）：
 * 先按字段跳（月不符跳到下月 1 号 0 点、日不符跳到次日 0 点、时不符跳到
 * 次时 0 分），把迭代次数压到几百量级；仍设一个安全上限，扫不到就返回 null
 * （表现为「这条任务没有下一次运行」，而不是卡住调度线程）。墙钟扫描的
 * 非命中分钟不再需要 Intl 投影（旧的 epoch 扫描每分钟一次 zonedParts），
 * 只有命中分钟才做时区换算。
 */
function nextCronOccurrence(fromMs: number, timeZone: string, expr: CronExpr): number | null {
  // 从 fromMs 的墙钟下一分钟起扫。
  const p0 = zonedParts(fromMs, timeZone);
  let cur: WallMinute = addWallMinute({
    year: p0.year,
    month: p0.month,
    day: p0.day,
    hour: p0.hour,
    minute: p0.minute,
  });
  // gap 补偿候选：epoch 为「原墙钟 + 跳幅」，limitKey 是它对应的墙钟——扫过
  // 这个墙钟还没有更早的真实命中，就收口返回候选。
  let pending: { epoch: number; limitKey: number } | null = null;

  for (let i = 0; i < 200_000; i++) {
    if (pending !== null && wallKey(cur) > pending.limitKey) return pending.epoch;
    const parts = { ...cur, weekday: weekdayOf(cur) };
    if (cronMatches(expr, parts)) {
      const { epoch, exists } = wallToEpoch({ ...cur, second: 0 }, timeZone);
      if (epoch > fromMs) {
        if (exists) {
          // 真实命中。若已有 gap 补偿候选，取更早者（相同时刻自然去重）。
          return pending !== null && pending.epoch < epoch ? pending.epoch : epoch;
        }
        // gap 命中：先记候选，继续扫——gap 之后、补偿时刻之前可能有更早的真实命中。
        if (pending === null || epoch < pending.epoch) {
          const lim = zonedParts(epoch, timeZone);
          pending = { epoch, limitKey: wallKey(lim) };
        }
      }
      cur = addWallMinute(cur);
      continue;
    }
    // 按字段跳，压缩迭代（纯日历运算，不触发时区换算）。
    if (!expr.months.has(cur.month)) {
      cur =
        cur.month === 12
          ? { year: cur.year + 1, month: 1, day: 1, hour: 0, minute: 0 }
          : { year: cur.year, month: cur.month + 1, day: 1, hour: 0, minute: 0 };
      continue;
    }
    if (!cronDayMatches(expr, parts)) {
      cur = { ...addCalendarDays(cur, 1), hour: 0, minute: 0 };
      continue;
    }
    if (!expr.hours.has(cur.hour)) {
      cur =
        cur.hour < 23
          ? { ...cur, hour: cur.hour + 1, minute: 0 }
          : { ...addCalendarDays(cur, 1), hour: 0, minute: 0 };
      continue;
    }
    cur = addWallMinute(cur);
  }
  return pending?.epoch ?? null;
}

/**
 * 计划 → 严格晚于 fromMs 的下一次绝对运行时刻；没有更多运行时返回 null。
 *
 * `once` 是绝对 epoch（过了就没有下一次）；`event` 不由时钟驱动（等外部投递，
 * 本批是待接线点），因此恒返回 null。
 */
export function computeNextRun(
  schedule: TaskSchedule,
  timeZone: string,
  fromMs: number
): number | null {
  switch (schedule.kind) {
    case "once":
      return schedule.at > fromMs ? schedule.at : null;
    case "daily":
      return nextDailyOccurrence(fromMs, timeZone, schedule.time, null);
    case "weekly":
      return nextDailyOccurrence(fromMs, timeZone, schedule.time, new Set(schedule.weekdays));
    case "cron":
      return nextCronOccurrence(fromMs, timeZone, parseCron(schedule.expression));
    case "event":
      return null;
  }
}
