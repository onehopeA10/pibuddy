/**
 * 文本文件的读与写（FS-101）。
 *
 * ## 冲突判据只有一个：内容 hash
 *
 * mtime 单独不足以判定冲突，反过来也不足以判定「没冲突」：
 *   - 只看 mtime → 一次 `git checkout` 之后 mtime 变了但内容没变，用户会
 *     被弹一个莫名其妙的冲突框（误报，而误报会训练用户闭眼点「覆盖」）；
 *   - 只看 mtime → 一秒内的两次写在部分文件系统上 mtime 相同（漏报，
 *     而漏报就是静默覆盖别人的修改）。
 * 因此 baseMtimeMs 只作为「值不值得重算」的提示，**唯一有决定权的是
 * sha256**：落盘之前重新读一遍磁盘字节算 hash，与调用方持有的 base 不符
 * 就一个字节都不写。
 *
 * ## 编码与换行原样保留
 *
 * 「顺手把 CRLF 规范化成 LF」在一个团队仓库里等于把整个文件标成改动。
 * 读的时候把换行归一成 LF 交给编辑器（CodeMirror 只认 \n），写的时候按
 * 磁盘上原有的风格还原回去。
 *
 * GBK 文件**只读不写**：Node 内建只有 UTF-8 编码器，把 GBK 文件按 UTF-8
 * 写回会让用户在别的工具里看到一整屏乱码。宁可明确拒绝并说清楚原因，
 * 也不做一次看不见的破坏。
 */
import type {
  FileReadResult,
  FileSaveResult,
  TextEncodingLabel,
  NewlineStyle,
} from "@pibuddy/contract";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";

import { writeFileAtomic } from "../fs-atomic.js";
import { resolveInWorkspace } from "../workspace-registry.js";

/** 单个可编辑文件的字节上限。超过它编辑器不打开，只给摘要。 */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

/** 冲突对话框里「磁盘当前内容」的预览长度。 */
export const CONFLICT_PREVIEW_CHARS = 2000;

export function sha256Of(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------- 编码探测

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * 判定一段字节的文本编码。
 *
 * 顺序是有理由的：BOM 是确定性证据，先看它；没有 BOM 就用**严格**
 * UTF-8 解码（fatal:true）试一次，能过就是 UTF-8（ASCII 是它的子集）；
 * 过不了的，在中文环境里几乎只剩 GBK —— 再往下猜收益已经为负。
 * 含 NUL 字节的一律当二进制：那不是编码问题，是根本不该往编辑器里塞。
 */
export function detectEncoding(buffer: Uint8Array): TextEncodingLabel {
  if (buffer.length >= 3 && UTF8_BOM.every((b, i) => buffer[i] === b)) return "utf8-bom";
  // 只看前 8KB：整文件扫 NUL 对几十 MB 的文件是白花的时间
  const head = buffer.subarray(0, 8192);
  for (const byte of head) {
    if (byte === 0) return "binary";
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return "utf8";
  } catch {
    // 严格 UTF-8 解不动
  }
  try {
    new TextDecoder("gbk", { fatal: true }).decode(buffer);
    return "gbk";
  } catch {
    return "binary";
  }
}

/** 有一个 CRLF 就算 CRLF 文件：混合换行的文件按多数派处理没有意义。 */
export function detectNewline(text: string): NewlineStyle {
  return text.includes("\r\n") ? "crlf" : "lf";
}

function decode(buffer: Uint8Array, encoding: TextEncodingLabel): string {
  if (encoding === "utf8-bom") return new TextDecoder("utf-8").decode(buffer.subarray(3));
  if (encoding === "gbk") return new TextDecoder("gbk").decode(buffer);
  return new TextDecoder("utf-8").decode(buffer);
}

/** 归一到 LF 交给编辑器；写回时再按原风格还原。 */
function toLf(text: string): string {
  return text.split("\r\n").join("\n");
}

function applyNewline(text: string, newline: NewlineStyle): string {
  const lf = toLf(text);
  return newline === "crlf" ? lf.split("\n").join("\r\n") : lf;
}

function encodeOut(text: string, encoding: TextEncodingLabel): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (encoding !== "utf8-bom") return bytes;
  const out = new Uint8Array(bytes.length + 3);
  out.set(UTF8_BOM, 0);
  out.set(bytes, 3);
  return out;
}

// ---------------------------------------------------------------- 读

export interface ReadFileParams {
  workspaceId: string;
  relativePath: string;
}

export async function readFile(params: ReadFileParams): Promise<FileReadResult> {
  const resolved = await resolveInWorkspace(params.workspaceId, params.relativePath, {
    requireFile: true,
  });
  const stat = await fsp.stat(resolved.realPath);
  const posixRel = resolved.relativePath.split(/[\\/]/).join("/");

  if (stat.size > MAX_EDITABLE_BYTES) {
    return {
      relativePath: posixRel,
      content: "",
      encoding: "binary",
      newline: "lf",
      mtimeMs: stat.mtimeMs,
      sha256: "",
      sizeBytes: stat.size,
      binary: false,
      tooLarge: true,
    };
  }

  const buffer = await fsp.readFile(resolved.realPath);
  const encoding = detectEncoding(buffer);
  if (encoding === "binary") {
    return {
      relativePath: posixRel,
      content: "",
      encoding,
      newline: "lf",
      mtimeMs: stat.mtimeMs,
      sha256: sha256Of(buffer),
      sizeBytes: stat.size,
      binary: true,
      tooLarge: false,
    };
  }

  const raw = decode(buffer, encoding);
  return {
    relativePath: posixRel,
    content: toLf(raw),
    encoding,
    newline: detectNewline(raw),
    mtimeMs: stat.mtimeMs,
    sha256: sha256Of(buffer),
    sizeBytes: stat.size,
    binary: false,
    tooLarge: false,
  };
}

// ---------------------------------------------------------------- 写

/**
 * 写入的**测试接缝**。
 *
 * 磁盘满（ENOSPC）没有别的办法在单测里制造出来，而「磁盘满时报的是不是
 * 人话」恰恰是最需要被测到的分支之一 —— 那是用户最慌的时刻。
 */
export type FileWriteFn = (absPath: string, data: Uint8Array) => void;

const defaultWrite: FileWriteFn = (absPath, data) => writeFileAtomic(absPath, data);
let writeImpl: FileWriteFn = defaultWrite;

/** 仅供单测：替换底层写入实现（传 null 还原）。 */
export function __setFileWriter(fn: FileWriteFn | null): void {
  writeImpl = fn ?? defaultWrite;
}

/** 把 fs 的 errno 翻译成用户能据以行动的分类。 */
export function classifyWriteError(err: unknown): { errorCode: FileSaveResult["errorCode"]; message: string } {
  const code = (err as NodeJS.ErrnoException).code ?? "";
  const message = (err as Error).message ?? String(err);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return { errorCode: "permission", message: "没有写入权限（文件或所在目录是只读的）" };
  }
  if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG") {
    return { errorCode: "disk", message: "磁盘空间不足，没有写入任何内容" };
  }
  if (code === "ENOENT") {
    return { errorCode: "missing", message: "文件已不存在（可能被外部删除）" };
  }
  return { errorCode: "disk", message };
}

export interface SaveFileParams {
  workspaceId: string;
  relativePath: string;
  content: string;
  baseMtimeMs: number;
  baseSha256: string;
  overwrite?: boolean;
}

/**
 * 保存文件。
 *
 * 返回 `{conflict:true}` 时**没有写入任何字节** —— 这是这个函数存在的
 * 全部意义：两个编辑器同时改同一个文件时，后保存的那个不能悄悄赢。
 */
export async function saveFile(params: SaveFileParams): Promise<FileSaveResult> {
  let resolved;
  try {
    resolved = await resolveInWorkspace(params.workspaceId, params.relativePath, {
      requireFile: true,
    });
  } catch (err) {
    return { ok: false, errorCode: "missing", message: (err as Error).message };
  }

  const buffer = await fsp.readFile(resolved.realPath);
  const stat = await fsp.stat(resolved.realPath);
  const currentSha = sha256Of(buffer);
  const encoding = detectEncoding(buffer);

  if (encoding === "binary") {
    return { ok: false, errorCode: "encoding", message: "二进制文件不支持文本编辑" };
  }
  if (encoding === "gbk") {
    return {
      ok: false,
      errorCode: "encoding",
      message: "这是一个 GBK 编码的文件，暂不支持在 PiBuddy 里保存（避免写成乱码）",
    };
  }

  // 冲突判定：唯一权威是 sha256。baseMtimeMs 变了但 hash 一致属于正常情况
  // （touch / checkout / 同内容重写），必须放行，否则就是误报。
  if (!params.overwrite && currentSha !== params.baseSha256) {
    const text = decode(buffer, encoding);
    return {
      ok: false,
      conflict: true,
      errorCode: "conflict",
      current: {
        mtimeMs: stat.mtimeMs,
        sha256: currentSha,
        preview: toLf(text).slice(0, CONFLICT_PREVIEW_CHARS),
      },
    };
  }

  const newline = detectNewline(decode(buffer, encoding));
  const out = encodeOut(applyNewline(params.content, newline), encoding);
  try {
    writeImpl(resolved.realPath, out);
  } catch (err) {
    return { ok: false, ...classifyWriteError(err) };
  }

  const after = await fsp.stat(resolved.realPath);
  return { ok: true, mtimeMs: after.mtimeMs, sha256: sha256Of(out) };
}
