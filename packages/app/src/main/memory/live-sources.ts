/**
 * Live 能力缝：定义 + 提供者 + 消费者。
 *
 * inject 只调用 collectLiveEvidence，不读文件。默认提供者读工作区文件；
 * 测试或后续日历/远程源用 replaceLiveSourceProviders 整表替换。
 * 未注册工作区或缺文件时返回空，不抛到热路径。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MemoryEnvelope } from "@pibuddy/contract";

import { requireWorkspaceRoot } from "../workspace-registry.js";

export interface LiveSourceProvider {
  id: string;
  collect(workspaceId: string, refs: string[]): MemoryEnvelope[];
}

const rootOverride = new Map<string, string>();

export function __setLiveRoot(workspaceId: string, root: string | null): void {
  if (!root) rootOverride.delete(workspaceId);
  else rootOverride.set(workspaceId, root);
}

export function resetLiveRoots(): void {
  rootOverride.clear();
}

function resolveRoot(workspaceId: string): string | null {
  if (!workspaceId) return null;
  const over = rootOverride.get(workspaceId);
  if (over) return over;
  try {
    return requireWorkspaceRoot(workspaceId);
  } catch {
    return null;
  }
}

function todayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fileHash(abs: string): string {
  return createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
}

function liveEnvelope(input: {
  id: string;
  subject: string;
  predicate: string;
  content: string;
  sourceRef: string;
  sourceHash: string;
}): MemoryEnvelope {
  return {
    id: input.id,
    scope: "project",
    logicalKind: "fact",
    claimSubject: input.subject,
    claimPredicate: input.predicate,
    claimObjectJson: null,
    source: "live",
    backend: "filesystem",
    sourceRef: input.sourceRef,
    sourceHash: input.sourceHash,
    status: "active",
    observedAt: Date.now(),
    verifiedAt: Date.now(),
    validFrom: Date.now(),
    validUntil: null,
    evidence: [{ type: "current_file", ref: input.sourceRef }],
    retrieval: null,
    content: input.content,
    estimatedTokens: Math.max(1, Math.ceil(input.content.length / 4)),
  };
}

function readPackageJson(root: string): MemoryEnvelope[] {
  const abs = path.join(root, "package.json");
  if (!fs.existsSync(abs)) return [];
  try {
    const raw = fs.readFileSync(abs, "utf8");
    const pkg = JSON.parse(raw) as {
      engines?: { node?: string };
      volta?: { node?: string };
      packageManager?: string;
    };
    const hash = fileHash(abs);
    const out: MemoryEnvelope[] = [];
    const node = pkg.engines?.node ?? pkg.volta?.node;
    if (node) {
      out.push(
        liveEnvelope({
          id: "live-node",
          subject: "node",
          predicate: "version",
          content: `package.json 声明 Node 版本是 ${node}`,
          sourceRef: "package.json",
          sourceHash: hash,
        })
      );
    }
    const pm = pkg.packageManager?.split("@")[0];
    if (pm) {
      out.push(
        liveEnvelope({
          id: "live-pkg",
          subject: "package_manager",
          predicate: "package.json",
          content: `package.json 声明包管理器是 ${pm}`,
          sourceRef: "package.json",
          sourceHash: hash,
        })
      );
    }
    return out;
  } catch {
    return [];
  }
}

function readCalendar(root: string): MemoryEnvelope[] {
  const candidates = [path.join(root, ".pibuddy", "calendar.json"), path.join(root, "calendar.json")];
  const today = todayKey();
  for (const abs of candidates) {
    if (!fs.existsSync(abs)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as {
        date?: string;
        events?: Array<{ title?: string; at?: string }>;
        days?: Record<string, Array<{ title?: string; at?: string }>>;
      };
      const events = raw.days?.[today] ?? (raw.date === today ? raw.events : undefined) ?? [];
      const titles = events.map((e) => e.title).filter((t): t is string => Boolean(t));
      if (titles.length === 0) return [];
      const hash = fileHash(abs);
      const when = events
        .map((e) => [e.at, e.title].filter(Boolean).join(" "))
        .filter(Boolean)
        .join("；");
      return [
        liveEnvelope({
          id: "live-cal",
          subject: "calendar",
          predicate: "today",
          content: `今天的会议：${when || titles.join("、")}`,
          sourceRef: path.basename(abs) === "calendar.json" && abs.includes(".pibuddy") ? ".pibuddy/calendar.json" : "calendar.json",
          sourceHash: hash,
        }),
      ];
    } catch {
      return [];
    }
  }
  return [];
}

function collectFromFiles(workspaceId: string, refs: string[]): MemoryEnvelope[] {
  const root = resolveRoot(workspaceId);
  if (!root || refs.length === 0) return [];
  const out: MemoryEnvelope[] = [];
  if (refs.includes("package.json")) out.push(...readPackageJson(root));
  if (refs.includes("calendar")) out.push(...readCalendar(root));
  return out;
}

export const FILE_LIVE_SOURCE_ID = "file";

const fileLiveSource: LiveSourceProvider = {
  id: FILE_LIVE_SOURCE_ID,
  collect: collectFromFiles,
};

let providers: LiveSourceProvider[] = [fileLiveSource];

export function listLiveSourceProviders(): readonly LiveSourceProvider[] {
  return providers;
}

/** 整表替换。空数组等于没有 Live 源。 */
export function replaceLiveSourceProviders(next: LiveSourceProvider[]): void {
  providers = [...next];
}

export function resetLiveSourceProviders(): void {
  providers = [fileLiveSource];
  resetLiveRoots();
}

export function collectLiveEvidence(workspaceId: string, refs: string[]): MemoryEnvelope[] {
  if (!workspaceId || refs.length === 0) return [];
  const out: MemoryEnvelope[] = [];
  for (const provider of providers) {
    out.push(...provider.collect(workspaceId, refs));
  }
  return out;
}
