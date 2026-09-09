/**
 * 提示词注入钩子（Governed Hybrid Memory Phase 1）。
 *
 * ## 零成本门控（feature gate）
 *
 * `injectMemory` 的**第一行**就是能力启用判定：`common.memory` 未启用时立即
 * 原样返回，不碰记忆库、不开 sqlite、不抽词、不查询。这条钩子被挂在 pi:prompt
 * 这条热路径上，未启用时它必须等价于「不存在」——否则「关掉记忆」会变成
 * 「关掉记忆但每发一句话还是白跑一遍检索」。对拍见 memory-inject.spec
 * （拆掉这道门 → disabled 路径也去开库 → 变红）。
 *
 * ## 注入是指针，不是全文折进 [长期记忆]
 *
 * prepareMemoryContext 按 FastAnalyzer 决定 mode。通用知识 mode=none 不查库。
 * 任务相关注入 L1 指针（kind + 一行标题 + id）。已进 Working 的来源不再 Recall。
 *
 * ## 删除必须让命中也归零
 *
 * 「保存 → 命中 → 删除 → 再查零命中」这条时序里，删除之后连**历史命中记录**
 * 里都不该再出现那条记忆。`clearHitsForMemory` 由 IPC 层在删除 / 合并时调用。
 */
import { randomUUID } from "node:crypto";
import type { MemoryHit, MemoryRecord } from "@pibuddy/contract";

import { isCapabilityEnabled } from "../capability/capability-state.js";
import { MEMORY_CAPABILITY_ID } from "../capability/manifests/memory.manifest.js";
import { resolveEnvelopes } from "./authority-resolver.js";
import { mergeMemoryContext } from "./context-merger.js";
import {
  isHindsightAvailable,
  recallHindsight,
  reflectHindsight,
  resetHindsightAdapter,
  retainHindsight,
} from "./hindsight-adapter.js";
import { evaluateInjectPolicy } from "./inject-policy.js";
import { listLiveEvidence, resetLiveEvidence } from "./live-evidence.js";
import { collectLiveEvidence, resetLiveSourceProviders } from "./live-sources.js";
import { appendPrepLog, resetPrepLog } from "./prep-log.js";
import { fastAnalyze } from "./memory-analyzer.js";
import { envelopeFromRecord } from "./memory-normalizer.js";
import { retainAsCandidate, shouldRetain } from "./memory-post-task.js";
import { compileQuery } from "./query-compiler.js";
import { effectiveMode, planMemory } from "./memory-router.js";
import { MAX_INJECTED, rankedMemories } from "./memory-search.js";
import { memoryStore } from "./memory-store.js";
import { admitToWorking, workingForSession } from "./working-memory.js";

const MAX_HITS_PER_WS = 100;
const recentHits = new Map<string, MemoryHit[]>();

export interface MemoryPrepTrace {
  mode: "none" | "canonical" | "recall" | "reflect";
  plannedMode: string;
  recalled: number;
  fromWorking: number;
  admitted: number;
  sessionId: string;
  hindsight: number;
  liveRefs: string[];
  recallQuery: string | null;
}

/** 最近一次 prepare 的路由痕迹（单测用）。能力关闭时保持 null。 */
let lastPrep: MemoryPrepTrace | null = null;

export function getLastMemoryPrep(): MemoryPrepTrace | null {
  return lastPrep;
}

function previewOf(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

export async function injectMemory(
  message: string,
  workspaceId: string,
  sessionId?: string
): Promise<string> {
  // —— 零成本门：未启用时到此为止，绝不触碰记忆库、绝不解 embedder ——
  const early = evaluateInjectPolicy({
    capabilityEnabled: isCapabilityEnabled(MEMORY_CAPABILITY_ID),
    workspaceId,
    injectionActive: true,
  });
  if (early.action === "skip") return message;
  return prepareMemoryContext(message, workspaceId, sessionId);
}

/**
 * injectMemory 的实现面。调用方已通过能力门之后才应走到这里；
 * 本函数仍会再判注入总开关，避免只关 workspace 开关时仍查库。
 */
export async function prepareMemoryContext(
  message: string,
  workspaceId: string,
  sessionId?: string
): Promise<string> {
  const store = memoryStore();
  const policy = evaluateInjectPolicy({
    capabilityEnabled: true,
    workspaceId,
    injectionActive: store.injectionActive(workspaceId),
  });
  if (policy.action === "skip") {
    lastPrep = null;
    return message;
  }

  const analysis = fastAnalyze(message, { hasActiveProject: true });
  const plan = planMemory(analysis, message);
  const mode = effectiveMode(plan.mode);
  const sid = sessionId || workspaceId;

  if (shouldRetain(message)) {
    const retained = retainAsCandidate(store, workspaceId, message);
    if (!retained.rejected && isHindsightAvailable()) {
      retainHindsight({
        bankId: "user",
        workspaceId: null,
        factType: "experience",
        content: message,
        tags: ["retain", "user"],
        observedAt: Date.now(),
      });
    }
  }

  if (mode === "none") {
    lastPrep = {
      mode,
      plannedMode: plan.mode,
      recalled: 0,
      fromWorking: 0,
      admitted: 0,
      sessionId: sid,
      hindsight: 0,
      liveRefs: [],
      recallQuery: null,
    };
    store.recordRouteEvent({
      requestId: randomUUID(),
      sessionId: sid,
      mode: "none",
      scopes: [],
      retrieved: 0,
      admitted: 0,
      injected: 0,
      conflicts: 0,
    });
    return commitPrepared(workspaceId, sid, message, "");
  }

  const working = plan.working.read
    ? workingForSession(store, sid).filter((item) => {
        if (!item.sourceMemoryId) return true;
        const src = store.get(item.sourceMemoryId);
        return Boolean(src && !src.excluded && src.sensitivity !== "sensitive");
      })
    : [];
  const already = new Set(
    plan.working.dedupeLoadedSources
      ? working.map((item) => item.sourceMemoryId).filter((id): id is string => Boolean(id))
      : []
  );
  const query = compileQuery(message, analysis) || message;
  const recallQuery = plan.recalls[0]?.query || query;
  const hits =
    plan.canonicalReads.length > 0 ? await rankedMemories(store, workspaceId, query, MAX_INJECTED) : [];
  const fresh = hits.map((h) => h.record).filter((r) => !already.has(r.id));
  const canonicalEnvs = fresh.map((r) => envelopeFromRecord(r));
  const liveRefs = plan.liveValidations.map((v) => v.ref);
  const liveEnvs = [...listLiveEvidence(workspaceId), ...collectLiveEvidence(workspaceId, liveRefs)];
  const hindsightEnvs =
    plan.recalls.length > 0
      ? recallHindsight(recallQuery, { workspaceId, preferObservations: /坑|失败|纠结/.test(message) })
      : [];
  const reflectEnvs =
    plan.reflections.length > 0
      ? reflectHindsight(plan.reflections[0]?.query || recallQuery, { workspaceId })
      : [];
  const resolvedEnvs = resolveEnvelopes([...liveEnvs, ...canonicalEnvs, ...hindsightEnvs, ...reflectEnvs]);
  const byId = new Map(fresh.map((r) => [r.id, r]));
  const recordsOf = (envs: typeof resolvedEnvs.admitted): MemoryRecord[] =>
    envs.map((e) => byId.get(e.id)).filter((r): r is MemoryRecord => Boolean(r));
  const verified = recordsOf(
    resolvedEnvs.admitted.filter(
      (e) => e.source === "canonical" || e.source === "working" || e.source === "current_user"
    )
  );
  const shadowed = recordsOf(resolvedEnvs.shadowed);
  const conflicts = recordsOf(resolvedEnvs.conflicts);

  if (plan.working.write) {
    for (const record of verified) {
      admitToWorking(store, sid, record);
    }
  }

  const live = resolvedEnvs.admitted
    .filter((e) => e.source === "live")
    .map((e) => ({ id: e.id, content: e.content }));
  const experiences = resolvedEnvs.admitted
    .filter((e) => e.source === "hindsight_experience" || e.source === "hindsight_world")
    .map((e) => ({ id: e.id, content: e.content }));
  const derivedSeen = new Set<string>();
  const derived = [...resolvedEnvs.derived, ...resolvedEnvs.admitted]
    .filter(
      (e) =>
        e.source === "hindsight_reflect" ||
        e.source === "hindsight_observation" ||
        (e.logicalKind === "belief" && e.source.startsWith("hindsight"))
    )
    .filter((e) => {
      if (derivedSeen.has(e.id)) return false;
      derivedSeen.add(e.id);
      return true;
    })
    .map((e) => ({ id: e.id, content: e.content }));

  const block = mergeMemoryContext({
    working: already.size > 0 ? working : [],
    verified,
    live,
    shadowed,
    conflicts,
    experiences,
    derived,
  });

  lastPrep = {
    mode,
    plannedMode: plan.mode,
    recalled: fresh.length,
    fromWorking: working.length,
    admitted: verified.length + live.length + experiences.length + derived.length,
    sessionId: sid,
    hindsight: hindsightEnvs.length + reflectEnvs.length,
    liveRefs,
    recallQuery: plan.recalls[0]?.query ?? null,
  };
  store.recordRouteEvent({
    requestId: randomUUID(),
    sessionId: sid,
    mode,
    scopes: Object.entries(analysis.scopes)
      .filter(([, on]) => on)
      .map(([name]) => name),
    retrieved: hits.length + hindsightEnvs.length,
    admitted: lastPrep.admitted,
    injected: block ? lastPrep.admitted + (already.size > 0 ? working.length : 0) : 0,
    conflicts: shadowed.length + conflicts.length,
  });

  if (!block) return commitPrepared(workspaceId, sid, message, "");
  recordHits(workspaceId, [...verified, ...shadowed]);
  return commitPrepared(workspaceId, sid, message, block);
}

function commitPrepared(workspaceId: string, sessionId: string, message: string, block: string): string {
  const returned = block ? `${block}\n\n${message}` : message;
  appendPrepLog({ workspaceId, sessionId, userMessage: message, block, returned });
  return returned;
}

function recordHits(workspaceId: string, records: MemoryRecord[]): void {
  const at = Date.now();
  const entries: MemoryHit[] = records.map((h) => ({
    id: h.id,
    type: h.type,
    scope: h.scope,
    preview: previewOf(h.content),
    at,
  }));
  const list = [...entries, ...(recentHits.get(workspaceId) ?? [])].slice(0, MAX_HITS_PER_WS);
  recentHits.set(workspaceId, list);
}

export function memoryHitsFor(workspaceId: string): MemoryHit[] {
  return [...(recentHits.get(workspaceId) ?? [])];
}

export function clearHitsForMemory(id: string): void {
  for (const [ws, hits] of recentHits) {
    const filtered = hits.filter((h) => h.id !== id);
    if (filtered.length !== hits.length) recentHits.set(ws, filtered);
  }
}

export function disposeMemoryInject(): void {
  recentHits.clear();
  lastPrep = null;
  resetHindsightAdapter();
  resetLiveEvidence();
  resetLiveSourceProviders();
  resetPrepLog();
}
