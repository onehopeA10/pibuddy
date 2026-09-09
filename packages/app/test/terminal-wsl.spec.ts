import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import { PtyManager } from "../src/main/terminal/pty-manager.js";
import {
  __resetWslCache,
  decodeWslOutput,
  listWslDistros,
  parseWslListVerbose,
  parseWslProfileId,
  planSpawn,
  resolveWslCommand,
  wslShellProfile,
} from "../src/main/terminal/wsl.js";
import {
  isWslUncPath,
  linuxPathToWslUnc,
  normalizeWslUnc,
  parseWslUncPath,
  wslStartDirFor,
} from "../src/main/wsl-paths.js";

/**
 * R5.1 WSL 支持的判据（coding.terminal 扩展 + 内核 wsl-paths）。
 *
 * WSL 依赖的逻辑全部抽成了纯函数，这里喂**真机录制的样本**：
 *
 *   - `wsl -l -v` 的输出是 **UTF-16LE 无 BOM**（Win11 26200 + WSL2 实录，
 *     Ubuntu-22.04 默认 + docker-desktop 两个发行版）。按 utf8 解出来是
 *     `N\0A\0M\0E\0…`，这正是要防的坑——把 decodeWslOutput 改成 utf8 直读，
 *     下面第一组立刻红。
 *   - 错误输出同样是 UTF-16LE 且**本地化**（中文 Windows 上录的
 *     `--badflag` 提示），解析结果必须是空表而不是一条乱码发行版。
 *
 * 真机行为（枚举 / UNC workspace / 终端 spawn）另见
 * src/main/workspace/wsl-unc.test.ts 的环境门控用例与 R5.1 实测记录。
 */

/** 真机录制：`wsl.exe -l -v`（UTF-16LE，无 BOM，CRLF）。 */
const SAMPLE_LIST_V = Buffer.from(
  "IAAgAE4AQQBNAEUAIAAgACAAIAAgACAAIAAgACAAIAAgACAAIAAgAFMAVABBAFQARQAgACAAIAAg" +
    "ACAAIAAgACAAIAAgACAAVgBFAFIAUwBJAE8ATgANAAoAKgAgAFUAYgB1AG4AdAB1AC0AMgAyAC4A" +
    "MAA0ACAAIAAgACAAIAAgAFIAdQBuAG4AaQBuAGcAIAAgACAAIAAgACAAIAAgACAAMgANAAoAIAAg" +
    "AGQAbwBjAGsAZQByAC0AZABlAHMAawB0AG8AcAAgACAAIAAgAFIAdQBuAG4AaQBuAGcAIAAgACAA" +
    "IAAgACAAIAAgACAAMgANAAoA",
  "base64"
);

/** 真机录制：`wsl.exe --badflag` 的本地化错误输出（UTF-16LE，中文 Windows）。 */
const SAMPLE_ERROR = Buffer.from(
  "4GVIZYR2fVTkTkyIwlNwZRr/IAAtAC0AYgBhAGQAZgBsAGEAZwANAAoA94t/Tyh1HCB3AHMAbAAu" +
    "AGUAeABlACAALQAtAGgAZQBsAHAAJwAgALeD1lPXUy9lAWOEdsJTcGUXUmiIAjANAAoA",
  "base64"
);

describe("decodeWslOutput：UTF-16LE 的坑（真实样本）", () => {
  it("UTF-16LE 样本解出干净文本，不含 NUL", () => {
    const text = decodeWslOutput(SAMPLE_LIST_V);
    expect(text).toContain("NAME");
    expect(text).toContain("Ubuntu-22.04");
    expect(text).toContain("docker-desktop");
    expect(text.includes("\0")).toBe(false);
  });

  it("对拍：按 utf8 直读同一份样本得到的是夹 NUL 的乱码（这正是要防的）", () => {
    const wrong = SAMPLE_LIST_V.toString("utf8");
    expect(wrong).toContain("N\0");
    expect(wrong).not.toContain("NAME");
  });

  it("utf8 输出（WSL_UTF8=1 的新版）原样通过，BOM 被剥掉", () => {
    expect(decodeWslOutput(Buffer.from("\uFEFFhello", "utf8"))).toBe("hello");
    expect(decodeWslOutput(Buffer.alloc(0))).toBe("");
  });
});

describe("parseWslListVerbose：wsl -l -v 的解析", () => {
  it("真实样本：两个发行版，默认标记 / 状态 / 版本齐全，表头被跳过", () => {
    const distros = parseWslListVerbose(decodeWslOutput(SAMPLE_LIST_V));
    expect(distros).toEqual([
      { name: "Ubuntu-22.04", isDefault: true, state: "Running", version: "2" },
      { name: "docker-desktop", isDefault: false, state: "Running", version: "2" },
    ]);
  });

  it("本地化错误输出（没装发行版那类）解析为空表，而不是乱码发行版", () => {
    expect(parseWslListVerbose(decodeWslOutput(SAMPLE_ERROR))).toEqual([]);
  });

  it("空输入 / 纯空白解析为空表", () => {
    expect(parseWslListVerbose("")).toEqual([]);
    expect(parseWslListVerbose("  \r\n\r\n")).toEqual([]);
  });

  it("默认发行版排在首行（带 *）时不会被当成表头吃掉", () => {
    // wsl -l -v 恒有表头，但解析不赌这一点：首行带 * 就是数据。
    const distros = parseWslListVerbose("* Alpine Stopped 2\n  Debian Running 2");
    expect(distros.map((d) => d.name)).toEqual(["Alpine", "Debian"]);
    expect(distros[0].isDefault).toBe(true);
  });
});

describe("WSL UNC 路径（内核 wsl-paths）", () => {
  it("两种前缀、两种斜杠都解析到同一个 distro + Linux 路径", () => {
    for (const p of [
      "\\\\wsl$\\Ubuntu-22.04\\home\\me\\proj",
      "\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\proj",
      "//wsl$/Ubuntu-22.04/home/me/proj",
    ]) {
      expect(parseWslUncPath(p)).toEqual({ distro: "Ubuntu-22.04", linuxPath: "/home/me/proj" });
      expect(isWslUncPath(p)).toBe(true);
    }
    expect(parseWslUncPath("C:\\work")).toBeNull();
    expect(parseWslUncPath("\\\\server\\share")).toBeNull();
  });

  it("normalizeWslUnc 消灭 \\\\wsl$ 与 \\\\wsl.localhost 的双重身份（同目录同名）", () => {
    expect(normalizeWslUnc("\\\\wsl$\\Ubuntu-22.04\\tmp\\x")).toBe(
      "\\\\wsl.localhost\\Ubuntu-22.04\\tmp\\x"
    );
    expect(normalizeWslUnc("\\\\wsl.localhost\\Ubuntu-22.04\\tmp\\x\\")).toBe(
      "\\\\wsl.localhost\\Ubuntu-22.04\\tmp\\x"
    );
    // 非 WSL 路径原样返回：本函数不承担别的规范化
    expect(normalizeWslUnc("D:\\work")).toBe("D:\\work");
  });

  it("linuxPathToWslUnc 与 parseWslUncPath 互逆（根目录也不例外）", () => {
    expect(linuxPathToWslUnc("/home/me", "Ubuntu-22.04")).toBe(
      "\\\\wsl.localhost\\Ubuntu-22.04\\home\\me"
    );
    expect(linuxPathToWslUnc("/", "U")).toBe("\\\\wsl.localhost\\U");
    expect(parseWslUncPath(linuxPathToWslUnc("/a/b", "U"))).toEqual({
      distro: "U",
      linuxPath: "/a/b",
    });
  });

  it("wslStartDirFor：盘符 → /mnt/*；同发行版 UNC → 原路径；跨发行版 / 其它 → ~", () => {
    expect(wslStartDirFor("C:\\work\\proj", "Ubuntu-22.04")).toBe("/mnt/c/work/proj");
    expect(wslStartDirFor("\\\\wsl.localhost\\Ubuntu-22.04\\tmp\\p", "Ubuntu-22.04")).toBe("/tmp/p");
    // 大小写不同视为同一发行版（Windows 侧路径大小写不敏感）
    expect(wslStartDirFor("\\\\wsl$\\ubuntu-22.04\\tmp\\p", "Ubuntu-22.04")).toBe("/tmp/p");
    expect(wslStartDirFor("\\\\wsl$\\docker-desktop\\x", "Ubuntu-22.04")).toBe("~");
    expect(wslStartDirFor("relative\\path", "Ubuntu-22.04")).toBe("~");
  });
});

describe("WSL profile 与 spawn 计划", () => {
  it("parseWslProfileId：合法名放行，非 wsl 前缀 / 危险字符拒绝", () => {
    expect(parseWslProfileId("wsl:Ubuntu-22.04")).toBe("Ubuntu-22.04");
    expect(parseWslProfileId("powershell")).toBeNull();
    expect(parseWslProfileId("wsl:")).toBeNull();
    expect(parseWslProfileId("wsl:a b")).toBeNull(); // 空格：注册名不含，也防 argv 拼接
    expect(parseWslProfileId("wsl:--import")).toBeNull(); // 开关形态直接挡下
  });

  it("planSpawn：WSL profile 追加 --cd 映射；UNC cwd 换成主目录（ConPTY 不赌 UNC）", () => {
    const shell = { id: "wsl:Ubuntu-22.04", file: "C:\\Windows\\System32\\wsl.exe", args: ["-d", "Ubuntu-22.04"] };
    const fromDrive = planSpawn(shell, "C:\\work\\proj");
    expect(fromDrive.args).toEqual(["-d", "Ubuntu-22.04", "--cd", "/mnt/c/work/proj"]);
    expect(fromDrive.cwd).toBe("C:\\work\\proj");

    const fromUnc = planSpawn(shell, "\\\\wsl.localhost\\Ubuntu-22.04\\tmp\\p");
    expect(fromUnc.args).toEqual(["-d", "Ubuntu-22.04", "--cd", "/tmp/p"]);
    expect(isWslUncPath(fromUnc.cwd)).toBe(false); // 主目录，不是 UNC
  });

  it("planSpawn：非 WSL shell 原样透传（既有行为一个字节不变）", () => {
    const shell = { id: "powershell", file: "powershell.exe", args: ["-NoLogo"] };
    expect(planSpawn(shell, "D:\\w")).toEqual({ file: "powershell.exe", args: ["-NoLogo"], cwd: "D:\\w" });
  });

  it("resolveWslCommand：ia32 先试 Sysnative；全缺返回 null（= 这台机器没有 WSL）", () => {
    const seen: string[] = [];
    const exists = (p: string): boolean => {
      seen.push(p);
      return false;
    };
    expect(resolveWslCommand({ SystemRoot: "C:\\Windows" }, "ia32", exists)).toBeNull();
    expect(seen[0]).toContain("Sysnative");
    expect(resolveWslCommand({ SystemRoot: "C:\\Windows" }, "x64", (p) => p.includes("System32"))).toContain(
      "System32"
    );
  });
});

describe("listWslDistros：懒枚举的优雅降级（注入 exec，永不抛错）", () => {
  it("非 Windows 平台恒 {available:false}，一个子进程都不 spawn", async () => {
    let spawned = 0;
    const result = await listWslDistros({
      platform: "linux",
      execFile: () => {
        spawned++;
        return undefined;
      },
    });
    expect(result).toEqual({ available: false, distros: [] });
    expect(spawned).toBe(0);
  });

  it("wsl.exe 不存在（command=null）→ {available:false}，不 spawn", async () => {
    const result = await listWslDistros({ platform: "win32", command: null });
    expect(result).toEqual({ available: false, distros: [] });
  });

  it("wsl.exe 在但报错（没装发行版）→ available:true + 空表，不抛", async () => {
    const result = await listWslDistros({
      platform: "win32",
      command: "C:\\Windows\\System32\\wsl.exe",
      execFile: (_f, _a, _o, cb) => cb(new Error("exit -1"), SAMPLE_ERROR, Buffer.alloc(0)),
    });
    expect(result).toEqual({ available: true, distros: [] });
  });

  it("ENOENT（可执行文件被策略挡）→ {available:false}，不抛", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const result = await listWslDistros({
      platform: "win32",
      command: "C:\\Windows\\System32\\wsl.exe",
      execFile: (_f, _a, _o, cb) => cb(err, Buffer.alloc(0), Buffer.alloc(0)),
    });
    expect(result).toEqual({ available: false, distros: [] });
  });

  it("正常输出（真实样本）→ available:true + 两个发行版", async () => {
    const result = await listWslDistros({
      platform: "win32",
      command: "C:\\Windows\\System32\\wsl.exe",
      execFile: (_f, args, _o, cb) => {
        expect(args).toEqual(["-l", "-v"]);
        cb(null, SAMPLE_LIST_V, Buffer.alloc(0));
        return undefined;
      },
    });
    expect(result.available).toBe(true);
    expect(result.distros.map((d) => d.name)).toEqual(["Ubuntu-22.04", "docker-desktop"]);
    __resetWslCache();
  });
});

describe("wslShellProfile：resolveShell 的同步一半", () => {
  const onWindows = process.platform === "win32";

  it.skipIf(!onWindows)("Windows：合法 profileId 给出 wsl.exe 绝对路径 + -d 参数", () => {
    const profile = wslShellProfile("wsl:Ubuntu-22.04");
    // 机器上没有 wsl.exe 时合法地返回 null（照常回落默认 shell）
    if (profile) {
      expect(profile.file.toLowerCase()).toContain("wsl.exe");
      expect(profile.args).toEqual(["-d", "Ubuntu-22.04"]);
      expect(profile.id).toBe("wsl:Ubuntu-22.04");
    }
    expect(wslShellProfile("powershell")).toBeNull();
    expect(wslShellProfile("wsl:bad name")).toBeNull();
  });

  it.skipIf(onWindows)("非 Windows：恒 null（选项在结构上不存在）", () => {
    expect(wslShellProfile("wsl:Ubuntu-22.04")).toBeNull();
  });
});

// ------------------------------------------------------------ 真机门控：真 PTY 进 WSL

/** 探测一个在跑的非 docker 发行版（与 wsl-unc.test.ts 同一门控口径）。 */
function detectRunningDistro(): string | null {
  if (process.platform !== "win32") return null;
  const wslExe = resolveWslCommand();
  if (!wslExe) return null;
  try {
    const out = execFileSync(wslExe, ["-l", "-v"], { timeout: 15_000, windowsHide: true });
    const distros = parseWslListVerbose(decodeWslOutput(out as unknown as Buffer));
    return (
      distros.find((d) => d.state === "Running" && !d.name.toLowerCase().startsWith("docker"))
        ?.name ?? null
    );
  } catch {
    return null;
  }
}

const runningDistro = detectRunningDistro();

describe.skipIf(!runningDistro)("R5.1 真机：PtyManager 用 wsl:<distro> profile 真的进到 WSL", () => {
  const manager = new PtyManager();
  afterAll(() => manager.disposeAll());

  async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return predicate();
  }

  it("open(wsl:<distro>) spawn 出 Linux shell，cwd 经 --cd 落在 /tmp（C:\\ 映射对拍另见纯函数组）", async () => {
    let text = "";
    manager.setEmitter((e) => {
      if (e.payload.kind === "data") text += e.payload.data;
    });
    const meta = manager.open({
      workspaceId: "ws-wsl",
      cwd: `\\\\wsl.localhost\\${runningDistro}\\tmp`,
      profileId: `wsl:${runningDistro}`,
      cols: 100,
      rows: 30,
    });
    // tab 元数据记 distro：shellId 即 `wsl:<distro>`
    expect(meta.shellId).toBe(`wsl:${runningDistro}`);
    expect(meta.running).toBe(true);

    manager.input("ws-wsl", meta.tabId, 'echo "MARK:$WSL_DISTRO_NAME:$(pwd)"\r');
    const seen = await waitFor(() => text.includes(`MARK:${runningDistro}:/tmp`));
    expect(seen).toBe(true);
    manager.kill("ws-wsl", meta.tabId);
  });
});
