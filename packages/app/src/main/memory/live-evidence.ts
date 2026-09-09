/**
 * 进程内 Live 证据槽，供测试补种。真实读文件走 live-sources。
 * 按 workspaceId 分区，缺 workspace 时 list 返回空。
 */
import type { MemoryEnvelope } from "@pibuddy/contract";

const liveByWorkspace = new Map<string, MemoryEnvelope[]>();

export function seedLiveEvidence(env: MemoryEnvelope, workspaceId: string): void {
  if (!workspaceId) return;
  const list = liveByWorkspace.get(workspaceId) ?? [];
  list.push(env);
  liveByWorkspace.set(workspaceId, list);
}

export function listLiveEvidence(workspaceId: string): MemoryEnvelope[] {
  if (!workspaceId) return [];
  return [...(liveByWorkspace.get(workspaceId) ?? [])];
}

export function resetLiveEvidence(): void {
  liveByWorkspace.clear();
}
