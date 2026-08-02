/**
 * 全计划唯一的附件能力注册表（SEC-003 / 裁定2）。
 *
 * ## 为什么要有 token
 *
 * 收敛前 `file:read-image` 接受渲染进程传来的**任意绝对路径**，唯一的约束是
 * 扩展名查表 —— 也就是说渲染进程里的一行 JS 就能把
 * `C:/Users/.../AppData/Roaming/.../auth.json` 改名思路读成 base64 发给模型。
 * 换成 token 之后，渲染进程持有的只是「刚才用户亲手选中的那一个文件」的
 * 一次性凭证，凭证之外它连磁盘上有什么都问不出来。
 *
 * ## TTL 取 30 分钟滑动过期
 *
 * 5 分钟对「先添加附件、再慢慢打一段长文字」这个再普通不过的操作来说太短
 * （用户会看到附件突然失效）；24 小时对一次性 capability 又太长。取 30 分钟
 * 并**访问即续期**：只要用户还在用它，凭证就一直有效；一旦真的忘了它，
 * 半小时后自动作废。会话切换与应用退出时另外显式撤销全部未消费凭证。
 *
 * ## resolve 时重做全部校验
 *
 * 签发时校验过一次不等于兑付时依然成立：符号链接可以被换掉、文件可以被
 * 替换成一个 20MB 的东西。因此 resolve 里重新 realpath、重新 stat、
 * 重新嗅探 magic bytes，声明的类型与实际字节不符即拒绝。
 */
import { shell } from "electron";
import type { AttachmentDescriptor, AttachmentRef } from "@pibuddy/contract";
import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { assertContained, lookupWorkspace } from "./workspace-registry.js";

/** 30 分钟滑动过期（访问即续期）。 */
export const ATTACHMENT_TTL_MS = 1800000;

/** 单个图片附件的字节上限。超过它的图片对模型也没有意义，只会打满内存。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 附件能力：读成 base64 内联给模型 / 用系统默认程序打开 / 在文件管理器里定位。 */
export type AttachmentCapability = "read" | "open" | "reveal";

/**
 * 访问级别（FS-101 的结构化附件）。
 *
 * 与上面的 `capabilities` 是两个正交的轴：capabilities 说「能拿它做哪几
 * 类动作」（读成 base64 / 打开 / 定位），access 说「能不能往回写」。
 * 分开是因为「读一张图给模型看」和「让 Agent 改这个文件」是完全不同的
 * 授权 —— 用一个数组同时表达两件事，迟早有人把 write 加进那个数组里。
 *
 * **签发即校验**：`resolveAttachment({ access: "read-write" })` 在记录是
 * `read` 时直接拒。只签发不校验的能力字段等于没有能力控制，而且不会有
 * 任何报错 —— 那种字段的存在本身就是误导。
 */
export type AttachmentAccess = "read" | "read-write";

/** 附件类型直接取自契约，避免 main 侧另立一套同名枚举而与渲染侧漂移。 */
export type AttachmentKind = AttachmentRef["kind"];

export interface AttachmentRecord {
  token: string;
  /** 签发时的 canonical realpath —— 只存在于主进程 */
  canonicalPath: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  capabilities: AttachmentCapability[];
  /** 读 / 读写。写请求经 resolveAttachment({access:"read-write"}) 校验 */
  access: AttachmentAccess;
  /** 相对工作区 root 的路径；工作区外的单文件授权取文件名 */
  relativePath: string;
  /** 用于界面显示的来源名（= basename），与 relativePath 分开是为了让
   *  附件条在窄侧栏里也有东西可显示 */
  sourceName: string;
  mimeType: string;
  /** 签发时刻的全文件 sha256，供变更集与冲突检测比对 */
  sha256: string;
  /** 归属工作区；为 null 表示由用户经系统文件对话框显式授权的单文件 */
  workspaceId: string | null;
  /** 归属会话；会话切换时按它批量撤销 */
  sessionId: string | null;
  /** 绝对过期时刻（Unix ms），每次成功访问后顺延 ATTACHMENT_TTL_MS */
  expiresAt: number;
}

const tokens = new Map<string, AttachmentRecord>();

/**
 * 访问即续期：把过期时刻顺延一个完整的 TTL。
 *
 * 这就是「滑动」的全部含义 —— 判据是「距最后一次使用是否超过 30 分钟」，
 * 而不是「距签发是否超过 30 分钟」。
 */
function renewOnAccess(record: AttachmentRecord, now: number): void {
  record.expiresAt = now + ATTACHMENT_TTL_MS;
}

function sweep(now: number): void {
  for (const [token, record] of tokens) {
    if (record.expiresAt <= now) tokens.delete(token);
  }
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv"]);

export function kindOf(filePath: string): AttachmentKind {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "other";
}

/**
 * 按扩展名给出声明 MIME。
 *
 * 声明值只是给 UI 显示与给模型做提示用的：图片的**真实**类型由 readImage
 * 里的 magic bytes 判定，那里才是有安全含义的那一处。这里不做嗅探是
 * 刻意的 —— 为了填一个显示字段去把每个附件读一遍首字节不划算。
 */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".zip": "application/zip",
};

export function mimeTypeOf(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// ---------------------------------------------------------------- magic bytes

interface ImageSignature {
  mimeType: string;
  /** null 表示该位任意（用于 WEBP 的 RIFF 长度字段） */
  bytes: (number | null)[];
}

/**
 * 图片格式的首字节签名。
 *
 * 扩展名是攻击者可控的字符串，字节不是：把一个 PE 可执行文件改名成 .png
 * 之后，扩展名查表会放行，magic bytes 不会。
 */
const IMAGE_SIGNATURES: ImageSignature[] = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JPEG: FF D8 FF
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  // GIF: 47 49 46 38 ("GIF8")
  { mimeType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  // WEBP: 52 49 46 46 xx xx xx xx 57 45 42 50 ("RIFF"…"WEBP")
  {
    mimeType: "image/webp",
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
  // BMP: 42 4D ("BM")
  { mimeType: "image/bmp", bytes: [0x42, 0x4d] },
];

/** 按首字节判定真实图片类型；不是已知图片格式返回 null。 */
export function sniffImageMime(head: Uint8Array): string | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (head.length < sig.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      const expected = sig.bytes[i];
      if (expected === null) continue;
      if (head[i] !== expected) {
        ok = false;
        break;
      }
    }
    if (ok) return sig.mimeType;
  }
  return null;
}

// ---------------------------------------------------------------- 签发

export interface IssueOptions {
  workspaceId?: string | null;
  sessionId?: string | null;
  capabilities?: AttachmentCapability[];
  /** 默认 read。给 Agent 用来落盘的附件才需要 read-write */
  access?: AttachmentAccess;
  now?: number;
}

/** 全文件 sha256。附件都是用户亲手选的单个文件，整读一遍是可接受的代价。 */
async function hashFile(absPath: string): Promise<string> {
  const buffer = await fsp.readFile(absPath);
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 为一个绝对路径签发能力凭证。
 *
 * 调用方只有两处：系统文件对话框的选中结果，以及用户拖拽进窗口的文件 ——
 * 两者都是真实的用户手势。渲染进程无法凭空构造出第三处。
 */
export async function issue(
  absPath: string,
  options: IssueOptions = {}
): Promise<AttachmentRecord> {
  const now = options.now ?? Date.now();
  const canonicalPath = await fsp.realpath(absPath);
  const stat = await fsp.stat(canonicalPath);
  if (!stat.isFile()) throw new Error(`ATTACHMENT_NOT_A_FILE: ${absPath}`);

  const workspaceId = options.workspaceId ?? null;
  // 工作区外的单文件授权（系统文件对话框 / 拖拽）没有 root 可相对，
  // relativePath 退化成文件名 —— 渲染进程仍然拿不到任何目录信息。
  let relativePath = path.basename(canonicalPath);
  if (workspaceId) {
    const record = lookupWorkspace(workspaceId);
    if (!record) throw new Error(`WORKSPACE_UNKNOWN: ${workspaceId}`);
    await assertContained(record.root, canonicalPath);
    relativePath = path.relative(record.root, canonicalPath).split(path.sep).join("/");
  }

  const token = randomBytes(24).toString("base64url");
  const entry: AttachmentRecord = {
    token,
    canonicalPath,
    name: path.basename(canonicalPath),
    size: stat.size,
    kind: kindOf(canonicalPath),
    capabilities: options.capabilities ?? ["read", "open", "reveal"],
    access: options.access ?? "read",
    relativePath,
    sourceName: path.basename(canonicalPath),
    mimeType: mimeTypeOf(canonicalPath),
    sha256: await hashFile(canonicalPath),
    workspaceId,
    sessionId: options.sessionId ?? null,
    expiresAt: now + ATTACHMENT_TTL_MS,
  };
  tokens.set(token, entry);
  return entry;
}

/**
 * 结构化附件引用（裁定2）—— **取代「把绝对路径当可信输入」的旧形态**。
 *
 * 返回对象恰好八个字段，标识恒为 `token`。这里刻意不返回 AttachmentRecord
 * 本身：那上面挂着 canonicalPath，一次「顺手把整条记录 return 出去」就把
 * 收敛掉的绝对路径又送回渲染进程了。
 */
export async function createAttachment(
  absPath: string,
  options: IssueOptions = {}
): Promise<AttachmentDescriptor> {
  const record = await issue(absPath, options);
  return toDescriptor(record);
}

/** 记录 → 八字段结构化引用。转换收在这里，各 handler 就没机会多带字段。 */
export function toDescriptor(record: AttachmentRecord): AttachmentDescriptor {
  return {
    token: record.token,
    capability: record.access,
    relativePath: record.relativePath,
    sourceName: record.sourceName,
    mimeType: record.mimeType,
    sizeBytes: record.size,
    sha256: record.sha256,
    expiresAt: record.expiresAt,
  };
}

// ---------------------------------------------------------------- 兑付

export interface ResolveOptions {
  capability?: AttachmentCapability;
  /** 声明本次是不是写请求。read 记录遇上 read-write 请求直接拒 */
  access?: AttachmentAccess;
  now?: number;
}

/**
 * 兑付凭证：重做过期、能力、收容与存在性校验，命中即滑动续期。
 *
 * 这里刻意不信任签发时记下的任何东西 —— canonicalPath 也要重新 realpath
 * 一遍并与记录比对，因为符号链接可以在签发之后被指向别处。
 */
export async function resolveAttachment(
  token: string,
  options: ResolveOptions = {}
): Promise<AttachmentRecord> {
  const now = options.now ?? Date.now();
  sweep(now);

  const record = tokens.get(token);
  if (!record) throw new Error("ATTACHMENT_TOKEN_INVALID");
  if (record.expiresAt <= now) {
    tokens.delete(token);
    throw new Error("ATTACHMENT_TOKEN_EXPIRED");
  }
  const capability = options.capability;
  if (capability && !record.capabilities.includes(capability)) {
    throw new Error(`ATTACHMENT_CAPABILITY_DENIED: ${capability}`);
  }
  // 写请求撞上只读凭证：拒。这一句就是 capability 字段全部的意义所在。
  if (options.access === "read-write" && record.access !== "read-write") {
    throw new Error("ATTACHMENT_ACCESS_DENIED: read-write");
  }

  const real = await fsp.realpath(record.canonicalPath);
  if (real !== record.canonicalPath) {
    tokens.delete(token);
    throw new Error("ATTACHMENT_TARGET_MOVED");
  }
  if (record.workspaceId) {
    const workspace = lookupWorkspace(record.workspaceId);
    if (!workspace) throw new Error(`WORKSPACE_UNKNOWN: ${record.workspaceId}`);
    await assertContained(workspace.root, real);
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new Error("ATTACHMENT_NOT_A_FILE");
  record.size = stat.size;

  renewOnAccess(record, now);
  return record;
}

/** 兑付后返回**主进程内部使用**的绝对路径（拼接给模型的文件引用块）。 */
export async function resolvePath(token: string, options: ResolveOptions = {}): Promise<string> {
  return (await resolveAttachment(token, options)).canonicalPath;
}

export interface AttachmentImage {
  data: string;
  mimeType: string;
}

/**
 * 读取图片附件为 base64。
 *
 * 用 fs/promises 而不是 readFileSync：早先这里是同步读，一个 10MB 的图片
 * 会把主进程（也就是整个 UI 的事件循环）按住不动。
 */
export async function readImage(
  token: string,
  options: ResolveOptions = {}
): Promise<AttachmentImage> {
  const record = await resolveAttachment(token, { ...options, capability: "read" });
  if (record.size > MAX_IMAGE_BYTES) {
    throw new Error(`ATTACHMENT_TOO_LARGE: ${record.size} > ${MAX_IMAGE_BYTES}`);
  }
  const buffer = await fsp.readFile(record.canonicalPath);
  const mimeType = sniffImageMime(buffer.subarray(0, 16));
  if (!mimeType) throw new Error("ATTACHMENT_NOT_AN_IMAGE");
  return { data: buffer.toString("base64"), mimeType };
}

/** 全 main 唯一调用 shell.openPath 的地方：只接受凭证，不接受路径。 */
export async function openAttachment(
  token: string,
  options: ResolveOptions = {}
): Promise<string> {
  const record = await resolveAttachment(token, { ...options, capability: "open" });
  return shell.openPath(record.canonicalPath);
}

/** 在系统文件管理器里定位附件。同样只接受凭证。 */
export async function revealAttachment(
  token: string,
  options: ResolveOptions = {}
): Promise<void> {
  const record = await resolveAttachment(token, { ...options, capability: "reveal" });
  shell.showItemInFolder(record.canonicalPath);
}

// ---------------------------------------------------------------- 撤销

/** 会话切换时撤销该会话签发的全部未消费凭证。 */
export function revokeAllForSession(sessionId: string): number {
  let removed = 0;
  for (const [token, record] of tokens) {
    if (record.sessionId === sessionId) {
      tokens.delete(token);
      removed++;
    }
  }
  return removed;
}

/** 应用退出 / 窗口销毁时撤销全部未消费凭证。 */
export function revokeAll(): number {
  const removed = tokens.size;
  tokens.clear();
  return removed;
}

/**
 * 记录 → 渲染侧视图。
 *
 * 这是**唯一**允许把附件信息送出主进程的形态：只有凭证、显示名、大小与类型，
 * 没有路径。转换收在这里，各 handler 就没有机会「顺手多带一个字段」。
 */
export function toAttachmentRef(record: AttachmentRecord): AttachmentRef {
  return {
    token: record.token,
    name: record.name,
    size: record.size,
    kind: record.kind,
    // 工作区内的附件带上相对路径供界面显示；工作区外的没有 root 可相对，
    // 此处留空 —— 绝对路径在任何情况下都不会从这里出去。
    ...(record.workspaceId ? { relativePath: record.relativePath } : {}),
  };
}

/** 仅供诊断与单测：当前未消费凭证数量。 */
export function outstandingCount(): number {
  return tokens.size;
}
