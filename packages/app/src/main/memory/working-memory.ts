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

export function admitToWorking(
  store: MemoryStore,
  workspaceId: string,
  sessionId: string,
  record: MemoryRecord
): WorkingItem {
  const hash = contentHash(record.content);
  store.invalidateWorkingIfHashChanged(workspaceId, sessionId, record.id, hash);
  return store.upsertWorkingItem({
    workspaceId,
    sessionId,
    kind: logicalKindFromType(record.type),
    content: record.content,
    sourceMemoryId: record.id,
    sourceHash: hash,
    expires: "task_end",
    refreshOnSourceChange: true,
  });
}

export function loadedSourceIds(store: MemoryStore, workspaceId: string, sessionId: string): Set<string> {
  return new Set(store.listWorkingSourceIds(workspaceId, sessionId));
}

export function workingForSession(store: MemoryStore, workspaceId: string, sessionId: string): WorkingItem[] {
  return store.listWorkingItems(workspaceId, sessionId);
}

/** 读 Working 前核对来源可见性、过期与 hash；失效项删除后不再注入。 */
export function refreshWorkingForSession(
  store: MemoryStore,
  workspaceId: string,
  sessionId: string
): WorkingItem[] {
  const kept: WorkingItem[] = [];
  for (const item of store.listWorkingItems(workspaceId, sessionId)) {
    if (!item.sourceMemoryId) {
      kept.push(item);
      continue;
    }
    const src = store.get(item.sourceMemoryId);
    const origin = store.originOf(item.sourceMemoryId);
    if (!src || src.excluded || src.sensitivity === "sensitive") {
      store.deleteWorkingItem(item.id);
      continue;
    }
    if (src.scope !== "global" && origin?.workspaceId !== workspaceId) {
      store.deleteWorkingItem(item.id);
      continue;
    }
    if (src.expiry != null && src.expiry > 0 && src.expiry < Date.now()) {
      store.deleteWorkingItem(item.id);
      continue;
    }
    const hash = contentHash(src.content);
    if (item.refreshOnSourceChange && item.sourceHash && item.sourceHash !== hash) {
      store.deleteWorkingItem(item.id);
      continue;
    }
    kept.push(item);
  }
  return kept;
}
