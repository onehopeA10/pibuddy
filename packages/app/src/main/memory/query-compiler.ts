/**
 * Query Compiler：把 TaskAnalysis 收成检索词，不把通用知识问句整句丢进 FTS。
 */
import type { TaskAnalysis } from "@pibuddy/contract";

const STOP = new Set(["什么", "怎么", "如何", "哪个", "是", "的", "了", "吗", "what", "is", "the", "a"]);

/**
 * These words locate a request in the current workspace but do not identify
 * which memory answers it. Treating them as evidence makes any two project
 * sentences look related.
 */
const GENERIC_ENGLISH_TERMS = new Set([
  "project",
  "repo",
  "repository",
  "workspace",
  "what",
  "which",
  "where",
  "when",
  "how",
  "the",
  "this",
  "that",
  "please",
]);

const GENERIC_CHINESE_PHRASES =
  /这个项目|本项目|当前项目|我们的项目|这个仓库|本仓库|当前仓库|这个 repo|本 repo|项目|仓库|工作区|这个|什么|怎么|如何|哪个|是否|多少|哪里|在哪|请问|帮我|一下/gi;

/**
 * Terms used for admission, not broad candidate generation. English tokens
 * keep word boundaries; Chinese keeps 2/3-character windows after generic
 * request scaffolding is removed.
 */
export function meaningfulLexicalTerms(text: string): string[] {
  const terms = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9_]{2,}/g)) {
    const term = match[0];
    if (!GENERIC_ENGLISH_TERMS.has(term)) terms.add(term);
  }

  const chinese = text.replace(GENERIC_CHINESE_PHRASES, " ");
  for (const run of chinese.matchAll(/[一-龥]{2,}/g)) {
    const value = run[0];
    for (let i = 0; i < value.length - 1; i++) {
      terms.add(value.slice(i, i + 2));
      if (i < value.length - 2) terms.add(value.slice(i, i + 3));
    }
  }
  return [...terms];
}

/** Number of complete, non-generic query terms also present in the content. */
export function meaningfulLexicalOverlap(query: string, content: string): number {
  const queryTerms = meaningfulLexicalTerms(query);
  if (queryTerms.length === 0) return 0;
  const contentTerms = new Set(meaningfulLexicalTerms(content));
  let overlap = 0;
  for (const term of queryTerms) if (contentTerms.has(term)) overlap++;
  return overlap;
}

export function compileQuery(message: string, analysis: TaskAnalysis): string {
  if (analysis.genericKnowledge) return "";
  const parts = message
    .split(/[\s,，。？?！!：:、]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && !STOP.has(p.toLowerCase()));
  if (analysis.entities.length > 0) parts.unshift(...analysis.entities);
  return parts.slice(0, 12).join(" ") || message;
}
