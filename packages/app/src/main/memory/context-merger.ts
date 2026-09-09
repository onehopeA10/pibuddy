/**
 * Context Merger：按语义块打包，L1 只给指针（kind + 一行标题 + id）。
 *
 * 不要输出 [SQLite Results] / 检索分。超预算先扔 derived。
 */
import { logicalKindFromType, type MemoryRecord, type WorkingItem } from "@pibuddy/contract";

const KIND_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  constraint: "约束",
  instruction: "约束",
  context: "背景",
  decision: "决策",
  procedure: "规程",
  experience: "经历",
  belief: "推断",
};

export function memoryTokenBudget(contextWindow = 128_000): number {
  return Math.min(4500, Math.floor(contextWindow * 0.08));
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function pointerLine(kind: string, title: string, id: string): string {
  const label = KIND_LABEL[kind] ?? kind;
  const one = title.replace(/\s+/g, " ").trim();
  return `- [${label}] ${one} (#${id})`;
}

function pointerFromRecord(record: MemoryRecord): string {
  return pointerLine(logicalKindFromType(record.type), record.content, record.id);
}

function pointerFromWorking(item: WorkingItem): string {
  return pointerLine(item.kind, item.content, item.sourceMemoryId ?? item.id);
}

export function mergeMemoryContext(input: {
  working: WorkingItem[];
  verified: MemoryRecord[];
  live?: Array<{ id: string; content: string }>;
  shadowed?: MemoryRecord[];
  conflicts?: MemoryRecord[];
  experiences?: Array<{ id: string; content: string }>;
  derived?: Array<{ id: string; content: string }>;
  contextWindow?: number;
}): string {
  const budget = memoryTokenBudget(input.contextWindow);
  const workingLines = input.working.map(pointerFromWorking);
  const verifiedLines = [
    ...input.verified.map(pointerFromRecord),
    ...(input.live ?? []).map((e) => pointerLine("fact", e.content, e.id)),
  ];
  const conflictLines = (input.conflicts ?? []).map(pointerFromRecord);
  const shadowLines = (input.shadowed ?? []).map(
    (r) => `${pointerFromRecord(r)}（已被项目约束覆盖，用户偏好仍保留）`
  );
  const experienceLines = (input.experiences ?? []).map((e) => pointerLine("experience", e.content, e.id));
  const derivedLines = (input.derived ?? []).map((e) =>
    `- [推断] [DERIVED - NOT VERIFIED FACT] ${e.content.replace(/\s+/g, " ").trim()} (#${e.id})`
  );

  const sections: Array<{ tag: string; lines: string[]; derived?: boolean }> = [
    { tag: "WORKING", lines: workingLines },
    { tag: "VERIFIED_MEMORY", lines: verifiedLines },
    { tag: "PAST_EXPERIENCE", lines: experienceLines, derived: true },
    { tag: "DERIVED_MEMORY", lines: derivedLines, derived: true },
    { tag: "CONFLICTS", lines: [...conflictLines, ...shadowLines], derived: true },
  ];

  const kept: string[] = [];
  let used = estimateTokens("<MEMORY_CONTEXT></MEMORY_CONTEXT>");
  for (const section of sections) {
    if (section.lines.length === 0) continue;
    const body = `<${section.tag}>\n${section.lines.join("\n")}\n</${section.tag}>`;
    const cost = estimateTokens(body);
    if (used + cost > budget && section.derived) continue;
    if (used + cost > budget) continue;
    kept.push(body);
    used += cost;
  }
  if (kept.length === 0) return "";
  return ["<MEMORY_CONTEXT>", ...kept, "</MEMORY_CONTEXT>"].join("\n");
}
