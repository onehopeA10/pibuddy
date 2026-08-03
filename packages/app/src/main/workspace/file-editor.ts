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
 *
 * ## 读-比-写必须在同一把锁里
 *
 * 「先读文件算 hash、比一下、再写」这三步之间只要有 await，冲突判定就是
 * 假的：两次并发保存会**同时**通过判定（两边读到的都是同一份旧内容），
 * 然后后写的那个静默盖掉先写的那个 —— 冲突对话框一次都不会弹，用户以为
 * 两次保存都成功了。这不是理论上的窗口，saveFile 里 resolveInWorkspace 与
 * readFile 两个 await 保证了并发调用一定会在这里交错。
 *
 * 因此本文件按**真实路径**串行化写入（withPathLock），并且在真正落盘的
 * 前一刻，透过**同一个打开的文件句柄**再验一次 hash。锁消灭了进程内的
 * 竞争；句柄复验把「外部编辑器插进来」的窗口从整个函数体收窄到 rename
 * 那一瞬间。
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

/**
 * 「外部编辑器在读-比-写之间插进来」的**测试接缝**。
 *
 * 和 __setFileWriter 同一个理由：这个时序在单测里没有别的办法制造出来，
 * 而它恰恰是最贵的一个分支 —— 判错的后果是别人的修改被静默抹掉。钩子在
 * 冲突判定之后、落盘之前触发，正是那个窗口本身。
 */
export type PreWriteHook = (absPath: string) => void | Promise<void>;
let preWriteHook: PreWriteHook | null = null;

/** 仅供单测：注册落盘前的钩子（传 null 卸载）。 */
export function __setPreWriteHook(fn: PreWriteHook | null): void {
  preWriteHook = fn;
}

// ------------------------------------------------------------ 按路径串行

/**
 * 同一个真实路径上的写入队列。
 *
 * key 用 realPath；Windows 上大小写不敏感，同一个文件可以用两种拼法进来，
 * 不折叠大小写的话两把「锁」互不相识，串行化就等于没做。
 */
const pathLocks = new Map<string, Promise<unknown>>();

function lockKey(absPath: string): string {
  return process.platform === "win32" ? absPath.toLowerCase() : absPath;
}

/** 当前排队中的路径数。单测据它断言锁不泄漏。 */
export function pendingWriteLockCount(): number {
  return pathLocks.size;
}

async function withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(absPath);
  const previous = pathLocks.get(key) ?? Promise.resolve();
  // 用 then(fn, fn)：前一个成功还是失败，后一个都要跑 —— 一次保存失败
  // 不能把这个路径上后续的保存全都锁死。
  const run = previous.then(fn, fn);
  // 存进表里的是「不会 reject 的影子」，否则下一个排队者会拿到
  // unhandled rejection，而真正的错误已经被本次调用方接走了。
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  pathLocks.set(key, tail);
  try {
    return await run;
  } finally {
    // 只有队尾才清理：中途清理会让后来者以为路径空闲，串行化当场失效。
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  }
}

/**
 * 从一个已打开的句柄把整个文件读出来。
 *
 * 用显式 position 而不是 handle.readFile()：后者从当前偏移读并推进偏移，
 * 同一个句柄读第二遍会拿到空 buffer —— 而「读第二遍」正是复验的全部内容。
 */
async function readAllFrom(handle: fsp.FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const buf = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buf, 0, buf.length, position);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return Buffer.concat(chunks);
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
 *
 * 整个「读 → 比 hash → 写」在**同一把按路径的锁**里完成，落盘前还透过
 * 同一个文件句柄复验一次。少了这两样，冲突判定在并发下恒真地通过。
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

  return withPathLock(resolved.realPath, () => saveLocked(resolved.realPath, params));
}

/**
 * 锁内「读 → 比 → 定稿」这一段。
 *
 * 返回 `{kind:"result"}` 表示这次保存到此为止（冲突 / 编码不支持），磁盘
 * 一个字节都没动；返回 `{kind:"write"}` 表示复验通过，可以落盘。
 */
type Prepared =
  | { kind: "result"; result: FileSaveResult }
  | { kind: "write"; out: Uint8Array };

async function prepareWrite(realPath: string, params: SaveFileParams): Promise<Prepared> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(realPath, "r");
  } catch (err) {
    return { kind: "result", result: { ok: false, ...classifyWriteError(err) } };
  }

  try {
    const buffer = await readAllFrom(handle);
    const stat = await handle.stat();
    const currentSha = sha256Of(buffer);
    const encoding = detectEncoding(buffer);

    if (encoding === "binary") {
      return binaryRejection();
    }
    if (encoding === "gbk") {
      return {
        kind: "result",
        result: {
          ok: false,
          errorCode: "encoding",
          message: "这是一个 GBK 编码的文件，暂不支持在 PiBuddy 里保存（避免写成乱码）",
        },
      };
    }

    // 冲突判定：唯一权威是 sha256。baseMtimeMs 变了但 hash 一致属于正常情况
    // （touch / checkout / 同内容重写），必须放行，否则就是误报。
    if (!params.overwrite && currentSha !== params.baseSha256) {
      return { kind: "result", result: conflictOf(buffer, encoding, stat.mtimeMs, currentSha) };
    }

    const newline = detectNewline(decode(buffer, encoding));
    const out = encodeOut(applyNewline(params.content, newline), encoding);

    await preWriteHook?.(realPath);

    // 落盘前的最后一次复验：走同一个句柄再读一遍。编码/换行都已经按上面
    // 那份字节算好了，这里只判「磁盘还是不是我比过的那一份」。
    if (!params.overwrite) {
      const again = await readAllFrom(handle);
      const againSha = sha256Of(again);
      if (againSha !== currentSha) {
        const againStat = await handle.stat();
        const againEncoding = detectEncoding(again);
        if (againEncoding === "binary") return binaryRejection();
        return {
          kind: "result",
          result: conflictOf(again, againEncoding, againStat.mtimeMs, againSha),
        };
      }
    }

    return { kind: "write", out };
  } finally {
    // 句柄在落盘之前关掉：writeFileAtomic 最后一步是 rename 覆盖目标，
    // Windows 上顶着一个自己打开的句柄去替换同一个文件是在自找 EPERM。
    // 此刻仍在锁内，进程内不会有第二个写者插进来。
    await handle.close().catch(() => undefined);
  }
}

function binaryRejection(): Prepared {
  return {
    kind: "result",
    result: { ok: false, errorCode: "encoding", message: "二进制文件不支持文本编辑" },
  };
}

/** 锁内的实际保存。进入这里时，同一路径上不会有第二个写者。 */
async function saveLocked(realPath: string, params: SaveFileParams): Promise<FileSaveResult> {
  const prepared = await prepareWrite(realPath, params);
  if (prepared.kind === "result") return prepared.result;

  try {
    writeImpl(realPath, prepared.out);
  } catch (err) {
    return { ok: false, ...classifyWriteError(err) };
  }

  const after = await fsp.stat(realPath);
  return { ok: true, mtimeMs: after.mtimeMs, sha256: sha256Of(prepared.out) };
}

function conflictOf(
  buffer: Uint8Array,
  encoding: TextEncodingLabel,
  mtimeMs: number,
  sha256: string
): FileSaveResult {
  return {
    ok: false,
    conflict: true,
    errorCode: "conflict",
    current: {
      mtimeMs,
      sha256,
      preview: toLf(decode(buffer, encoding)).slice(0, CONFLICT_PREVIEW_CHARS),
    },
  };
}
