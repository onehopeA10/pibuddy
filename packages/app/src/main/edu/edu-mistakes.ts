/**
 * 错题本 JSONL 的解析（edu.kids / REQ-0001 R3）。**纯函数，不碰 IO。**
 *
 * ## 写入方是 agent，解析必须宽进
 *
 * `edu-kids/mistakes.jsonl` 由 pi 会话里的 agent 按 skills/edu-mistake-book
 * 的 SKILL.md 约定追加。模型写出来的行可能缺字段、可能整行不是 JSON——
 * 坏一行只跳一行并计数（skipped），绝不因一行坏数据让整个错题本在面板上
 * 消失。这与 session-tree 读会话 JSONL 的取舍完全一致。
 *
 * ## 出口有界
 *
 * 错题本长年累积无上界，IPC 响应必须有界：按日期倒序取最近 limit 条，
 * total 报全量。排序用稳定排序 + 字符串比较（YYYY-MM-DD 字典序 == 时间序），
 * 非法日期归为空串排在最后（最旧）。
 */
import type { EduMistakeEntry } from "@pibuddy/contract";

export interface ParsedMistakes {
  entries: EduMistakeEntry[];
  /** 被跳过的坏行数（JSON 解析失败或缺必填字段） */
  skipped: number;
  /** 有效错题总数（entries 只是其中最近的 limit 条） */
  total: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 单行 → 归一化条目；必填字段（topic / question）缺失即整行无效。 */
function parseLine(line: string): EduMistakeEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const topic = record.topic;
  const question = record.question;
  if (typeof topic !== "string" || topic.trim().length === 0) return null;
  if (typeof question !== "string" || question.trim().length === 0) return null;
  const date = typeof record.date === "string" && DATE_RE.test(record.date) ? record.date : "";
  return {
    date,
    subject: typeof record.subject === "string" && record.subject ? record.subject : "other",
    topic: topic.trim(),
    question: question.trim(),
    wrong: asOptionalString(record.wrong),
    right: asOptionalString(record.right),
    note: asOptionalString(record.note),
  };
}

export function parseMistakeJsonl(text: string, limit: number): ParsedMistakes {
  const valid: EduMistakeEntry[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const entry = parseLine(trimmed);
    if (entry === null) {
      skipped += 1;
    } else {
      valid.push(entry);
    }
  }
  // 稳定排序：同一天的错题保持写入顺序（后写的在后）；日期新的在前。
  const sorted = valid
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => {
      if (a.entry.date !== b.entry.date) return a.entry.date < b.entry.date ? 1 : -1;
      return a.order - b.order;
    })
    .map((item) => item.entry);
  return { entries: sorted.slice(0, limit), skipped, total: valid.length };
}
