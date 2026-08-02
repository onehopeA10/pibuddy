/**
 * 搜索的宿主侧：起进程、发请求、管取消、管生命周期（FS-101）。
 *
 * ## 为什么取消要有 200ms 的硬期限
 *
 * 用户每敲一个字就是一次新搜索，上一次必须立刻闭嘴。只发一条 cancel
 * 然后等子进程自觉停下是不够的：它可能正卡在一个 900MB 的日志文件上。
 * 这里的规则是「发 cancel，200ms 内没停就 kill」——搜索是纯只读的，
 * 杀掉它不会损坏任何东西，而让它继续吐结果会让搜索框在用户眼前跳。
 *
 * ## 为什么工作区关闭必须 kill
 *
 * 泄漏一个 utility process 在 UI 上**完全无感**：没有窗口、没有报错，
 * 只是内存一路涨。连续切二十次工作区之后，任务管理器里躺着二十个
 * PiBuddy 子进程 —— 而用户只会觉得「这软件越用越卡」。
 */
import { utilityProcess } from "electron";
import type { WorkspaceSearchPage } from "@pibuddy/contract";
import path from "node:path";

import { SEARCH_DEFAULT_LIMIT } from "./search-scan.js";
import type { SearchWorkerReply, SearchWorkerRequest } from "./search-entry.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import { ignorePolicyFor } from "./workspace-store.js";

/** 发出 cancel 之后，等子进程自觉停下的最长时间。 */
export const SEARCH_CANCEL_GRACE_MS = 200;

/** 子进程句柄的最小接口。测试用一个同构的假实现替换它。 */
export interface SearchChild {
  postMessage(message: SearchWorkerRequest): void;
  on(event: "message", listener: (reply: SearchWorkerReply) => void): void;
  kill(): void;
  readonly killed: boolean;
}

export type SearchChildFactory = () => SearchChild;

/**
 * 默认工厂：真的起一个 utility process。
 *
 * 入口路径按 `import.meta.dirname` 拼：打包后主进程与 search-entry.js 一起
 * 躺在 `out/main/` 下，写绝对路径或相对 cwd 的路径在 packaged 构建里必然
 * 找不到（而 dev 下一切正常，是典型的「装完才暴露」缺陷）。
 */
const defaultFactory: SearchChildFactory = () => {
  const entry = path.join(import.meta.dirname, "search-entry.js");
  const child = utilityProcess.fork(entry, [], { serviceName: "pibuddy-search" });
  // utilityProcess 没有可读的 killed 标志，自己记一份 —— 泄漏检查需要它。
  let killed = false;
  return {
    postMessage: (message) => child.postMessage(message),
    on: (_event, listener) => child.on("message", listener),
    kill: () => {
      killed = true;
      child.kill();
    },
    get killed() {
      return killed;
    },
  };
};

let factory: SearchChildFactory = defaultFactory;

/** 仅供单测：替换子进程工厂（传 null 还原成真的 utilityProcess.fork）。 */
export function __setSearchChildFactory(next: SearchChildFactory | null): void {
  factory = next ?? defaultFactory;
}

interface WorkerSlot {
  child: SearchChild;
  pending: Map<string, (reply: SearchWorkerReply) => void>;
}

const workers = new Map<string, WorkerSlot>();

/** 仅供单测与诊断：当前活着的搜索子进程数。 */
export function activeSearchWorkerCount(): number {
  return workers.size;
}

/** 仅供单测：取某工作区的子进程句柄（断言 killed）。 */
export function searchChildFor(workspaceId: string): SearchChild | null {
  return workers.get(workspaceId)?.child ?? null;
}

function slotFor(workspaceId: string): WorkerSlot {
  const existing = workers.get(workspaceId);
  if (existing) return existing;
  const child = factory();
  const slot: WorkerSlot = { child, pending: new Map() };
  child.on("message", (reply) => {
    const resolve = slot.pending.get(reply.requestId);
    // 已取消的请求：结果照样会回来，但**必须丢掉** —— 交给调用方就等于
    // 「取消了还在往搜索框里塞旧结果」。
    if (!resolve) return;
    slot.pending.delete(reply.requestId);
    resolve(reply);
  });
  workers.set(workspaceId, slot);
  return slot;
}

export interface SearchParams {
  workspaceId: string;
  query: string;
  mode?: "name" | "content";
  limit?: number;
  cursor?: string | null;
  requestId: string;
  signal?: AbortSignal;
}

const EMPTY_CANCELLED: WorkspaceSearchPage = {
  items: [],
  nextCursor: null,
  truncated: false,
  cancelled: true,
};

/**
 * 执行一次搜索。
 *
 * `signal` 触发后立刻以 `{cancelled:true}` 结算，并给子进程发 cancel；
 * 子进程若在 SEARCH_CANCEL_GRACE_MS 内没有回应就被 kill 掉重建。
 */
export function search(params: SearchParams): Promise<WorkspaceSearchPage> {
  const root = requireWorkspaceRoot(params.workspaceId);
  const slot = slotFor(params.workspaceId);
  const { requestId } = params;

  if (params.signal?.aborted) return Promise.resolve(EMPTY_CANCELLED);

  return new Promise<WorkspaceSearchPage>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      slot.pending.delete(requestId);
      params.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    function onAbort(): void {
      slot.child.postMessage({ type: "cancel", requestId });
      // 先把调用方结算掉：取消是立刻生效的，不能让 UI 等子进程的脸色
      finish(() => resolve(EMPTY_CANCELLED));

      // finish 已经把这一条从 pending 里摘了，这里换上一个**只记「子进程
      // 认账了没有」**的哨兵。
      //
      // 早先这里直接用 `slot.pending.has(requestId)` 当判据 —— 而 finish
      // 刚刚删过它，那个条件恒为 false，于是 kill 分支是一段永远走不到的
      // 死代码：卡在大文件上的子进程会一直活着，表现只是内存慢慢涨。
      let acked = false;
      slot.pending.set(requestId, () => {
        acked = true;
      });
      const graceTimer = setTimeout(() => {
        slot.pending.delete(requestId);
        // 期限内没认账 = 它真的卡住了。搜索是纯只读的，杀掉没有副作用。
        if (!acked) disposeSearchWorker(params.workspaceId);
      }, SEARCH_CANCEL_GRACE_MS);
      graceTimer.unref?.();
    }

    slot.pending.set(requestId, (reply) => {
      finish(() => {
        if (reply.type === "error") reject(new Error(reply.message));
        else resolve(reply.page);
      });
    });
    params.signal?.addEventListener("abort", onAbort, { once: true });

    slot.child.postMessage({
      type: "search",
      requestId,
      root,
      query: params.query,
      mode: params.mode ?? "content",
      limit: params.limit ?? SEARCH_DEFAULT_LIMIT,
      cursor: params.cursor ?? null,
      ignorePolicy: ignorePolicyFor(params.workspaceId),
    });
  });
}

/** 关闭某个工作区的搜索子进程。工作区切换 / 关闭时必须调用。 */
export function disposeSearchWorker(workspaceId: string): boolean {
  const slot = workers.get(workspaceId);
  if (!slot) return false;
  slot.pending.clear();
  slot.child.kill();
  workers.delete(workspaceId);
  return true;
}

/** 应用退出时收掉全部搜索子进程。 */
export function disposeAllSearchWorkers(): number {
  const count = workers.size;
  for (const slot of workers.values()) {
    slot.pending.clear();
    slot.child.kill();
  }
  workers.clear();
  return count;
}
