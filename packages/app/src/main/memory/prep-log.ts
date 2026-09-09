/**
 * 模型可见即可回放：每次实际准备写入的 MEMORY_CONTEXT 旁路记一笔。
 *
 * 不进 memories 表（避免污染 FTS / Authority），不写 pi JSONL。
 * 按 workspaceId + sessionId 分区，只留最近一条供 reconstruct。
 */
export interface MemoryPrepLogEntry {
  workspaceId: string;
  sessionId: string;
  at: number;
  userMessage: string;
  block: string;
  returned: string;
}

const lastByKey = new Map<string, MemoryPrepLogEntry>();

function keyOf(workspaceId: string, sessionId: string): string {
  return `${workspaceId}::${sessionId}`;
}

export function appendPrepLog(entry: Omit<MemoryPrepLogEntry, "at">): MemoryPrepLogEntry {
  const full: MemoryPrepLogEntry = { ...entry, at: Date.now() };
  lastByKey.set(keyOf(entry.workspaceId, entry.sessionId), full);
  return full;
}

export function lastPrepLog(workspaceId: string, sessionId: string): MemoryPrepLogEntry | null {
  return lastByKey.get(keyOf(workspaceId, sessionId)) ?? null;
}

/** 用日志里的 block 重建当时返回给模型的字符串。 */
export function reconstructInjected(workspaceId: string, sessionId: string, userMessage: string): string | null {
  const entry = lastPrepLog(workspaceId, sessionId);
  if (!entry || entry.userMessage !== userMessage) return null;
  return entry.block ? `${entry.block}\n\n${entry.userMessage}` : entry.userMessage;
}

export function resetPrepLog(): void {
  lastByKey.clear();
}
