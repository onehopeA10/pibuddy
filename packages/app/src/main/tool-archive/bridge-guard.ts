/**
 * tool bridge 回包路径上的护栏接线 + 可观测计数（tool-archive）。
 *
 * 纯判定在 `result-guard.ts`（零 electron 依赖、可对拍），落盘在
 * `archive-store.ts`。本文件只做三件事：把两者接起来、记三个计数、
 * **保证自己永远不抛**。
 *
 * ## 为什么必须「永远不抛」
 *
 * 接入点在 `tool-bridge.ts` 的 `onLine` 里、`reply({ok:true})` 之前。那一段
 * 外面裹着 try/catch——护栏一旦抛错，一次**成功**的工具调用会被改写成
 * `{ok:false}` 回给模型。护栏把好结果变成错误，比没有护栏坏得多。
 * 所以这里整体裹 try/catch，任何意外一律回落到原文 + 计一次失败。
 *
 * ## 三个计数的字段只在 >0 时出现
 *
 * 与参考实现同一口径：0 表示为 **undefined 而不是 0**。理由是这三个数进的
 * 是诊断快照，`{}` 与 `{archivedResults: 0}` 在阅读时含义不同——前者是
 * 「这段时间没发生过归档」，后者容易被读成「归档发生了但省下 0」。
 *
 * `archiveFailures > 0` 是上线后最该盯的告警：它意味着「上下文没省下来
 * 且原文还在」，即降级回旧行为。因此它同时打一条 warn 日志。
 */
import { createLogger, type Logger } from "../logger.js";
import { archiveScopeForCwd, writeToolResultArchive } from "./archive-store.js";
import { guardToolResult } from "./result-guard.js";

let logger: Logger | null = null;
function log(): Logger {
  if (!logger) logger = createLogger("home");
  return logger;
}

let archivedResults = 0;
let archiveFailures = 0;
let estimatedTokensSaved = 0;

/** 归档计数快照。**字段只在 >0 时出现**（0 表示为 undefined）。 */
export interface ToolArchiveCounters {
  archivedResults?: number;
  archiveFailures?: number;
  estimatedTokensSaved?: number;
}

export function toolArchiveCounters(): ToolArchiveCounters {
  return {
    ...(archivedResults > 0 ? { archivedResults } : {}),
    ...(archiveFailures > 0 ? { archiveFailures } : {}),
    ...(estimatedTokensSaved > 0 ? { estimatedTokensSaved } : {}),
  };
}

/** 仅供单测：计数归零。 */
export function __resetToolArchiveCounters(): void {
  archivedResults = 0;
  archiveFailures = 0;
  estimatedTokensSaved = 0;
}

/**
 * bridge 回包前的唯一护栏入口：超阈值就先落归档、回包换成占位符；
 * 未超阈值或归档失败一律原样返回原文。
 */
export async function guardBridgeToolResult(
  toolName: string,
  cwd: string | null,
  result: unknown
): Promise<unknown> {
  try {
    const outcome = await guardToolResult({
      toolName,
      workspaceId: archiveScopeForCwd(cwd),
      result,
      archive: writeToolResultArchive,
    });
    if (outcome.archived) {
      archivedResults += 1;
      estimatedTokensSaved += outcome.estimatedTokensSaved;
      // 字段名刻意不含 "token"：logger-redact 的 SECRET_KEY_RE 命中键名里的
      // token 就把值整体换成 [redacted]，那条规则是对的，改名的是我们。
      log().debug("tool_result_archived", {
        tool: toolName,
        savedEstimate: outcome.estimatedTokensSaved,
      });
    } else if (outcome.archiveFailed) {
      archiveFailures += 1;
      // 降级回旧行为：上下文没省下来，但原文一个字都没丢。带上累计次数——
      // 一次是偶发，持续增长才是要处理的事。
      log().warn("tool_result_archive_failed", {
        tool: toolName,
        archiveFailures: toolArchiveCounters().archiveFailures,
      });
    }
    return outcome.result;
  } catch {
    archiveFailures += 1;
    return result;
  }
}
