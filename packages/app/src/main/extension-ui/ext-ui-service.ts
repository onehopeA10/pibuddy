/**
 * Extension UI 的挂起表与生命周期（EXT-101）。
 *
 * ## 为什么这套状态必须住在 main
 *
 * 改造前挂起的弹窗只存在于渲染进程的 `uiRequests` 数组里，主进程对「现在
 * 有哪些问题还没被回答」一无所知。由此长出三个实测缺陷：
 *
 *  1. **timeout 完全没有实现**。全库只有 pi-sdk/src/types.ts 里一行类型
 *     声明。rpc.md:1145 写得很清楚：带 `timeout` 的 dialog 由 agent 侧到期
 *     自行 auto-resolve，「客户端不需要跟踪超时」。这句话被读成了「客户端
 *     什么都不用做」——但它真正的含义是**到期之后本地那个 modal 上的按钮
 *     已经没人接收了**。而那个 modal 是 mask-closable:false 的：用户面对
 *     一个关不掉、点了也没反应的框，发出去的响应带着一个失效 id，
 *     client.ts 直写 stdin、无任何校验，静默吞掉。
 *  2. **僵尸弹窗**。uiRequests 不随 runtime / session 清理。上一代留下的
 *     弹窗被作答时，`clientFor` 抛错，而 `respondUi` 那条路径上没有
 *     try/catch —— 结果是一条无人认领的 unhandled promise rejection。
 *  3. **setWidget / setTitle 落进 default 分支被静默丢弃**。它们是
 *     fire-and-forget，丢弃不会挂起任何东西，所以既不报错也不失败，
 *     只是扩展写的东西永远显示不出来。
 *
 * 把表放到 main 之后，这三件事都有了唯一的、可断言的落点：定时器归它管，
 * 代际清理归它管，「这个 id 还有效吗」有唯一答案。
 *
 * ## 一条硬约束：到期时不向 pi 写任何东西
 *
 * 上游已经自行 auto-resolve 过了。我们再补一条响应，pi 侧会收到一个
 * 无人 pending 的 id —— 轻则被忽略，重则被下一轮同 id 复用者认领。
 * expire 只做三件事：清定时器、出表、告诉渲染进程把框关掉。
 */
import { PUSH_CHANNELS, type PushChannel } from "@pibuddy/contract";
import {
  isDialogMethod,
  type ExtensionUiMethod,
  type ExtensionUiRequest,
  type ExtensionUiResponse,
} from "@pibuddy/pi-sdk";

/**
 * 请求被路由到的处理分支。
 *
 * 九个 method 恰好落在六个分支上，**没有 default**：新增一个上游 method
 * 会让 routeOf 的 switch 在 typecheck 阶段失败（返回类型不再可达），
 * 而不是像改造前那样悄悄落进 `default: break`。
 */
export type UiBranch = "dialog" | "notify" | "status" | "widget" | "title" | "editorText";

export function routeOf(method: ExtensionUiMethod): UiBranch {
  switch (method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      return "dialog";
    case "notify":
      return "notify";
    case "setStatus":
      return "status";
    case "setWidget":
      return "widget";
    case "setTitle":
      return "title";
    case "set_editor_text":
      return "editorText";
  }
}

export type RespondReason = "expired" | "no-runtime";

export type RespondResult = { ok: true } | { ok: false; reason: RespondReason };

/** 一条弹窗失效的原因，决定渲染侧给用户看哪句话。 */
export type ExpireReason = "timeout" | "generation" | "runtime-gone";

/** 主进程侧维护的 fire-and-forget 状态快照（供窗口 reload 后恢复）。 */
export interface ExtUiSnapshot {
  requests: ExtensionUiRequest[];
  statuses: { key: string; text: string }[];
  widgets: { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }[];
  title: string;
  editorText: string;
}

/**
 * 服务对外界的两个依赖。
 *
 * 刻意不是 PiSupervisor / PiRpcClient 本身：这两个都拖着 Electron 与真实
 * 子进程，单测里没法驱动。生产实现在 pi-ipc.ts 里把它们接起来。
 */
export interface ExtUiResponder {
  /** 返回 false = 这条响应没送出去（进程已退出 / stdin 已关） */
  respondUi(response: ExtensionUiResponse): boolean;
}

export interface ExtUiHost {
  /** 经 event-forwarder 的 sendPush 发出，自动获得信封与代际/序号 */
  push(targetId: number, channel: PushChannel, payload: unknown): void;
  /** 当前 runtime 的应答器；没有活跃 runtime 时返回 null */
  responderFor(targetId: number): ExtUiResponder | null;
}

interface PendingEntry {
  request: ExtensionUiRequest;
  targetId: number;
  runtimeGeneration: number;
  timer: NodeJS.Timeout | null;
  abort: AbortController;
}

interface TargetState {
  statuses: Map<string, string>;
  widgets: Map<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  title: string;
  editorText: string;
}

function emptyTargetState(): TargetState {
  return { statuses: new Map(), widgets: new Map(), title: "", editorText: "" };
}

export class ExtensionUiService {
  /** id → 挂起项。id 由 pi 生成（uuid），全局唯一，不必按 target 分表。 */
  private readonly pending = new Map<string, PendingEntry>();
  private readonly states = new Map<number, TargetState>();

  constructor(private readonly host: ExtUiHost) {}

  /** 当前仍挂着定时器的请求数。定时器泄漏的唯一判据。 */
  get pendingTimerCount(): number {
    let n = 0;
    for (const entry of this.pending.values()) if (entry.timer !== null) n++;
    return n;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 收到一条 extension_ui_request。返回它被路由到的分支。
   *
   * 只有 dialog 四法进挂起表。给 notify 建一个等待项等于凭空造出一个
   * 永远不会被回答的问题。
   */
  track(targetId: number, runtimeGeneration: number, request: ExtensionUiRequest): UiBranch {
    const branch = routeOf(request.method);
    const state = this.stateFor(targetId);

    switch (branch) {
      case "dialog":
        this.addPending(targetId, runtimeGeneration, request);
        break;
      case "status": {
        const key = request.statusKey ?? "";
        // rpc.md:1265「statusText: undefined（或省略）= 清除该 key」
        if (request.statusText === undefined || request.statusText === "") {
          state.statuses.delete(key);
        } else {
          state.statuses.set(key, request.statusText);
        }
        break;
      }
      case "widget": {
        const key = request.widgetKey ?? "";
        // 同上：widgetLines 缺席 = 删除这个 widget，而不是渲染一个空框
        if (request.widgetLines === undefined) {
          state.widgets.delete(key);
        } else {
          state.widgets.set(key, {
            lines: request.widgetLines,
            placement: request.widgetPlacement ?? "aboveEditor",
          });
        }
        break;
      }
      case "title":
        state.title = request.title ?? "";
        break;
      case "editorText":
        state.editorText = request.text ?? "";
        break;
      case "notify":
        break;
    }
    return branch;
  }

  /**
   * 回答一条弹窗。
   *
   * 顺序不可换：**先查表再查 runtime**。反过来的话，一个已过期的 id 在
   * runtime 还活着时会被直接写进 stdin —— 那正是改造前的行为。
   */
  respond(targetId: number, response: ExtensionUiResponse): RespondResult {
    const entry = this.pending.get(response.id);
    if (!entry || entry.targetId !== targetId) {
      return { ok: false, reason: "expired" };
    }
    this.drop(entry, "answered");

    const responder = this.host.responderFor(targetId);
    if (!responder) return { ok: false, reason: "no-runtime" };
    // 返回值必须被检查：pi-sdk 的 respondUi 在进程已退出 / stdin 已关时
    // 返回 false 而不再抛错，吞掉它就回到了「弹窗关了、助手那边没收到」。
    const delivered = responder.respondUi(response);
    if (!delivered) return { ok: false, reason: "no-runtime" };
    return { ok: true };
  }

  /**
   * 让一条弹窗失效（超时到期 / 主动作废）。
   *
   * **不向 pi 写任何响应**：超时场景下上游已经 auto-resolve 过了。
   */
  expire(id: string, reason: ExpireReason = "timeout"): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const targetId = entry.targetId;
    this.drop(entry, reason);
    this.host.push(targetId, PUSH_CHANNELS.piUiExpire, { id, reason });
    return true;
  }

  /**
   * 代际清理：`upToGeneration` 及更早的挂起项全部作废，并广播整代失效。
   *
   * runtime 重启与会话切换都走这里。按代际而不是按时间窗口判定，与
   * pi-supervisor 的丢弃规则同源 —— 两处用不同判据是 RUN-002 那类问题的
   * 温床。
   */
  clearGeneration(
    targetId: number,
    upToGeneration: number,
    reason: Exclude<ExpireReason, "timeout"> = "generation"
  ): number {
    let cleared = 0;
    for (const entry of [...this.pending.values()]) {
      if (entry.targetId !== targetId) continue;
      if (entry.runtimeGeneration > upToGeneration) continue;
      this.drop(entry, reason);
      cleared++;
    }
    this.states.delete(targetId);
    this.host.push(targetId, PUSH_CHANNELS.piUiExpireAll, {
      generation: upToGeneration,
      reason,
    });
    return cleared;
  }

  /** 窗口销毁：不广播（没人收），只保证定时器不残留。 */
  forgetTarget(targetId: number): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.targetId === targetId) this.drop(entry, "runtime-gone");
    }
    this.states.delete(targetId);
  }

  /**
   * 窗口 reload 后的恢复快照。
   *
   * runtime 若已随 reload 重启，挂起表已被 clearGeneration 清空，这里返回
   * 空列表 —— 那是**正确答案**，而不是「恢复失败」：那些问题的提问者已经
   * 不在了，把它们画回屏幕上才是骗人。
   */
  snapshot(targetId: number): ExtUiSnapshot {
    const state = this.states.get(targetId) ?? emptyTargetState();
    return {
      requests: [...this.pending.values()]
        .filter((e) => e.targetId === targetId)
        .map((e) => e.request),
      statuses: [...state.statuses].map(([key, text]) => ({ key, text })),
      widgets: [...state.widgets].map(([key, w]) => ({
        key,
        lines: w.lines,
        placement: w.placement,
      })),
      title: state.title,
      editorText: state.editorText,
    };
  }

  /** 挂起项的取消信号：main 侧等待方可以据它放弃等待。 */
  signalFor(id: string): AbortSignal | null {
    return this.pending.get(id)?.abort.signal ?? null;
  }

  /** 仅供单测与诊断。 */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  // ---------- 内部 ----------

  private stateFor(targetId: number): TargetState {
    let state = this.states.get(targetId);
    if (!state) {
      state = emptyTargetState();
      this.states.set(targetId, state);
    }
    return state;
  }

  private addPending(
    targetId: number,
    runtimeGeneration: number,
    request: ExtensionUiRequest
  ): void {
    if (!isDialogMethod(request.method)) return;
    // 同 id 重复到达（上游重发）：先清掉旧定时器再覆盖，否则旧的那个会在
    // 几分钟后向一个已经被回答过的 id 广播 expire。
    const existing = this.pending.get(request.id);
    if (existing) this.drop(existing, "generation");

    const entry: PendingEntry = {
      request,
      targetId,
      runtimeGeneration,
      timer: null,
      abort: new AbortController(),
    };
    const timeout = request.timeout;
    if (typeof timeout === "number" && timeout > 0) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.expire(request.id, "timeout");
      }, timeout);
      // 定时器不该把 Electron 主进程的事件循环钉住（也不该拖住单测退出）
      entry.timer.unref?.();
    }
    this.pending.set(request.id, entry);
  }

  /**
   * 出表 + 清定时器 + 触发取消信号。
   *
   * 三条路径（respond / expire / clearGeneration）全部经这里，是为了让
   * 「clearTimeout 有没有被调用」只有一个需要检查的地方。
   */
  private drop(entry: PendingEntry, reason: ExpireReason | "answered"): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.pending.delete(entry.request.id);
    if (reason !== "answered") entry.abort.abort(reason);
  }
}
