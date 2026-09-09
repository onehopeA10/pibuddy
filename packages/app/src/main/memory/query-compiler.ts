/**
 * Query Compiler：把 TaskAnalysis 收成检索词，不把通用知识问句整句丢进 FTS。
 */
import type { TaskAnalysis } from "@pibuddy/contract";

const STOP = new Set(["什么", "怎么", "如何", "哪个", "是", "的", "了", "吗", "what", "is", "the", "a"]);

export function compileQuery(message: string, analysis: TaskAnalysis): string {
  if (analysis.genericKnowledge) return "";
  const parts = message
    .split(/[\s,，。？?！!：:、]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && !STOP.has(p.toLowerCase()));
  if (analysis.entities.length > 0) parts.unshift(...analysis.entities);
  return parts.slice(0, 12).join(" ") || message;
}
