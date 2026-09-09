/**
 * 从本机 Pi CLI 会话目录扫描并拷入当前工作区会话桶。
 *
 * 只读 ~/.pi/agent/sessions；写入目标由 resolveSessionDir 决定，
 * 文件名锁成 import-pi-<id>.jsonl，拷完再走既有索引同步。
 */
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PI_SESSIONS_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");

export interface PiImportCandidate {
  source: "pi";
  externalId: string;
  title: string;
  projectPath: string | null;
  messageCount: number;
  updatedAt: number;
  alreadyHere: boolean;
  sourceFile: string;
}

interface PiHeader {
  type?: string;
  id?: string;
  cwd?: string;
  timestamp?: string;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

export function importedFileName(externalId: string): string {
  return `import-pi-${safeId(externalId)}.jsonl`;
}

async function parsePiJsonl(filePath: string): Promise<{
  header: PiHeader;
  title: string;
  messageCount: number;
  updatedAt: number;
} | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  let header: PiHeader;
  try {
    header = JSON.parse(lines[0]) as PiHeader;
  } catch {
    return null;
  }
  if (header.type !== "session" || !header.id) return null;

  let title = header.id;
  let messageCount = 0;
  let updatedAt = Date.parse(header.timestamp ?? "") || 0;
  for (const line of lines.slice(1)) {
    let entry: {
      type?: string;
      name?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type === "session_info" && entry.name) title = entry.name;
    if (entry.type === "message") {
      messageCount += 1;
      const ts = Date.parse(entry.timestamp ?? "") || 0;
      if (ts > updatedAt) updatedAt = ts;
      if (title === header.id && entry.message?.role === "user") {
        const text = contentText(entry.message.content);
        if (text) title = text.slice(0, 80);
      }
    }
  }
  if (messageCount === 0) return null;
  return { header, title, messageCount, updatedAt };
}

export async function scanPiSessions(destDir: string): Promise<PiImportCandidate[]> {
  let dirs: string[] = [];
  try {
    dirs = await readdir(PI_SESSIONS_ROOT);
  } catch {
    return [];
  }

  const destNames = new Set<string>();
  try {
    for (const name of await readdir(destDir)) destNames.add(name);
  } catch {
    /* 目标桶还不存在：全部算尚未导入 */
  }

  const out: PiImportCandidate[] = [];
  for (const dir of dirs) {
    const dirPath = path.join(PI_SESSIONS_ROOT, dir);
    let files: string[] = [];
    try {
      const info = await stat(dirPath);
      if (!info.isDirectory()) continue;
      files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const parsed = await parsePiJsonl(filePath);
      if (!parsed) continue;
      const destName = importedFileName(parsed.header.id!);
      out.push({
        source: "pi",
        externalId: parsed.header.id!,
        title: parsed.title,
        projectPath: parsed.header.cwd ?? null,
        messageCount: parsed.messageCount,
        updatedAt: parsed.updatedAt,
        alreadyHere: destNames.has(destName) || path.resolve(filePath).startsWith(path.resolve(destDir)),
        sourceFile: filePath,
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function importPiSessions(
  destDir: string,
  externalIds: readonly string[]
): Promise<{ imported: number; skipped: number; failed: number }> {
  const wanted = new Set(externalIds);
  const scanned = await scanPiSessions(destDir);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const destRoot = path.resolve(destDir);
  await mkdir(destRoot, { recursive: true });
  for (const item of scanned) {
    if (!wanted.has(item.externalId)) continue;
    if (item.alreadyHere) {
      skipped += 1;
      continue;
    }
    const dest = path.join(destRoot, importedFileName(item.externalId));
    if (!dest.startsWith(destRoot + path.sep) && dest !== destRoot) {
      failed += 1;
      continue;
    }
    try {
      await copyFile(item.sourceFile, dest);
      imported += 1;
    } catch {
      failed += 1;
    }
  }
  return { imported, skipped, failed };
}
