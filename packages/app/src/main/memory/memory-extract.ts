/**
 * 有限的自动抽取（MEM-101 第二版）——从会话里抽候选事实，**但不当真相**。
 *
 * ## ADR 红线：总结不是不可更正的真相
 *
 * 自动抽取最大的风险是「把一次总结当成事实反复注入、越描越黑，而用户看不见、
 * 改不了」。本模块用四道结构性约束把这条红线钉死：
 *
 *   1. 抽出来的每一条 `origin = "inferred"`（不是 user）；
 *   2. `confidence = 0.5`（< 1，明确不确定）；
 *   3. 保留 `sourceSessionId` / `sourceTurnId` —— 用户能点开看它到底从哪句话来的
 *      （memory:evidence），据此判断采不采信；
 *   4. `excluded = true` 落库 —— **默认不注入**，等用户在面板里逐条确认（取消排除）
 *      才进注入候选。一条抽错的事实因此绝不会在用户没看见时就被塞进提示词。
 *
 * 落库之后它与用户显式保存的记忆走**同一套**审计通道：查看 / 编辑 / 合并 / 删除。
 *
 * ## 抽取器是可注入的
 *
 * 默认抽取器是一组保守的启发式（扫用户消息里像「长期偏好 / 指令」的句子），
 * 刻意不追求完备 —— 完备的事实抽取需要一个 live 模型，而红线不在抽得准不准，
 * 在**抽错了能不能被用户纠正**。需要更强的抽取（Provider LLM）时通过
 * `__setFactExtractor` 换实现即可，四道约束不变。
 */
import { createReadStream } from "node:fs";
import type { MemoryRecord, MemoryType } from "@pibuddy/contract";

import { requireWorkspaceRoot } from "../workspace-registry.js";
import { loadSettings } from "../settings.js";
import { sessionIndex } from "../sessions/session-index.js";
import { memoryStore, type MemoryStore } from "./memory-store.js";
import { embedMemory } from "./memory-search.js";

/** 抽取读会话文件的字节上限（一段足够定位若干轮，不整文件读入）。 */
const READ_MAX = 2 * 1024 * 1024;
/** 候选正文的字节上限。 */
const CONTENT_MAX = 400;

/** 会话里的一轮用户消息。 */
export interface SessionTurn {
  turnId: string | null;
  role: string;
  text: string;
}

/** 一条抽取候选（尚未落库）。 */
export interface FactCandidate {
  content: string;
  type: MemoryType;
  turnId: string | null;
}

/** 抽取器：从若干轮里抽候选。可注入。 */
export type FactExtractor = (turns: SessionTurn[]) => FactCandidate[];

/**
 * 默认启发式抽取器。
 *
 * 只看**用户**消息（模型的话不是「用户的事实」）。对每一句，命中偏好 / 指令 / 事实
 * 的线索词才收，按线索强度排序。刻意保守 —— 宁可少抽，不可把随口一句当成长期事实。
 */
const PREFERENCE_CUES = ["喜欢", "偏好", "习惯", "prefer", "总是用", "一律用", "回复用", "用中文", "用英文"];
const INSTRUCTION_CUES = ["以后", "记住", "务必", "不要", "别再", "请始终", "always", "never", "每次都"];
const FACT_CUES = ["我的", "我们", "这个项目", "后端用", "前端用", "数据库是", "叫", "是给"];

function classifyCandidate(sentence: string): MemoryType | null {
  const s = sentence.trim();
  if (s.length < 4) return null;
  if (INSTRUCTION_CUES.some((c) => s.includes(c))) return "instruction";
  if (PREFERENCE_CUES.some((c) => s.includes(c))) return "preference";
  if (FACT_CUES.some((c) => s.includes(c))) return "fact";
  return null;
}

export const defaultExtractor: FactExtractor = (turns) => {
  const out: FactCandidate[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    for (const raw of turn.text.split(/[。！？.!?\n]/)) {
      const sentence = raw.trim();
      if (!sentence || seen.has(sentence)) continue;
      const type = classifyCandidate(sentence);
      if (!type) continue;
      seen.add(sentence);
      out.push({ content: sentence.slice(0, CONTENT_MAX), type, turnId: turn.turnId });
    }
  }
  return out;
};

let extractorImpl: FactExtractor = defaultExtractor;

/** 仅供单测 / 接入 Provider LLM 抽取：替换抽取器。传 null 恢复默认启发式。 */
export function __setFactExtractor(extractor: FactExtractor | null): void {
  extractorImpl = extractor ?? defaultExtractor;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      parts.push((block as { text?: string }).text ?? "");
    }
  }
  return parts.join("\n");
}

function readHead(file: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(file, { start: 0, end: READ_MAX - 1 });
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("error", () => resolve(""));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** 读一段会话的全部消息轮次（供抽取器扫描）。只读，失败返回空。 */
export async function readSessionTurns(workspaceId: string, sessionId: string): Promise<SessionTurn[]> {
  try {
    const root = requireWorkspaceRoot(workspaceId);
    const settings = loadSettings();
    const index = sessionIndex();
    await index.syncWorkspace(root, settings);
    const row = index.bySessionId(sessionId, workspaceId);
    if (!row) return [];
    const head = await readHead(row.sourcePath);
    if (!head) return [];
    const turns: SessionTurn[] = [];
    for (const line of head.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== "message") continue;
      const msg = entry.message as { role?: string; content?: unknown } | undefined;
      if (!msg) continue;
      const text = textOf(msg.content).trim();
      if (!text) continue;
      turns.push({ turnId: entry.id == null ? null : String(entry.id), role: msg.role ?? "", text });
    }
    return turns;
  } catch {
    return [];
  }
}

/**
 * 从一段会话抽候选事实并落库（origin=inferred, confidence=0.5, excluded=true）。
 *
 * 落库后为每条补算向量（语义检索可命中），失败不影响落库。返回落库的候选 +
 * 扫描到的轮次数（供 UI 说明「从 N 轮里抽出 M 条」）。
 */
export async function extractFromSession(
  workspaceId: string,
  sessionId: string,
  limit: number,
  store: MemoryStore = memoryStore()
): Promise<{ candidates: MemoryRecord[]; scannedTurns: number }> {
  const turns = await readSessionTurns(workspaceId, sessionId);
  const candidates = extractorImpl(turns).slice(0, limit);
  const saved: MemoryRecord[] = [];
  for (const cand of candidates) {
    const outcome = store.save({
      workspaceId,
      content: cand.content,
      type: cand.type,
      scope: "workspace",
      origin: "inferred",
      confidence: 0.5,
      excluded: true,
      sourceSessionId: sessionId,
      sourceTurnId: cand.turnId,
    });
    // secret 命中的候选会被 save 拒（ok:false）——抽取同样不把密钥收进记忆。
    if (outcome.ok && outcome.record) {
      saved.push(outcome.record);
      await embedMemory(store, outcome.record.id, workspaceId, "workspace", cand.content);
    }
  }
  return { candidates: saved, scannedTurns: turns.length };
}
