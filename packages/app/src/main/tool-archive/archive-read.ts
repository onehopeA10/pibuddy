/**
 * 归档的恢复读取（tool-archive）——**严格有界**。
 *
 * ## 有界化不是优化，是正确性
 *
 * 这个工具自己也走 tool bridge，回包同样要过 `bridge-guard` 那道护栏。
 * 如果一次读取能把整份归档吐回来，那份回包必然又超阈值 → 又被归档 →
 * 模型再去读那份归档 → 又超阈值……**死循环**。所以响应必须严格小于归档
 * 阈值，而且这条自指约束要写死在工具描述里（见 manifest 与 extension）。
 *
 * ## 界画在「估算 token」上而不是「字符数」上
 *
 * 参考实现按字符二分（默认 4000 字符 / 响应总上限 7500 字符）。**照抄会
 * 错**：7500 个字符如果全是中文，按重标定后的估算是 11250 token，远超
 * 2048 的归档阈值——于是读归档的响应自己又被归档了。中文优先产品里，
 * 唯一正确的界是 token 的界。这里取 `TOOL_ARCHIVE_READ_MAX_RESPONSE_TOKENS
 * = 1024`，恰是默认阈值 2048 的一半，留足一倍余量。
 *
 * 二分手法沿用参考实现：候选终点 → 整包序列化 → 估算 → 收敛到「装得下的
 * 最大一页」。判据作用在**整个响应对象**上而不是 content 片段上，元数据
 * 的体积因此也被算进去了。
 */
import {
  homeReadArchivedResultArgsSchema,
  type HomeReadArchivedResultArgs,
} from "@pibuddy/contract";

import { readToolResultArchive, type ToolArchiveReadFailureReason } from "./archive-store.js";
import { parseToolArchiveRef, serializeToolResult } from "./result-guard.js";
import { estimateTokens } from "./token-estimate.js";

/** 响应类别判别符。 */
export const TOOL_ARCHIVE_READ_KIND = "pibuddy.tool_result_archive";

/** 不传 limit 时的请求页宽（字符）。真正的界是下面那条 token 上限。 */
export const TOOL_ARCHIVE_READ_DEFAULT_LIMIT = 4000;

/**
 * 单次响应的估算 token 硬上限。
 *
 * 必须**显著低于**归档阈值（默认 2048），否则读归档会触发新一轮归档。
 * 取一半：既留足余量，也不至于把页面切得太碎（纯中文一页约 600 字，
 * 纯 ASCII 一页约 4000 字符）。
 */
export const TOOL_ARCHIVE_READ_MAX_RESPONSE_TOKENS = 1024;

export interface ArchiveReadPage {
  ok: true;
  kind: typeof TOOL_ARCHIVE_READ_KIND;
  ref: string;
  toolName: string;
  offset: number;
  /** 本页实际返回的字符数（可能小于请求的 limit——被 token 上限收窄了）。 */
  limit: number;
  totalChars: number;
  nextOffset: number | null;
  hasMore: boolean;
  content: string;
}

export interface ArchiveReadFailure {
  ok: false;
  kind: typeof TOOL_ARCHIVE_READ_KIND;
  ref: string;
  reason: ToolArchiveReadFailureReason | "invalid_args" | "invalid_ref";
}

export type ArchiveReadResponse = ArchiveReadPage | ArchiveReadFailure;

function failure(ref: string, reason: ArchiveReadFailure["reason"]): ArchiveReadFailure {
  return { ok: false, kind: TOOL_ARCHIVE_READ_KIND, ref, reason };
}

/**
 * 二分逼近「整包装得下」的最大一页。
 *
 * 至少推进 1 个字符：否则 `nextOffset === offset`，模型会原地打转。单个
 * 字符撑不爆 1024 token 的上限，这条兜底不会真的破界。
 */
function boundedPage(input: {
  ref: string;
  toolName: string;
  content: string;
  offset: number;
  limit: number;
}): ArchiveReadPage {
  const offset = Math.min(input.offset, input.content.length);
  const requestedEnd = Math.min(input.content.length, offset + input.limit);
  const build = (end: number): ArchiveReadPage => ({
    ok: true,
    kind: TOOL_ARCHIVE_READ_KIND,
    ref: input.ref,
    toolName: input.toolName,
    offset,
    limit: end - offset,
    totalChars: input.content.length,
    nextOffset: end < input.content.length ? end : null,
    hasMore: end < input.content.length,
    content: input.content.slice(offset, end),
  });

  let low = offset;
  let high = requestedEnd;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const fits =
      estimateTokens(serializeToolResult(build(candidate))) <=
      TOOL_ARCHIVE_READ_MAX_RESPONSE_TOKENS;
    if (fits) low = candidate;
    else high = candidate - 1;
  }
  return build(Math.max(low, Math.min(offset + 1, input.content.length)));
}

/**
 * 读回一段归档。工作区由调用方（home-ipc 的执行面）从 cwd 解析后传入，
 * 落盘侧再逐条复验前四关——这里不重复那四关，也不绕过它们。
 */
export async function readArchivedToolResult(
  workspaceId: string,
  args: unknown
): Promise<ArchiveReadResponse> {
  const parsedArgs = homeReadArchivedResultArgsSchema.safeParse(args);
  if (!parsedArgs.success) {
    const ref = typeof (args as { ref?: unknown } | null)?.ref === "string"
      ? String((args as { ref: string }).ref)
      : "";
    return failure(ref, "invalid_args");
  }
  const request: HomeReadArchivedResultArgs = parsedArgs.data;

  const identity = parseToolArchiveRef(request.ref);
  if (identity === null) return failure(request.ref, "invalid_ref");

  const read = await readToolResultArchive({ ...identity, workspaceId });
  if (!read.ok) return failure(request.ref, read.reason);

  return boundedPage({
    ref: request.ref,
    toolName: read.toolName,
    content: read.serializedResult,
    offset: request.offset ?? 0,
    limit: request.limit ?? TOOL_ARCHIVE_READ_DEFAULT_LIMIT,
  });
}
