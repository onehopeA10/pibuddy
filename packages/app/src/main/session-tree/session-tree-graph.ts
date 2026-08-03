/**
 * 会话树归一化（common.session-tree）。
 *
 * 输入是会话 JSONL 里的**扁平 entry 列表**（append-only、每条带稳定 id 与
 * parentId），输出是一份类型化、拍平、带性能保护的 `SessionTreeGraph`。
 *
 * ## 为什么从 JSONL 的扁平 entry 重建树，而不是走 pi 的 get_tree
 *
 * pi 的 `get_tree` 是**内核（pi runtime）**的能力，取它必须持有 pi client，
 * 而那条 client 索引住在 `pi/pi-ipc.ts`——一个 common 能力去 import pi 域会
 * 撞穿 `kernel-boundary.spec.ts` 的「内核模块不得 import pi 域」（那张允许表
 * 只减不增）。会话 JSONL 本来就是这棵树的**真相源**：source/pi 明说它是
 * 「append-only tree of entries with stable ids」（rpc.md:694 起），每条 entry
 * 的 `parentId` 就是树的边。据它重建树，既拿到同一棵树，又不碰 pi 域、还天然
 * 按 workspaceId + sessionId 分区（数据分区铁律）。
 *
 * ## 当前叶子怎么定
 *
 * JSONL 是按写入顺序追加的，pi 永远往**当前活动分支的末端**追加；fork 之后
 * 新分支的 entry 排在文件最后。因此「文件里最后一条带 id 的 entry」就是当前
 * 活动叶子。这条推断不依赖任何 pi RPC。
 *
 * ## 本文件是纯函数
 *
 * 不 import electron、不读文件、不发 RPC。读 JSONL 那半在 session-tree-ipc.ts，
 * 这一半只做确定性变换，单测直接喂各种畸形 entry 列表即可。
 *
 * ## 性能保护
 *
 * 「不要一次渲染几千节点全展开」的正确落点是**数据出口**：截断在这里做，且
 * **保证活动分支（根 → 当前叶子）完整**，其余分支填到预算为止。
 */
import type { SessionTreeGraph, SessionTreeNode, SessionTreeNodeKind } from "@pibuddy/contract";

/** 节点上限。活动分支不受此限（见文件头），其余分支填到这里为止。 */
export const SESSION_TREE_NODE_CAP = 400;

const PREVIEW_MAX_CHARS = 120;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 从 message.content 里抽出可读文本。
 *
 * content 可能是字符串，也可能是 `[{type:"text", text}, …]` 的块数组
 * （与 session-index.ts 的 textOf 同构，未知块一律跳过）。
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec && rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.join("\n");
}

interface Classified {
  kind: SessionTreeNodeKind;
  preview: string;
  modelId: string | null;
}

/**
 * 认出一条 entry 是什么。
 *
 * pi 的 entry.type 是开放集合（source/pi 会往里写 fork / compaction / 扩展记录），
 * 不认识的一律归 `other`——照旧显示为一个节点，绝不因为看不懂就把树判坏。
 */
function classify(entry: Record<string, unknown>): Classified {
  switch (entry.type) {
    case "session":
      return { kind: "session", preview: "会话起点", modelId: null };
    case "compaction":
      return { kind: "compaction", preview: "上下文压缩", modelId: null };
    case "model_change": {
      const modelId = asString(entry.modelId);
      return { kind: "model-change", preview: modelId ? `切换模型 ${modelId}` : "切换模型", modelId };
    }
    case "message": {
      const msg = asRecord(entry.message);
      const role = msg ? asString(msg.role) : null;
      const text = msg ? textOf(msg.content) : "";
      const preview = text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX_CHARS);
      const modelId = msg ? asString(msg.model) : null;
      if (role === "user") return { kind: "user", preview, modelId };
      if (role === "assistant") return { kind: "assistant", preview, modelId };
      return { kind: "other", preview, modelId };
    }
    default:
      return { kind: "other", preview: "", modelId: null };
  }
}

/** 一条已解析的 entry。 */
interface ParsedEntry {
  id: string;
  parentId: string | null;
  raw: Record<string, unknown>;
}

/** 归一化后、拍平前的一个中间节点。 */
interface FlatNode {
  node: SessionTreeNode;
  children: FlatNode[];
}

function toParsed(entries: readonly unknown[]): { parsed: ParsedEntry[]; leafId: string | null } {
  const parsed: ParsedEntry[] = [];
  let leafId: string | null = null;
  for (const raw of entries) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const id = asString(rec.id);
    // 没有稳定 id 的 entry 无法连边、无法定位；跳过它（session header 之类的
    // 无 id 记录本就不该出现在树里）。
    if (id === null) continue;
    const parentId = asString(rec.parentId);
    parsed.push({ id, parentId, raw: rec });
    // 文件里最后一条带 id 的 entry 即当前活动叶子（append-only，末端在活动分支）。
    leafId = id;
  }
  return { parsed, leafId };
}

/** 递归建一个 FlatNode 子树。`seen` 防自引用 / 环导致的无限递归。 */
function buildNode(
  id: string,
  parentId: string | null,
  depth: number,
  leafId: string | null,
  byParent: Map<string, ParsedEntry[]>,
  entryById: Map<string, ParsedEntry>,
  seen: Set<string>
): FlatNode {
  const parsed = entryById.get(id)!;
  const childEntries = byParent.get(id) ?? [];
  const children: FlatNode[] = [];
  for (const child of childEntries) {
    if (seen.has(child.id)) continue; // 防环
    seen.add(child.id);
    children.push(buildNode(child.id, id, depth + 1, leafId, byParent, entryById, seen));
  }

  const { kind, preview, modelId } = classify(parsed.raw);
  const node: SessionTreeNode = {
    id,
    parentId,
    kind,
    preview,
    modelId,
    depth,
    branchPoint: children.length > 1,
    current: id === leafId,
    timestamp: asString(parsed.raw.timestamp),
  };
  return { node, children };
}

function countNodes(flat: FlatNode): number {
  let total = 1;
  for (const child of flat.children) total += countNodes(child);
  return total;
}

/** 收集根 → 当前叶子这条活动分支上的全部 id（截断时保证完整）。 */
function activePathIds(roots: FlatNode[], leafId: string | null): Set<string> {
  const path = new Set<string>();
  if (leafId === null) return path;
  const dfs = (flat: FlatNode): boolean => {
    if (flat.node.id === leafId) {
      path.add(flat.node.id);
      return true;
    }
    for (const child of flat.children) {
      if (dfs(child)) {
        path.add(flat.node.id);
        return true;
      }
    }
    return false;
  };
  for (const root of roots) dfs(root);
  return path;
}

/**
 * 把树拍平成父在子前的线性序，带节点上限。
 *
 * 先序遍历。**活动分支（根 → 当前叶子）上的节点无视预算恒发**——这是「大树
 * 截断后当前分支仍完整」这条保证的唯一承载点，不依赖遍历顺序（渲染侧的布局
 * 只看 parentId，与发出顺序无关）。非活动节点只在预算内发，且**父没发就不
 * 下探**——否则会连出一条指向缺失父的边。父恒在子之前：先序遍历本身保证。
 */
function flatten(
  roots: FlatNode[],
  activeIds: Set<string>
): { nodes: SessionTreeNode[]; emitted: number } {
  const nodes: SessionTreeNode[] = [];
  let emitted = 0;

  const visit = (flat: FlatNode): void => {
    const onActive = activeIds.has(flat.node.id);
    if (!onActive && emitted >= SESSION_TREE_NODE_CAP) return; // 预算耗尽，剪掉整棵子树
    nodes.push(flat.node);
    emitted += 1;
    for (const child of flat.children) visit(child);
  };

  for (const root of roots) visit(root);
  return { nodes, emitted };
}

/**
 * 归一化入口。
 *
 * @param entries 会话 JSONL 的全部记录（含 session header 等无 id 记录，会被跳过）
 */
export function buildSessionTreeGraph(entries: readonly unknown[]): SessionTreeGraph {
  const { parsed, leafId } = toParsed(entries);

  const entryById = new Map<string, ParsedEntry>();
  for (const p of parsed) entryById.set(p.id, p); // 同 id 后者覆盖前者（JSONL 不该有，防御）

  const byParent = new Map<string, ParsedEntry[]>();
  const roots: ParsedEntry[] = [];
  for (const p of parsed) {
    // parentId 为空、或指向一条不存在的 entry（断链孤儿），都当作根（rpc.md:724）。
    if (p.parentId !== null && entryById.has(p.parentId)) {
      const list = byParent.get(p.parentId) ?? [];
      list.push(p);
      byParent.set(p.parentId, list);
    } else {
      roots.push(p);
    }
  }

  const seen = new Set<string>(roots.map((r) => r.id));
  const rootNodes = roots.map((r) => buildNode(r.id, null, 0, leafId, byParent, entryById, seen));

  const totalNodes = rootNodes.reduce((sum, root) => sum + countNodes(root), 0);
  const activeIds = activePathIds(rootNodes, leafId);
  const { nodes, emitted } = flatten(rootNodes, activeIds);

  return {
    nodes,
    rootIds: rootNodes.map((root) => root.node.id),
    currentLeafId: leafId,
    totalNodes,
    truncated: emitted < totalNodes,
  };
}
