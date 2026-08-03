import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  createDirtyDialog,
  setDirtyPrompt,
  useWorkspaceStore,
  type DirtyDecision,
} from "./workspace";

/**
 * 工作区面板里两类**会丢用户数据**的路径。
 *
 * 不做穷举矩阵 —— 只钉四件事，每一件对应一次真实的数据损失：
 *   1. 关 tab 时点「取消」，tab 必须还在（旧写法直接从数组里删）；
 *   2. 切工作区时点「取消」，切换必须没发生（旧写法直接清空 tabs）；
 *   3. A 工作区的迟到读取不能落进 B（旧写法无条件加 tab，之后按**当前**
 *      workspaceId 保存，等于把 A 的内容写进 B 的同名文件）；
 *   4. 切换必须释放旧工作区的 watcher / 搜索子进程（main 侧一直有释放
 *      函数，缺的是这一次调用）。
 */

let readFile: ReturnType<typeof vi.fn>;
let saveFile: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;
let listDir: ReturnType<typeof vi.fn>;
let changesets: ReturnType<typeof vi.fn>;

function fileResult(content: string, sha = "sha-a"): unknown {
  return {
    relativePath: "a.txt",
    content,
    encoding: "utf8",
    newline: "lf",
    mtimeMs: 1,
    sha256: sha,
    sizeBytes: content.length,
    binary: false,
    tooLarge: false,
  };
}

function installBridge(): void {
  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: {
      workspace: {
        listDir,
        watchDir: vi.fn(async () => undefined),
        onTreeChanged: () => () => undefined,
        readFile,
        saveFile,
        release,
        changesets,
        cancelSearch: vi.fn(async () => undefined),
        search: vi.fn(),
      },
    },
  };
}

/** 装一个固定答案的三选一实现，并记录被问了几次。 */
function answer(decision: DirtyDecision): { calls: number } {
  const box = { calls: 0 };
  setDirtyPrompt(async () => {
    box.calls++;
    return decision;
  });
  return box;
}

/** 造一条已经打开、内容被改过的 tab（不走 IPC，直接摆进 store）。 */
function seedDirtyTab(
  store: ReturnType<typeof useWorkspaceStore>,
  workspaceId: string,
  relativePath = "a.txt"
): void {
  store.tabs.push({
    workspaceId,
    relativePath,
    savedContent: "磁盘上的内容\n",
    content: "我改了但还没保存\n",
    encoding: "utf8",
    newline: "lf",
    baseMtimeMs: 1,
    baseSha256: "sha-a",
    binary: false,
    tooLarge: false,
    conflict: null,
    showDiff: false,
    gotoLine: null,
  });
  store.activePath = relativePath;
}

beforeEach(() => {
  setActivePinia(createPinia());
  readFile = vi.fn(async () => fileResult("磁盘上的内容\n"));
  saveFile = vi.fn(async () => ({ ok: true, mtimeMs: 2, sha256: "sha-b" }));
  release = vi.fn(async () => undefined);
  listDir = vi.fn(async () => ({ entries: [], total: 0, truncated: false }));
  changesets = vi.fn(async () => ({ entries: [], diffs: [] }));
  installBridge();
  setDirtyPrompt(null);
});

describe("缺陷1 · 未保存的编辑不会被静默丢弃", () => {
  it("关 tab 点「取消」：closeTab 返回 false，tab 还在，没有发生任何保存", async () => {
    const ws = useWorkspaceStore();
    ws.workspaceId = "wsA";
    seedDirtyTab(ws, "wsA");
    const asked = answer("cancel");

    const closed = await ws.closeTab("a.txt");

    expect(closed).toBe(false);
    expect(asked.calls).toBe(1);
    expect(ws.tabs).toHaveLength(1);
    expect(ws.tabs[0]?.content).toBe("我改了但还没保存\n");
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("关 tab 点「保存」：先落盘再关；点「放弃」才直接关", async () => {
    const ws = useWorkspaceStore();
    ws.workspaceId = "wsA";
    seedDirtyTab(ws, "wsA");
    answer("save");

    expect(await ws.closeTab("a.txt")).toBe(true);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "wsA",
      relativePath: "a.txt",
      content: "我改了但还没保存\n",
    });
    expect(ws.tabs).toHaveLength(0);

    seedDirtyTab(ws, "wsA", "b.txt");
    answer("discard");
    expect(await ws.closeTab("b.txt")).toBe(true);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(ws.tabs).toHaveLength(0);
  });

  it("选了「保存」但保存冲突：tab 不关（关掉等于替用户选了放弃）", async () => {
    const ws = useWorkspaceStore();
    ws.workspaceId = "wsA";
    seedDirtyTab(ws, "wsA");
    answer("save");
    saveFile.mockResolvedValueOnce({
      ok: false,
      conflict: true,
      current: { mtimeMs: 9, sha256: "sha-x", preview: "别人的改动" },
    });

    expect(await ws.closeTab("a.txt")).toBe(false);
    expect(ws.tabs).toHaveLength(1);
    expect(ws.tabs[0]?.conflict?.preview).toBe("别人的改动");
  });

  it("切工作区点「取消」：attach 返回 false，workspaceId / tabs / 代际全都没动", async () => {
    const ws = useWorkspaceStore();
    ws.workspaceId = "wsA";
    seedDirtyTab(ws, "wsA");
    const genBefore = ws.generation;
    answer("cancel");

    expect(await ws.attach("wsB")).toBe(false);

    expect(ws.workspaceId).toBe("wsA");
    expect(ws.tabs).toHaveLength(1);
    expect(ws.tabs[0]?.content).toBe("我改了但还没保存\n");
    expect(ws.generation).toBe(genBefore);
    expect(release).not.toHaveBeenCalled();
  });

  it("切工作区点「保存」：先把脏 tab 落盘，再真的切过去", async () => {
    const ws = useWorkspaceStore();
    ws.workspaceId = "wsA";
    seedDirtyTab(ws, "wsA");
    answer("save");

    expect(await ws.attach("wsB")).toBe(true);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile.mock.calls[0]?.[0]).toMatchObject({ workspaceId: "wsA" });
    expect(ws.workspaceId).toBe("wsB");
    expect(ws.tabs).toHaveLength(0);
  });
});

describe("三选一对话框的每条出口都自己 resolve", () => {
  /**
   * 真机验证抓到的：第一版只在 onAfterLeave 里 resolve。窗口不可见时
   * （`document.visibilityState === "hidden"`）CSS 离场过渡不会跑完 →
   * transitionend 不触发 → onAfterLeave 不触发 → Promise 永久挂起，
   * 表现是点了「放弃修改」之后 tab 既不关也不报错。
   *
   * 因此下面每一条都**故意不调 onAfterLeave**：只要哪条按钮的 resolve
   * 又回到依赖 afterLeave，这里就会超时挂住。
   */
  const cases: [keyof ReturnType<typeof createDirtyDialog>["handlers"], DirtyDecision][] = [
    ["onPositiveClick", "save"],
    ["onNegativeClick", "discard"],
    ["onClose", "cancel"],
    ["onEsc", "cancel"],
    ["onMaskClick", "cancel"],
  ];

  for (const [hook, expected] of cases) {
    it(`${hook} 单独触发即 resolve 成 ${expected}（不碰 onAfterLeave）`, async () => {
      const { handlers, decision } = createDirtyDialog();
      handlers[hook]();
      const settled = await Promise.race([
        decision,
        new Promise<string>((r) => setTimeout(() => r("HUNG"), 200)),
      ]);
      expect(settled).toBe(expected);
    });
  }

  it("第一次决定说了算：之后的 afterLeave 兜底不会把它改掉", async () => {
    const { handlers, decision } = createDirtyDialog();
    handlers.onNegativeClick();
    handlers.onAfterLeave();
    expect(await decision).toBe("discard");
  });
});

describe("缺陷2 · tab 绑定所属工作区", () => {
  it("A 的读取迟到、期间已切到 B：结果整份丢弃，B 里不会凭空多一个 tab", async () => {
    const ws = useWorkspaceStore();
    ws.workspaceId = "wsA";

    // 读取卡住不返回，模拟「点开文件之后马上切了工作区」
    let resolveRead: (v: unknown) => void = () => undefined;
    readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );

    const opening = ws.openFile("a.txt");
    expect(await ws.attach("wsB")).toBe(true);
    resolveRead(fileResult("A 工作区的内容\n"));
    await opening;

    expect(ws.workspaceId).toBe("wsB");
    expect(ws.tabs).toHaveLength(0);
    expect(ws.activePath).toBe("");
  });

  it("tab 的 workspaceId 与当前不一致时拒绝保存，一个字节都不发给 main", async () => {
    const ws = useWorkspaceStore();
    ws.workspaceId = "wsB";
    // 一条从 A 残留下来的 tab（例如日后新增的「切回去」路径）
    seedDirtyTab(ws, "wsA");

    const result = await ws.saveTab(ws.tabs[0]!);

    expect(result).toBe("error");
    expect(saveFile).not.toHaveBeenCalled();
    expect(ws.saveError).toContain("已经切走的工作区");
  });

  it("正常打开的 tab 带着当前 workspaceId，保存时原样回传", async () => {
    const ws = useWorkspaceStore();
    ws.workspaceId = "wsA";
    await ws.openFile("a.txt");

    expect(ws.tabs[0]?.workspaceId).toBe("wsA");
    ws.tabs[0]!.content = "改过了\n";
    expect(await ws.saveTab(ws.tabs[0]!)).toBe("saved");
    expect(saveFile.mock.calls[0]?.[0]).toMatchObject({ workspaceId: "wsA" });
  });
});

describe("缺陷4 · 切换释放旧工作区的资源", () => {
  it("连切 3 次：每次都对**上一个** workspaceId 调一次 release", async () => {
    const ws = useWorkspaceStore();
    expect(await ws.attach("ws1")).toBe(true);
    expect(await ws.attach("ws2")).toBe(true);
    expect(await ws.attach("ws3")).toBe(true);
    expect(await ws.attach("ws4")).toBe(true);

    // 第一次 attach 时没有「上一个」，所以是 3 次而不是 4 次
    expect(release.mock.calls.map((c) => c[0])).toEqual(["ws1", "ws2", "ws3"]);
  });

  it("面板卸载也要释放：detach 之后当前工作区的资源被收掉", async () => {
    const ws = useWorkspaceStore();
    await ws.attach("ws1");
    release.mockClear();

    ws.detach();

    expect(release).toHaveBeenCalledWith("ws1");
  });
});
