/**
 * 会话树 / 分叉的渲染侧状态（common.session-tree）。
 *
 * ## 三条数据来源，各司其职
 *
 * - `sessions.tree()`：归一化的树结构（主进程折好，见 session-tree-graph.ts）。
 * - `pi.getForkMessages()`：**当前分支上可分叉的 user 消息**——这是跟着活动
 *   分支走的动态集合，不烙进静态的树里（换分支就会脱节），因此单独取、单独叠。
 * - `pi.fork()` / `pi.clone()`：分叉 / 克隆的**内核动作**。可被扩展否决
 *   （`success` 仍为 true，需自己看 `data.cancelled`），因此两者都必须查两层。
 *
 * ## 分叉是导航，不是删除
 *
 * pi 的会话是 append-only 的树，fork 只是在某条历史 user 消息上**新长一条
 * 分支**，原分支一个字节都不动（get_tree 连废弃分支一起返回）。因此 fork /
 * clone 成功后只做一件事：`refresh()` 把两条分支都重新画出来。绝不在本地把
 * 旧分支从图里抹掉。
 */
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { SessionTreeGraph } from "@contract";

/** get_fork_messages 的一条：`{entryId, text}`（rpc.md:671）。 */
interface ForkMessage {
  entryId: string;
  text: string;
}

function readForkMessages(data: unknown): ForkMessage[] {
  const messages = (data as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return [];
  const out: ForkMessage[] = [];
  for (const m of messages) {
    const rec = m as { entryId?: unknown; text?: unknown };
    if (typeof rec?.entryId === "string") {
      out.push({ entryId: rec.entryId, text: typeof rec.text === "string" ? rec.text : "" });
    }
  }
  return out;
}

export const useSessionTreeStore = defineStore("sessionTree", () => {
  const graph = shallowRef<SessionTreeGraph | null>(null);
  /** 当前分支上可分叉的 entryId 集合（权威值来自 get_fork_messages）。 */
  const forkableIds = shallowRef<Set<string>>(new Set());
  /** 点选的节点 id（导航到该 entry = 在树里高亮它）。 */
  const selectedId = ref<string | null>(null);
  const loading = ref(false);
  /** fork / clone 正在进行——期间禁用按钮，避免并发发两次分叉。 */
  const busy = ref(false);
  const error = ref("");
  /** 一次动作（分叉 / 克隆）的结果提示，含「被扩展取消」这种非错误的否决。 */
  const notice = ref("");
  /**
   * 当前面板盯着的 (workspaceId, sessionId)。由 refresh 首参写入，fork / clone
   * 成功后据它原地重拉——树 channel 只认不透明标识，路径反查在 main 侧。
   */
  const workspaceId = ref("");
  const sessionId = ref("");

  /**
   * 重新拉取树 + 可分叉集合。
   *
   * 首次由面板带上 (workspaceId, sessionId) 调用，之后（fork / clone 触发的
   * 重拉）不带参、复用上一次的目标。两条来源并发取，任一失败都如实记进 error。
   */
  async function refresh(ws?: string, sid?: string): Promise<void> {
    if (ws !== undefined) workspaceId.value = ws;
    if (sid !== undefined) sessionId.value = sid;
    // 目标还没定（会话未打开）：清空，不发请求。
    if (!workspaceId.value || !sessionId.value) {
      graph.value = null;
      return;
    }
    loading.value = true;
    error.value = "";
    try {
      const [treeGraph, forkResp] = await Promise.all([
        window.piBuddy.sessions.tree(workspaceId.value, sessionId.value),
        window.piBuddy.pi.getForkMessages(),
      ]);
      graph.value = treeGraph;
      forkableIds.value = new Set(
        forkResp.success ? readForkMessages(forkResp.data).map((m) => m.entryId) : []
      );
      // 选中的节点若已不在新树里（会话切换了），清掉高亮。
      if (selectedId.value && !treeGraph.nodes.some((n) => n.id === selectedId.value)) {
        selectedId.value = null;
      }
    } catch (err) {
      error.value = (err as Error).message;
      graph.value = null;
    } finally {
      loading.value = false;
    }
  }

  function select(id: string): void {
    selectedId.value = id;
  }

  /** 该节点当前可否作为分叉起点（在权威集合里）。 */
  function isForkable(id: string): boolean {
    return forkableIds.value.has(id);
  }

  /**
   * 从某条历史 user 消息分叉。
   *
   * 走 pi 内核 RPC，**两层检查**：先 `success`，再 `data.cancelled`（扩展否决
   * 时 success 仍是 true）。成功后 refresh —— 原分支保留，新分支一起画出来。
   */
  async function fork(entryId: string): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    notice.value = "";
    error.value = "";
    try {
      const resp = await window.piBuddy.pi.fork(entryId);
      if (!resp.success) {
        error.value = resp.error ?? "分叉失败";
        return;
      }
      if (resp.data?.cancelled) {
        notice.value = "分叉被扩展取消";
        return;
      }
      notice.value = "已从该消息分叉";
      await refresh();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      busy.value = false;
    }
  }

  /** 克隆当前分支到一个新会话（同样两层检查）。 */
  async function clone(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    notice.value = "";
    error.value = "";
    try {
      const resp = await window.piBuddy.pi.clone();
      if (!resp.success) {
        error.value = resp.error ?? "克隆失败";
        return;
      }
      if (resp.data?.cancelled) {
        notice.value = "克隆被扩展取消";
        return;
      }
      notice.value = "已克隆当前分支";
      await refresh();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      busy.value = false;
    }
  }

  return {
    graph,
    forkableIds,
    selectedId,
    loading,
    busy,
    error,
    notice,
    refresh,
    select,
    isForkable,
    fork,
    clone,
  };
});
