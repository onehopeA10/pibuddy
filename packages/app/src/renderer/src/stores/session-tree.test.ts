/**
 * 会话树 store 的行为判据（common.session-tree）。
 *
 * 重点钉三件事：
 *   1. refresh 把「树结构」与「可分叉集合」两条来源正确合起来；
 *   2. fork / clone 走内核 RPC，**两层检查**（success + data.cancelled），
 *      被扩展否决时不当成成功、也不当成错误；
 *   3. 分叉成功后**重拉树**（原分支保留、新分支出现），绝不本地删分支。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { SessionTreeGraph } from "@contract";
import { useSessionTreeStore } from "./session-tree";

function graph(ids: string[], leaf: string | null): SessionTreeGraph {
  return {
    nodes: ids.map((id, i) => ({
      id,
      parentId: i === 0 ? null : ids[i - 1],
      kind: "user",
      preview: id,
      modelId: null,
      depth: i,
      branchPoint: false,
      current: id === leaf,
      timestamp: null,
    })),
    rootIds: ids.length ? [ids[0]] : [],
    currentLeafId: leaf,
    totalNodes: ids.length,
    truncated: false,
  };
}

let tree: ReturnType<typeof vi.fn>;
let getForkMessages: ReturnType<typeof vi.fn>;
let fork: ReturnType<typeof vi.fn>;
let clone: ReturnType<typeof vi.fn>;

function installBridge(): void {
  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: {
      sessions: { tree },
      pi: { getForkMessages, fork, clone },
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  tree = vi.fn(async () => graph(["u1", "a1"], "a1"));
  getForkMessages = vi.fn(async () => ({ success: true, data: { messages: [{ entryId: "u1", text: "q" }] } }));
  fork = vi.fn(async () => ({ success: true, data: { text: "q", cancelled: false } }));
  clone = vi.fn(async () => ({ success: true, data: { cancelled: false } }));
  installBridge();
});

describe("refresh 合并两条来源", () => {
  it("树结构进 graph，可分叉集合进 forkableIds", async () => {
    const store = useSessionTreeStore();
    await store.refresh("ws", "s");
    expect(store.graph?.nodes.map((n) => n.id)).toEqual(["u1", "a1"]);
    expect(store.isForkable("u1")).toBe(true);
    expect(store.isForkable("a1")).toBe(false);
    expect(store.error).toBe("");
  });

  it("get_fork_messages 失败时可分叉集合为空，但树照常展示", async () => {
    getForkMessages.mockResolvedValueOnce({ success: false });
    const store = useSessionTreeStore();
    await store.refresh("ws", "s");
    expect(store.graph?.nodes.length).toBe(2);
    expect(store.isForkable("u1")).toBe(false);
  });

  it("tree() 抛错时记进 error，不留半棵树", async () => {
    tree.mockRejectedValueOnce(new Error("未知通道 session-tree:graph"));
    const store = useSessionTreeStore();
    await store.refresh("ws", "s");
    expect(store.graph).toBe(null);
    expect(store.error).toMatch(/未知通道/);
  });
});

describe("fork：两层检查 + 非破坏性", () => {
  it("成功（未被取消）后重拉树 —— 原分支保留、新分支一起画出来", async () => {
    const store = useSessionTreeStore();
    await store.refresh("ws", "s");
    expect(tree).toHaveBeenCalledTimes(1);

    // fork 之后树多一条分支
    tree.mockResolvedValueOnce(graph(["u1", "a1", "a2"], "a2"));
    await store.fork("u1");

    expect(fork).toHaveBeenCalledWith("u1");
    expect(store.notice).toMatch(/分叉/);
    // 关键：fork 成功触发了一次 refresh（tree 又被调了一次）
    expect(tree).toHaveBeenCalledTimes(2);
    expect(store.graph?.nodes.map((n) => n.id)).toEqual(["u1", "a1", "a2"]);
  });

  it("被扩展取消（success=true, cancelled=true）时不重拉、不报错，只给提示", async () => {
    fork.mockResolvedValueOnce({ success: true, data: { text: "q", cancelled: true } });
    const store = useSessionTreeStore();
    await store.refresh("ws", "s");
    tree.mockClear();

    await store.fork("u1");
    expect(store.notice).toMatch(/取消/);
    expect(store.error).toBe("");
    // 取消 = 什么都没变，绝不重拉、更不删分支
    expect(tree).not.toHaveBeenCalled();
  });

  it("success=false 时记 error，不当成分叉成功", async () => {
    fork.mockResolvedValueOnce({ success: false, error: "runtime 不可用" });
    const store = useSessionTreeStore();
    await store.fork("u1");
    expect(store.error).toBe("runtime 不可用");
    expect(store.notice).toBe("");
  });
});

describe("clone：同样两层检查", () => {
  it("成功后重拉树", async () => {
    const store = useSessionTreeStore();
    await store.refresh("ws", "s");
    tree.mockClear();
    await store.clone();
    expect(clone).toHaveBeenCalled();
    expect(store.notice).toMatch(/克隆/);
    expect(tree).toHaveBeenCalledTimes(1);
  });

  it("被取消时不重拉", async () => {
    clone.mockResolvedValueOnce({ success: true, data: { cancelled: true } });
    const store = useSessionTreeStore();
    await store.refresh("ws", "s");
    tree.mockClear();
    await store.clone();
    expect(store.notice).toMatch(/取消/);
    expect(tree).not.toHaveBeenCalled();
  });
});
