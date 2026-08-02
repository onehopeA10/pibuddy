import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionMeta } from "@pibuddy/contract";

export type { SessionMeta };

/**
 * pi 会话按工作目录存储在
 * ~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl，
 * 其中 <path> 为工作目录路径中 / \ : 替换为 - 的结果。
 */
export function sessionDirFor(workspace: string): string {
  const seg = workspace.replace(/[\\/:]/g, "-");
  return path.join(os.homedir(), ".pi", "agent", "sessions", `--${seg}--`);
}

export function listSessions(workspace: string): SessionMeta[] {
  const dir = sessionDirFor(workspace);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: SessionMeta[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, ent.name);
    try {
      const stat = fs.statSync(filePath);
      const meta = parseSessionFile(filePath);
      if (meta) result.push({ ...meta, modified: stat.mtimeMs });
    } catch {
      // 跳过损坏的会话文件
    }
  }
  result.sort((a, b) => b.modified - a.modified);
  return result;
}

function parseSessionFile(filePath: string): Omit<SessionMeta, "modified"> | null {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");

  let id = "";
  let name: string | undefined;
  let firstMessage = "";
  let messageCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const type = entry.type as string;
    if (type === "session") {
      id = (entry.id as string) ?? "";
    } else if (type === "session_info") {
      if (typeof entry.name === "string") name = entry.name;
    } else if (type === "message") {
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      if (!message) continue;
      if (message.role === "user" || message.role === "assistant") messageCount++;
      if (!firstMessage && message.role === "user") {
        firstMessage = extractText(message.content).slice(0, 120);
      }
    }
  }
  if (!id) return null;
  return { path: filePath, id, name, firstMessage, messageCount };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        return (block as { text?: string }).text ?? "";
      }
    }
  }
  return "";
}
