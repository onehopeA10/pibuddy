/**
 * 极简 5 字段 cron 解析（分 时 日 月 周）。
 *
 * ## 为什么自己写而不引 cron 库
 *
 * 本仓「未新增任何运行时依赖」。5 字段 cron 的语法面很小（`*` / 列表 / 区间 /
 * 步长），自己实现几十行、可被单测逐条钉死，比拖进一个几百 KB 的解析器
 * （还得过 `check-pure-js-deps` 闸门）划算得多。
 *
 * 支持通配、步长（如「每 15 分」）、单值、区间（如 1-5）、区间加步长，以及
 * 以上任意组合的逗号列表。「日」与「周」两个字段按**标准 cron 的 OR 语义**
 * 匹配（两者都受限时，命中任一即算数）——这条语义容易写错成 AND，因此单独
 * 拎出来测。
 */

export interface CronExpr {
  /** 0-59 */
  minutes: ReadonlySet<number>;
  /** 0-23 */
  hours: ReadonlySet<number>;
  /** 1-31 */
  daysOfMonth: ReadonlySet<number>;
  /** 1-12 */
  months: ReadonlySet<number>;
  /** 0-6，0=周日（cron 里 7 也是周日，解析时归一到 0） */
  daysOfWeek: ReadonlySet<number>;
  /** 「日」字段是否为 `*`（决定 OR 语义走哪条分支） */
  domStar: boolean;
  /** 「周」字段是否为 `*` */
  dowStar: boolean;
}

/** 解析一个字段（如「每 15 分」的步长写法、区间 1-5、列表 0,30）成取值集合。 */
function parseField(field: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") throw new Error(`CRON_FIELD_INVALID: ${label} 空段 "${field}"`);
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`CRON_FIELD_INVALID: ${label} 非法步长 "${part}"`);
      }
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else {
      const dash = range.indexOf("-");
      if (dash >= 0) {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      } else {
        lo = Number(range);
        hi = lo;
      }
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`CRON_FIELD_INVALID: ${label} 非整数 "${part}"`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`CRON_FIELD_INVALID: ${label} 越界 "${part}"（允许 ${min}-${max}）`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** 解析一条 5 字段 cron 表达式。字段数不对直接抛错，不猜。 */
export function parseCron(expression: string): CronExpr {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`CRON_INVALID: 需要 5 个字段，实际 ${fields.length}："${expression}"`);
  }
  const [min, hour, dom, month, dow] = fields;
  const daysOfWeekRaw = parseField(dow, 0, 7, "周");
  // cron 里 7 与 0 都是周日，归一到 0。
  const daysOfWeek = new Set<number>();
  for (const v of daysOfWeekRaw) daysOfWeek.add(v === 7 ? 0 : v);
  return {
    minutes: parseField(min, 0, 59, "分"),
    hours: parseField(hour, 0, 23, "时"),
    daysOfMonth: parseField(dom, 1, 31, "日"),
    months: parseField(month, 1, 12, "月"),
    daysOfWeek,
    domStar: dom.trim() === "*",
    dowStar: dow.trim() === "*",
  };
}

/**
 * cron 的「日」匹配：dom 与 dow 的标准 OR 语义。
 *
 *   - 两者都受限（都不是 `*`）⇒ 命中任一即算数（OR）；
 *   - 只有一个受限 ⇒ 只看那一个；
 *   - 两者都是 `*` ⇒ 任意日。
 *
 * 这条是 cron 里最容易写错的语义（很多人误以为是 AND），因此单独成函数、
 * 单独测。
 */
export function cronDayMatches(
  expr: CronExpr,
  parts: { day: number; weekday: number }
): boolean {
  const domRestricted = !expr.domStar;
  const dowRestricted = !expr.dowStar;
  const domOk = expr.daysOfMonth.has(parts.day);
  const dowOk = expr.daysOfWeek.has(parts.weekday);
  if (domRestricted && dowRestricted) return domOk || dowOk;
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true;
}

/** 某个墙钟分钟是否命中表达式（分 / 时 / 月 / 日全部对上）。 */
export function cronMatches(
  expr: CronExpr,
  parts: { minute: number; hour: number; day: number; month: number; weekday: number }
): boolean {
  return (
    expr.minutes.has(parts.minute) &&
    expr.hours.has(parts.hour) &&
    expr.months.has(parts.month) &&
    cronDayMatches(expr, parts)
  );
}
