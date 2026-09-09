/**
 * PostTask：retain ≠ commit。
 * 「记住」只进 memory_candidates，绝不自动写成 Canonical fact。
 */
import { classifyContent } from "./memory-secret.js";
import type { MemoryStore } from "./memory-store.js";

export function shouldRetain(text: string): boolean {
  return /记住|记得住|记一下/.test(text);
}

export function isHypothesis(text: string): boolean {
  return /我猜|可能是|也许是|hypothesis|assuming/.test(text);
}

export function retainAsCandidate(
  store: MemoryStore,
  workspaceId: string,
  text: string
): { committed: false; rejected: boolean; candidateId: string | null } {
  const verdict = classifyContent(text);
  if (verdict.rejected) {
    return { committed: false, rejected: true, candidateId: null };
  }
  const kind = isHypothesis(text) ? "belief" : "preference";
  const id = store.insertCandidate({
    workspaceId,
    scope: "user",
    logicalKind: kind,
    payload: { text },
    evidence: { utterance: text },
  });
  if (!id) return { committed: false, rejected: true, candidateId: null };
  return { committed: false, rejected: false, candidateId: id };
}
