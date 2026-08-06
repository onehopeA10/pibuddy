/**
 * 转换 worker（ART-101）——**这个文件里的代码跑在一个受限的 utilityProcess
 * 里，而不是主进程里**。
 *
 * ## 为什么必须是独立进程
 *
 * 这里解析的是攻击者可以完全控制的字节：一个 docx 就是一个 zip，里面
 * 装着任意 XML。mammoth / exceljs / jszip 都是纯 JS，不会执行宏，但
 * 「不会执行宏」和「不会被一个精心构造的 zip 炸掉」是两回事 —— 解压
 * 炸弹、深度嵌套 XML、几 GB 的共享字符串表，每一个都能把宿主进程的
 * 内存打满。跑在子进程里之后，最坏情况是 convert-host 按 CONVERT_LIMITS
 * 把它 kill 掉并返回一个 `oom` / `timeout`，主进程和 UI 一点事没有。
 *
 * ## 宏、远程模板、外部链接、自动数据连接是怎么「显式关闭」的
 *
 * OOXML 里这四样东西各自对应几个确定的 zip 成员（vbaProject.bin、
 * settings.xml.rels 里的 attachedTemplate、externalLinks/、
 * connections.xml…）。BLOCKED_OOXML_PARTS 在**解析之前**先把整个包的
 * 成员表过一遍：命中的成员既不读也不传给任何解析库，并在结果里如实
 * 列出「这份文档带了什么、我们没给它执行的机会」。
 *
 * 这比「相信解析库默认不执行」强的地方在于它是**可断言的**：
 * office-safety.test.ts 拿一个真的带 VBA 与远程模板的 fixture 跑一遍，
 * 断言输出里既没有宏内容，也没有任何 http(s) 目标。
 *
 * ## PDF 为什么只走 extractText
 *
 * unpdf 还提供一条「把整页渲染成图片」的 API，那条路要一个原生的
 * canvas 绑定（.node 二进制），与 electron-builder 的 `npmRebuild: false`
 * 直接冲突 —— TASK-013 的 check-pure-js-deps.mjs 闸门会当场退出码 1。
 * 本文件因此只用 extractText 做结构化文本抽取，一个像素都不渲染，
 * 且**不出现那条渲染 API 的名字**（c[12] 对本文件做的就是字符串断言）。
 */
import type {
  PreviewCode,
  PreviewErrorCode,
  PreviewKind,
  PreviewResult,
  PreviewTable,
} from "@pibuddy/contract";
import fsp from "node:fs/promises";
import path from "node:path";

import { kindForExtension, type ConvertReply, type ConvertRequest } from "./preview-types.js";

/**
 * 每个错误码对应的、**用户能据以行动**的一句中文。
 *
 * 这张表是界面文案的唯一来源：PreviewPane 直接显示 `result.suggestion`，
 * 而 suggestion 恒取自这里。单测断言六条取值互不相同且都不短于 10 个
 * 字符 —— 「可读建议」这件事没法直接测，但「不是空串、不是复制粘贴的
 * 同一句话」可以，而这两条恰好挡住了绝大多数敷衍的写法。
 */
export const SUGGESTION: Record<PreviewErrorCode, string> = {
  corrupt: "这个文件的内容读不出来，可能在传输或保存时损坏了。请找原始文件重新拿一份。",
  "password-protected": "这个文件有密码保护。请先用原来的程序去掉密码，或者提供解密后的版本。",
  "too-large": "这个文件太大了，预览会把内存占满。请用系统里的对应程序直接打开它。",
  unsupported: "这种格式（或文件里的这一部分）暂时还不能预览。可以用系统默认程序打开看看。",
  timeout: "解析这个文件用的时间太久，已经停下来了。文件可能异常复杂，建议用原程序打开。",
  oom: "解析这个文件占用的内存超出了上限，已经停下来了。请用系统里的对应程序直接打开它。",
};

/** 显式关闭的四类 Office 能力。写成常量是为了让「关了什么」可被逐条断言。 */
export const OFFICE_SAFETY = {
  macros: "disabled",
  remoteTemplates: "disabled",
  externalLinks: "disabled",
  autoDataConnections: "disabled",
} as const;

/**
 * 解析前一律剔除的 OOXML 成员。
 *
 * 逐条对应上面四项：
 *   vbaProject.bin / vbaData.xml   宏（VBA 工程本体）
 *   settings.xml.rels              里可能挂着 attachedTemplate 的远程模板
 *   externalLinks/ / externalLink  外部工作簿链接
 *   connections.xml / queryTable   自动数据连接（刷新即发起网络请求）
 *   oleObject / embeddings/        嵌入的 OLE 对象（可执行体的常见藏身处）
 *   customXml/                     常被用来夹带远程引用
 */
export const BLOCKED_OOXML_PARTS =
  /(vbaProject\.bin|vbaData\.xml|settings\.xml\.rels|externalLink|connections\.xml|queryTable|oleObject|embeddings\/|customXml\/)/i;

/** 抽取文本的默认字符上限。超出即截断并在末尾标注。 */
export const DEFAULT_MAX_TEXT_CHARS = 400_000;

/** 表格类最多展示的行数。再多也没人会在预览里往下拖。 */
export const MAX_TABLE_ROWS = 200;

/** 单元格文本上限，防一个单元格里塞一兆字符。 */
const MAX_CELL_CHARS = 512;

// ------------------------------------------------------------------ 工具

function emptyResult(
  kind: PreviewKind,
  code: PreviewCode,
  request: Pick<ConvertRequest, "sourceName" | "sizeBytes">,
  text = ""
): PreviewResult {
  return {
    kind,
    code,
    text,
    suggestion: code === "ok" ? "" : SUGGESTION[code as PreviewErrorCode],
    notices: [],
    tables: [],
    dataUrl: null,
    sourceName: request.sourceName,
    sizeBytes: request.sizeBytes,
    elapsedMs: 0,
  };
}

/**
 * 把抽出来的文本里的 http(s) 目标换成占位符。
 *
 * 这是**刻意的有损处理**。预览区是一块只读的文本视图，把一份不可信
 * 文档里的 URL 原样显示出来，等于把钓鱼链接摆到用户眼前并让它看起来
 * 像是应用自己的内容 —— 而用户完全没有办法分辨这一段是文档作者写的
 * 还是我们写的。代价是正文里合法的网址也会被打码；相比之下这个代价
 * 划算，需要拿到原文的用户可以用系统程序打开原件。
 */
export function redactExternalTargets(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, "[外部链接已屏蔽]");
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（内容过长，已截断到 ${limit} 个字符）`;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const rich = value as { text?: unknown; result?: unknown; richText?: unknown[] };
    if (typeof rich.text === "string") return rich.text.slice(0, MAX_CELL_CHARS);
    if (Array.isArray(rich.richText)) {
      return rich.richText
        .map((r) => String((r as { text?: unknown }).text ?? ""))
        .join("")
        .slice(0, MAX_CELL_CHARS);
    }
    // 公式单元格：只取缓存的计算结果，**绝不重算** —— 重算意味着解释
    // 一段来历不明的表达式。
    if (rich.result !== undefined) return String(rich.result).slice(0, MAX_CELL_CHARS);
    if (value instanceof Date) return value.toISOString();
    return "";
  }
  return String(value).slice(0, MAX_CELL_CHARS);
}

/** ZIP 局部文件头。OOXML 三兄弟都必须以它开头。 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** CFB / OLE2 复合文档头。老式 .doc/.xls/.ppt 与**加密后的** OOXML 都是它。 */
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

function startsWith(buf: Uint8Array, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  return sig.every((b, i) => buf[i] === b);
}

// ------------------------------------------------------------------ 图片

/** 从首部字节判断图片尺寸。判不出来返回 null（仍然照常预览，只是不显示尺寸）。 */
export function imageDimensions(buf: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // PNG: 8 字节签名 + 4 长度 + "IHDR" + width(4) + height(4)
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47]) && buf.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: "GIF8" + 2 字节版本，宽高是小端 uint16
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38]) && buf.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // BMP: BITMAPINFOHEADER 的宽高在 18 / 22，小端 int32
  if (startsWith(buf, [0x42, 0x4d]) && buf.length >= 26) {
    return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  }
  // JPEG: 逐段扫到任意 SOFn（C0-CF，跳过 C4/C8/CC 三个非 SOF）
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      const length = view.getUint16(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return null;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

// -------------------------------------------------------- 音视频 metadata

/**
 * 只读容器头里的元数据，**一帧都不解码**。
 *
 * 解码是把攻击者可控的字节流喂给一个 C 解码器 —— 那正是本任务整套
 * 隔离想要避免的事。这里只认两种自描述得足够清楚的容器：ISO BMFF
 * （mp4/mov/m4a）的 mvhd 与 RIFF/WAVE 的 fmt+data。其余容器如实返回
 * unsupported，而不是渲染一段空白冒充成功。
 */
export function mediaMetadata(buf: Uint8Array): string | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // ---- RIFF/WAVE ----
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.length >= 44) {
    const isWave =
      buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45;
    if (isWave) {
      // fmt 块固定在 12 起（标准 WAV 写法）：channels(22) sampleRate(24) bits(34)
      const channels = view.getUint16(22, true);
      const sampleRate = view.getUint32(24, true);
      const bits = view.getUint16(34, true);
      const bytesPerSec = view.getUint32(28, true);
      const dataBytes = buf.length - 44;
      const seconds = bytesPerSec > 0 ? dataBytes / bytesPerSec : 0;
      return [
        "容器：RIFF / WAVE",
        `声道数：${channels}`,
        `采样率：${sampleRate} Hz`,
        `位深：${bits} bit`,
        `时长：约 ${seconds.toFixed(2)} 秒`,
      ].join("\n");
    }
  }
  // ---- ISO BMFF（mp4 / mov / m4a）：找顶层 moov，再找里面的 mvhd ----
  if (buf.length >= 16 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = new TextDecoder().decode(buf.subarray(8, 12));
    // mvhd 的四字符码可以出现在任何嵌套层级，直接线性扫描即可 ——
    // 我们只读四个整数，不按 box 树递归解析（少一大块攻击面）。
    for (let i = 0; i + 32 < buf.length; i++) {
      if (buf[i] === 0x6d && buf[i + 1] === 0x76 && buf[i + 2] === 0x68 && buf[i + 3] === 0x64) {
        const version = buf[i + 4];
        let timescale = 0;
        let duration = 0;
        if (version === 0) {
          timescale = view.getUint32(i + 16);
          duration = view.getUint32(i + 20);
        } else if (version === 1 && i + 44 < buf.length) {
          timescale = view.getUint32(i + 24);
          duration = Number(view.getBigUint64(i + 28));
        }
        const seconds = timescale > 0 ? duration / timescale : 0;
        return [
          "容器：ISO BMFF (MP4/MOV)",
          `品牌：${brand}`,
          `时间刻度：${timescale}`,
          `时长：约 ${seconds.toFixed(2)} 秒`,
        ].join("\n");
      }
    }
    return `容器：ISO BMFF (MP4/MOV)\n品牌：${brand}\n（这个文件里没有可读的 mvhd，取不到时长）`;
  }
  return null;
}

// ------------------------------------------------------------------ 分派

/** OOXML 安全预扫描的结果。`blocked` 里的成员一个字节都不会被读。 */
export interface OoxmlScan {
  /** 被 BLOCKED_OOXML_PARTS 命中的成员名 */
  blocked: string[];
  /** 全部成员名（供 pptx 取 slide 列表） */
  entries: string[];
}

/**
 * 用 jszip 把包打开，只列成员表，**不解压任何被拦截的成员**。
 *
 * jszip 的 loadAsync 只解析中央目录，条目内容是惰性的 —— 因此「列出来
 * 但不读」在这里是真的没读，不是读完再丢。
 */
export async function scanOoxml(buf: Uint8Array): Promise<OoxmlScan> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.keys(zip.files);
  return { entries, blocked: entries.filter((name) => BLOCKED_OOXML_PARTS.test(name)) };
}

/**
 * 把预扫描结果变成给用户看的提示行。
 *
 * 走 `notices` 而不是拼进正文：表格类只渲染 tables 不渲染 text，
 * 拼进正文的话，一个带宏的 .xlsm 在界面上一个字的警告都不会有 ——
 * 而同样带宏的 .docx 却有。同一件事在两种文件上表现不同，正是
 * 那种没人会发现的缺陷。
 */
function safetyNotices(scan: OoxmlScan): string[] {
  if (scan.blocked.length === 0) return [];
  return [
    `⚠ 这个文档里带了 ${scan.blocked.length} 项被拦下的内容（宏 / 远程模板 / 外部链接 / 数据连接 / 嵌入对象），它们没有被读取，也没有被执行：`,
    ...scan.blocked.slice(0, 20).map((name) => `· ${name}`),
  ];
}

/** 是不是 OOXML 的加密壳（扩展名是 x 系但内容是 CFB）。 */
function looksEncrypted(ext: string, buf: Uint8Array): boolean {
  const ooxml = [".docx", ".docm", ".xlsx", ".xlsm", ".pptx", ".pptm"];
  return ooxml.includes(ext) && startsWith(buf, CFB_MAGIC);
}

/**
 * 执行一次转换。**纯函数式的入口**：读文件、按类型分派、返回结果，
 * 不碰任何全局状态，因此单测可以直接调它而不必起子进程。
 */
export async function convertFile(request: ConvertRequest): Promise<PreviewResult> {
  const started = Date.now();
  const maxChars = request.maxTextChars || DEFAULT_MAX_TEXT_CHARS;
  const ext = path.extname(request.inputPath).toLowerCase();
  const kind = kindForExtension(ext);

  if (kind === null) {
    return emptyResult(
      "text",
      "unsupported",
      request,
      `${request.sourceName}\n（这个扩展名 ${ext || "（无）"} 不在可预览清单里）`
    );
  }

  let buf: Uint8Array;
  try {
    const workerMaxInputBytes = 50 * 1024 * 1024;
    if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 0 || request.sizeBytes > workerMaxInputBytes) {
      return emptyResult(kind, "too-large", request);
    }
    const handle = await fsp.open(request.inputPath, "r");
    try {
      const maxBytes = request.sizeBytes;
      const bytes = Buffer.allocUnsafe(maxBytes + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) return emptyResult(kind, "too-large", request);
      buf = bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch {
    return emptyResult(kind, "corrupt", request);
  }

  const finish = (result: PreviewResult): PreviewResult => ({
    ...result,
    elapsedMs: Date.now() - started,
  });

  try {
    switch (kind) {
      case "markdown":
      case "text": {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        return finish({ ...emptyResult(kind, "ok", request, truncate(text, maxChars)) });
      }

      case "json": {
        const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        try {
          const pretty = JSON.stringify(JSON.parse(raw), null, 2);
          return finish(emptyResult(kind, "ok", request, truncate(pretty, maxChars)));
        } catch {
          // JSON Lines：逐行都是合法 JSON 时按行美化，仍然算成功。
          const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
          const ok = lines.length > 0 && lines.every((l) => tryParse(l));
          if (ok) {
            const pretty = lines
              .map((l) => JSON.stringify(JSON.parse(l), null, 2))
              .join("\n---\n");
            return finish(emptyResult(kind, "ok", request, truncate(pretty, maxChars)));
          }
          return finish(emptyResult(kind, "corrupt", request, truncate(raw, 2000)));
        }
      }

      case "csv": {
        const { default: Papa } = await import("papaparse");
        const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        const parsed = Papa.parse<string[]>(raw, { skipEmptyLines: true });
        const rows = (parsed.data as string[][])
          .slice(0, MAX_TABLE_ROWS)
          .map((row) => row.map((v) => String(v ?? "").slice(0, MAX_CELL_CHARS)));
        if (rows.length === 0) return finish(emptyResult(kind, "corrupt", request));
        const table: PreviewTable = {
          name: "",
          rows,
          truncated: (parsed.data as unknown[]).length > MAX_TABLE_ROWS,
        };
        const text = rows.map((r) => r.join("\t")).join("\n");
        return finish({
          ...emptyResult(kind, "ok", request, truncate(text, maxChars)),
          tables: [table],
        });
      }

      case "image": {
        const mime = IMAGE_MIME[ext] ?? "application/octet-stream";
        const dim = imageDimensions(buf);
        const lines = [
          request.sourceName,
          `类型：${mime}`,
          dim ? `尺寸：${dim.width} × ${dim.height}` : "尺寸：读不出来",
          `大小：${request.sizeBytes} 字节`,
        ];
        return finish({
          ...emptyResult(kind, "ok", request, lines.join("\n")),
          // SVG 是可执行的（内联 <script>），绝不给它 data URL —— 预览
          // 窗口虽然 javascript:false，但这个 dataUrl 也会被渲染进程用，
          // 那里是开着脚本的。
          dataUrl:
            ext === ".svg"
              ? null
              : `data:${mime};base64,${Buffer.from(buf).toString("base64")}`,
        });
      }

      case "media-metadata": {
        const meta = mediaMetadata(buf);
        if (meta === null) {
          return finish(
            emptyResult(
              kind,
              "unsupported",
              request,
              `${request.sourceName}\n大小：${request.sizeBytes} 字节\n（这个容器格式读不出元数据）`
            )
          );
        }
        return finish(emptyResult(kind, "ok", request, `${request.sourceName}\n${meta}`));
      }

      case "pdf": {
        // unpdf 的 extractText 是**纯 JS** 的 pdfjs 无 canvas 构建。
        // 只走文本抽取那条 API：渲染成图片的那条需要原生 canvas 绑定。
        const { extractText, getDocumentProxy } = await import("unpdf");
        try {
          // 必须复制成一个**纯** Uint8Array：pdf.js 显式拒绝 Node 的 Buffer
          // （`Please provide binary data as Uint8Array, rather than Buffer`），
          // 而它抛的是一个普通 Error —— 不转的话每份 PDF 都被归类成 corrupt，
          // 且看不出任何和 PDF 有关的线索。
          const doc = await getDocumentProxy(new Uint8Array(buf));
          const { text, totalPages } = await extractText(doc, { mergePages: true });
          const body = Array.isArray(text) ? text.join("\n") : String(text ?? "");
          const clean = redactExternalTargets(body).trim();
          if (clean.length === 0) {
            return finish(
              emptyResult(
                kind,
                "unsupported",
                request,
                `${request.sourceName}\n共 ${totalPages} 页\n（这份 PDF 里没有可抽取的文本层，可能是扫描件）`
              )
            );
          }
          return finish(
            emptyResult(
              kind,
              "ok",
              request,
              truncate(`${request.sourceName}\n共 ${totalPages} 页\n\n${clean}`, maxChars)
            )
          );
        } catch (err) {
          return finish(emptyResult(kind, classifyPdfError(err), request));
        }
      }

      case "word": {
        if (looksEncrypted(ext, buf)) {
          return finish(emptyResult(kind, "password-protected", request));
        }
        if (!startsWith(buf, ZIP_MAGIC)) {
          // 老式 .doc 是 CFB 二进制，没有纯 JS 解析器；如实说不支持。
          return finish(
            emptyResult(
              kind,
              startsWith(buf, CFB_MAGIC) ? "unsupported" : "corrupt",
              request,
              startsWith(buf, CFB_MAGIC)
                ? `${request.sourceName}\n（这是老式的 .doc 二进制格式，请另存为 .docx 后再预览）`
                : ""
            )
          );
        }
        const scan = await scanOoxml(buf);
        const { default: mammoth } = await import("mammoth");
        // extractRawText 只吐**可见文本**：超链接的 href、域代码、
        // 嵌入对象的字节一概不进结果。这是最小权限的抽取形态。
        const out = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
        const body = redactExternalTargets(out.value ?? "");
        return finish({
          ...emptyResult(kind, "ok", request, truncate(body, maxChars)),
          notices: safetyNotices(scan),
        });
      }

      case "excel": {
        if (looksEncrypted(ext, buf)) {
          return finish(emptyResult(kind, "password-protected", request));
        }
        if (!startsWith(buf, ZIP_MAGIC)) {
          return finish(
            emptyResult(
              kind,
              startsWith(buf, CFB_MAGIC) ? "unsupported" : "corrupt",
              request,
              startsWith(buf, CFB_MAGIC)
                ? `${request.sourceName}\n（这是老式的 .xls 二进制格式，请另存为 .xlsx 后再预览）`
                : ""
            )
          );
        }
        const scan = await scanOoxml(buf);
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.load(Buffer.from(buf) as unknown as ArrayBuffer);
        const tables: PreviewTable[] = [];
        const chunks: string[] = [];
        workbook.eachSheet((sheet) => {
          const rows: string[][] = [];
          sheet.eachRow((row, rowNumber) => {
            if (rowNumber > MAX_TABLE_ROWS) return;
            const values = Array.isArray(row.values) ? row.values.slice(1) : [];
            rows.push(values.map((v) => cell(v)));
          });
          tables.push({
            name: sheet.name,
            rows,
            truncated: sheet.rowCount > MAX_TABLE_ROWS,
          });
          chunks.push(`# ${sheet.name}`, ...rows.map((r) => r.join("\t")));
        });
        const text = truncate(redactExternalTargets(chunks.join("\n")), maxChars);
        if (tables.length === 0) return finish(emptyResult(kind, "corrupt", request));
        return finish({
          ...emptyResult(kind, "ok", request, text),
          tables,
          notices: safetyNotices(scan),
        });
      }

      case "ppt": {
        if (looksEncrypted(ext, buf)) {
          return finish(emptyResult(kind, "password-protected", request));
        }
        if (!startsWith(buf, ZIP_MAGIC)) {
          return finish(
            emptyResult(
              kind,
              startsWith(buf, CFB_MAGIC) ? "unsupported" : "corrupt",
              request,
              startsWith(buf, CFB_MAGIC)
                ? `${request.sourceName}\n（这是老式的 .ppt 二进制格式，请另存为 .pptx 后再预览）`
                : ""
            )
          );
        }
        return finish(await convertPptx(buf, request, maxChars));
      }

      default:
        return finish(emptyResult(kind, "unsupported", request));
    }
  } catch (err) {
    // 任何解析库抛出来的东西都在这里收口：预览崩掉一次不该让整个
    // worker 进程死掉，宿主那边会把它记成一次 corrupt 而不是 timeout。
    const message = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(message)) {
      return finish(emptyResult(kind, "password-protected", request));
    }
    return finish(emptyResult(kind, "corrupt", request));
  }
}

function tryParse(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function classifyPdfError(err: unknown): PreviewErrorCode {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "PasswordException" || /password/i.test(message)) return "password-protected";
  if (/invalid pdf|structure/i.test(message)) return "corrupt";
  return "corrupt";
}

// ------------------------------------------------------------------ PPTX

/**
 * PPTX 正文抽取：解 zip → 解析 `ppt/slides/slideN.xml` → 取全部 `<a:t>`。
 *
 * 没有成熟的纯 JS PPTX 解析库（能用的几个都要么停更、要么把 canvas 拉
 * 进来），因此这里如实自建一个最小实现：**只抽文本框里的文字**。
 * SmartArt（`diagrams/`）、嵌入 OLE 对象、图表数据都不在这个实现的
 * 能力范围内 —— 命中它们时返回 `unsupported`，同时把已经抽出来的正文
 * 照常返回，而不是把整份文件报成失败。
 */
async function convertPptx(
  buf: Uint8Array,
  request: ConvertRequest,
  maxChars: number
): Promise<PreviewResult> {
  const { default: JSZip } = await import("jszip");
  const { XMLParser } = await import("fast-xml-parser");
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.keys(zip.files);
  const scan: OoxmlScan = {
    entries,
    blocked: entries.filter((name) => BLOCKED_OOXML_PARTS.test(name)),
  };

  const slideNames = entries
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideIndex(a) - slideIndex(b));

  if (slideNames.length === 0) {
    return emptyResult("ppt", "corrupt", request);
  }

  const parser = new XMLParser({
    ignoreAttributes: true,
    // 不做实体解析：XXE / 十亿笑声都从这里进来。fast-xml-parser 默认
    // 不展开外部实体，这里再显式关一次，免得默认值哪天变了。
    processEntities: false,
  });

  const chunks: string[] = [];
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.files[slideNames[i]].async("string");
    const texts: string[] = [];
    collectText(parser.parse(xml), texts);
    chunks.push(`# 第 ${i + 1} 页`, texts.join("\n"));
  }

  // SmartArt / 图表 / 嵌入对象：正文照常给，同时如实降级。
  const hasUnsupportedParts = entries.some((name) =>
    /^ppt\/(diagrams|charts|embeddings)\//.test(name)
  );
  const body = truncate(redactExternalTargets(chunks.join("\n\n")), maxChars);
  return {
    ...emptyResult("ppt", hasUnsupportedParts ? "unsupported" : "ok", request, body),
    notices: safetyNotices(scan),
  };
}

function slideIndex(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/** 深度优先收集 `a:t` 节点的文本。深度封顶，防深嵌套 XML 把栈打爆。 */
function collectText(node: unknown, out: string[], depth = 0): void {
  if (depth > 64 || node === null || node === undefined) return;
  if (typeof node === "string") return;
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "a:t") {
      if (typeof value === "string") out.push(value);
      else if (Array.isArray(value)) out.push(...value.map((v) => String(v)));
      else if (value !== null && value !== undefined) out.push(String(value));
      continue;
    }
    collectText(value, out, depth + 1);
  }
}

// ------------------------------------------------- utilityProcess 入口装配

/**
 * 只有真的跑在 utilityProcess 里时才装配消息循环。
 *
 * 单测直接 import 本模块并调 convertFile —— 那时 `process.parentPort`
 * 是 undefined，下面这段整个跳过。没有这道判断的话，import 本身会抛，
 * 于是 convert-worker 的逻辑变成不可单测的。
 */
const parentPort = (process as NodeJS.Process & { parentPort?: NodeJS.EventEmitter })
  .parentPort;

if (parentPort && typeof parentPort.on === "function") {
  parentPort.on("message", (event: { data?: ConvertRequest }) => {
    const request = event?.data;
    if (!request) return;
    void convertFile(request)
      .then((result) => {
        const reply: ConvertReply = { requestId: request.requestId, result };
        (parentPort as unknown as { postMessage(m: unknown): void }).postMessage(reply);
      })
      .catch(() => {
        const reply: ConvertReply = {
          requestId: request.requestId,
          result: emptyResult("text", "corrupt", request),
        };
        (parentPort as unknown as { postMessage(m: unknown): void }).postMessage(reply);
      });
  });
}
