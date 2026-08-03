import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 内核边界的结构性断言（ADR-0002 实施顺序第 1 条）。
 *
 * 这些不是「测实现」，而是把 ADR 里的文字条款钉成机器判据。同类手法在本仓
 * 已有先例：`ipc-guard.ts:14` 的「守卫外 ipcMain 命中数恒为 0」、
 * `net/outbound-guard.ts:16` 的「守卫外 fetch( 命中数恒为 0」。
 *
 * 判据钉的是**依赖方向**，不钉任何文件名以外的实现细节：handler 迁到别的
 * 目录、logger 换个实现，这里依然成立；而一旦有人把日志出口又接回 pi 域，
 * 或者新开一个内核模块去 import pi，立刻红。
 */

const MAIN = path.resolve(import.meta.dirname, "../src/main");
const APP_SRC = path.resolve(import.meta.dirname, "../src");

/** pi 域的模块路径特征（相对 import 的尾部）。 */
const PI_DOMAIN = /(^|\/)pi\/[\w-]+\.js$/;

/**
 * pi 域的成员文件（相对 src/main）。
 *
 * 除 `pi/` 目录外还有三个顶层文件：它们是 pi runtime 的组成部分（spawn 参数、
 * 运行时清单、supervisor），只是摆放位置是历史遗留。它们 import `pi/` 属于
 * **域内**依赖，不是内核对 pi 的依赖，因此不在下面那条判据的范围里。
 */
const PI_DOMAIN_MEMBERS = new Set([
  "pi-supervisor.ts",
  "pi-launcher.ts",
  "pi-runtime-manifest.ts",
]);

function isPiDomainFile(file: string): boolean {
  return file.startsWith("pi/") || PI_DOMAIN_MEMBERS.has(file);
}

/**
 * 允许 import pi 域的内核模块，逐条附理由。
 *
 * 这张表**只减不增**：新增一条就等于新增一处内核对 pi runtime 的硬依赖，
 * 而 ADR-0002 的前提正是 pi runtime 必须可替换。
 */
const PI_IMPORT_ALLOWLIST: Record<string, string> = {
  // 宿主的装配点。能力包架构里注册表本来就该知道每个能力的入口。
  "ipc-registry.ts": "registerPiIpc —— 装配清单",
  // ADR-0002「其余四条」之一：client 索引的生命周期出口，随 pi 能力包拆分时处理。
  "ipc.ts": "disposeClientFor —— 待随 pi 包拆分迁走",
  // ADR-0002「其余四条」之一：sessions:rename / export 需要当前 runtime 的 client。
  "sessions/sessions-ipc.ts": "tryClientFor —— 待随 pi 包拆分迁走",
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

interface ImportStatement {
  /** 相对 src/main 的 posix 路径 */
  file: string;
  /** import / export 的绑定子句原文 */
  clause: string;
  /** from 后面的模块说明符 */
  specifier: string;
}

/**
 * 抽出所有 `import … from "…"` / `export … from "…"`。
 *
 * 子句里禁止出现 `;`，因此一条语句不会吞掉后面的代码 —— 那种吞法会让
 * 断言在某些文件上凭空多出并不存在的绑定名，变成随机的假红或假绿。
 */
function importsOf(files: string[]): ImportStatement[] {
  const out: ImportStatement[] = [];
  const re = /^(?:import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["'];?$/gm;
  for (const full of files) {
    const text = fs.readFileSync(full, "utf8");
    const file = path.relative(MAIN, full).split(path.sep).join("/");
    for (const m of text.matchAll(re)) {
      out.push({ file, clause: m[1], specifier: m[2] });
    }
  }
  return out;
}

const mainFiles = walk(MAIN).filter((f) => !f.endsWith(".test.ts"));
const mainImports = importsOf(mainFiles);

describe("ADR-0002：日志是内核设施，不是 pi 域的导出", () => {
  it("main 下没有任何模块从 pi 域取 log", () => {
    const offenders = mainImports
      .filter((stmt) => PI_DOMAIN.test(stmt.specifier))
      .filter((stmt) => /\blog\b/.test(stmt.clause))
      .map((stmt) => `${stmt.file} → ${stmt.specifier}`);
    expect(offenders).toEqual([]);
  });

  it("pi 域自己也只是 log() 的消费方：pi-ipc.ts 不再导出 log", () => {
    const text = fs.readFileSync(path.join(MAIN, "pi/pi-ipc.ts"), "utf8");
    expect(text).not.toMatch(/export\s+function\s+log\b/);
    expect(text).toContain('import { log } from "../log.js";');
  });

  it("内核日志出口只有 log.ts 一处解析日志目录", () => {
    const sites = mainFiles
      .filter((full) => /getPath\("userData"\),\s*"logs"\)/.test(fs.readFileSync(full, "utf8")))
      .map((full) => path.relative(MAIN, full).split(path.sep).join("/"));
    expect(sites).toEqual(["log.ts"]);
  });

  it("全仓仍然只有一个日志器实现", () => {
    const impls = walk(APP_SRC)
      .filter((full) => /^\s*export function createLogger\b/m.test(fs.readFileSync(full, "utf8")))
      .map((full) => path.relative(APP_SRC, full).split(path.sep).join("/"));
    expect(impls).toEqual(["main/logger.ts"]);
  });
});

describe("ADR-0002：内核模块不得 import pi 域", () => {
  it("除登记在案的三处外，没有内核模块依赖 pi 域", () => {
    const offenders = mainImports
      .filter((stmt) => !isPiDomainFile(stmt.file))
      .filter((stmt) => PI_DOMAIN.test(stmt.specifier))
      .filter((stmt) => PI_IMPORT_ALLOWLIST[stmt.file] === undefined)
      .map((stmt) => `${stmt.file} → ${stmt.specifier}`);
    expect(offenders).toEqual([]);
  });

  it("登记表里的每一条都还真的存在（表只减不增，不留死条目）", () => {
    const actual = new Set(
      mainImports
        .filter((stmt) => !isPiDomainFile(stmt.file))
        .filter((stmt) => PI_DOMAIN.test(stmt.specifier))
        .map((stmt) => stmt.file)
    );
    expect([...actual].sort()).toEqual(Object.keys(PI_IMPORT_ALLOWLIST).sort());
  });
});
