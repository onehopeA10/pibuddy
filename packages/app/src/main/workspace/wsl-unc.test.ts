import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * R5.1：workspace 各设施在 WSL UNC 路径（`\\wsl.localhost\<distro>\...`）上的
 * **真机集成判据**。
 *
 * ## 环境门控（诚实地跳过，不是隐藏失败）
 *
 * 这些用例只有在「Windows + 有一个在跑的非 docker WSL 发行版」的机器上才有
 * 意义 —— 没有 WSL 的机器上被测行为本身不存在，跳过是如实陈述而非回避。
 * 门控探测走与生产同一条路径（wsl.exe -l -v + UTF-16LE 解码 + 解析），
 * 探测本身失败也只会让用例跳过，不会红。
 *
 * ## 已实测钉住的坑（Win11 26200 + Node 24 + WSL2）
 *
 *   1. `\\wsl$` 与 `\\wsl.localhost` 是同一目录的两个名字，realpath **互不归一**
 *      → registerWorkspace 里先 normalizeWslUnc，两种写法必须得到同一个
 *      workspaceId（本文件第 1 组）。
 *   2. `fs.watch` 在 9P 共享上**同步抛 EISDIR** → watchDir 降级成无事件的空
 *      条目，不抛错、记账照常（第 3 组）。
 *   3. WSL 内的 Linux 符号链接经 9P `stat`/`realpath` 报 ENOENT，但 readdir 的
 *      Dirent 能正确标出 isSymbolicLink → 文件树标记为 symlink、不展开（第 2 组）。
 *   4. 搜索扫描（纯 fs）与原子保存（temp + rename）在 UNC 上工作（第 4、5 组）。
 */

let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: {
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => {}),
  },
}));

const { decodeWslOutput, parseWslListVerbose, resolveWslCommand } = await import(
  "../terminal/wsl.js"
);

/** 探测一个可用的（Running、非 docker-*）发行版；探测失败一律返回 null。 */
function detectUsableDistro(): { distro: string; wslExe: string } | null {
  if (process.platform !== "win32") return null;
  const wslExe = resolveWslCommand();
  if (!wslExe) return null;
  try {
    const out = execFileSync(wslExe, ["-l", "-v"], {
      timeout: 15_000,
      windowsHide: true,
    });
    const distros = parseWslListVerbose(decodeWslOutput(out as unknown as Buffer));
    const usable = distros.find(
      (d) => d.state === "Running" && !d.name.toLowerCase().startsWith("docker")
    );
    if (!usable) return null;
    // UNC 根真的可达才算可用（发行版可能刚被停掉）
    if (!fs.existsSync(`\\\\wsl.localhost\\${usable.name}\\tmp`)) return null;
    return { distro: usable.name, wslExe };
  } catch {
    return null;
  }
}

const env = detectUsableDistro();
const hasWsl = env !== null;

/** 在 WSL 里跑一条命令（重试一次抵御 VM 冷启动），返回解码后的 stdout。 */
function runInWsl(args: string[]): string {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = execFileSync(env!.wslExe, ["-d", env!.distro, "--", ...args], {
        timeout: 60_000,
        windowsHide: true,
      });
      return decodeWslOutput(out as unknown as Buffer);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const fixtureName = `pibuddy-wsl-test-${Date.now().toString(36)}`;
const uncRoot = env ? `\\\\wsl.localhost\\${env.distro}\\tmp\\${fixtureName}` : "";
const uncRootDollar = env ? `\\\\wsl$\\${env.distro}\\tmp\\${fixtureName}` : "";

let registry: typeof import("../workspace-registry.js");
let store: typeof import("./workspace-store.js");
let tree: typeof import("./file-tree.js");
let editor: typeof import("./file-editor.js");
let scan: typeof import("./search-scan.js");
let workspaceId = "";

beforeAll(async () => {
  if (!hasWsl) return;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-wsl-ud-"));
  // 全部经 Windows 侧 UNC 写入：这本身就是被测能力的一半
  await fsp.mkdir(path.join(uncRoot, "sub"), { recursive: true });
  await fsp.writeFile(path.join(uncRoot, "hello.txt"), "hello from windows\nwsl marker line\n");
  await fsp.writeFile(path.join(uncRoot, "sub", "data.md"), "# nested\n");
  // Linux 符号链接（坑 3）：只能从 WSL 侧建。首次调用可能撞上 WSL VM 冷启动 /
  // 忙碌，重试一次再放弃 —— 放弃时直接把整组判为不可用（跳过），不留半套夹具。
  runInWsl(["ln", "-sf", "/etc", `/tmp/${fixtureName}/esc-link`]);

  registry = await import("../workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
  store = await import("./workspace-store.js");
  store.__setWorkspaceStoreDataDir(userDataDir);
  tree = await import("./file-tree.js");
  editor = await import("./file-editor.js");
  scan = await import("./search-scan.js");
  workspaceId = registry.registerWorkspace(uncRoot).workspaceId;
  store.workspaceStore().open(registry.requireWorkspaceRoot(workspaceId));
}, 150_000);

afterAll(async () => {
  if (!hasWsl) return;
  tree?.closeAllWatchers();
  store?.__setWorkspaceStoreDataDir(null);
  registry?.__setWorkspaceDataDir(null);
  await fsp.rm(uncRoot, { recursive: true, force: true }).catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe.skipIf(!hasWsl)("R5.1 坑 1：\\\\wsl$ 与 \\\\wsl.localhost 的双重身份", () => {
  it("两种 UNC 写法注册出同一个 workspaceId，root 收敛为 \\\\wsl.localhost 形态", () => {
    const viaLocalhost = registry.registerWorkspace(uncRoot);
    const viaDollar = registry.registerWorkspace(uncRootDollar);
    expect(viaDollar.workspaceId).toBe(viaLocalhost.workspaceId);
    expect(viaDollar.root.toLowerCase()).toContain("\\\\wsl.localhost\\");
  });
});

describe.skipIf(!hasWsl)("R5.1：文件树在 UNC 上工作，Linux 符号链接被标记而不炸", () => {
  it("listDir 列出 Windows 侧建的目录与文件，esc-link 标为 symlink", async () => {
    const page = await tree.listDir(workspaceId, "");
    const names = page.entries.map((e) => e.name).sort();
    expect(names).toEqual(["esc-link", "hello.txt", "sub"].sort());
    const link = page.entries.find((e) => e.name === "esc-link");
    expect(link?.isSymlink).toBe(true);
    // 符号链接不是「真目录」（readdir 不跟随）→ UI 不给展开
    expect(link?.isDirectory).toBe(false);
  });

  it("对符号链接做收容解析会失败（9P 上 realpath ENOENT），但只影响那一条路径", async () => {
    await expect(registry.resolveInWorkspace(workspaceId, "esc-link")).rejects.toThrow();
    await expect(registry.resolveInWorkspace(workspaceId, "hello.txt")).resolves.toMatchObject({
      isFile: true,
    });
  });
});

describe.skipIf(!hasWsl)("R5.1 坑 2：fs.watch 在 9P 上抛 EISDIR → 降级不抛错", () => {
  it("watchDir 不抛，记账照常，unwatch / closeWatchers 干净归零", async () => {
    const before = tree.activeWatcherCount();
    await expect(tree.watchDir(workspaceId, "")).resolves.toBeUndefined();
    await expect(tree.watchDir(workspaceId, "sub")).resolves.toBeUndefined();
    expect(tree.activeWatcherCount()).toBe(before + 2);
    tree.unwatchDir(workspaceId, "sub");
    expect(tree.activeWatcherCount()).toBe(before + 1);
    expect(tree.closeWatchers(workspaceId)).toBe(1);
    expect(tree.activeWatcherCount()).toBe(before);
  });
});

describe.skipIf(!hasWsl)("R5.1：搜索扫描（纯 fs，utility process 同一实现）在 UNC 上工作", () => {
  it("内容搜索命中 Windows 侧写入的行", () => {
    const page = scan.runSearchScan({
      root: registry.requireWorkspaceRoot(workspaceId),
      query: "wsl marker",
      mode: "content",
      limit: 10,
      cursor: null,
      ignorePolicy: [],
    });
    expect(page.items.length).toBe(1);
    expect(page.items[0].relativePath).toBe("hello.txt");
    expect(page.items[0].line).toBe(2);
  });

  it("文件名搜索命中嵌套文件", () => {
    const page = scan.runSearchScan({
      root: registry.requireWorkspaceRoot(workspaceId),
      query: "data",
      mode: "name",
      limit: 10,
      cursor: null,
      ignorePolicy: [],
    });
    expect(page.items.map((i) => i.relativePath)).toEqual(["sub/data.md"]);
  });
});

describe.skipIf(!hasWsl)("R5.1：读 / 原子保存（temp + rename）在 UNC 上工作", () => {
  it("readFile → saveFile 闭环，内容真的落在 WSL 文件系统里", async () => {
    const read = await editor.readFile({ workspaceId, relativePath: "hello.txt" });
    expect(read.content).toContain("hello from windows");

    const saved = await editor.saveFile({
      workspaceId,
      relativePath: "hello.txt",
      content: `${read.content}appended over unc\n`,
      baseMtimeMs: read.mtimeMs,
      baseSha256: read.sha256,
      overwrite: false,
    });
    expect(saved.ok).toBe(true);

    // 从 WSL 侧读回来对拍：写进去的不是 Windows 侧的幻觉
    expect(runInWsl(["cat", `/tmp/${fixtureName}/hello.txt`])).toContain("appended over unc");
  });
});

describe.skipIf(hasWsl)("无 WSL 环境", () => {
  it("本机没有可用的 WSL 发行版：UNC 集成用例整组跳过（如实标注，非隐藏失败）", () => {
    expect(hasWsl).toBe(false);
  });
});
