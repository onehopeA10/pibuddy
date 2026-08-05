/**
 * 工具结果护栏：判定 + 占位符构造（tool-archive）。
 *
 * ## 这道闸在回答什么
 *
 * `HOME_BRIDGE_MAX_LINE_BYTES = 256KB` 是**传输**上界，超了拒收整行。过了
 * 那道闸的体量直接进 pi 的上下文——256KB 全中文的一行约 13 万真实 token
 * （旧口径 `chars/4` 只报 2.2 万，见 token-estimate.ts 的标定）。工具侧
 * `limit ≤ 50` 那种查询级约束只是粗糙兜底：50 个带完整属性的实体照样很大。
 *
 * 目标形态：**工具执行 → 完整结果先落归档（文件旁路，不受 256KB 限制）→
 * 回包只传占位符或原文**。256KB 从此是「永远不会被触及的安全网」而不是
 * 截断点。
 *
 * ## 六条不变式在代码里的落点
 *
 *   1. **只改回包，不改归档**：归档里存的恒是 `serializeToolResult(result)`
 *      的完整原文；占位符只出现在返回值里。
 *   2. **归档成功之前不得构造占位符**：这是**代码结构保证**——下面
 *      `guardToolResult` 里「归档失败即 return」的那一行之后才出现
 *      `placeholder` 的构造语句。「先建占位符再补 id」在这个结构里写不出来。
 *   3. **fail-open 三种失败等价**：archive 抛错 / 返回 undefined / artifactId
 *      空或全空白，一律保留原文 + 计一次 `archiveFailures`，三种在计数上
 *      不可区分。
 *   4. **占位符自带可恢复引用**：artifactId / bodySha256 / originalBytes /
 *      originalEstimatedTokens / toolName / reason + readInstructions。
 *   5. 恢复读取的有界化在 `archive-read.ts`（否则读归档会触发新一轮归档）。
 *   6. 读回的前四校验在 `archive-store.ts`。
 *
 * ## `archiveFailures > 0` 是最该盯的告警
 *
 * 它的含义是「上下文没省下来**且**原文还在」——即降级回旧行为。护栏没起
 * 作用，但也没弄丢任何东西；真正的风险是它一直涨而没人看见。
 */
import { createHash } from "node:crypto";

import { estimateTokens } from "./token-estimate.js";
import type { ToolArchiveWriteInput } from "./archive-store.js";

/** 占位符的类别判别符。模型侧、我们侧都靠它认出「这不是结果，是引用」。 */
export const ARCHIVED_TOOL_RESULT_KIND = "pibuddy.archived_tool_result";

/** 归档原因。目前只有一种，留成字面量类型是为了将来加第二种时全站编译期对齐。 */
export const ARCHIVED_TOOL_RESULT_REASON = "tool_result_archived_before_reply";

/**
 * 默认阈值：估算 token 超过它就归档。
 *
 * 2048 与参考实现同一个数字，但**含义完全不同**：重标定之后这 2048 是
 * 真实 token，纯中文约 1366 字、纯 ASCII 约 8192 字符就触发；旧口径下
 * 同一个 2048 要到 8192 个字符才触发，中文场景实际约合 12000 真实 token。
 *
 * 取 2048 的依据（实测，见 token-estimate.ts）：`list_entities` 正常返回
 * 50 行紧凑行约 700 token（不归档，正常路径零影响）；同样 50 个实体的
 * **全属性** JSON 约 5400 token（归档，正是要挡的那一类）。2048 落在这两
 * 者之间且离两边都有余量。
 */
export const DEFAULT_TOOL_ARCHIVE_MAX_ESTIMATED_TOKENS = 2048;

let configuredMaxEstimatedTokens = DEFAULT_TOOL_ARCHIVE_MAX_ESTIMATED_TOKENS;

/** 当前阈值。 */
export function toolArchiveMaxEstimatedTokens(): number {
  return configuredMaxEstimatedTokens;
}

/** 改阈值；传 null 复位为默认值。非正数一律忽略（阈值 ≤ 0 等于全归档）。 */
export function setToolArchiveMaxEstimatedTokens(value: number | null): void {
  if (value === null) {
    configuredMaxEstimatedTokens = DEFAULT_TOOL_ARCHIVE_MAX_ESTIMATED_TOKENS;
    return;
  }
  if (!Number.isFinite(value) || value <= 0) return;
  configuredMaxEstimatedTokens = Math.floor(value);
}

// ---------------------------------------------------------------- 可恢复引用

const REF_PREFIX = "pibuddy://tool-archive/";

export interface ToolArchiveRef {
  artifactId: string;
  bodySha256: string;
  originalBytes: number;
}

/** 占位符里那条「拿去读回来」的引用。 */
export function buildToolArchiveRef(input: ToolArchiveRef): string {
  return (
    `${REF_PREFIX}${encodeURIComponent(input.artifactId)}` +
    `?sha256=${encodeURIComponent(input.bodySha256)}&bytes=${input.originalBytes}`
  );
}

/**
 * 解析引用。形态不对一律返回 null——**绝不猜**：猜错的下场是拿别的归档的
 * 内容去满足这次读取。
 */
export function parseToolArchiveRef(ref: unknown): ToolArchiveRef | null {
  if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX)) return null;
  const rest = ref.slice(REF_PREFIX.length);
  const q = rest.indexOf("?");
  if (q < 0) return null;
  let artifactId: string;
  try {
    artifactId = decodeURIComponent(rest.slice(0, q));
  } catch {
    return null;
  }
  const params = new URLSearchParams(rest.slice(q + 1));
  const keys = [...params.keys()];
  if (keys.length !== 2 || !keys.includes("sha256") || !keys.includes("bytes")) return null;
  const bodySha256 = params.get("sha256") ?? "";
  const bytesText = params.get("bytes") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(bodySha256) || !/^[1-9][0-9]*$/.test(bytesText)) return null;
  const originalBytes = Number(bytesText);
  if (!Number.isSafeInteger(originalBytes)) return null;
  return { artifactId, bodySha256, originalBytes };
}

// ---------------------------------------------------------------- 占位符

/**
 * 给模型的恢复指引。
 *
 * 最后一句是**负向引导**，照抄参考实现里那句实测出来的经验（"Do not use
 * Glob to find the archive."）：模型看见「归档」两个字的第一反应是去文件
 * 系统里翻，而归档根本不在工作区里——不明写这一句，它会白白烧掉几轮工具
 * 调用去找一个找不到的文件。
 */
export const ARCHIVED_TOOL_RESULT_READ_INSTRUCTIONS =
  "这条工具结果太大，已完整归档（一个字都没丢），这里只留引用。" +
  "调用 home.assistant.read_archived_result 工具、把本对象的 ref 原样传进去即可读回；" +
  "返回内容是分页的，按响应里的 nextOffset 继续读下一页。" +
  "不要用 Glob / 文件搜索去找归档文件——它不在工作区里，只能经这个工具读。";

export interface ArchivedToolResultPlaceholder {
  kind: typeof ARCHIVED_TOOL_RESULT_KIND;
  ref: string;
  artifactId: string;
  bodySha256: string;
  originalBytes: number;
  originalEstimatedTokens: number;
  toolName: string;
  reason: typeof ARCHIVED_TOOL_RESULT_REASON;
  readInstructions: string;
}

/** 认出一个值是不是占位符（已归档的结果不该被二次归档）。 */
export function isArchivedToolResultPlaceholder(
  value: unknown
): value is ArchivedToolResultPlaceholder {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Partial<ArchivedToolResultPlaceholder>).kind === ARCHIVED_TOOL_RESULT_KIND
  );
}

// ---------------------------------------------------------------- 判定

/**
 * 结果 → 归档用的字符串形态。
 *
 * 与回包里 `JSON.stringify` 看到的是同一份内容，因此估算出来的 token 数
 * 就是真会进上下文的那一份，不多不少。
 */
export function serializeToolResult(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface ToolResultGuardInput {
  toolName: string;
  /** 归档隔离域；解析不出工作区时为 null（视同归档不可用 → fail-open）。 */
  workspaceId: string | null;
  result: unknown;
  /** 覆盖阈值（不传取当前配置值）。 */
  maxEstimatedTokens?: number;
  /**
   * 归档动作。三种失败等价：抛错 / 返回 undefined / artifactId 空或全空白。
   */
  archive: (
    input: ToolArchiveWriteInput
  ) => Promise<{ artifactId?: string } | void | undefined> | { artifactId?: string } | void;
}

export interface ToolResultGuardOutcome {
  /** 回包里该放的东西：占位符（已归档）或原文（未超阈值 / 归档失败）。 */
  result: unknown;
  archived: boolean;
  archiveFailed: boolean;
  estimatedTokensSaved: number;
}

/**
 * 判定 + 归档 + 构造占位符。
 *
 * `archive` 是注入的，所以这个函数可以在单测里对拍：把它换成必然失败的
 * 三种形态，断言「原文还在 **且** 占位符不存在」。
 */
export async function guardToolResult(
  input: ToolResultGuardInput
): Promise<ToolResultGuardOutcome> {
  const unchanged: ToolResultGuardOutcome = {
    result: input.result,
    archived: false,
    archiveFailed: false,
    estimatedTokensSaved: 0,
  };
  // 已经是占位符：二次归档只会套娃，且原文早就不在这条路上了。
  if (isArchivedToolResultPlaceholder(input.result)) return unchanged;

  const serializedResult = serializeToolResult(input.result);
  const originalEstimatedTokens = estimateTokens(serializedResult);
  const threshold = input.maxEstimatedTokens ?? configuredMaxEstimatedTokens;
  if (originalEstimatedTokens <= threshold) return unchanged;

  // 超阈值但没有隔离域 = 归档不可用。与 archive 抛错同等对待（不变式 3）。
  if (input.workspaceId === null) {
    return { ...unchanged, archiveFailed: true };
  }

  const originalBytes = Buffer.byteLength(serializedResult, "utf8");
  const bodySha256 = createHash("sha256").update(serializedResult, "utf8").digest("hex");

  let archived: { artifactId?: string } | void | undefined;
  try {
    archived = await Promise.resolve(
      input.archive({
        workspaceId: input.workspaceId,
        toolName: input.toolName,
        bodySha256,
        originalBytes,
        originalEstimatedTokens,
        serializedResult,
      })
    );
  } catch {
    archived = undefined;
  }
  const artifactId = archived === undefined || archived === null ? undefined : archived.artifactId;

  // ★ 不变式 2 的代码结构保证：归档失败即 return。占位符的构造语句物理位于
  //   这一行**之后**——所以「先建占位符再补 id」在这里写不出来。
  //   对拍：删掉这个 early-return，fail-open 用例会同时红在两条断言上
  //   （原文不在了 / 出现了一个 artifactId 为 undefined 的占位符）。
  if (typeof artifactId !== "string" || artifactId.trim() === "") {
    return { ...unchanged, archiveFailed: true };
  }

  const placeholder: ArchivedToolResultPlaceholder = {
    kind: ARCHIVED_TOOL_RESULT_KIND,
    ref: buildToolArchiveRef({ artifactId, bodySha256, originalBytes }),
    artifactId,
    bodySha256,
    originalBytes,
    originalEstimatedTokens,
    toolName: input.toolName,
    reason: ARCHIVED_TOOL_RESULT_REASON,
    readInstructions: ARCHIVED_TOOL_RESULT_READ_INSTRUCTIONS,
  };
  const placeholderTokens = estimateTokens(serializeToolResult(placeholder));
  return {
    result: placeholder,
    archived: true,
    archiveFailed: false,
    estimatedTokensSaved: Math.max(0, originalEstimatedTokens - placeholderTokens),
  };
}
