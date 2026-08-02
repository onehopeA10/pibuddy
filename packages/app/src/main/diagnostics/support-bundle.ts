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
      sizeBytes: safeStat(sources.settingsFile) ?? 0,
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
  if (sources.crashDumpConsent === "allow" && sources.crashDumpDir) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(sources.crashDumpDir);
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      const file = path.join(sources.crashDumpDir, name);
      const size = safeStat(file);
      if (size === null) continue;
      entries.push({
        path: `crash-dumps/${name}`,
        sizeBytes: size,
        redacted: false,
        description: "崩溃转储（二进制，无法脱敏；你已明确同意包含它）",
        source: file,
      });
    }
  }

  return entries;
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
  const files: Array<{ name: string; data: Buffer }> = [];

  for (const entry of planned) {
    if (entry.inline !== undefined) {
      files.push({ name: entry.path, data: Buffer.from(redactText(entry.inline), "utf8") });
      continue;
    }
    if (!entry.source) continue;

    if (entry.redacted) {
      const raw = entry.path.startsWith("logs/")
        ? readTail(entry.source, MAX_LOG_TAIL_BYTES)
        : readFileOr(entry.source);
      files.push({ name: entry.path, data: Buffer.from(redactText(raw), "utf8") });
    } else {
      try {
        files.push({ name: entry.path, data: fs.readFileSync(entry.source) });
      } catch {
        /* 读不到就跳过，不要因为一个文件让整个诊断包导不出来 */
      }
    }
  }

  const zip = buildZip(files);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, zip);

  return {
    path: targetPath,
    entryCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.data.length, 0),
  };
}

function readFileOr(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- ZIP

/** Node 22 起 zlib 自带 crc32；老版本回落到本地表。 */
const crc32: (data: Buffer) => number =
  typeof (zlib as unknown as { crc32?: unknown }).crc32 === "function"
    ? (zlib as unknown as { crc32: (d: Buffer) => number }).crc32
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

function fallbackCrc32(data: Buffer): number {
  let c = 0xffffffff;
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
 * 最小 ZIP 写入器：STORE（method 0），UTF-8 文件名。
 *
 * 只实现读得懂的那一小块规范：本地头 + 中央目录 + EOCD。不支持 zip64 ——
 * 诊断包超过 4GB 说明别处已经先坏了。
 */
export function buildZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const { time, date } = dosDateTime(new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + file.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}
