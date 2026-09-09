/**
 * 所有存储结果进入 Resolver 前必须变成 MemoryEnvelope。
 * 检索分只作 admission，不进 Authority。
 */
import {
  logicalKindFromType,
  logicalScopeFromMemoryScope,
  type MemoryEnvelope,
  type MemoryRecord,
} from "@pibuddy/contract";

import { inferClaim } from "./claim-key.js";

export function envelopeFromRecord(record: MemoryRecord, live = false): MemoryEnvelope {
  const kind = logicalKindFromType(record.type);
  const claim = inferClaim(record.content, kind);
  return {
    id: record.id,
    scope: logicalScopeFromMemoryScope(record.scope),
    logicalKind: kind,
    claimSubject: claim.subject,
    claimPredicate: claim.predicate,
    claimObjectJson: null,
    source: live ? "live" : "canonical",
    backend: live ? "runtime" : "sqlite",
    sourceRef: record.id,
    sourceHash: null,
    status: "active",
    observedAt: record.updated,
    verifiedAt: record.origin === "user" ? record.updated : null,
    validFrom: record.created,
    validUntil: record.expiry,
    evidence: [],
    retrieval: null,
    content: record.content,
    estimatedTokens: Math.max(1, Math.ceil(record.content.length / 4)),
  };
}

export function markPossiblyStale(env: MemoryEnvelope, expectedHash: string, actualHash: string): MemoryEnvelope {
  if (!expectedHash || expectedHash === actualHash) return env;
  return { ...env, status: "possibly_stale", sourceHash: actualHash };
}
