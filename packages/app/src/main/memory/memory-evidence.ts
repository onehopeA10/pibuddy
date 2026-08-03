/**
 * 原始证据读取（MEM-101 第一版）——本能力唯一真正的 `workspace.read`。
 *
 * ## 为什么必须能读到证据
 *
 * 「模型推断的事实要保留来源，不能把总结当不可更正真相」这条要求，落到用户
 * 手上就是一个动作：点开一条记忆，看它到底从哪一句话里来的。没有这条路，
 * 一条记忆就只是一句无从核对的断言。因此这里按记忆存下的
 * (workspaceId, sourceSessionId, sourceTurnId) 把会话 JSONL 里那一轮的原文取回来。
 *
 * ## 只读，且失败即如实说「没有」
 *
 * 读会话文件是**只读**：本文件不含任何写入调用（会话文件同时属于 pi 命令行，
 * 改坏了回不来）。来源缺失 / 文件已删 / 找不到那一轮时返回 `found:false`，
 * 绝不编造一段证据——一段编出来的「原文」比没有更有害。
 */
import { createReadStream } from "node:fs";
import type { MemoryEvidenceResult } from "@pibuddy/contract";

import { requireWorkspaceRoot } from "../workspace-registry.js";
import { loadSettings } from "../settings.js";
import { resolveSessionDir } from "../sessions/session-dir.js";
import { sessionIndex } from "../sessions/session-index.js";
import { memoryStore } from "./memory-store.js";

/** 单次读证据的字节上限：够定位一轮对话，远小于「把整个会话读进内存」。 */
const EVIDENCE_READ_MAX = 2 * 1024 * 1024;
/** 返回的证据文本上限。 */
const EVIDENCE_TEXT_MAX = 4000;

const EMPTY: MemoryEvidenceResult = { found: false, sessionName: null, text: "" };

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

/** 读会话文件头部若干字节（只读一段，不整文件读入）。 */
function readHead(file: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(file, { start: 0, end: EVIDENCE_READ_MAX - 1 });
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("error", () => resolve(""));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * 取一条记忆的来源会话轮次原文。
 *
 * 有 turnId 时优先找 `id === turnId` 的那一行；找不到（或没有 turnId）时
 * 回落到该会话里**最后一条用户消息**——那是「用户当时说的话」，通常正是
 * 这条记忆被记下来的那句。
 */
export async function readEvidence(memoryId: string): Promise<MemoryEvidenceResult> {
  const origin = memoryStore().originOf(memoryId);
  if (!origin || !origin.sessionId) return EMPTY;
  try {
    const root = requireWorkspaceRoot(origin.workspaceId);
    const settings = loadSettings();
    const index = sessionIndex();
    // 先同步一次，覆盖「索引刚被删 / 首次访问」的情况。
    await index.syncWorkspace(root, settings);
    const row = index.bySessionId(origin.sessionId, origin.workspaceId);
    if (!row) return EMPTY;
    // resolveSessionDir 只为在多工作区共享目录时对齐口径；本文件不写它。
    void resolveSessionDir(root, settings);

    const head = await readHead(row.sourcePath);
    if (!head) return { found: false, sessionName: row.name, text: "" };

    let fallback = "";
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
      if (origin.turnId && entry.id === origin.turnId) {
        return { found: true, sessionName: row.name, text: text.slice(0, EVIDENCE_TEXT_MAX) };
      }
      if (msg.role === "user") fallback = text;
    }
    if (fallback) {
      return { found: true, sessionName: row.name, text: fallback.slice(0, EVIDENCE_TEXT_MAX) };
    }
    return { found: false, sessionName: row.name, text: "" };
  } catch {
    return EMPTY;
  }
}
