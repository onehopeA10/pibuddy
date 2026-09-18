/**
 * pi-runtime 白名单剪枝（F-003）。
 *
 * 只删明确可丢的 docs / tests / sourcemap / 错平台预编译目录。
 * 入口 dist/cli.js 与 runtime-manifest.json 永不删除。
 * Windows 量体积必须走 realpath，避免 8.3 短路径把同一棵树算两次。
 */
import fs from "node:fs";
import path from "node:path";

const KEEP_BASENAMES = new Set(["runtime-manifest.json", "package.json"]);
const KEEP_RELS = new Set(["dist/cli.js"]);

function posixRel(rel) {
  return rel.split(path.sep).join("/");
}

function wrongPlatformTokens(platform) {
  if (platform === "win32") return ["darwin", "linux", "osx", "macos"];
  if (platform === "darwin") return ["win32", "linux", "windows"];
  return ["darwin", "win32", "osx", "macos", "windows"];
}

export function shouldPrune(rel, platform = process.platform) {
  const n = posixRel(rel);
  const base = path.posix.basename(n);
  if (KEEP_RELS.has(n) || KEEP_BASENAMES.has(base)) return false;
  if (n.endsWith(".map")) return true;
  if (/(^|\/)docs(\/|$)/i.test(n)) return true;
  if (/(^|\/)tests?(\/|$)/i.test(n)) return true;
  if (/^readme/i.test(base)) return true;
  const nativeHint = /(^|\/)(prebuilds|binaries)(\/|$)/i.test(n);
  if (nativeHint) {
    const tokens = wrongPlatformTokens(platform);
    const lower = n.toLowerCase();
    if (tokens.some((t) => lower.includes(`/${t}-`) || lower.includes(`/${t}/`))) {
      return true;
    }
  }
  return false;
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

export function pruneRuntime(root, platform = process.platform) {
  const removed = [];
  for (const full of walkFiles(root)) {
    const rel = path.relative(root, full);
    if (!shouldPrune(rel, platform)) continue;
    fs.rmSync(full, { force: true });
    removed.push(posixRel(rel));
  }
  return removed;
}

export function measureRuntimeBytes(root) {
  const real = fs.realpathSync(root);
  let total = 0;
  for (const full of walkFiles(real)) {
    try {
      total += fs.statSync(full).size;
    } catch {
      /* 剪枝竞态：跳过 */
    }
  }
  return total;
}
