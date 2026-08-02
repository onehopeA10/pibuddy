import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * FS-101 搜索的关键路径。
 *
 * 子进程用一个**同构的假实现**替换：它跑的是真的扫描逻辑
 * （search-entry 的 handleSearchRequest），只是不真的 fork 一个进程。
 * 这样测到的是宿主侧的协议、取消与生命周期 —— 那才是会出问题的地方，
 * 而起一个真的 utility process 只会让测试变慢并且在 CI 上飘。
 */
let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  utilityProcess: { fork: vi.fn() },
  shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn(), trashItem: vi.fn(async () => {}) },
}));

let tmpRoot = "";
let workspaceDir = "";
let workspaceId = "";
let canonicalRoot = "";

type Worker = typeof import("./search-worker.js");
type Entry = typeof import("./search-entry.js");

const opened: { worker: Worker | null; store: typeof import("./workspace-store.js") | null } = {
  worker: null,
  store: null,
};

/** 假子进程的统计：起了几个、各自被 kill 了没有。 */
let spawnCount = 0;

async function freshWorker(options: { stall?: boolean } = {}): Promise<Worker> {
  vi.resetModules();
  const registry = await import("../workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
  const record = registry.registerWorkspace(workspaceDir);
  workspaceId = record.workspaceId;
  canonicalRoot = record.root;
  const store = await import("./workspace-store.js");
  store.__setWorkspaceStoreDataDir(userDataDir);
  const ignore = await import("./ignore-rules.js");
  ignore.__resetIgnoreCache();
  const entry: Entry = await import("./search-entry.js");
  const worker = await import("./search-worker.js");

  spawnCount = 0;
  worker.__setSearchChildFactory(() => {
    spawnCount++;
    let killed = false;
    const listeners: ((reply: unknown) => void)[] = [];
    return {
      postMessage(message) {
        // stall：模拟一个卡在大文件上、收到 cancel 也不吭声的子进程
        if (options.stall) return;
        setTimeout(() => {
          if (killed) return;
          entry.handleSearchRequest(message, (out) => {
            for (const l of listeners) l(out);
          });
        }, 0);
      },
      on(_event, listener) {
        listeners.push(listener as (reply: unknown) => void);
      },
      kill() {
        killed = true;
      },
      get killed() {
        return killed;
      },
    };
  });

  opened.worker = worker;
  opened.store = store;
  return worker;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-search-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(path.join(workspaceDir, "src", `f${i}.txt`), "needle here\nneedle again\n", "utf8");
  }
  // 超长单行：preview 必须被硬截断，否则一次搜索能把 IPC 打满
  fs.writeFileSync(path.join(workspaceDir, "long.txt"), `${"needle".repeat(500)}\n`, "utf8");
});

afterEach(() => {
  opened.worker?.disposeAllSearchWorkers();
  opened.store?.__setWorkspaceStoreDataDir(null);
  opened.worker = null;
  opened.store = null;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("搜索结果的三条硬约束", () => {
  it("limit 生效并给出下一页游标", async () => {
    const worker = await freshWorker();
    const page = await worker.search({ workspaceId, query: "needle", limit: 5, requestId: "r1" });
    expect(page.items).toHaveLength(5);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBeTruthy();
  });

  it("preview 长度不超过 200", async () => {
    const worker = await freshWorker();
    const page = await worker.search({ workspaceId, query: "needle", limit: 200, requestId: "r2" });
    for (const item of page.items) expect(item.preview.length).toBeLessThanOrEqual(200);
  });

  it("结果序列化后不含 workspace canonical root 子串（worker 是独立的一条出口）", async () => {
    const worker = await freshWorker();
    const page = await worker.search({ workspaceId, query: "needle", limit: 50, requestId: "r3" });
    expect(page.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(page.items)).not.toContain(canonicalRoot);
    // Windows 上路径分隔符会被 JSON 转义，反斜杠形态也要一并排除
    expect(JSON.stringify(page.items)).not.toContain(canonicalRoot.split("\\").join("\\\\"));
  });
});

describe("取消", () => {
  it("AbortSignal 触发后立刻以 cancelled 结算，且此后不再有结果送达", async () => {
    const worker = await freshWorker({ stall: true });
    const controller = new AbortController();
    const promise = worker.search({
      workspaceId,
      query: "needle",
      requestId: "r4",
      signal: controller.signal,
    });
    controller.abort();
    const page = await promise;
    expect(page.cancelled).toBe(true);
    expect(page.items).toHaveLength(0);

    // 期限内子进程没有回应 → 被 kill 掉。等 200ms + 一点余量。
    const child = worker.searchChildFor(workspaceId);
    await new Promise((r) => setTimeout(r, worker.SEARCH_CANCEL_GRACE_MS + 60));
    expect(child === null || child.killed).toBe(true);
  });
});

describe("子进程生命周期", () => {
  it("关闭工作区时子进程被 kill", async () => {
    const worker = await freshWorker();
    await worker.search({ workspaceId, query: "needle", limit: 1, requestId: "r5" });
    const child = worker.searchChildFor(workspaceId);
    expect(child).not.toBeNull();
    worker.disposeSearchWorker(workspaceId);
    expect(child?.killed).toBe(true);
    expect(worker.activeSearchWorkerCount()).toBe(0);
  });

  it("连续开关工作区 20 次之后活跃子进程数不增长", async () => {
    const worker = await freshWorker();
    for (let i = 0; i < 20; i++) {
      await worker.search({ workspaceId, query: "needle", limit: 1, requestId: `loop${i}` });
      worker.disposeSearchWorker(workspaceId);
    }
    expect(worker.activeSearchWorkerCount()).toBe(0);
    // 每一轮各起一个、各关一个：起的次数等于轮数，没有一个滞留
    expect(spawnCount).toBe(20);
  });
});
