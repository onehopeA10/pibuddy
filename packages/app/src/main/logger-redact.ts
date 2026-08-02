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

/**
 * 键名敏感正则。命中即整值抹掉。
 *
 * `^key$` 是精确匹配而不是子串匹配：写成裸 `key` 会把 `keyboardLayout`、
 * `monkeyPatch` 一并抹掉，那种脱敏产出的日志除了「有东西被抹了」之外
 * 什么都说明不了。
 */
export const SECRET_KEY_RE = /apiKey|authorization|token|secret|password|^key$|^api_key$/i;

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

/**
 * `Bearer <token>`。
 *
 * 终止符里排掉引号与括号：写成 `\S+` 时，`"Authorization":"Bearer abc"`
 * 会把结尾的引号一起吃掉，诊断包里那份 JSON 于是变成语法错误的文本 ——
 * 脱敏不该把证据一起毁掉。
 */
const BEARER_RE = /\bBearer\s+[^\s"'`,;)\]}]+/gi;
/** sk-xxx / ghp_xxx 一类的裸密钥 */
const NAKED_KEY_RE = /\b(?:sk|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9\-_]{8,}/g;

/**
 * 字符串里内嵌的 JSON 片段：`"key": "值"`、`"token":"值"`…
 *
 * 键名保留、值抹掉。整段抹掉会让「哪个字段泄了」这件事也一起消失，
 * 而那正是排查时唯一有用的信息。
 */
const JSON_SECRET_RE =
  /("(?:key|api_?key|token|secret|password|authorization)"\s*:\s*)"[^"]*"/gi;

/**
 * 用户主目录归一为 `~`。
 *
 * 三条正则而不是只用 os.homedir()：诊断包里常常带着**别的机器**写下的
 * 路径（会话 JSONL、错误堆栈、pi 运行时日志），那些路径里的用户名同样是
 * 个人信息，而它们和本机 homedir 对不上。
 */
const WIN_HOME_RE = /[A-Za-z]:[\\/]Users[\\/][^\\/\s"';:*?<>|]+/g;
const NIX_HOME_RE = /\/(?:home|Users)\/[^\\/\s"';:*?<>|]+/g;

const MAX_STRING = 512;
const MAX_DEPTH = 8;

/**
 * 环境变量里那些「名字看起来就是密钥」的**值**。
 *
 * 只收名字命中 SECRET_KEY_RE 且长度 >= 8 的值：短值（`1`、`true`、`zh_CN`）
 * 一旦进来，会把日志里所有出现该字面量的地方都替换成 [redacted]，
 * 结果是一份马赛克。惰性计算 + 缓存，避免每行日志都遍历一遍 process.env。
 */
let envSecretCache: string[] | null = null;
function envSecretValues(): string[] {
  if (envSecretCache) return envSecretCache;
  const out: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!SECRET_KEY_RE.test(name)) continue;
    out.push(value);
  }
  // 长的先替换：短值可能是长值的前缀，先替短的会留下尾巴。
  envSecretCache = out.sort((a, b) => b.length - a.length);
  return envSecretCache;
}

/** 仅供单测：process.env 被改动后清缓存。 */
export function __resetEnvSecretCache(): void {
  envSecretCache = null;
}

/**
 * 字符串脱敏。**唯一的字符串级规则集**，对象路径最终也走到这里。
 *
 * 导出是给 support-bundle 用的：它要脱敏的是整份文本文件，不是结构化字段。
 */
export function redactText(value: string): string {
  let out = value
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(NAKED_KEY_RE, "[redacted]")
    .replace(JSON_SECRET_RE, '$1"[redacted]"');

  for (const secret of envSecretValues()) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }

  const home = os.homedir();
  if (home && out.includes(home)) out = out.split(home).join("~");
  out = out.replace(WIN_HOME_RE, "~").replace(NIX_HOME_RE, "~");

  return out;
}

function redactString(value: string): string {
  const out = redactText(value);
  return out.length > MAX_STRING
    ? `${out.slice(0, MAX_STRING)}…(+${out.length - MAX_STRING})`
    : out;
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
