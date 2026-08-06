/**
 * 一键诊断包（OBS-101）。
 *
 * ## 先预览，后导出
 *
 * `previewBundle()` **不写任何文件**，只返回将要导出的清单：每个条目的
 * zip 内路径、大小、以及**是否已脱敏**。用户看完再决定导不导。
 *
 * 「导出前给清单」不是礼貌用语，是一条硬要求：诊断包会被发到聊天窗口、
 * 贴进工单、转发给不认识的人。用户有权在按下按钮之前知道自己要交出去的
 * 到底是哪些文件。
 *
 * ## crash dump 必须单独取得同意
 *
 * 日志与设置副本是**文本**，可以逐字脱敏；crash dump 是进程内存的二进制
 * 快照，里面可能有用户刚敲的任何一个字，脱敏对它根本不成立。因此它只在
 * `crashDumpConsent === "allow"` 时才进包，而且在清单里 `redacted: false`
 * 明写出来 —— 把它和日志混在一句「已脱敏」里，是在骗用户。
 *
 * ## zip 用 STORE（不压缩）
 *
 * 一是没有第三方依赖（check-pure-js-deps 的闸门下，为了打个包引一个带
 * 原生扩展的压缩库是本末倒置）；二是**可验证**：单测能直接在产出的字节流里
 * 搜预置的假密钥，如果搜不到，那是真的没写进去，而不是被 deflate 藏起来了。
 * 代价是包大一些，因此日志按尾部截断收集，见 MAX_LOG_TAIL_BYTES。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import type { BundleEntry } from "@pibuddy/contract";

import { redactSecrets, redactText } from "../logger-redact.js";

/** 每个日志文件最多收尾部多少字节。排查看的是最近发生了什么。 */
export const MAX_LOG_TAIL_BYTES = 1024 * 1024;
/** 最多收几个日志文件（当前 + 归档）。 */
export const MAX_LOG_FILES_IN_BUNDLE = 4;
/** settings.json 单文件上限，防止损坏或恶意文件被整份读入主进程。 */
export const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * 整个诊断包的总量上限。
 *
 * crash dump 是**进程内存的快照**：一个崩掉的 Electron 主进程能留下几百兆
 * 甚至上 GB 的 .dmp，而 Windows 的 CrashPad 目录里会攒着好几个。不设上限
 * 的后果不是「包有点大」，是导出这一下就把主进程自己撑爆 —— 用户点「导出
 * 诊断包」是因为程序已经出问题了，结果这个按钮又把它打崩一次。
 *
 * 512MB 是「还能发出去的附件」和「排查够用」之间的折中：日志与设置只有
 * 几 MB，剩下的全留给转储。
 */
export const MAX_BUNDLE_TOTAL_BYTES = 512 * 1024 * 1024;
/** 最多收几个崩溃转储。取最近的几个，排查看的是刚才那次崩溃。 */
export const MAX_CRASH_DUMPS_IN_BUNDLE = 3;
/** 单个崩溃转储的上限。比这还大的一个就能把整个预算吃光。 */
export const MAX_CRASH_DUMP_BYTES = 256 * 1024 * 1024;
/** 流式复制的分块大小。任何一个文件都不整份读进内存。 */
const COPY_CHUNK_BYTES = 1024 * 1024;

export interface BundleSources {
  /** 当前日志文件 + 归档，按新到旧 */
  logFiles: string[];
  /** settings.json 的路径（会被脱敏后收进包） */
  settingsFile?: string;
  /** <userData>/update-state 目录：三个 marker 一起收 */
  updateStateDir?: string;
  /** 崩溃转储目录。仅在 consent === "allow" 时收 */
  crashDumpDir?: string;
  crashDumpConsent: "unset" | "allow" | "deny";
  /** 系统与版本信息（对象形态，经 redactSecrets 之后序列化） */
  systemInfo: Record<string, unknown>;
}

interface PlannedEntry extends BundleEntry {
  /** 磁盘上的源路径；systemInfo 这类合成条目为 null */
  source: string | null;
  /** 合成条目的内容 */
  inline?: string;
}

function safeStat(file: string): number | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** 读文件尾部若干字节。日志动辄几 MB，全收进去没人愿意上传。 */
function readTail(file: string, maxBytes: number): string {
  const size = safeStat(file) ?? 0;
  if (size <= maxBytes) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    return `…（已截断，只保留最后 ${maxBytes} 字节）\n${buf.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 规划诊断包的内容。preview 与 export 走**同一个**规划函数 ——
 * 两边各算一次的必然结果是清单和实际导出的内容对不上，而那正是
 * 「预览」这个设计要防的事。
 */
function plan(sources: BundleSources): PlannedEntry[] {
  const entries: PlannedEntry[] = [];

  const systemInfoText = `${JSON.stringify(redactSecrets(sources.systemInfo), null, 2)}\n`;
  entries.push({
    path: "system-info.json",
    sizeBytes: Buffer.byteLength(systemInfoText),
    redacted: true,
    description: "应用版本、操作系统、运行时模式等基本信息",
    source: null,
    inline: systemInfoText,
  });

  for (const file of sources.logFiles.slice(0, MAX_LOG_FILES_IN_BUNDLE)) {
    const size = safeStat(file);
    if (size === null) continue;
    entries.push({
      path: `logs/${path.basename(file)}`,
      sizeBytes: Math.min(size, MAX_LOG_TAIL_BYTES),
      redacted: true,
      description: "结构化运行日志（密钥、正文、主目录路径已脱敏）",
      source: file,
    });
  }

  if (sources.settingsFile && safeStat(sources.settingsFile) !== null) {
    entries.push({
      path: "settings.json",
      sizeBytes: Math.min(safeStat(sources.settingsFile) ?? 0, MAX_SETTINGS_BYTES),
      redacted: true,
      description: "应用设置副本（不含任何密钥，密钥不在设置文件里）",
      source: sources.settingsFile,
    });
  }

  if (sources.updateStateDir) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(sources.updateStateDir).filter((n) => n.endsWith(".json"));
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      const file = path.join(sources.updateStateDir, name);
      const size = safeStat(file);
      if (size === null) continue;
      entries.push({
        path: `update-state/${name}`,
        sizeBytes: size,
        redacted: true,
        description: "更新交接与启动健康检查记录",
        source: file,
      });
    }
  }

  // 二进制转储：只在明确同意之后，且清单里如实标 redacted: false。
  //
  // 上面几类都是文本、总共几 MB，所以预算全部留给这里。被挡掉的每一条
  // 都记进 omitted，最后作为一个条目写进包 —— 悄悄少收几个文件，排查的
  // 人会以为「崩的时候就没留转储」，那是个会把人带偏的谎。
  const omitted: string[] = [];
  let used = entries.reduce((sum, e) => sum + e.sizeBytes, 0);

  if (sources.crashDumpConsent === "allow" && sources.crashDumpDir) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(sources.crashDumpDir);
    } catch {
      names = [];
    }
    // 按修改时间从新到旧：排查看的是刚才那次崩溃，不是三个月前那次。
    const dumps = names
      .map((name) => ({ name, file: path.join(sources.crashDumpDir as string, name) }))
      .map((d) => ({ ...d, size: safeStat(d.file), mtime: safeMtime(d.file) }))
      .filter((d): d is typeof d & { size: number } => d.size !== null)
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));

    let taken = 0;
    for (const dump of dumps) {
      if (taken >= MAX_CRASH_DUMPS_IN_BUNDLE) {
        omitted.push(`crash-dumps/${dump.name}：只收最近 ${MAX_CRASH_DUMPS_IN_BUNDLE} 个崩溃转储`);
        continue;
      }
      if (dump.size > MAX_CRASH_DUMP_BYTES) {
        omitted.push(
          `crash-dumps/${dump.name}：单个转储 ${mb(dump.size)} MB，超过上限 ${mb(MAX_CRASH_DUMP_BYTES)} MB`
        );
        continue;
      }
      if (used + dump.size > MAX_BUNDLE_TOTAL_BYTES) {
        omitted.push(
          `crash-dumps/${dump.name}：再收就超过诊断包总量上限 ${mb(MAX_BUNDLE_TOTAL_BYTES)} MB`
        );
        continue;
      }
      used += dump.size;
      taken++;
      entries.push({
        path: `crash-dumps/${dump.name}`,
        sizeBytes: dump.size,
        redacted: false,
        description: "崩溃转储（二进制，无法脱敏；你已明确同意包含它）",
        source: dump.file,
      });
    }
  }

  if (omitted.length > 0) {
    const text = `以下文件因为体积上限没有收进这个诊断包：\n\n${omitted.map((l) => `- ${l}`).join("\n")}\n`;
    entries.push({
      path: "omitted.txt",
      sizeBytes: Buffer.byteLength(text),
      redacted: true,
      description: "因体积上限未收进包的文件清单",
      source: null,
      inline: text,
    });
  }

  return entries;
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function safeMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 导出前的清单。**不写盘**。
 *
 * 返回的每一项都带 `redacted`，界面按它分组显示，不允许把
 * redacted:false 的条目混在「已脱敏」那一栏里。
 */
export function previewBundle(sources: BundleSources): BundleEntry[] {
  return plan(sources).map(({ path: p, sizeBytes, redacted, description }) => ({
    path: p,
    sizeBytes,
    redacted,
    description,
  }));
}

export interface BundleWriteResult {
  path: string;
  entryCount: number;
  totalBytes: number;
}

/**
 * 真正导出。
 *
 * 每个**文本**条目在写进 zip 之前都过一遍脱敏（redactText 是 logger-redact
 * 里那份唯一实现的字符串入口，不截断长度）；标了 `redacted: false` 的二进制
 * 条目原样收进去 —— 它们能进包，前提是用户已经明确同意过。
 */
export function exportBundle(targetPath: string, sources: BundleSources): BundleWriteResult {
  const planned = plan(sources);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const fd = fs.openSync(targetPath, "w");
  const zip = new ZipStreamWriter(fd);
  try {
    for (const entry of planned) {
      if (entry.inline !== undefined) {
        zip.addBuffer(entry.path, Buffer.from(redactText(entry.inline), "utf8"));
        continue;
      }
      if (!entry.source) continue;

      if (entry.redacted) {
        // 文本条目要整份脱敏（redactText 是唯一实现，不能分块喂 —— 密钥
        // 正好横跨两个分块时，分块脱敏会漏掉它）。收进来的文本本身已经
        // 有上限：日志取尾部 1MB，settings.json 是配置文件。
        const raw = entry.path.startsWith("logs/")
          ? readTail(entry.source, MAX_LOG_TAIL_BYTES)
          : entry.path === "settings.json"
            ? readTail(entry.source, MAX_SETTINGS_BYTES)
            : readFileOr(entry.source);
        zip.addBuffer(entry.path, Buffer.from(redactText(raw), "utf8"));
      } else {
        // 二进制条目**流式**复制：这里正是原来 readFileSync 把几百兆转储
        // 整份读进内存、最后再 Buffer.concat 一次的地方。读不到就跳过，
        // 不要因为一个文件让整个诊断包导不出来。
        zip.addFileStreamed(entry.path, entry.source);
      }
    }
    return { path: targetPath, ...zip.finish() };
  } finally {
    fs.closeSync(fd);
  }
}

function readFileOr(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- ZIP

/**
 * Node 22 起 zlib 自带 crc32；老版本回落到本地表。
 *
 * 两者都收一个种子值：STORE 的本地头要求 crc 写在数据之前，而数据是分块
 * 流出去的，只能一块一块地把 crc 累起来。
 */
const crc32: (data: Buffer, seed?: number) => number =
  typeof (zlib as unknown as { crc32?: unknown }).crc32 === "function"
    ? (zlib as unknown as { crc32: (d: Buffer, v?: number) => number }).crc32
    : fallbackCrc32;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function fallbackCrc32(data: Buffer, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间戳。zip 格式规定的 2 秒精度，不是笔误。 */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 最小 ZIP 写入器：STORE（method 0），UTF-8 文件名，**边算边往 fd 里写**。
 *
 * 只实现读得懂的那一小块规范：本地头 + 中央目录 + EOCD。不支持 zip64 ——
 * 诊断包超过 4GB 说明别处已经先坏了。
 *
 * 之所以不是「先在内存里拼好再 writeFileSync」：那种写法的峰值内存 = 所有
 * 条目之和 ×2（一份是各条目的 Buffer，一份是 Buffer.concat 出来的整包）。
 * 崩溃转储动辄几百兆，这个按钮于是能把一个已经出过问题的主进程再打崩一次。
 * 现在常驻内存只有中央目录（每条约 46 字节 + 文件名）与一个 1MB 的复制缓冲。
 *
 * STORE 而不是 deflate 仍然是刻意的：单测能直接在产出的字节流里搜预置的
 * 假密钥，搜不到才真的说明没写进去。
 */
class ZipStreamWriter {
  private readonly time: number;
  private readonly date: number;
  private readonly centrals: Buffer[] = [];
  private offset = 0;
  private count = 0;
  private payloadBytes = 0;

  constructor(private readonly fd: number) {
    const stamp = dosDateTime(new Date());
    this.time = stamp.time;
    this.date = stamp.date;
  }

  private write(buf: Buffer): void {
    fs.writeSync(this.fd, buf);
    this.offset += buf.length;
  }

  private localHeader(nameBuf: Buffer, crc: number, size: number): Buffer {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(this.time, 10);
    local.writeUInt16LE(this.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    return local;
  }

  private pushCentral(nameBuf: Buffer, crc: number, size: number, at: number): void {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(this.time, 12);
    central.writeUInt16LE(this.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(at, 42);
    this.centrals.push(central, nameBuf);
    this.count++;
    this.payloadBytes += size;
  }

  /** 已经在内存里的小条目（脱敏之后的文本）。 */
  addBuffer(name: string, data: Buffer): void {
    const nameBuf = Buffer.from(name, "utf8");
    const at = this.offset;
    this.write(this.localHeader(nameBuf, crc32(data), data.length));
    this.write(nameBuf);
    this.write(data);
    this.pushCentral(nameBuf, crc32(data), data.length, at);
  }

  /**
   * 磁盘上的大文件：分两遍，**任何时刻内存里只有一个分块**。
   *
   * STORE 的本地头必须把 crc 与长度写在数据前面，所以第一遍先把文件过一
   * 遍算 crc 和真实长度，第二遍再照着这个长度流式复制。第二遍写出的字节
   * 数被钉死成第一遍量到的那个数（短了补零、长了截断），这样即使文件在
   * 两遍之间被改动，产出的 zip 也仍然是一个能打开的合法文件。
   *
   * 读不到就整条跳过：一个转储读不出来不该让整个诊断包导不出来。
   */
  addFileStreamed(name: string, source: string): void {
    const scanned = scanFile(source);
    if (!scanned) return;

    const nameBuf = Buffer.from(name, "utf8");
    const at = this.offset;
    this.write(this.localHeader(nameBuf, scanned.crc, scanned.size));
    this.write(nameBuf);

    let written = 0;
    readInChunks(source, (chunk) => {
      if (written >= scanned.size) return false;
      const slice =
        written + chunk.length > scanned.size ? chunk.subarray(0, scanned.size - written) : chunk;
      this.write(slice);
      written += slice.length;
      return true;
    });
    if (written < scanned.size) this.write(Buffer.alloc(scanned.size - written));

    this.pushCentral(nameBuf, scanned.crc, scanned.size, at);
  }

  finish(): { entryCount: number; totalBytes: number } {
    const centralAt = this.offset;
    for (const buf of this.centrals) this.write(buf);
    const centralSize = this.offset - centralAt;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.count, 8);
    eocd.writeUInt16LE(this.count, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralAt, 16);
    this.write(eocd);

    return { entryCount: this.count, totalBytes: this.payloadBytes };
  }
}

/** 分块读一个文件。回调返回 false 即停止。读不开返回 false。 */
function readInChunks(file: string, onChunk: (chunk: Buffer) => boolean): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, COPY_CHUNK_BYTES, null);
      if (read <= 0) return true;
      if (!onChunk(buf.subarray(0, read))) return true;
    }
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** 第一遍：算 crc 与真实长度，全程不留整份内容。 */
function scanFile(file: string): { crc: number; size: number } | null {
  let crc = 0;
  let size = 0;
  const ok = readInChunks(file, (chunk) => {
    crc = crc32(chunk, crc);
    size += chunk.length;
    return true;
  });
  return ok ? { crc, size } : null;
}
