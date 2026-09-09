/**
 * 定时任务说人话：下一跑时间、缺授权，不把 cron / IANA / 权限 ID 摊给普通人。
 *
 * 纯函数，主进程对话确认和渲染侧任务卡片共用。不读磁盘、不碰调度器。
 */
export type PlainSchedule =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; weekdays: readonly number[]; time: string }
  | { kind: "cron"; expression: string }
  | { kind: "event"; event: string };

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"] as const;

const PERMISSION_WORDS: Record<string, string> = {
  "workspace.read": "读工作区文件",
  "workspace.write": "改工作区文件",
  "process.git": "使用 Git",
  "process.shell": "运行命令",
  "network.local": "访问本机网络",
  "tasks.manage": "管理定时任务",
};

export interface ZonedClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** 09:00 → 9:00；15:00 保持 15:00。 */
export function formatWallClock(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return `${Number(h)}:${m ?? "00"}`;
}

export function zonedClock(epochMs: number, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekdayName = get("weekday");
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdayMap[weekdayName] ?? 0,
  };
}

function dayIndex(clock: ZonedClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day) / 86_400_000;
}

function clockWall(clock: ZonedClock): string {
  return formatWallClock(`${pad2(clock.hour)}:${pad2(clock.minute)}`);
}

/**
 * 相对「现在」说下次几点。没有排期就老实说还没排。
 */
export function humanNextRun(
  nextRunAt: number | null,
  timeZone: string,
  now: number
): string {
  if (nextRunAt === null) return "还没排下次";
  const next = zonedClock(nextRunAt, timeZone);
  const here = zonedClock(now, timeZone);
  const delta = dayIndex(next) - dayIndex(here);
  const wall = clockWall(next);
  if (delta < 0) return `已错过（本该 ${wall}）`;
  if (delta === 0) return `今天 ${wall}`;
  if (delta === 1) return `明天 ${wall}`;
  if (delta < 7) return `周${WEEKDAY[next.weekday]} ${wall}`;
  return `${next.month}月${next.day}日 ${wall}`;
}

function humanCron(expression: string): string | null {
  const bits = expression.trim().split(/\s+/);
  if (bits.length !== 5) return null;
  const [minute, hour, dom, month, dow] = bits;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const wall = formatWallClock(`${pad2(Number(hour))}:${pad2(Number(minute))}`);
  if (dom === "*" && month === "*" && dow === "*") return `每天 ${wall}`;
  if (dom === "*" && month === "*" && /^\d$/.test(dow)) {
    return `每周${WEEKDAY[Number(dow)]} ${wall}`;
  }
  return null;
}

export function humanSchedule(schedule: PlainSchedule): string {
  switch (schedule.kind) {
    case "once":
      return "一次";
    case "daily":
      return `每天 ${formatWallClock(schedule.time)}`;
    case "weekly": {
      const days = schedule.weekdays.map((d) => `周${WEEKDAY[d]}`).join("、");
      return `${days} ${formatWallClock(schedule.time)}`;
    }
    case "cron":
      return humanCron(schedule.expression) ?? "按自定义时间表";
    case "event":
      return `等「${schedule.event}」发生时`;
  }
}

export function humanPermission(id: string): string {
  return PERMISSION_WORDS[id] ?? id;
}

export function humanAuthGap(missing: readonly string[]): string {
  if (missing.length === 0) return "";
  return `还差工作区授权：${missing.map(humanPermission).join("、")}`;
}

export function humanTaskHeadline(input: {
  nextRunAt: number | null;
  timeZone: string;
  missingPermissions: readonly string[];
  paused: boolean;
  schedule: PlainSchedule;
  now: number;
}): string {
  if (input.paused) return "已暂停";
  if (input.schedule.kind === "event") {
    const wait = humanSchedule(input.schedule);
    const gap = humanAuthGap(input.missingPermissions);
    return gap ? `${wait} 会跑，${gap}` : `${wait} 会跑`;
  }
  const when = humanNextRun(input.nextRunAt, input.timeZone, input.now);
  const gap = humanAuthGap(input.missingPermissions);
  if (when === "还没排下次") return gap || "还没排下次";
  return gap ? `${when} 会跑，${gap}` : `${when} 会跑`;
}

export function humanTaskCreated(input: {
  nextRunAt: number | null;
  timeZone: string;
  schedule: PlainSchedule;
  now: number;
  missingPermissions?: readonly string[];
}): string {
  const gap = humanAuthGap(input.missingPermissions ?? []);
  if (input.schedule.kind === "event") {
    const line = `已排好：${humanSchedule(input.schedule)} 会跑`;
    return gap ? `${line}，${gap}` : line;
  }
  const when = humanNextRun(input.nextRunAt, input.timeZone, input.now);
  const line = `已排好：${when} 会跑`;
  return gap ? `${line}，${gap}` : line;
}
