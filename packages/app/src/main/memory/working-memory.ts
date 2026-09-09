/**
 * Working Memory：当前任务缓存，不是长期真相。
 *
 * 默认 expires=task_end。source_hash 变了则失效。已进 Working 的来源默认不再 Recall。
 */
import { createHash } from "node:crypto";
import { logicalKindFromType, type MemoryRecord, type WorkingItem } from "@pibuddy/contract";

import type { MemoryStore } from "./memory-store.js";

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function admitToWorking(store: MemoryStore, sessionId: string, record: MemoryRecord): WorkingItem {
  const hash = contentHash(record.content);
  store.invalidateWorkingIfHashChanged(sessionId, record.id, hash);
  return store.upsertWorkingItem({
    sessionId,
    kind: logicalKindFromType(record.type),
    content: record.content,
    sourceMemoryId: record.id,
    sourceHash: hash,
    expires: "task_end",
    refreshOnSourceChange: true,
  });
}

export function loadedSourceIds(store: MemoryStore, sessionId: string): Set<string> {
  return new Set(store.listWorkingSourceIds(sessionId));
}

export function workingForSession(store: MemoryStore, sessionId: string): WorkingItem[] {
  return store.listWorkingItems(sessionId);
}
