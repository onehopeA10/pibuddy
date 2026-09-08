/**
 * 把产物库里的记录投影到对话消息上（对话即动作 · 改完能看懂）。
 *
 * 记账仍在 main 的 artifact-tracker。这里只做渲染侧投影：按 toolCallId
 * 挂到**发出该工具调用的那条** assistant，而不是整段历史都堆到最后一条。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import type { ArtifactLink, ArtifactRecord } from "@contract";

export interface ChatLikeItem {
  key: number;
  message: { role: string; content?: unknown };
}

export function linksFromRecords(
  records: readonly ArtifactRecord[],
  toolCallId?: string
): ArtifactLink[] {
  const matched = toolCallId
    ? records.filter((r) => r.sourceToolCallId === toolCallId && r.status !== "failed")
    : records.filter((r) => r.status === "ready" || r.status === "generating");
  return matched.map((r) => ({
    artifactId: r.id,
    version: r.version,
    name: r.name,
  }));
}

export function mergeArtifactLinks(
  current: readonly ArtifactLink[],
  incoming: readonly ArtifactLink[]
): ArtifactLink[] {
  const seen = new Set(current.map((l) => `${l.artifactId}@${l.version}`));
  const out = [...current];
  for (const link of incoming) {
    const id = `${link.artifactId}@${link.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(link);
  }
  return out;
}

export function latestAssistantKey(
  items: readonly ChatLikeItem[],
  streaming: boolean
): string | number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.message.role === "assistant") return items[i]!.key;
  }
  return streaming ? "live-assistant" : "live-assistant";
}

function toolCallIdsOf(message: { content?: unknown }): string[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const row = block as { type?: string; id?: string };
    if (row.type === "toolCall" && typeof row.id === "string") ids.push(row.id);
  }
  return ids;
}

export function assistantKeyForToolCall(
  items: readonly ChatLikeItem[],
  toolCallId: string,
  streaming: boolean
): string | number {
  for (const item of items) {
    if (item.message.role !== "assistant") continue;
    if (toolCallIdsOf(item.message).includes(toolCallId)) return item.key;
  }
  return latestAssistantKey(items, streaming);
}

export function assignRecordsToItems(
  records: readonly ArtifactRecord[],
  items: readonly ChatLikeItem[]
): Array<{ key: string | number; links: ArtifactLink[] }> {
  const grouped = new Map<string, ArtifactLink[]>();
  for (const record of records) {
    const links = linksFromRecords([record]);
    if (links.length === 0) continue;
    const key = record.sourceToolCallId
      ? assistantKeyForToolCall(items, record.sourceToolCallId, false)
      : latestAssistantKey(items, false);
    const slot = String(key);
    grouped.set(slot, mergeArtifactLinks(grouped.get(slot) ?? [], links));
  }
  return [...grouped.entries()].map(([key, links]) => ({
    key: key === "live-assistant" ? key : Number.isNaN(Number(key)) ? key : Number(key),
    links,
  }));
}

function cacheKey(workspaceId: string, sessionId?: string): string {
  return `${workspaceId}#${sessionId ?? ""}`;
}

export function resolveRecordFrom(
  records: readonly ArtifactRecord[],
  artifactId: string,
  version: number
): ArtifactRecord | null {
  const anchor = records.find((a) => a.id === artifactId);
  if (!anchor) return null;
  return (
    records.find(
      (a) =>
        a.logicalKey === anchor.logicalKey &&
        a.workspaceId === anchor.workspaceId &&
        a.version === version
    ) ?? anchor
  );
}

export function pendingChangeIdFrom(
  pendingByKey: Readonly<Record<string, string>>,
  item: Pick<ArtifactRecord, "sourceToolCallId" | "exportPath">
): string | null {
  if (item.sourceToolCallId) {
    const byTool = pendingByKey[`tool:${item.sourceToolCallId}`];
    if (byTool) return byTool;
  }
  if (item.exportPath) return pendingByKey[`path:${item.exportPath}`] ?? null;
  return null;
}

export const useChatArtifactsStore = defineStore("chat-artifacts", () => {
  const byKey = ref<Record<string, ArtifactLink[]>>({});
  const records = ref<ArtifactRecord[]>([]);
  const pendingByKey = ref<Record<string, string>>({});
  let recordsKey = "";
  let recordsInflight: Promise<ArtifactRecord[]> | null = null;
  let changesKey = "";
  let changesInflight: Promise<void> | null = null;

  function reset(): void {
    byKey.value = {};
    records.value = [];
    pendingByKey.value = {};
    recordsKey = "";
    recordsInflight = null;
    changesKey = "";
    changesInflight = null;
  }

  function invalidateRecords(): void {
    recordsKey = "";
    recordsInflight = null;
    changesKey = "";
    changesInflight = null;
  }

  function artifactsFor(keys: ReadonlyArray<string | number>): ArtifactLink[] {
    const seen = new Set<string>();
    const out: ArtifactLink[] = [];
    for (const key of keys) {
      for (const link of byKey.value[String(key)] ?? []) {
        const id = `${link.artifactId}@${link.version}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(link);
      }
    }
    return out;
  }

  function attach(key: string | number, links: readonly ArtifactLink[]): void {
    if (links.length === 0) return;
    const slot = String(key);
    byKey.value = {
      ...byKey.value,
      [slot]: mergeArtifactLinks(byKey.value[slot] ?? [], links),
    };
  }

  async function fetchRecords(
    workspaceId: string,
    sessionId?: string
  ): Promise<ArtifactRecord[]> {
    const api = window.piBuddy?.artifacts;
    if (!api || !workspaceId) return [];
    const key = cacheKey(workspaceId, sessionId);
    if (recordsKey === key) {
      if (recordsInflight) return recordsInflight;
      return records.value;
    }
    recordsKey = key;
    recordsInflight = (async () => {
      try {
        const filter = sessionId ? { sessionId } : {};
        const [page, trash] = await Promise.all([
          api.query({ workspaceId, ...filter, limit: 200 }),
          api.query({ workspaceId, ...filter, trashed: true, limit: 200 }),
        ]);
        records.value = [...page.items, ...trash.items];
        return records.value;
      } catch {
        records.value = [];
        return records.value;
      }
    })().finally(() => {
      recordsInflight = null;
    });
    return recordsInflight;
  }

  async function fetchPendingChanges(workspaceId: string, sessionId?: string): Promise<void> {
    const api = window.piBuddy?.workspace;
    if (!api?.changesets || !workspaceId) return;
    const key = cacheKey(workspaceId, sessionId);
    if (changesKey === key) {
      if (changesInflight) return changesInflight;
      return;
    }
    changesKey = key;
    changesInflight = (async () => {
      try {
        const page = await api.changesets({
          workspaceId,
          ...(sessionId ? { sessionId } : {}),
        });
        const next: Record<string, string> = {};
        for (const entry of page.entries) {
          if (entry.status !== "pending" && entry.status !== "unverified") continue;
          if (entry.toolCallId) next[`tool:${entry.toolCallId}`] = entry.id;
          if (entry.relativePath) next[`path:${entry.relativePath}`] = entry.id;
        }
        pendingByKey.value = next;
      } catch {
        pendingByKey.value = {};
      }
    })().finally(() => {
      changesInflight = null;
    });
    return changesInflight;
  }

  async function ensureResolved(workspaceId: string, sessionId?: string): Promise<void> {
    await Promise.all([
      fetchRecords(workspaceId, sessionId),
      fetchPendingChanges(workspaceId, sessionId),
    ]);
  }

  function resolveRecord(artifactId: string, version: number): ArtifactRecord | null {
    return resolveRecordFrom(records.value, artifactId, version);
  }

  function pendingChangeIdFor(
    item: Pick<ArtifactRecord, "sourceToolCallId" | "exportPath">
  ): string | null {
    return pendingChangeIdFrom(pendingByKey.value, item);
  }

  async function querySession(
    workspaceId: string,
    sessionId: string
  ): Promise<ArtifactRecord[]> {
    if (!workspaceId || !sessionId) return [];
    invalidateRecords();
    return fetchRecords(workspaceId, sessionId);
  }

  async function projectToolEnd(input: {
    workspaceId: string;
    sessionId: string;
    toolCallId: string;
    items: readonly ChatLikeItem[];
    streaming: boolean;
  }): Promise<number> {
    const rows = await querySession(input.workspaceId, input.sessionId);
    const links = linksFromRecords(rows, input.toolCallId);
    if (links.length === 0) return 0;
    attach(assistantKeyForToolCall(input.items, input.toolCallId, input.streaming), links);
    return links.length;
  }

  async function backfillSession(input: {
    workspaceId: string;
    sessionId: string;
    items: readonly ChatLikeItem[];
  }): Promise<number> {
    const rows = await fetchRecords(input.workspaceId, input.sessionId);
    const assigned = assignRecordsToItems(rows, input.items);
    let n = 0;
    for (const row of assigned) {
      attach(row.key, row.links);
      n += row.links.length;
    }
    return n;
  }

  return {
    byKey,
    records,
    reset,
    invalidateRecords,
    artifactsFor,
    attach,
    ensureResolved,
    resolveRecord,
    pendingChangeIdFor,
    projectToolEnd,
    backfillSession,
  };
});
