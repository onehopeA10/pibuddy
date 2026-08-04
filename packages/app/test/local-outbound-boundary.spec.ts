import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BUILT_IN_CAPABILITIES } from "../src/main/capability/capability-manifests.js";

/**
 * local 车道的结构性断言（SEC-004 扩展 / Phase A）。
 *
 * 三份 census 把「出站原语只有两条守卫」这句话钉成机器判据，手法同
 * kernel-boundary.spec（守卫外 ipcMain / fetch 命中数恒为 0）：
 *
 *   ① socket census —— main 下裸 socket 出站原语（net.connect / tls.connect /
 *      http(s).request / new WebSocket）只允许出现在登记表里，表只减不增；
 *   ② fetch census —— outbound-guard.ts 头注释里那条 rg 命令固化为 vitest：
 *      守卫外 `fetch(` 命中数恒为 0；
 *   ③ import census —— import 两个 local 原语文件的模块 ⊆ {声明了
 *      network.local 的能力目录} ∪ {net/ 自身}。本阶段还没有声明方，断言对
 *      空集也成立；HA 能力包落地时无需改这里，机制自动生效。
 */

const APP_SRC = path.resolve(import.meta.dirname, "../src");

/** 去注释（同 capability-drift.spec：不去的话注释里的一次「提及」会被判成调用）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** main/** 下全部 .ts 实现文件，路径相对 APP_SRC、`/` 分隔（与 manifest 的写法一致）。 */
function mainFiles(): string[] {
  const acc: string[] = [];
  const walk = (relDir: string): void => {
    for (const entry of fs.readdirSync(path.join(APP_SRC, relDir), { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) continue;
      acc.push(rel);
    }
  };
  walk("main");
  return acc;
}

function sourceOf(rel: string): string {
  return stripComments(fs.readFileSync(path.join(APP_SRC, rel), "utf8"));
}

/**
 * 浏览器端字符串容器豁免：pwa-assets 里的 .ts 只是装浏览器端代码的字符串，
 * fetch / new WebSocket 特征在手机浏览器里运行，从不在主进程执行——与
 * capability-drift.spec 的 PERMISSION_SCAN_EXEMPTIONS 同一条理由、同一个路径。
 */
const BROWSER_STRING_EXEMPT = "main/remote/pwa-assets";

function isBrowserStringExempt(rel: string): boolean {
  return rel === BROWSER_STRING_EXEMPT || rel.startsWith(`${BROWSER_STRING_EXEMPT}/`);
}

// ---------------------------------------------------------------- ① socket

/**
 * 裸 socket 出站原语的允许表，逐条附理由，**只减不增**：新增一条 = 新开一条
 * 绕过两个出站守卫的通路。
 */
const SOCKET_ALLOWLIST: Record<string, string> = {
  "main/net/local-ws-client.ts":
    "local 车道唯一的 WS 客户端原语：入口参数是 AuthorizedLocalEndpoint（brand type，" +
    "必过 manifest 上界 + PermissionEngine 授权两道关），连接前重跑私网地址断言",
};

const SOCKET_RE = /\b(?:net|tls)\.connect\s*\(|\bhttps?\.request\s*\(|\bnew\s+WebSocket\s*\(/;

describe("① socket census：裸 socket 出站原语只在允许表里", () => {
  it("命中集合 == 允许表键集合（双向：越权即红，死条目也红）", () => {
    const hits = mainFiles()
      .filter((rel) => !isBrowserStringExempt(rel))
      .filter((rel) => SOCKET_RE.test(sourceOf(rel)));
    expect(hits.sort()).toEqual(Object.keys(SOCKET_ALLOWLIST).sort());
  });

  it("允许表每条都带非空理由", () => {
    for (const [rel, reason] of Object.entries(SOCKET_ALLOWLIST)) {
      expect([rel, reason.trim().length > 0]).toEqual([rel, true]);
    }
  });

  it("豁免路径真实存在（路径没了 = 豁免过期 = 红）", () => {
    expect(fs.existsSync(path.join(APP_SRC, BROWSER_STRING_EXEMPT))).toBe(true);
  });
});

// ---------------------------------------------------------------- ② fetch

/**
 * fetch census 的豁免表（outbound-guard.ts 头注释 rg 排除表的 vitest 固化）。
 */
const FETCH_EXEMPTIONS: Record<string, string> = {
  "main/net/outbound-guard.ts": "公网车道唯一出站原语（rg 排除表第一行）",
  "main/net/outbound-local-guard.ts": "local 车道唯一出站原语（rg 排除表第二行）",
  "main/git":
    "git 域的 fetch 是 `git fetch` 语义（git-network.ts 的导出函数名与其调用点），" +
    "底下走 runGit 子进程，不是 HTTP fetch",
  [BROWSER_STRING_EXEMPT]: "发给手机浏览器执行的前端代码字符串，不在主进程运行",
};

function isFetchExempt(rel: string): boolean {
  return Object.keys(FETCH_EXEMPTIONS).some((ex) => rel === ex || rel.startsWith(`${ex}/`));
}

describe("② fetch census：守卫外 fetch( 命中数恒为 0", () => {
  it("豁免表外没有任何 fetch( 调用", () => {
    const offenders = mainFiles()
      .filter((rel) => !isFetchExempt(rel))
      .filter((rel) => /\bfetch\s*\(/.test(sourceOf(rel)));
    expect(offenders).toEqual([]);
  });

  it("豁免表不留死条目（路径必须真实存在且理由非空）", () => {
    for (const [rel, reason] of Object.entries(FETCH_EXEMPTIONS)) {
      expect([rel, fs.existsSync(path.join(APP_SRC, rel))]).toEqual([rel, true]);
      expect([rel, reason.trim().length > 0]).toEqual([rel, true]);
    }
  });
});

// ---------------------------------------------------------------- ③ import

// 说明符可能是 "../net/outbound-local-guard.js"（跨目录）也可能是
// "./outbound-local-guard.js"（net/ 内部相对引用），因此只钉文件名段。
const LOCAL_GUARD_IMPORT_RE =
  /from\s+["'][^"']*\/(?:outbound-local-guard|local-ws-client)\.js["']/;

describe("③ import census：local 原语只许声明了 network.local 的能力目录取用", () => {
  /** 声明了 network.local 的能力目录（相对 APP_SRC）。本阶段为空集，机制先行。 */
  function declaringDirs(): string[] {
    return BUILT_IN_CAPABILITIES.filter((m) => m.permissions.includes("network.local")).map((m) =>
      path.posix.dirname(m.exposure.module)
    );
  }

  it("import 两个 local 原语的文件 ⊆ 声明目录 ∪ net/ 自身", () => {
    const dirs = declaringDirs();
    const offenders = mainFiles()
      .filter((rel) => LOCAL_GUARD_IMPORT_RE.test(sourceOf(rel)))
      .filter(
        (rel) => !rel.startsWith("main/net/") && !dirs.some((dir) => rel.startsWith(`${dir}/`))
      );
    expect(offenders).toEqual([]);
  });

  it("机制反-恒真：两个原语文件在磁盘上，且提取正则至少认出 net/ 内部那次 import", () => {
    // 数据集为空时「对每条断言…」永远通过（capability-drift 的同款教训）。
    // 这里钉两件事：原语文件真实存在；local-ws-client 自己 import
    // outbound-local-guard——提取正则连它都认不出的话，上面那条就是恒真的。
    expect(fs.existsSync(path.join(APP_SRC, "main/net/outbound-local-guard.ts"))).toBe(true);
    expect(fs.existsSync(path.join(APP_SRC, "main/net/local-ws-client.ts"))).toBe(true);
    expect(LOCAL_GUARD_IMPORT_RE.test(sourceOf("main/net/local-ws-client.ts"))).toBe(true);
  });
});
