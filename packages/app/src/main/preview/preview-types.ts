/**
 * 预览域的类型投影与扩展名判定（ART-101）。
 *
 * 十类 PreviewKind 与六类错误码的**定义**住在 `@pibuddy/contract/preview.ts`
 * （契约唯一性，裁定6），本文件一个 `export type` 都不重复它们，只做两件
 * 契约管不着的事：
 *
 *   1. 扩展名 → PreviewKind 的分派表；
 *   2. 转换宿主与 worker 之间的**进程间消息形状**——那是两个 Node 进程
 *      之间的私有协议，不跨 IPC 边界，因此不属于契约包。
 */
import type { PreviewCode, PreviewKind, PreviewResult } from "@pibuddy/contract";

/**
 * 扩展名 → 内容类别。
 *
 * 判定只看扩展名是刻意的：真正的安全边界是「转换跑在受限进程里」和
 * 「预览窗口不执行脚本」，而不是「我们猜对了它是什么」。猜错的代价
 * 只是解析失败并返回一个 `unsupported`，不会有任何字节被执行。
 */
const KIND_BY_EXT: Record<string, PreviewKind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".log": "text",
  ".ts": "text",
  ".tsx": "text",
  ".js": "text",
  ".jsx": "text",
  ".mjs": "text",
  ".cjs": "text",
  ".py": "text",
  ".java": "text",
  ".go": "text",
  ".rs": "text",
  ".c": "text",
  ".h": "text",
  ".cpp": "text",
  ".cs": "text",
  ".sh": "text",
  ".yml": "text",
  ".yaml": "text",
  ".toml": "text",
  ".ini": "text",
  ".xml": "text",
  ".html": "text",
  ".css": "text",
  ".sql": "text",
  ".json": "json",
  ".jsonl": "json",
  ".csv": "csv",
  ".tsv": "csv",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".svg": "image",
  ".mp3": "media-metadata",
  ".wav": "media-metadata",
  ".m4a": "media-metadata",
  ".flac": "media-metadata",
  ".ogg": "media-metadata",
  ".mp4": "media-metadata",
  ".mov": "media-metadata",
  ".webm": "media-metadata",
  ".mkv": "media-metadata",
  ".avi": "media-metadata",
  ".pdf": "pdf",
  ".doc": "word",
  ".docx": "word",
  ".docm": "word",
  ".xls": "excel",
  ".xlsx": "excel",
  ".xlsm": "excel",
  ".ppt": "ppt",
  ".pptx": "ppt",
  ".pptm": "ppt",
};

/** 扩展名（含点，小写）→ PreviewKind；表里没有的一律按 `text` 走文本嗅探。 */
export function kindForExtension(ext: string): PreviewKind | null {
  return KIND_BY_EXT[ext.toLowerCase()] ?? null;
}

/** 本文件已知的全部扩展名，供诊断与单测枚举。 */
export function knownPreviewExtensions(): string[] {
  return Object.keys(KIND_BY_EXT);
}

/** 宿主 → worker 的请求。只有一个输入路径和一个专属输出目录，别的都没有。 */
export interface ConvertRequest {
  requestId: string;
  /** 已经过收容校验的输入文件绝对路径 */
  inputPath: string;
  /** 本次转换专属的临时输出目录 */
  outputDir: string;
  sourceName: string;
  sizeBytes: number;
  /** 抽取文本的字符上限，超出即截断（防止一个 400MB 的 csv 打满内存） */
  maxTextChars: number;
}

/** worker → 宿主的回复。`result` 是完整的 PreviewResult。 */
export interface ConvertReply {
  requestId: string;
  result: PreviewResult;
}

/** 宿主侧对外的结果形状：成功带 result，失败只带 code。 */
export type ConvertOutcome =
  | { ok: true; result: PreviewResult }
  | { ok: false; code: PreviewCode };
