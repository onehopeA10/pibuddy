/**
 * 会话树归一化的行为判据（common.session-tree）。
 *
 * 纯函数，无需给 electron / 文件系统打桩。输入是会话 JSONL 的**扁平 entry
 * 列表**（append order），据每条的 parentId 重建树。重点钉五件容易悄悄坏掉
 * 的事：节点分类、分支点、当前叶子（= 文件里最后一条带 id 的 entry）、断链
 * 孤儿成根、以及**大树截断时活动分支必须完整**。
 */
import { describe, expect, it } from "vitest";

import { buildSessionTreeGraph, SESSION_TREE_NODE_CAP } from "./session-tree-graph.js";

/** 造一条 message entry。 */
function msg(id: string, parentId: string | null, role: string, text: string) {
  return { type: "message", id, parentId, message: { role, content: text } };
}

describe("buildSessionTreeGraph · 基本结构", () => {
  it("分类 / 深度 / 父子 / 当前叶子（末条）/ 拍平顺序都对得上", () => {
    // append order：session header → user → assistant
    const entries = [
      { type: "session", id: "s0", parentId: null },
      msg("u1", "s0", "user", "  hello   world "),
      msg("a1", "u1", "assistant", "hi"),
    ];
    const graph = buildSessionTreeGraph(entries);

    expect(graph.rootIds).toEqual(["s0"]);
    expect(graph.currentLeafId).toBe("a1"); // 最后一条带 id 的 entry
    expect(graph.totalNodes).toBe(3);
    expect(graph.truncated).toBe(false);
    // 父恒在子之前
    expect(graph.nodes.map((n) => n.id)).toEqual(["s0", "u1", "a1"]);

    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
    expect(byId.get("s0")!.kind).toBe("session");
    expect(byId.get("u1")!.kind).toBe("user");
    expect(byId.get("a1")!.kind).toBe("assistant");
    // 预览去掉了多余空白
    expect(byId.get("u1")!.preview).toBe("hello world");
    expect(byId.get("u1")!.depth).toBe(1);
    expect(byId.get("a1")!.depth).toBe(2);
    expect(byId.get("a1")!.parentId).toBe("u1");
    expect(graph.nodes.filter((n) => n.current).map((n) => n.id)).toEqual(["a1"]);
  });

  it("同一父下有两个孩子的被标为分支点，两条分支都在（分叉是导航不是删除）", () => {
    const entries = [
      msg("u1", null, "user", "q"),
      msg("a1", "u1", "assistant", "answer A"),
      msg("a2", "u1", "assistant", "answer B"), // fork：a2 也挂在 u1 下
    ];
    const graph = buildSessionTreeGraph(entries);
    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
    expect(byId.get("u1")!.branchPoint).toBe(true);
    expect(byId.get("a1")!.branchPoint).toBe(false);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["a1", "a2", "u1"]);
    // 末条是 a2 → 当前叶子
    expect(graph.currentLeafId).toBe("a2");
  });

  it("model_change / compaction / 未知 type 各归其类", () => {
    const entries = [
      { type: "model_change", id: "m1", parentId: null, modelId: "gpt-x" },
      { type: "compaction", id: "c1", parentId: "m1" },
      { type: "weird_extension_entry", id: "x1", parentId: "c1" },
    ];
    const graph = buildSessionTreeGraph(entries);
    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
    expect(byId.get("m1")!.kind).toBe("model-change");
    expect(byId.get("m1")!.modelId).toBe("gpt-x");
    expect(byId.get("c1")!.kind).toBe("compaction");
    expect(byId.get("x1")!.kind).toBe("other");
  });
});

describe("buildSessionTreeGraph · 防御式解析", () => {
  it("空列表 → 空图，不抛", () => {
    const graph = buildSessionTreeGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.rootIds).toEqual([]);
    expect(graph.totalNodes).toBe(0);
    expect(graph.currentLeafId).toBe(null);
  });

  it("缺 id 的记录（如 session header 无 id）被跳过，不进树", () => {
    const entries = [
      { type: "session", cwd: "/x" }, // 无 id
      msg("u1", null, "user", "kept"),
    ];
    const graph = buildSessionTreeGraph(entries);
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1"]);
    expect(graph.totalNodes).toBe(1);
  });

  it("parentId 指向不存在的 entry（断链孤儿）当作根", () => {
    const entries = [
      msg("a", null, "user", "root a"),
      msg("orphan", "ghost", "user", "parent gone"), // ghost 不存在
    ];
    const graph = buildSessionTreeGraph(entries);
    expect(graph.rootIds.sort()).toEqual(["a", "orphan"]);
    expect(graph.nodes.find((n) => n.id === "orphan")!.parentId).toBe(null);
  });
});

describe("buildSessionTreeGraph · 性能截断", () => {
  /**
   * 造一条「主干 + 每一节挂一大堆旁支」的扁平 entry 列表，总数远超上限。
   * 主干最后一节是当前叶子。断言：截断了、但主干（根 → 当前叶子）一节不少。
   */
  function bigEntries(spineLen: number, fanoutPerNode: number) {
    const entries: ReturnType<typeof msg>[] = [msg("spine-0", null, "user", "root")];
    let leafId = "spine-0";
    for (let i = 1; i < spineLen; i++) {
      // 先把旁支写进文件，再写主干下一节 —— 主干节点因此在 append order 里排在
      // 一大堆旁支之后。这样先序遍历会先把预算花在旁支上，主干深处只能靠「活动
      // 分支无视预算恒发」进来；否则这条测试对那条保证就是恒真的。
      for (let j = 0; j < fanoutPerNode; j++) {
        entries.push(msg(`branch-${i}-${j}`, `spine-${i - 1}`, "assistant", `b${i}-${j}`));
      }
      const id = `spine-${i}`;
      entries.push(msg(id, `spine-${i - 1}`, "user", `step ${i}`));
      leafId = id; // 主干每次写在旁支之后，末条恒是主干末端
    }
    return { entries, leafId };
  }

  it("总数超上限时截断，且活动主干（根 → 当前叶子）完整保留", () => {
    const spineLen = 30;
    const { entries, leafId } = bigEntries(spineLen, 60); // 30 + 29*60 ≈ 1770 >> 400
    const graph = buildSessionTreeGraph(entries);

    expect(graph.currentLeafId).toBe(leafId);
    expect(graph.totalNodes).toBeGreaterThan(SESSION_TREE_NODE_CAP);
    expect(graph.truncated).toBe(true);

    const present = new Set(graph.nodes.map((n) => n.id));
    for (let i = 0; i < spineLen; i++) {
      expect([`spine-${i}`, present.has(`spine-${i}`)]).toEqual([`spine-${i}`, true]);
    }
    expect(present.has(leafId)).toBe(true);
    expect(graph.nodes.find((n) => n.id === leafId)!.current).toBe(true);

    // 每个被下发的非根节点，其父也一定被下发（不会连出指向缺失父的边）
    for (const n of graph.nodes) {
      if (n.parentId !== null) expect([n.id, present.has(n.parentId)]).toEqual([n.id, true]);
    }
  });

  it("恰好不超上限时不截断，全部下发", () => {
    const { entries } = bigEntries(5, 3); // 5 + 4*3 = 17 < 400
    const graph = buildSessionTreeGraph(entries);
    expect(graph.truncated).toBe(false);
    expect(graph.nodes.length).toBe(graph.totalNodes);
  });
});
