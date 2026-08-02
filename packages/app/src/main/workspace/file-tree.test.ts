import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * FS-101 文件树的两条关键路径：
 *
 *   1. **watcher 句柄不泄漏** —— 展开一次建一个 watcher、折叠时不关，
 *      表现是应用开几小时之后文件树突然不再刷新，而这期间零报错。
 *   2. **ignore 规则真的生效** —— 尤其是 `!` 否定模式：写成「命中即忽略、
 *      不看后面」的话，否定模式等于不存在，而它同样不报错。
 */
let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn(), trashItem: vi.fn(async () => {}) },
}));

let tmpRoot = "";
let workspaceDir = "";
let workspaceId = "";

type Tree = typeof import("./file-tree.js");

/**
 * 每个用例拿一份全新的模块实例。
 *
 * `openModules` 里攒的是**这一轮**的模块引用：Windows 上 SQLite 的 WAL
 * 文件在句柄没关之前删不掉，afterEach 会以 EPERM 失败。而 vi.resetModules()
 * 之后旧实例已经取不到了，所以必须在这里留一份。
 */
const openModules: { tree: Tree | null; store: typeof import("./workspace-store.js") | null } = {
  tree: null,
  store: null,
};

async function freshTree(): Promise<Tree> {
  vi.resetModules();
  const registry = await import("../workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
  workspaceId = registry.registerWorkspace(workspaceDir).workspaceId;
  const store = await import("./workspace-store.js");
  store.__setWorkspaceStoreDataDir(userDataDir);
  const ignore = await import("./ignore-rules.js");
  ignore.__resetIgnoreCache();
  const tree = await import("./file-tree.js");
  openModules.store = store;
  openModules.tree = tree;
  return tree;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-tree-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "node_modules", "left-pad"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "src", "index.ts"), "export {};\n", "utf8");
  fs.writeFileSync(path.join(workspaceDir, "a.log"), "x\n", "utf8");
  fs.writeFileSync(path.join(workspaceDir, "keep.log"), "x\n", "utf8");
  fs.writeFileSync(path.join(workspaceDir, "普通 文件.txt"), "x\n", "utf8");
});

afterEach(() => {
  openModules.tree?.closeAllWatchers();
  openModules.store?.__setWorkspaceStoreDataDir(null);
  openModules.tree = null;
  openModules.store = null;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("watcher 句柄不泄漏", () => {
  it("同一目录展开/折叠 200 次之后活跃 watcher 数为 0", async () => {
    const tree = await freshTree();
    for (let i = 0; i < 200; i++) {
      await tree.watchDir(workspaceId, "src");
      tree.unwatchDir(workspaceId, "src");
    }
    expect(tree.activeWatcherCount()).toBe(0);
  });

  it("工作区关闭时所有 watcher 被 close", async () => {
    const tree = await freshTree();
    await tree.watchDir(workspaceId, "");
    await tree.watchDir(workspaceId, "src");
    expect(tree.activeWatcherCount()).toBe(2);
    tree.closeWatchers(workspaceId);
    expect(tree.activeWatcherCount()).toBe(0);
  });

  it("同一目录重复监听只建一个 watcher（引用计数）", async () => {
    const tree = await freshTree();
    await tree.watchDir(workspaceId, "src");
    await tree.watchDir(workspaceId, "src");
    expect(tree.activeWatcherCount()).toBe(1);
    tree.unwatchDir(workspaceId, "src");
    // 还有一个持有者，不能关
    expect(tree.activeWatcherCount()).toBe(1);
    tree.unwatchDir(workspaceId, "src");
    expect(tree.activeWatcherCount()).toBe(0);
  });
});

describe("ignore 规则", () => {
  it("node_modules 与 .git 默认被忽略且不出现在返回项里", async () => {
    const tree = await freshTree();
    const page = await tree.listDir(workspaceId, "");
    const names = page.entries.map((e) => e.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    // 被忽略的条目仍计入 total：UI 上「这个目录多大」按真实条目数显示
    expect(page.total).toBeGreaterThan(page.entries.length);
    // 但**不能**因此被判成 truncated —— 真机验证抓到过这个：任何含
    // node_modules 的目录（也就是几乎所有工作区根）都会挂出一条「目录过大」，
    // 而真正撞上限的那个目录反倒一声不吭地把五千个节点铺进 DOM。
    expect(page.truncated).toBe(false);
  });

  it("glob 模式命中被忽略，`!` 否定模式重新包含", async () => {
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), "*.log\n!keep.log\n", "utf8");
    const tree = await freshTree();
    const names = (await tree.listDir(workspaceId, "")).entries.map((e) => e.name);
    expect(names).not.toContain("a.log");
    expect(names).toContain("keep.log");
  });

  it("含中文与空格的合法文件名照常列出", async () => {
    const tree = await freshTree();
    const names = (await tree.listDir(workspaceId, "")).entries.map((e) => e.name);
    expect(names).toContain("普通 文件.txt");
  });

  it("includeIgnored 打开后被忽略的条目回到列表里并带 ignored 标记", async () => {
    const tree = await freshTree();
    const page = await tree.listDir(workspaceId, "", { includeIgnored: true });
    const nodeModules = page.entries.find((e) => e.name === "node_modules");
    expect(nodeModules?.ignored).toBe(true);
  });
});

describe("超大目录", () => {
  it("条目数超过 limit 时返回 truncated 与真实 total，而不是硬列全部", async () => {
    const big = path.join(workspaceDir, "big");
    fs.mkdirSync(big);
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), "x", "utf8");
    const tree = await freshTree();
    const page = await tree.listDir(workspaceId, "big", { limit: 10 });
    expect(page.entries).toHaveLength(10);
    expect(page.truncated).toBe(true);
    expect(page.total).toBe(30);
  });
});
