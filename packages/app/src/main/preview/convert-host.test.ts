import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 转换宿主的四项硬上限与两条卫生条款（ART-101）。
 *
 * 每一条都对应一个**装完才会暴露**的失败：
 *
 *   超时不 kill        → 卡住的子进程一直活着，表现只是内存慢慢涨
 *   超大输入照样 fork  → 一次预览就把内存打满
 *   env 原样继承       → 解析恶意文档的进程持有全部 API key
 *   临时目录不清       → 磁盘一天天满，全程零报错
 *   asar 路径不重写    → dev 全绿、装完之后预览整体不可用
 */
import type { PreviewResult } from "@pibuddy/contract";

let tempDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => tempDir },
  utilityProcess: { fork: vi.fn() },
}));

type Host = typeof import("./convert-host.js");

let tmpRoot = "";
let host: Host;

/** 记录每次 fork 的参数，并按剧本决定这个假子进程怎么表现。 */
interface Script {
  /** 回一个正常结果 */
  reply?: Partial<PreviewResult>;
  /** 什么都不回（用来触发超时） */
  silent?: boolean;
  /** 立刻 exit（模拟被 --max-old-space-size 打死） */
  crash?: boolean;
}

const forks: { entry: string; env: Record<string, string>; execArgv: string[] }[] = [];

function installFactory(scriptFor: (n: number) => Script): void {
  let n = 0;
  host.__setConvertChildFactory((entry, options) => {
    const script = scriptFor(n++);
    forks.push({ entry, env: options.env, execArgv: options.execArgv });
    let messageListener: ((reply: unknown) => void) | null = null;
    let exitListener: ((code: number) => void) | null = null;
    let killed = false;
    return {
      postMessage: (request) => {
        if (script.silent) return;
        if (script.crash) {
          setTimeout(() => exitListener?.(1), 0);
          return;
        }
        setTimeout(() => {
          messageListener?.({
            requestId: request.requestId,
            result: {
              kind: "text",
              code: "ok",
              text: "内容",
              suggestion: "",
              notices: [],
              tables: [],
              dataUrl: null,
              sourceName: request.sourceName,
              sizeBytes: request.sizeBytes,
              elapsedMs: 1,
              ...script.reply,
            },
          });
        }, 0);
      },
      on: (_e, listener) => {
        messageListener = listener as (reply: unknown) => void;
      },
      once: (_e, listener) => {
        exitListener = listener as (code: number) => void;
      },
      kill: () => {
        killed = true;
      },
      get killed() {
        return killed;
      },
    };
  });
}

beforeEach(async () => {
  vi.resetModules();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-convert-"));
  tempDir = tmpRoot;
  forks.length = 0;
  host = await import("./convert-host.js");
  host.__resetForkCount();
});

afterEach(() => {
  host?.__setConvertChildFactory(null);
  host?.__setConvertTimeout(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFile(name: string, bytes: number): string {
  const p = path.join(tmpRoot, name);
  const fd = fs.openSync(p, "w");
  // 稀疏写：只落一个字节，文件大小仍然是 bytes（测上限不需要真的写满）
  if (bytes > 0) {
    fs.ftruncateSync(fd, bytes);
  }
  fs.closeSync(fd);
  return p;
}

describe("CONVERT_LIMITS", () => {
  it("四项硬上限取值与计划一致", () => {
    expect(host.CONVERT_LIMITS.maxInputBytes).toBe(50 * 1024 * 1024);
    expect(host.CONVERT_LIMITS.maxOutputBytes).toBe(100 * 1024 * 1024);
    expect(host.CONVERT_LIMITS.timeoutMs).toBe(30_000);
    expect(host.CONVERT_LIMITS.maxRssBytes).toBe(512 * 1024 * 1024);
  });

  it("(b) 输入超过 maxInputBytes 直接拒绝，且一个子进程都没起", async () => {
    const big = writeFile("huge.docx", host.CONVERT_LIMITS.maxInputBytes + 1);
    installFactory(() => ({}));
    const outcome = await host.convert({ inputPath: big, sourceName: "huge.docx" });
    expect(outcome).toEqual({ ok: false, code: "too-large" });
    expect(host.forkCountSoFar()).toBe(0);
    expect(forks).toHaveLength(0);
  });

  it("(a) 超过 timeoutMs 的转换被 kill 并返回 timeout", async () => {
    // 把 30 秒压成 30 毫秒：判据是「到点就 kill」，不是「到点的那个数」。
    // 那个数由上面一条断言逐字盯着。
    host.__setConvertTimeout(30);
    const file = writeFile("slow.docx", 1024);
    let killed = false;
    host.__setConvertChildFactory(() => ({
      postMessage: () => {},
      on: () => {},
      once: () => {},
      kill: () => {
        killed = true;
      },
      get killed() {
        return killed;
      },
    }));
    const outcome = await host.convert({ inputPath: file, sourceName: "slow.docx" });
    expect(outcome).toEqual({ ok: false, code: "timeout" });
    expect(killed).toBe(true);
  });

  it("子进程崩掉（堆上限被打满）记成 oom", async () => {
    const file = writeFile("bomb.xlsx", 2048);
    installFactory(() => ({ crash: true }));
    const outcome = await host.convert({ inputPath: file, sourceName: "bomb.xlsx" });
    expect(outcome).toEqual({ ok: false, code: "oom" });
  });

  it("堆上限经 --max-old-space-size 真的传给了子进程", async () => {
    const file = writeFile("a.md", 8);
    installFactory(() => ({}));
    await host.convert({ inputPath: file, sourceName: "a.md" });
    expect(forks[0].execArgv).toContain("--max-old-space-size=512");
  });
});

describe("env 净化", () => {
  it("(c) 子进程 env 里没有任何 PIBUDDY_ 前缀或 _API_KEY 后缀的变量", async () => {
    const env = host.sanitizedEnv({
      PATH: "/usr/bin",
      TEMP: "/tmp",
      PIBUDDY_UPDATE_FEED_URL: "https://x",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "sk-secret2",
      NODE_OPTIONS: "--require ./evil.js",
    } as NodeJS.ProcessEnv);
    const keys = Object.keys(env);
    expect(keys.some((k) => k.startsWith("PIBUDDY_"))).toBe(false);
    expect(keys.some((k) => k.endsWith("_API_KEY"))).toBe(false);
    expect(Object.values(env)).not.toContain("sk-secret");
    // NODE_OPTIONS 被清空：外部注入的 --require 比宏还直接。
    expect(env.NODE_OPTIONS).toBe("");
  });

  it("真正 fork 时用的也是净化过的 env", async () => {
    const file = writeFile("b.md", 8);
    installFactory(() => ({}));
    await host.convert({ inputPath: file, sourceName: "b.md" });
    const keys = Object.keys(forks[0].env);
    expect(keys.some((k) => k.startsWith("PIBUDDY_"))).toBe(false);
    expect(keys.some((k) => k.endsWith("_API_KEY"))).toBe(false);
    expect(host.lastForkEnv().NODE_OPTIONS).toBe("");
  });
});

describe("packaged worker 路径解析", () => {
  it("(a) 路径里含 app.asar 时改写成 app.asar.unpacked，且不留裸 app.asar/", () => {
    const packaged = "C:\\Program Files\\PiBuddy\\resources\\app.asar\\out\\main\\convert-worker.js";
    const rewritten = host.rewriteAsarPath(packaged);
    expect(rewritten).toContain("app.asar.unpacked");
    expect(rewritten).not.toContain("app.asar\\out");
    const posix = "/opt/PiBuddy/resources/app.asar/out/main/convert-worker.js";
    const rewrittenPosix = host.rewriteAsarPath(posix);
    expect(rewrittenPosix).toContain("app.asar.unpacked");
    expect(rewrittenPosix).not.toContain("app.asar/out");
  });

  it("(b) dev 下（路径不含 app.asar）原样返回", () => {
    const dev = path.join("D:", "work", "pi-ui", "out", "main", "convert-worker.js");
    expect(host.rewriteAsarPath(dev)).toBe(dev);
    // 真实入口在 dev 下也不该被改写
    expect(host.resolveWorkerPath()).not.toContain("app.asar.unpacked");
    expect(host.resolveWorkerPath()).toContain("convert-worker.js");
  });
});

describe("临时目录清理", () => {
  it("50 次转换（其中 20 次故意失败）之后专属目录一个不剩", async () => {
    const good = writeFile("ok.md", 16);
    const tooBig = writeFile("nope.md", host.CONVERT_LIMITS.maxInputBytes + 1);
    // 前 20 次让子进程直接崩（oom 路径），后 30 次正常返回
    installFactory((n) => (n < 20 ? { crash: true } : {}));

    for (let i = 0; i < 50; i++) {
      if (i === 25) {
        // 掺一次 too-large：它走的是「根本不 fork」那条路，同样不该留目录
        await host.convert({ inputPath: tooBig, sourceName: "nope.md" });
        continue;
      }
      await host.convert({ inputPath: good, sourceName: "ok.md" });
    }

    const base = path.join(tempDir, "pibuddy-convert");
    expect(fs.existsSync(base)).toBe(true);
    expect(fs.readdirSync(base)).toHaveLength(0);
  });
});

/**
 * 输出闸门量的是**整份结果**，不只是 `text`。
 *
 * 旧实现只数 `Buffer.byteLength(result.text)`，于是 `tables` / `dataUrl` /
 * `notices` 三处全是敞开的：一个宽表或多工作表的 xlsx 完全可以做到 text
 * 为空、tables 里躺着几百兆字符串 —— 闸门一个字节都数不到，而这份结果要
 * 跨两次 structured-clone，主进程在克隆期间是完全卡住的。
 */
describe("输出规模上限覆盖 tables / dataUrl / notices", () => {
  function result(over: Partial<PreviewResult>): PreviewResult {
    return {
      kind: "excel",
      code: "ok",
      text: "",
      suggestion: "",
      notices: [],
      tables: [],
      dataUrl: null,
      sourceName: "book.xlsx",
      sizeBytes: 1024,
      elapsedMs: 1,
      ...over,
    };
  }

  function sheet(name: string, rows: string[][]): PreviewResult["tables"][number] {
    return { name, rows, truncated: false };
  }

  it("正常结果放行", () => {
    expect(
      host.checkOutputLimits(result({ tables: [sheet("Sheet1", [["a", "b"], ["c", "d"]])] }))
    ).toBeNull();
  });

  it("工作表数超限 → too-large，提示里说清是工作表太多", () => {
    const tables = Array.from({ length: host.CONVERT_LIMITS.maxTables + 1 }, (_, i) =>
      sheet(`S${i}`, [["x"]])
    );
    const v = host.checkOutputLimits(result({ tables }));
    expect(v?.code).toBe("too-large");
    expect(v?.suggestion).toContain("工作表");
  });

  it("列数超限 → too-large，提示里说清是列太多", () => {
    const wide = Array.from({ length: host.CONVERT_LIMITS.maxTableColumns + 1 }, () => "x");
    const v = host.checkOutputLimits(result({ tables: [sheet("宽表", [wide])] }));
    expect(v?.code).toBe("too-large");
    expect(v?.suggestion).toContain("列");
  });

  it("单元格字符总数超限 → too-large（text 为空也照样拦得住）", () => {
    // 每格 1000 字符 × 10000 格 = 1000 万字符，超过 800 万上限
    const cell = "字".repeat(1000);
    const rows = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => cell));
    const v = host.checkOutputLimits(result({ text: "", tables: [sheet("Sheet1", rows)] }));
    expect(v?.code).toBe("too-large");
    expect(v?.suggestion).toContain("表格内容太多");
  });

  it("dataUrl 也计入总量（图片走的就是这一条）", () => {
    const huge = "A".repeat(host.CONVERT_LIMITS.maxOutputBytes + 1);
    const v = host.checkOutputLimits(result({ kind: "image", dataUrl: `data:image/png;base64,${huge}` }));
    expect(v?.code).toBe("too-large");
    expect(v?.suggestion).toContain("MB");
  });

  it("超限时 convert() 返回 too-large，并带上那句更具体的提示", async () => {
    const file = writeFile("wide.xlsx", 4096);
    const wide = Array.from({ length: host.CONVERT_LIMITS.maxTableColumns + 1 }, () => "x");
    installFactory(() => ({ reply: { tables: [{ name: "宽表", rows: [wide], truncated: false }] } }));
    const outcome = await host.convert({ inputPath: file, sourceName: "wide.xlsx" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("too-large");
    expect(outcome.suggestion).toContain("列");
  });
});
