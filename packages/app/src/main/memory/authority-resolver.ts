/**
 * Authority：字典序裁决，检索分不得改排名。
 */
import { type MemoryEnvelope, type MemoryRecord } from "@pibuddy/contract";

import { claimIdentity } from "./claim-key.js";
import { envelopeFromRecord } from "./memory-normalizer.js";

export interface ResolveResult {
  admitted: MemoryRecord[];
  shadowed: MemoryRecord[];
  conflicts: MemoryRecord[];
}

export interface EnvelopeResolveResult {
  admitted: MemoryEnvelope[];
  shadowed: MemoryEnvelope[];
  conflicts: MemoryEnvelope[];
  derived: MemoryEnvelope[];
}

const TIER: Record<MemoryEnvelope["source"], number> = {
  live: 0,
  current_user: 1,
  working: 2,
  canonical: 3,
  hindsight_world: 6,
  hindsight_experience: 6,
  hindsight_observation: 5,
  hindsight_reflect: 7,
  archive: 7,
};

export function resolveEnvelopes(items: MemoryEnvelope[]): EnvelopeResolveResult {
  const active = items.filter((x) => x.status !== "stale" && x.status !== "superseded");
  const groups = new Map<string, MemoryEnvelope[]>();
  for (const item of active) {
    const key = claimIdentity(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const admitted: MemoryEnvelope[] = [];
  const shadowed: MemoryEnvelope[] = [];
  const conflicts: MemoryEnvelope[] = [];
  const derived: MemoryEnvelope[] = [];

  for (const group of groups.values()) {
    const live = group.filter((x) => x.source === "live");
    if (live.length > 0) {
      admitted.push(live[live.length - 1]!);
      for (const other of group) {
        if (other !== live[live.length - 1]) {
          if (other.source.startsWith("hindsight") || other.logicalKind === "belief") derived.push(other);
          else conflicts.push(other);
        }
      }
      continue;
    }

    const ranked = [...group].sort((a, b) => {
      const ta = TIER[a.source] ?? 9;
      const tb = TIER[b.source] ?? 9;
      if (ta !== tb) return ta - tb;
      if (a.logicalKind === "constraint" && b.logicalKind === "preference") return -1;
      if (a.logicalKind === "preference" && b.logicalKind === "constraint") return 1;
      return (b.verifiedAt ?? b.observedAt ?? 0) - (a.verifiedAt ?? a.observedAt ?? 0);
    });
    // 刻意不读 retrieval.final
    const winner = ranked[0]!;
    admitted.push(winner);
    for (const loser of ranked.slice(1)) {
      if (winner.logicalKind === "constraint" && loser.logicalKind === "preference") shadowed.push(loser);
      else if (loser.source === "hindsight_reflect" || loser.logicalKind === "belief") derived.push(loser);
      else if (TIER[loser.source] >= 5) derived.push(loser);
      else shadowed.push(loser);
    }
  }

  return { admitted, shadowed, conflicts, derived };
}

export function resolveAuthority(records: MemoryRecord[]): ResolveResult {
  const envelopes = records
    .filter((r) => !r.excluded && r.sensitivity !== "sensitive")
    .map((r) => envelopeFromRecord(r));
  const resolved = resolveEnvelopes(envelopes);
  const byId = new Map(records.map((r) => [r.id, r]));
  const toRecords = (list: MemoryEnvelope[]): MemoryRecord[] =>
    list.map((e) => byId.get(e.id)).filter((r): r is MemoryRecord => Boolean(r));
  return {
    admitted: toRecords(resolved.admitted),
    shadowed: toRecords([...resolved.shadowed, ...resolved.derived]),
    conflicts: toRecords(resolved.conflicts),
  };
}
