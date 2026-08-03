import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * FS-101 / FS-102 的 IPC 出口。
 *
 * 两条断言，都是结构性的：
 *
 *   1. **返回值里不含 workspace canonical root** —— 这一域一旦漏出绝对
 *      路径，TASK-007 建立的 capability 化在这里就白做了。断言用的是
 *      「序列化之后不含 root 子串」，因此哪怕是嵌在某个新字段里也会被抓到。
 *   2. **新增通道全部经 ipc-guard 注册且在契约里有 schema** —— 断言查的是
 *      guard 的运行时注册表，不钉死任何 handler 文件路径：handler 日后
 *      迁到别的目录，这条断言依然成立（CT-05 的教训）。
 */
let userDataDir = "";

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
  BrowserWindow: { getAllWindows: () => [] },
  utilityProcess: { fork: vi.fn() },
  shell: {
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => {}),
  },
  dialog: { showOpenDialog: vi.fn() },
}));

let tmpRoot = "";
let workspaceDir = "";
let workspaceId = "";
let canonicalRoot = "";

const opened: {
  store: typeof import("./workspace-store.js") | null;
  changeset: typeof import("../changeset/changeset-store.js") | null;
  tree: typeof import("./file-tree.js") | null;
} = { store: null, changeset: null, tree: null };

/** 主 frame 的假 event：guard 的第一道闸只看 senderFrame === mainFrame。 */
const mainFrameEvent = { senderFrame: { id: 1 }, sender: { id: 7, mainFrame: { id: 1 } } };
(mainFrameEvent as { senderFrame: unknown }).senderFrame = mainFrameEvent.sender.mainFrame;

async function setup() {
  vi.resetModules();
  handlers.clear();

  const registry = await import("../workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
  const record = registry.registerWorkspace(workspaceDir);
  workspaceId = record.workspaceId;
  canonicalRoot = record.root;

  const store = await import("./workspace-store.js");
  store.__setWorkspaceStoreDataDir(userDataDir);
  const changeset = await import("../changeset/changeset-store.js");
  changeset.__setChangesetDataDir(userDataDir);
  const ignore = await import("./ignore-rules.js");
  ignore.__resetIgnoreCache();
  const tree = await import("./file-tree.js");

  const guard = await import("../ipc-guard.js");
  guard.__resetRegisteredChannels();
  const workspaceIpc = await import("./workspace-ipc.js");
  const changesetIpc = await import("../changeset/changeset-ipc.js");
  workspaceIpc.registerWorkspaceIpc();
  changesetIpc.registerChangesetIpc();

  opened.store = store;
  opened.changeset = changeset;
  opened.tree = tree;
  return { guard, workspaceIpc, changesetIpc };
}

function call(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`channel not registered: ${channel}`);
  return handler(mainFrameEvent, payload);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-wsipc-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "src", "a.txt"), "hello\n", "utf8");
});

afterEach(() => {
  opened.tree?.closeAllWatchers();
  opened.store?.__setWorkspaceStoreDataDir(null);
  opened.changeset?.__setChangesetDataDir(null);
  opened.store = null;
  opened.changeset = null;
  opened.tree = null;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("跨进程边界上只有相对路径", () => {
  it("树 / 读文件 / 附件三条返回值序列化后都不含 canonical root 子串", async () => {
    await setup();
    const { CHANNELS } = await import("@pibuddy/contract");

    const results = [
      await call(CHANNELS.workspaceTreeList, { workspaceId, relativePath: "" }),
      await call(CHANNELS.workspaceTreeList, { workspaceId, relativePath: "src" }),
      await call(CHANNELS.workspaceFileRead, { workspaceId, relativePath: "src/a.txt" }),
      await call(CHANNELS.workspaceAttachmentCreate, { workspaceId, relativePath: "src/a.txt" }),
      await call(CHANNELS.changesetQuery, { workspaceId }),
    ];

    for (const result of results) {
      const json = JSON.stringify(result);
      expect(json).not.toContain(canonicalRoot);
      expect(json).not.toContain(canonicalRoot.split("\\").join("\\\\"));
    }
  });

  it("结构化附件恰好八个字段，标识字段名是 token", async () => {
    await setup();
    const { CHANNELS } = await import("@pibuddy/contract");
    const descriptor = (await call(CHANNELS.workspaceAttachmentCreate, {
      workspaceId,
      relativePath: "src/a.txt",
    })) as Record<string, unknown>;

    expect(Object.keys(descriptor).sort()).toEqual(
      [
        "capability",
        "expiresAt",
        "mimeType",
        "relativePath",
        "sha256",
        "sizeBytes",
        "sourceName",
        "token",
      ].sort()
    );
    expect(descriptor.relativePath).toBe("src/a.txt");
  });

  it("越界的相对路径被拒（收容判定复用 resolveInWorkspace）", async () => {
    await setup();
    const { CHANNELS } = await import("@pibuddy/contract");
    await expect(
      call(CHANNELS.workspaceFileRead, { workspaceId, relativePath: "../outside.txt" })
    ).rejects.toThrow();
  });
});

describe("注册面（裁定1 的结构断言）", () => {
  it("本任务的通道全部出现在 ipc-guard 的注册表中，且各自在契约里有 schema", async () => {
    const { guard, workspaceIpc, changesetIpc } = await setup();
    const { CHANNEL_CONTRACTS } = await import("@pibuddy/contract");

    const registered = guard.registeredChannels();
    const mine = [...workspaceIpc.WORKSPACE_CHANNELS, ...changesetIpc.CHANGESET_CHANNELS];

    // (a) 逐一出现在注册表中
    for (const channel of mine) expect(registered).toContain(channel);
    // (b) 注册表里的每条都在契约里有 schema
    for (const channel of registered) expect(CHANNEL_CONTRACTS[channel]).toBeTruthy();
    // (c) 表长度 >= 9
    expect(registered.length).toBeGreaterThanOrEqual(9);
    // workspace 域恰 9 条，changeset 域恰 4 条
    expect(workspaceIpc.WORKSPACE_CHANNELS).toHaveLength(9);
    expect(changesetIpc.CHANGESET_CHANNELS).toHaveLength(4);
  });
});

/**
 * 切换工作区必须把 watcher 与搜索子进程收掉。
 *
 * 泄漏在功能上完全无声：句柄用尽之前文件树一切正常，用尽之后它停止刷新
 * 且**不报任何错**。因此断言必须钉在可数的量上，而不是「有没有调到某个
 * 函数」—— main 侧的释放函数一直存在，缺的从来是「谁来叫它」。
 */
describe("切换工作区释放旧资源", () => {
  it("每轮换一个目录监听再 release：5 轮之后活跃 watcher 数不增长（恒为 0）", async () => {
    await setup();
    const { CHANNELS } = await import("@pibuddy/contract");
    const tree = opened.tree as NonNullable<typeof opened.tree>;

    // 每轮换一个目录：同一个目录反复 watch 只会加引用计数、watchers.size
    // 恒为 1，那样的断言在真泄漏时照样绿，等于没测。
    for (let i = 0; i < 5; i++) {
      const dir = `d${i}`;
      fs.mkdirSync(path.join(workspaceDir, dir), { recursive: true });
      await call(CHANNELS.workspaceTreeWatch, { workspaceId, relativePath: dir, watching: true });
      expect(tree.activeWatcherCount()).toBe(1);

      await call(CHANNELS.workspaceRelease, { workspaceId });
      expect(tree.activeWatcherCount()).toBe(0);
    }

    expect(tree.activeWatcherCount()).toBe(0);
  });

  it("release 之后搜索子进程也被杀掉（不只是 watcher）", async () => {
    const { workspaceIpc } = await setup();
    const { CHANNELS } = await import("@pibuddy/contract");
    const worker = await import("./search-worker.js");
    const entry = await import("./search-entry.js");

    // 同构的假子进程：跑真的扫描逻辑，只是不真的 fork（与
    // search-worker.test.ts 同一口径）。要断言的是宿主侧的生命周期。
    let killed = 0;
    worker.__setSearchChildFactory(() => {
      const listeners: ((reply: unknown) => void)[] = [];
      let dead = false;
      return {
        postMessage(message) {
          setTimeout(() => {
            if (dead) return;
            entry.handleSearchRequest(message, (out) => {
              for (const l of listeners) l(out);
            });
          }, 0);
        },
        on(_event, listener) {
          listeners.push(listener as (reply: unknown) => void);
        },
        kill() {
          dead = true;
          killed++;
        },
        get killed() {
          return dead;
        },
      };
    });

    try {
      await call(CHANNELS.workspaceSearch, {
        workspaceId,
        query: "hello",
        mode: "content",
        requestId: "r1",
      });
      expect(worker.activeSearchWorkerCount()).toBe(1);

      await call(CHANNELS.workspaceRelease, { workspaceId });
      expect(worker.activeSearchWorkerCount()).toBe(0);
      expect(killed).toBe(1);
    } finally {
      worker.__setSearchChildFactory(null);
      workspaceIpc.disposeAllWorkspaceResources();
    }
  });
});
