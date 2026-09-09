/**
 * 进程内 HindsightAdapter。不是外网服务，也不引入第二套向量库。
 *
 * unavailable 时 recall/reflect 返回空，Canonical 路径必须仍能跑。
 * retain 只进本 Adapter bank，不写 memories 主表。
 */
import { randomUUID } from "node:crypto";
import type { MemoryEnvelope } from "@pibuddy/contract";

import { classifyContent } from "./memory-secret.js";

export type HindsightFactType = "world" | "experience" | "observation";

export interface HindsightEpisode {
  id: string;
  bankId: string;
  workspaceId: string | null;
  factType: HindsightFactType;
  content: string;
  tags: string[];
  observedAt: number;
  sourceFacts: string[];
}

let available = false;
const bank: HindsightEpisode[] = [];

export function setHindsightAvailable(on: boolean): void {
  available = on;
}

export function isHindsightAvailable(): boolean {
  return available;
}

export function resetHindsightAdapter(): void {
  available = false;
  bank.length = 0;
}

export function seedHindsight(input: Omit<HindsightEpisode, "id" | "sourceFacts"> & {
  id?: string;
  sourceFacts?: string[];
}): HindsightEpisode | null {
  if (classifyContent(input.content).rejected) return null;
  const episode: HindsightEpisode = {
    id: input.id ?? randomUUID(),
    bankId: input.bankId,
    workspaceId: input.workspaceId,
    factType: input.factType,
    content: input.content,
    tags: input.tags,
    observedAt: input.observedAt,
    sourceFacts: input.sourceFacts ?? [],
  };
  bank.push(episode);
  return episode;
}

function tagsMatch(episode: HindsightEpisode, tags: string[], mode: string): boolean {
  if (tags.length === 0) return true;
  if (mode === "any" || mode === "any_strict") return tags.some((t) => episode.tags.includes(t));
  if (mode === "exact") {
    return tags.length === episode.tags.length && tags.every((t) => episode.tags.includes(t));
  }
  return tags.every((t) => episode.tags.includes(t));
}

function matchesQuery(episode: HindsightEpisode, query: string): boolean {
  const q = query.toLowerCase();
  const hay = `${episode.content} ${episode.tags.join(" ")}`.toLowerCase();
  if (hay.includes(q)) return true;
  const tokens = q.split(/[\s,，。？?！!：:、]+/).filter((t) => t.length >= 2);
  const keyed = ["包管理", "pnpm", "yarn", "npm", "docker", "deploy", "部署", "失败", "纠结", "喜欢", "node"].filter(
    (k) => q.includes(k)
  );
  return [...tokens, ...keyed].some((t) => hay.includes(t));
}

function toEnvelope(episode: HindsightEpisode, source: MemoryEnvelope["source"], kind: MemoryEnvelope["logicalKind"]): MemoryEnvelope {
  return {
    id: episode.id,
    scope: episode.workspaceId ? "project" : "user",
    logicalKind: kind,
    claimSubject: episode.tags[0] ?? kind,
    claimPredicate: episode.factType,
    claimObjectJson: null,
    source,
    backend: "hindsight",
    sourceRef: episode.id,
    sourceHash: null,
    status: "active",
    observedAt: episode.observedAt,
    verifiedAt: null,
    validFrom: null,
    validUntil: null,
    evidence: episode.sourceFacts.map((ref) => ({ type: "historical_episode" as const, ref })),
    retrieval: { semantic: null, keyword: null, reranker: null, final: null },
    content: episode.content,
    estimatedTokens: Math.max(1, Math.ceil(episode.content.length / 4)),
  };
}

function search(
  query: string,
  opts: { workspaceId?: string; tags?: string[]; tagsMatch?: string; factTypes?: HindsightFactType[] }
): HindsightEpisode[] {
  if (!available) return [];
  // 缺 tenant 一律空：不能把「没带 workspaceId」当成全库共享。
  if (!opts.workspaceId) return [];
  return bank.filter((ep) => {
    if (ep.workspaceId && ep.workspaceId !== opts.workspaceId) return false;
    if (opts.factTypes && opts.factTypes.length > 0 && !opts.factTypes.includes(ep.factType)) return false;
    if (!tagsMatch(ep, opts.tags ?? [], opts.tagsMatch ?? "all_strict")) return false;
    return matchesQuery(ep, query) || (opts.tags ?? []).length > 0;
  });
}

export function recallHindsight(
  query: string,
  opts: {
    workspaceId?: string;
    tags?: string[];
    tagsMatch?: string;
    preferObservations?: boolean;
    includeSourceFacts?: boolean;
    maxItems?: number;
  } = {}
): MemoryEnvelope[] {
  if (!available) return [];
  let hits = search(query, opts);
  if (opts.preferObservations) {
    hits = [...hits].sort((a, b) => Number(b.factType === "observation") - Number(a.factType === "observation"));
  }
  return hits.slice(0, opts.maxItems ?? 8).map((ep) => {
    const env = toEnvelope(
      ep,
      ep.factType === "observation" ? "hindsight_observation" : ep.factType === "world" ? "hindsight_world" : "hindsight_experience",
      ep.factType === "observation" ? "belief" : "experience"
    );
    if (!opts.includeSourceFacts) env.evidence = [];
    return env;
  });
}

export function reflectHindsight(query: string, opts: { workspaceId?: string; tags?: string[] } = {}): MemoryEnvelope[] {
  if (!available) return [];
  const hits = search(query, { ...opts, factTypes: ["observation", "experience"] });
  if (hits.length === 0) return [];
  const summary = `综合 ${hits.length} 条经历：${hits[0]!.content}`;
  return [
    {
      id: `reflect-${randomUUID()}`,
      scope: "user",
      logicalKind: "belief",
      claimSubject: "pattern",
      claimPredicate: "reflect",
      claimObjectJson: null,
      source: "hindsight_reflect",
      backend: "hindsight",
      sourceRef: hits[0]!.id,
      sourceHash: null,
      status: "active",
      observedAt: Date.now(),
      verifiedAt: null,
      validFrom: null,
      validUntil: null,
      evidence: [{ type: "inference", ref: hits[0]!.id }],
      retrieval: { semantic: 0.99, keyword: 0.99, reranker: 0.99, final: 0.99 },
      content: `[DERIVED - NOT VERIFIED FACT] ${summary}`,
      estimatedTokens: 24,
    },
  ];
}

/** retain ≠ commit：只进 Adapter bank。 */
export function retainHindsight(input: Omit<HindsightEpisode, "id" | "sourceFacts"> & { sourceFacts?: string[] }): {
  ok: boolean;
  episode: HindsightEpisode | null;
} {
  if (!available) return { ok: false, episode: null };
  const episode = seedHindsight(input);
  return episode ? { ok: true, episode } : { ok: false, episode: null };
}

export function listHindsight(workspaceId?: string): HindsightEpisode[] {
  if (!workspaceId) return [];
  return bank.filter((ep) => ep.workspaceId === workspaceId || ep.workspaceId === null);
}
