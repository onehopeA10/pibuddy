/**
 * 转换宿主（ART-101）：起进程、施加硬上限、收尸、清临时目录。
 *
 * ## 四项硬上限为什么必须在宿主这一侧
 *
 * worker 自己是不可信的 —— 它正在解析攻击者提供的字节，一旦被打崩，
 * 它写在自己代码里的任何「上限」都跟着一起没了。因此判据全部放在
 * 这一侧：**输入大小在 fork 之前查**（超了根本不起进程），**超时由宿主
 * 的定时器 kill**（不指望子进程自觉），**内存由 V8 的 --max-old-space-size
 * 硬封**（超了子进程直接崩，宿主记一次 oom），**输出大小在收到回复时查**。
 *
 * ## 每次转换一个专属临时目录，而且必须被删掉
 *
 * 转换产物落在 `<temp>/pibuddy-convert/<uuid>/` 下，子进程除了这个目录
 * 和那一个输入文件之外不被授予任何路径。残留目录是一个**完全无声**的
 * 缺陷：不报错、不影响功能，只是磁盘一天天满 —— 因此清理写在 finally
 * 里，成功、超时、oom、too-large 四条路径共用同一处。
 *
 * ## 环境变量必须净化
 *
 * 主进程的 env 里躺着 provider 的 API key（`*_API_KEY`）与全部
 * `PIBUDDY_*` 配置。子进程解析的是恶意文档，把这些原样继承过去，
 * 等于让一个已经假定会被打崩的进程持有全部凭据。
 */
import { app, utilityProcess } from "electron";
import type { PreviewCode, PreviewResult } from "@pibuddy/contract";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { DEFAULT_MAX_TEXT_CHARS } from "./convert-worker.js";
import type { ConvertOutcome, ConvertReply, ConvertRequest } from "./preview-types.js";

/**
 * 一次转换的四项硬上限。
 *
 * 数值不是拍的：50MB 覆盖了绝大多数真实的 Office / PDF 文件（超过这个
 * 尺寸的文档在 Word 里打开本身就要转好久）；100MB 输出上限给抽取结果
 * 留了两倍余量；30 秒是用户还愿意等的极限；512MB 堆上限比 Electron
 * 主进程自己的常驻占用还小，被打满时崩的是子进程。
 */
export const CONVERT_LIMITS = {
  maxInputBytes: 50 * 1024 * 1024,
  /**
   * 输出上限，量的是**整个 PreviewResult**，不只是 `text`。
   *
   * 只量 text 的话，`tables` / `dataUrl` / `notices` 三处全是敞开的：一个
   * 宽表或多工作表的 xlsx 可以做到 text 为空、tables 里躺着几百兆字符串，
   * 这个闸门一个字节都数不到。而这份结果要跨两次 structured-clone
   * （worker → main、main → 渲染进程），主进程在克隆期间是**完全卡住**的。
   */
  maxOutputBytes: 100 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRssBytes: 512 * 1024 * 1024,
  /** 工作表 / 分片数上限。真实文件极少超过，异常形状会一眼撞上。 */
  maxTables: 256,
  /** 单表列数上限。Excel 理论上能到 16384 列，那种表预览里根本没法看。 */
  maxTableColumns: 4096,
  /** 全部表格单元格的字符总数。宽表最直接的膨胀维度就是它。 */
  maxTableCellChars: 8_000_000,
} as const;

/** 超限时的降级信息：错误码 + 一句用户能据以行动的话。 */
export interface OutputLimitViolation {
  code: "too-large";
  suggestion: string;
}

/**
 * 检查一份转换结果的规模。**在宿主这一侧，不在 worker 里。**
 *
 * worker 正在解析攻击者提供的字节，它写在自己代码里的任何上限都可能已经
 * 随它一起被打崩了；这里量的是**实际收到的东西**。
 *
 * 超限一律返回可行动的降级提示，而不是悄悄截断 —— 截断之后用户看到的是
 * 一份缺了后半截的表格，界面上没有任何线索说少了东西，他会照着这份残表
 * 去做判断。
 */
export function checkOutputLimits(result: PreviewResult): OutputLimitViolation | null {
  if (result.tables.length > CONVERT_LIMITS.maxTables) {
    return {
      code: "too-large",
      suggestion: `这个文件里有 ${result.tables.length} 个工作表，超过预览能安全处理的 ${CONVERT_LIMITS.maxTables} 个。请用 Excel 这类程序直接打开，或者先拆成几个小文件再预览。`,
    };
  }

  let cellChars = 0;
  let bytes =
    Buffer.byteLength(result.text, "utf8") +
    Buffer.byteLength(result.suggestion, "utf8") +
    Buffer.byteLength(result.sourceName, "utf8") +
    (result.dataUrl === null ? 0 : Buffer.byteLength(result.dataUrl, "utf8"));
  for (const notice of result.notices) bytes += Buffer.byteLength(notice, "utf8");

  for (const table of result.tables) {
    bytes += Buffer.byteLength(table.name, "utf8");
    for (const row of table.rows) {
      if (row.length > CONVERT_LIMITS.maxTableColumns) {
        return {
          code: "too-large",
          suggestion: `这张表有 ${row.length} 列，超过预览上限 ${CONVERT_LIMITS.maxTableColumns} 列。请用 Excel 这类程序直接打开，或者先删掉用不到的列再预览。`,
        };
      }
      for (const cell of row) {
        cellChars += cell.length;
        bytes += Buffer.byteLength(cell, "utf8");
        // 提前收手：已经超了就不必把剩下的几千万个单元格再数一遍。
        if (cellChars > CONVERT_LIMITS.maxTableCellChars) {
          return {
            code: "too-large",
            suggestion: `这个文件里的表格内容太多（超过 ${Math.round(CONVERT_LIMITS.maxTableCellChars / 10000) / 100} 百万字符），全部塞进预览会把界面卡死。请用 Excel 这类程序直接打开它。`,
          };
        }
        if (bytes > CONVERT_LIMITS.maxOutputBytes) return tooLargeOverall(bytes);
      }
    }
  }

  if (bytes > CONVERT_LIMITS.maxOutputBytes) return tooLargeOverall(bytes);
  return null;
}

function tooLargeOverall(bytes: number): OutputLimitViolation {
  const mb = Math.round(bytes / 1024 / 1024);
  const limitMb = Math.round(CONVERT_LIMITS.maxOutputBytes / 1024 / 1024);
  return {
    code: "too-large",
    suggestion: `这个文件抽出来的内容有大约 ${mb} MB，超过预览上限 ${limitMb} MB，显示出来会把界面卡死。请用系统里的对应程序直接打开它。`,
  };
}

/** 全部专属临时目录的父目录。清理断言查的就是它下面还剩几个条目。 */
export function convertBaseDir(): string {
  return path.join(app.getPath("temp"), "pibuddy-convert");
}

/**
 * worker 脚本在磁盘上的位置。
 *
 * `utilityProcess.fork` 收的是一个**真实文件路径**，asar 里的虚拟路径它
 * 打不开。electron-builder.yml 因此把 `out/main/convert-worker.js` 列进
 * asarUnpack，运行期这里把路径里的 `app.asar` 改写成 `app.asar.unpacked`。
 *
 * dev 下 `import.meta.dirname` 不含 app.asar，原样返回 —— 漏掉这段重写
 * 的表现极其典型：dev 全绿、单测全绿、装完之后预览整体打不开。
 */
export function resolveWorkerPath(): string {
  return rewriteAsarPath(path.join(import.meta.dirname, "convert-worker.js"));
}

/**
 * 把 asar 内的路径重写成 asar.unpacked。
 *
 * 抽成纯函数才测得到：`import.meta.dirname` 在测试里恒为源码目录，
 * 走不到 packaged 分支 —— 而那个分支恰恰是唯一会在装机后才出问题的。
 * 两种分隔符都认（Windows 上 electron-builder 产出的路径是反斜杠）。
 */
export function rewriteAsarPath(p: string): string {
  for (const sep of ["\\", "/"]) {
    const marker = `app.asar${sep}`;
    if (p.includes(marker)) return p.split(marker).join(`app.asar.unpacked${sep}`);
  }
  return p;
}

/**
 * 子进程可见的环境变量。
 *
 * 白名单式：只有 PATH / TEMP / TMP / SystemRoot 这几个「不给就起不来」
 * 的变量能过去，其余一律不传。另外显式再滤一道 `PIBUDDY_*` 与
 * `*_API_KEY` —— 白名单已经够了，这一道是给单测一个可以直接断言的对象。
 */
export function sanitizedEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const allow = ["PATH", "Path", "TEMP", "TMP", "TMPDIR", "SystemRoot", "windir", "HOME"];
  const out: Record<string, string> = {};
  for (const key of allow) {
    const value = source[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  for (const key of Object.keys(out)) {
    if (key.startsWith("PIBUDDY_") || key.endsWith("_API_KEY")) delete out[key];
  }
  // NODE_OPTIONS 必须显式清空：外部设置的 --require 会让攻击者选定的
  // 模块在 worker 启动时先跑一遍，那比宏还直接。
  out.NODE_OPTIONS = "";
  return out;
}

/** 子进程句柄的最小接口。单测用一个同构的假实现替换它。 */
export interface ConvertChild {
  postMessage(message: ConvertRequest): void;
  on(event: "message", listener: (reply: ConvertReply) => void): void;
  once(event: "exit", listener: (code: number) => void): void;
  kill(): void;
  readonly killed: boolean;
}

export interface ForkOptions {
  env: Record<string, string>;
  execArgv: string[];
  serviceName: string;
}

export type ConvertChildFactory = (entry: string, options: ForkOptions) => ConvertChild;

const defaultFactory: ConvertChildFactory = (entry, options) => {
  const child = utilityProcess.fork(entry, [], {
    env: options.env,
    execArgv: options.execArgv,
    serviceName: options.serviceName,
    stdio: "pipe",
  });
  let killed = false;
  return {
    postMessage: (message) => child.postMessage(message),
    on: (_event, listener) => child.on("message", listener as (m: unknown) => void),
    once: (_event, listener) => child.once("exit", listener as (c: number) => void),
    kill: () => {
      killed = true;
      child.kill();
    },
    get killed() {
      return killed;
    },
  };
};

let factory: ConvertChildFactory = defaultFactory;

/**
 * 仅供单测：临时压缩超时。
 *
 * 不用 vi.useFakeTimers 是有原因的：convert() 在装定时器之前要先 await
 * 两次真实的文件系统调用，假时钟推进那一刻定时器还没装上，推进就落空了
 * —— 表现是测试卡满 20 秒然后超时，而被测代码其实是好的。
 */
let timeoutOverrideMs: number | null = null;
export function __setConvertTimeout(ms: number | null): void {
  timeoutOverrideMs = ms;
}

/** 仅供单测：替换子进程工厂（传 null 还原成真的 utilityProcess.fork）。 */
export function __setConvertChildFactory(next: ConvertChildFactory | null): void {
  factory = next ?? defaultFactory;
}

/** 最近一次 fork 时传给子进程的 env。单测据它断言凭据没有外泄。 */
let lastEnv: Record<string, string> = {};
export function lastForkEnv(): Record<string, string> {
  return lastEnv;
}

/** 已经 fork 过多少次。单测据它断言「too-large 的输入根本没起进程」。 */
let forkCount = 0;
export function forkCountSoFar(): number {
  return forkCount;
}
export function __resetForkCount(): void {
  forkCount = 0;
  lastEnv = {};
}

export interface ConvertInput {
  /** 已经过收容校验的输入文件绝对路径 */
  inputPath: string;
  sourceName: string;
  maxTextChars?: number;
}

/**
 * 执行一次转换。
 *
 * 返回 `{ok:false, code}` 而不是抛错：调用方（preview-ipc）要把 code 原样
 * 交给界面显示对应的建议文案，抛错会让分类在 catch 里被压平成一句
 * 「出错了」。
 */
export async function convert(input: ConvertInput): Promise<ConvertOutcome> {
  // ---- 闸 1：输入大小。超了**不 fork** —— 起一个进程再让它读 5GB 是自找的。
  let size = 0;
  try {
    const stat = await fsp.stat(input.inputPath);
    size = stat.size;
    if (!stat.isFile()) return { ok: false, code: "corrupt" };
  } catch {
    return { ok: false, code: "corrupt" };
  }
  if (size > CONVERT_LIMITS.maxInputBytes) {
    return { ok: false, code: "too-large" };
  }

  const base = convertBaseDir();
  const outputDir = path.join(base, randomUUID());
  await fsp.mkdir(outputDir, { recursive: true });

  try {
    return await runInChild(input, size, outputDir);
  } finally {
    // 成功、超时、oom、异常 —— 四条路径共用这一处清理。
    await fsp.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runInChild(
  input: ConvertInput,
  size: number,
  outputDir: string
): Promise<ConvertOutcome> {
  const requestId = randomUUID();
  const env = sanitizedEnv();
  lastEnv = env;
  forkCount++;

  const child = factory(resolveWorkerPath(), {
    env,
    // V8 堆上限 = maxRssBytes。超了子进程自己崩，宿主收到 exit 记 oom。
    execArgv: [`--max-old-space-size=${Math.floor(CONVERT_LIMITS.maxRssBytes / 1024 / 1024)}`],
    serviceName: "pibuddy-convert",
  });

  return new Promise<ConvertOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ConvertOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      // 不指望子进程自觉停下：它可能正卡在一个解压炸弹里。
      finish({ ok: false, code: "timeout" });
    }, timeoutOverrideMs ?? CONVERT_LIMITS.timeoutMs);
    timer.unref?.();

    child.once("exit", () => {
      // 还没回结果就退了 = 它崩了。绝大多数情况是被 --max-old-space-size
      // 打死的，记成 oom；这比记成一句「未知错误」对用户有用得多。
      finish({ ok: false, code: "oom" });
    });

    child.on("message", (reply) => {
      if (!reply || reply.requestId !== requestId) return;
      const result = reply.result as PreviewResult | undefined;
      if (!result) return finish({ ok: false, code: "corrupt" });
      // ---- 闸 4：输出规模。抽出来的内容也可能是攻击载荷（zip 炸弹解出来
      // 的几百兆字符、几千列的宽表），塞进 IPC 会把主进程与渲染进程一起
      // 拖死。量的是整份结果，不只是 text —— 见 checkOutputLimits。
      const violation = checkOutputLimits(result);
      if (violation) return finish({ ok: false, code: violation.code, suggestion: violation.suggestion });
      finish({ ok: true, result });
    });

    const request: ConvertRequest = {
      requestId,
      inputPath: input.inputPath,
      outputDir,
      sourceName: input.sourceName,
      sizeBytes: size,
      maxTextChars: input.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    };
    child.postMessage(request);
  });
}

/** 把 code 映射成给用户看的那句话。preview-ipc 与渲染侧共用同一处口径。 */
export function isFailureCode(code: PreviewCode): boolean {
  return code !== "ok";
}

/** 应用退出时清掉整棵转换缓存树（残留只会表现为磁盘慢慢满）。 */
export function purgeConvertCache(): void {
  try {
    fs.rmSync(convertBaseDir(), { recursive: true, force: true });
  } catch {
    // 清不掉不该阻塞退出
  }
}
