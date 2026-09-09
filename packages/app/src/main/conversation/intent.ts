/**
 * 对话即动作的意图解析（纯函数，不碰磁盘 / electron）。
 *
 * 普通人不会先打开侧栏再填表。他们会说「记住我不吃辣」「每天九点提醒我看待办」。
 * 这里只认**明确口令**，宁可漏掉也不误伤闲聊（「我记得昨天…」绝不能落成一条记忆）。
 */
import type { TaskSchedule } from "@pibuddy/contract";

export type RememberIntent = {
  kind: "remember";
  content: string;
};

export type ScheduleIntent = {
  kind: "schedule";
  schedule: TaskSchedule;
  /** 任务短名，给人看 */
  name: string;
  /** 到点后发给 Agent 的提示词 */
  prompt: string;
  /** `tomorrow`：apply 时按工作区时区把 once.at 解成明天该墙钟 */
  resolve?: "tomorrow";
  /** resolve=tomorrow 时的墙钟（HH:MM） */
  wallTime?: string;
};

export type OfficeSkillName =
  | "office-file-organize"
  | "office-table-clean"
  | "office-doc-convert";

export type OfficeSkillIntent = {
  kind: "office-skill";
  skillName: OfficeSkillName;
};

export type ConversationIntent = RememberIntent | ScheduleIntent | OfficeSkillIntent;

const REMEMBER_LEAD = /^(?:请)?记住(?:一下)?[：:，,\s]+(.+)$/u;
const REMEMBER_BARE = /^(?:请)?记住(?!了|得)(.+)$/u;
const REMEMBER_BA = /^(?:请)?把[「“"'](.+?)[」”"']记住/u;
const REMEMBER_BA_PLAIN = /^(?:请)?把(.+?)记住(?:一下)?$/u;

const ACTION_RE = /提醒|叫我|通知我|帮我看|帮我整理|帮我跑|定时/;
const DAILY_RE = /每天|每日/;
const WEEKLY_RE = /每周|每星期/;
const TOMORROW_RE = /明天|明早|明晚/;

const WEEKDAY_MAP: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

const SKILL_RULES: ReadonlyArray<{
  skillName: OfficeSkillName;
  re: RegExp;
}> = [
  {
    skillName: "office-file-organize",
    re: /文件整理|整理技能|按月归档|按月份归档|批量重命名|整理下载|文件夹.+整理|整理.+文件夹/,
  },
  {
    skillName: "office-table-clean",
    re: /表格处理|表格技能|分析表格|按手机号去重|去重后汇总|\.csv\b/i,
  },
  {
    skillName: "office-doc-convert",
    re: /文档转换|转成\s*PDF|转成\s*Word|转成\s*Markdown|转成\s*docx/i,
  },
];

function trimContent(raw: string): string | null {
  const content = raw.replace(/^[「「"'“]+|[」」"'”]+$/g, "").trim();
  if (content.length < 2) return null;
  if (/^[了得嗎吗呀啊呢]$/u.test(content)) return null;
  return content;
}

function parseRemember(text: string): RememberIntent | null {
  if (/^(?:我)?还?记得/.test(text) || /^记住了/.test(text) || /^你还?记得/.test(text)) {
    return null;
  }
  const quoted = text.match(REMEMBER_BA);
  if (quoted?.[1]) {
    const content = trimContent(quoted[1]);
    return content ? { kind: "remember", content } : null;
  }
  const lead = text.match(REMEMBER_LEAD);
  if (lead?.[1]) {
    const content = trimContent(lead[1]);
    return content ? { kind: "remember", content } : null;
  }
  const ba = text.match(REMEMBER_BA_PLAIN);
  if (ba?.[1]) {
    const content = trimContent(ba[1]);
    return content ? { kind: "remember", content } : null;
  }
  const bare = text.match(REMEMBER_BARE);
  if (bare?.[1]) {
    const content = trimContent(bare[1]);
    return content ? { kind: "remember", content } : null;
  }
  return null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function parseClock(text: string): string | null {
  const hm = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h <= 23 && m <= 59) return `${pad2(h)}:${pad2(m)}`;
  }
  const dotted = text.match(/(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/);
  if (dotted) {
    let h = Number(dotted[1]);
    const m = dotted[2] === "半" ? 30 : dotted[3] ? Number(dotted[3]) : 0;
    if (/下午|晚上|今晚|傍晚/.test(text) && h > 0 && h < 12) h += 12;
    if (/中午/.test(text) && h === 0) h = 12;
    if (h <= 23 && m <= 59) return `${pad2(h)}:${pad2(m)}`;
  }
  if (/早上|早晨|上午/.test(text)) return "09:00";
  if (/中午/.test(text)) return "12:00";
  if (/下午/.test(text)) return "15:00";
  if (/晚上|今晚|夜里/.test(text)) return "20:00";
  return null;
}

function parseWeekdays(text: string): number[] | null {
  if (/工作日/.test(text)) return [1, 2, 3, 4, 5];
  const hits: number[] = [];
  const re = /周([一二三四五六日天])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const d = WEEKDAY_MAP[m[1]];
    if (d !== undefined && !hits.includes(d)) hits.push(d);
  }
  return hits.length ? hits.sort((a, b) => a - b) : null;
}

function scheduleName(schedule: TaskSchedule, prompt: string): string {
  const short = prompt.replace(/\s+/g, " ").trim().slice(0, 16);
  if (schedule.kind === "daily") return `每天 ${schedule.time} · ${short}`;
  if (schedule.kind === "weekly") return `每周 · ${short}`;
  if (schedule.kind === "once") return `一次 · ${short}`;
  return short || "对话创建的任务";
}

function parseSchedule(text: string): ScheduleIntent | null {
  if (!ACTION_RE.test(text)) return null;
  const time = parseClock(text);
  if (DAILY_RE.test(text)) {
    if (!time) return null;
    const schedule: TaskSchedule = { kind: "daily", time };
    return { kind: "schedule", schedule, name: scheduleName(schedule, text), prompt: text };
  }
  if (WEEKLY_RE.test(text)) {
    if (!time) return null;
    const weekdays = parseWeekdays(text) ?? [1];
    const schedule: TaskSchedule = { kind: "weekly", weekdays, time };
    return { kind: "schedule", schedule, name: scheduleName(schedule, text), prompt: text };
  }
  if (TOMORROW_RE.test(text)) {
    if (!time) return null;
    return {
      kind: "schedule",
      schedule: { kind: "once", at: 0 },
      name: scheduleName({ kind: "once", at: 0 }, text),
      prompt: text,
      resolve: "tomorrow",
      wallTime: time,
    };
  }
  return null;
}

function parseOfficeSkill(text: string): OfficeSkillIntent | null {
  if (/\/skill:office-/.test(text)) return null;
  for (const rule of SKILL_RULES) {
    if (rule.re.test(text)) return { kind: "office-skill", skillName: rule.skillName };
  }
  return null;
}

/**
 * 从一句用户话里抽出 0..n 个明确动作。顺序固定：先记住、再建任务、再挂技能。
 */
export function parseConversationIntents(message: string): ConversationIntent[] {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text || text.includes("[PiBuddy 已处理]")) return [];
  const out: ConversationIntent[] = [];
  const remember = parseRemember(text);
  if (remember) out.push(remember);
  const schedule = parseSchedule(text);
  if (schedule) out.push(schedule);
  const skill = parseOfficeSkill(text);
  if (skill) out.push(skill);
  return out;
}

export function skillCommand(skillName: string): string {
  return `/skill:${skillName}`;
}
