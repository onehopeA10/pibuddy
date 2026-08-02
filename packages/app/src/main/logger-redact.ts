/**
 * 全仓唯一的脱敏实现（裁定4）。
 *
 * logger.ts、后续 TASK-013 的 support-bundle、TASK-014 的 connectivity 探测
 * 一律 import 本文件，不得各写一份 —— 脱敏规则一旦分叉，总有一份会漏。
 *
 * 三类处理：
 *   1. 键名命中敏感正则 → 值整体替换为 "[redacted]"
 *   2. prompt / message / text 等正文字段 → 只留长度，不留内容
 *   3. 字符串里的 Bearer token 与 home 路径 → 就地替换
 */
import os from "node:os";

/** 键名敏感正则。命中即整值抹掉。 */
export const SECRET_KEY_RE = /apiKey|authorization|token|secret|password/i;

/** 正文字段：不记内容，只记 <name>Length。 */
const BODY_KEYS = new Set(["prompt", "message", "text", "content", "delta", "output"]);

/** 环境变量白名单：只有这些键的**键名**会被记录，值一律不记。 */
export const ENV_KEY_ALLOWLIST = new Set([
  "NODE_ENV",
  "ELECTRON_RENDERER_URL",
  "PI_BIN",
  "PATH",
  "LANG",
]);

const BEARER_RE = /\bBearer\s+[\w.\-+/=]+/gi;
/** sk-xxx / ghp_xxx 一类的裸密钥 */
const NAKED_KEY_RE = /\b(?:sk|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9\-_]{8,}/g;

const MAX_STRING = 512;
const MAX_DEPTH = 8;

function redactString(value: string): string {
  let out = value.replace(BEARER_RE, "Bearer [redacted]").replace(NAKED_KEY_RE, "[redacted]");
  const home = os.homedir();
  if (home && out.includes(home)) out = out.split(home).join("~");
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…(+${out.length - MAX_STRING})`;
  return out;
}

/**
 * 递归脱敏任意结构。返回值一定是可安全 JSON.stringify 的新对象，
 * 不会改动入参。
 */
export function redactSecrets(input: unknown, depth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (depth > MAX_DEPTH) return "[depth-limit]";

  if (typeof input === "string") return redactString(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (typeof input === "bigint") return input.toString();
  if (typeof input === "function") return "[function]";
  if (input instanceof Error) {
    return { name: input.name, message: redactString(input.message) };
  }
  if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
    return `[binary ${"byteLength" in input ? input.byteLength : 0}B]`;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 50).map((item) => redactSecrets(item, depth + 1));
  }
  if (typeof input !== "object") return "[unserializable]";

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (BODY_KEYS.has(key)) {
      out[`${key}Length`] = typeof value === "string" ? value.length : lengthOf(value);
      continue;
    }
    if (key === "env" && value && typeof value === "object") {
      out.envKeys = Object.keys(value as Record<string, unknown>).filter((k) =>
        ENV_KEY_ALLOWLIST.has(k)
      );
      continue;
    }
    out[key] = redactSecrets(value, depth + 1);
  }
  return out;
}

function lengthOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}
