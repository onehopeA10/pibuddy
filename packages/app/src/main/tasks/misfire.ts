/**
 * 错过运行（missed run）的处理——**纯函数**，因此 DST / 时钟回拨 / sleep-wake
 * / App 关闭这些时序全都能用 `ManualClock` 精确制造出来再断言。
 *
 * ## 三档策略，由用户在建任务时选
 *
 *   - `skip`     —— 只跑「准点」的那次（在 grace 窗口内），错过的一律不补；
 *   - `run-once` —— 无论错过多少次，最多补跑**一次**（取最近那个墙钟槽位）；
 *   - `catch-up` —— 逐个补跑错过的每一次（**每次带自己的墙钟槽位**，因此每次
 *                   都有独立的 idempotency key —— 只有幂等 action 才该选它）。
 *
 * ## 时钟回拨为什么在这里天然安全
 *
 * 回拨 = `now` 比上次已处理的槽位 `sinceMs` 还早。`enumerateSlots` 从
 * `sinceMs` 起找严格晚于它、且 ≤ now 的槽位——回拨时这个集合**为空**，因此
 * 一个 dueSlot 都产生不出来。「时钟往回跳不会重复触发」不是靠一个 if 挡出来
 * 的，而是这个枚举的定义本身就排除了它。
 */
import type { MisfirePolicy, TaskSchedule } from "@pibuddy/contract";

import { computeNextRun } from "./schedule.js";

/**
 * 一次补跑最多枚举多少个错过槽位。
 *
 * catch-up 一个每分钟触发的任务被关了一周，会积压上万个槽位。逐个补跑上万
 * 次不是补偿而是灾难；封顶之后超出的部分被丢弃，且在 scheduler 侧留审计。
 */
export const MAX_CATCHUP_SLOTS = 1000;

/** 「准点」窗口：晚于槽位不超过这个毫秒数，算准点触发而非错过。 */
export const DEFAULT_GRACE_MS = 60_000;

export interface MisfirePlan {
  /** 现在要跑的槽位，升序；每个槽位 → 一个独立 idempotency key。 */
  dueSlots: number[];
  /** 严格晚于 now 的下一次；没有更多运行时为 null。 */
  nextAfter: number | null;
  /** 因封顶被丢弃的错过槽位数（供审计）。 */
  dropped: number;
}

/** 枚举 (sinceMs, now] 区间内的全部触发槽位，升序，封顶。 */
function enumerateSlots(
  schedule: TaskSchedule,
  timeZone: string,
  sinceMs: number,
  now: number,
  cap: number
): { slots: number[]; dropped: number } {
  const slots: number[] = [];
  let cursor = sinceMs;
  let dropped = 0;
  // 多枚举一圈以便如实报告「被丢弃了多少」，但只保留前 cap 个。
  for (let i = 0; i < cap + 1; i++) {
    const next = computeNextRun(schedule, timeZone, cursor);
    if (next === null || next > now) break;
    if (slots.length < cap) slots.push(next);
    else dropped++;
    cursor = next;
  }
  return { slots, dropped };
}

export interface MisfireArgs {
  schedule: TaskSchedule;
  timeZone: string;
  /** 起算下界（排他）：上次已处理的槽位；新任务传创建时刻——都不该回溯到它之前。 */
  sinceMs: number;
  /** 现在几点（来自可注入时钟）。 */
  now: number;
  policy: MisfirePolicy;
  graceMs?: number;
}

/**
 * 算出这次唤醒该跑哪些槽位、以及下一次是什么时候。
 *
 * `sinceMs` 排他下界保证：崩溃恢复时从「上次处理到的槽位」续，绝不把创建
 * 之前或已处理过的槽位重新翻出来。
 */
export function planMisfire(args: MisfireArgs): MisfirePlan {
  const { schedule, timeZone, sinceMs, now, policy } = args;
  const graceMs = args.graceMs ?? DEFAULT_GRACE_MS;

  const { slots: due, dropped } = enumerateSlots(
    schedule,
    timeZone,
    sinceMs,
    now,
    MAX_CATCHUP_SLOTS
  );
  const nextAfter = computeNextRun(schedule, timeZone, now);

  if (due.length === 0) {
    return { dueSlots: [], nextAfter, dropped };
  }

  let dueSlots: number[];
  switch (policy) {
    case "skip":
      // 只保留准点的（通常就是刚到点的那一个）；错过很久的全部略过。
      dueSlots = due.filter((s) => now - s <= graceMs);
      break;
    case "run-once":
      // 无论积压多少，坍缩成最近那一个墙钟槽位的单次补偿。
      dueSlots = [due[due.length - 1]];
      break;
    case "catch-up":
      dueSlots = due;
      break;
  }

  return { dueSlots, nextAfter, dropped: policy === "catch-up" ? dropped : 0 };
}
