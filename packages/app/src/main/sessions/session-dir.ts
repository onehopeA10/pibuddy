/**
 * 会话目录解析器（SES-001）——**纯函数模块，不触碰任何文件系统 API**。
 *
 * 为什么单独一个文件：枚举实现会在 M2 被 SQLite 索引版本整体替换，而
 * 「工作目录 → 会话目录」这套换算是与存储形态无关的常量逻辑，必须原样存活。
 *
 * ## 目录名编码必须逐字对齐 pi
 *
 * pi 的真相源在 dist/core/session-manager.js 的 getDefaultSessionDirPath：
 *
 *     const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
 *
 * 关键是**先剥离前导分隔符再做替换**。少了第一步，POSIX 路径 `/home/u`
 * 会被编码成 `---home-u--`（三连字符），与 pi 实际写入的 `--home-u--` 差一个
 * 字符，历史会话列表因此恒为空。
 *
 * 这个缺陷在 Windows 上完全不可见：`D:\x` 与 `C:\Users\yehh` 没有前导分隔符，
 * 两种算法结果一致。所以它的验收只能是跨平台纯函数单测，不能靠手工点界面。
 */
import os from "node:os";
import path from "node:path";
import type { AppSettings } from "@pibuddy/contract";

/**
 * 把一个**已归一化**的绝对路径编码成 pi 的会话子目录名。
 *
 * 入参刻意不做 path.resolve：单测要能在 Windows 上直接喂 POSIX 路径，
 * 一旦经过平台相关的归一化，跨平台缺陷就再也测不出来了。
 */
export function encodeSessionDirSegment(resolvedPath: string): string {
  return `--${resolvedPath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * 四级优先链，与 pi 自身的解析顺序一致：
 *
 *   1. settings.sessionDir                （应用显式配置，等价于 pi 的 --session-dir）
 *   2. PI_CODING_AGENT_SESSION_DIR        （环境变量直接指定会话目录）
 *   3. PI_CODING_AGENT_DIR/sessions/<seg> （环境变量改配置根，会话仍按 cwd 分桶）
 *   4. ~/.pi/agent/sessions/<seg>         （默认）
 *
 * 主进程枚举与 pi 写入必须落在同一个目录，因此启动 pi 时会把本函数的结果
 * 通过 `--session-dir` 一并传下去 —— 两条独立推断路径是 SES-001 的第二个根因。
 */
export function resolveSessionDir(cwd: string, settings: AppSettings): string {
  if (settings.sessionDir) return settings.sessionDir;

  const envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (envSessionDir) return envSessionDir;

  const segment = encodeSessionDirSegment(path.resolve(cwd));
  const envAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (envAgentDir) return path.join(envAgentDir, "sessions", segment);

  return path.join(os.homedir(), ".pi", "agent", "sessions", segment);
}

/**
 * 会话 id 只能当文件名用。带路径分隔符的值不能拼进 sessionDir，
 * 否则「打开会话」会变成任意文件读写。
 */
export function isSafeSessionFileId(sessionId: string): boolean {
  return /^[\w.-]{1,128}$/.test(sessionId);
}

/** 索引还没跟上时，按约定文件名去找同一条会话（文件必须已经存在才能续）。 */
export function sessionFilePath(sessionDir: string, sessionId: string): string {
  if (!isSafeSessionFileId(sessionId)) {
    throw new Error(`SESSION_UNKNOWN: ${sessionId}`);
  }
  return path.join(sessionDir, `${sessionId}.jsonl`);
}

/**
 * 续跑用哪条 jsonl。索引优先；否则只有约定文件真的在磁盘上才用它。
 * 文件还没落盘（pi 惰性写）或已被删掉时返回 null，调用方应改开新会话，
 * 不能把一条不存在的路径丢给 realpath。
 */
export function pickResumeSessionPath(
  indexedPath: string | null,
  fallbackPath: string,
  fallbackExists: boolean
): string | null {
  if (indexedPath) return indexedPath;
  return fallbackExists ? fallbackPath : null;
}
