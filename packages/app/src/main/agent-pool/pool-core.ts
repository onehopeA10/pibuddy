/**
 * 后台多会话池的**纯**内核状态机（AGT-101 第一批）。
 *
 * ## 为什么是纯的（不 import electron / 不碰进程）
 *
 * 这个文件里没有一行 `utilityProcess.fork` / `BrowserWindow` / `dialog`。真正
 * 启停进程、弹原生框、推 IPC 的活儿都由注入的 `PoolRuntimeHost` 与 `onChange`
 * 回调承担（接线在 `pool.ts`）。理由与 `capability-registry.ts`、
 * `permission-engine.ts` 一致：并发不串台、重试所有权、空闲回收、超时拒绝这四件
 * 事**只有单测查得住**，而需要给 electron 打桩才能跑的判据最后都会变成没人跑
 * 的判据。把决策与副作用分开，多会话并发就能在一个纯函数环境里被真正制造出来。
 *
 * ## 它管什么、不管什么
 *
 * 管：每会话进程态（focused/background/warm/stopped/crashed）、列表任务态、
 * 资源上界与公平准入队列、空闲回收、按 origin 分配崩溃重试所有权、权限 inbox 的排队与
 * 超时拒绝、按会话隔离的事件序号闸门（不串台的落点）、单调快照序号。
 *
 * 不管：怎么起 pi 进程（`PoolRuntimeHost.launch`）、权限最终怎么裁决
 * （既有 `decidePermission`，池只把待办排进 inbox、超时清掉，**绝不自动允许**）、
 * 快照怎么推到窗口（`onChange`）。
 *
 * ## 生命周期所有权
 *
 * `requestSession` 带显式 origin：用户会话由池拥有崩溃重试；child / task 会话
 * 分别把重试安全交给 child 核心 / scheduler。`PoolRuntimeHost` 是启停进程的唯一
 * 接缝，三类会话仍共享池的准入、回收与资源上界。
 */
import type { AgentEvent } from "@pibuddy/pi-sdk";
import {
  DEFAULT_POOL_CAPS,
  isLiveRunState,
  POOL_ENVELOPE_GENERATION,
  POOL_ENVELOPE_ID,
  shouldAcceptEnvelope,
  wrapEnvelope,
  type PiEnvelope,
  type PoolCaps,
  type PoolInboxItem,
  type PoolListState,
  type PoolRunState,
  type PoolSessionView,
  type PoolSnapshot,
  type SequencedFrame,
} from "@pibuddy/contract";

// ---------------------------------------------------------------- 时序常量

/**
 * 时序参数（可注入，便于单测把秒级窗口压成毫秒）。
 *
 *   - `idleToWarmMs`     background 空闲多久降为 warm（进程还在，标记为可停候选）。
 *   - `warmToStoppedMs`  warm 再空闲多久停掉进程（回收）。
 *   - `permissionTimeoutMs` inbox 里一条权限待办多久无人响应就自动拒绝。
 *   - `crashWindowMs` / `crashBudget` 崩溃预算窗口与预算：窗口内崩溃次数超过预算
 *     就放弃自动恢复（置 crashed）。
 */
export interface PoolTiming {
  idleToWarmMs: number;
  warmToStoppedMs: number;
  permissionTimeoutMs: number;
  crashWindowMs: number;
  crashBudget: number;
}

export const DEFAULT_POOL_TIMING: PoolTiming = {
  idleToWarmMs: 5 * 60_000,
  warmToStoppedMs: 15 * 60_000,
  permissionTimeoutMs: 2 * 60_000,
  crashWindowMs: 60_000,
  crashBudget: 3,
};

// ---------------------------------------------------------------- host 接缝

/** 会话的生命周期所有者；只有 user 会话由池通用崩溃预算自动重试。 */
export type PoolSessionOrigin = "user" | "child" | "task";

/** 一次会话准入的启动请求（host 据此真正派生 runtime）。 */
export interface PoolLaunchRequest {
  sessionId: string;
  workspaceId: string | null;
  /** 谁拥有这次会话的重试决策。 */
  origin: PoolSessionOrigin;
  inheritPermissions?: boolean;
}

/**
 * 启停真实进程的唯一接缝。
 *
 * 池只决策「该起 / 该停哪个会话」，具体怎么起（复用现有 supervisor 的 launch、
 * 分配 runtimeId 与 generation、接事件流）由实现方在 `pool.ts` 里落地。
 * host 的方法**必须同步返回**：池在调用它之后立即更新自身状态，任何 await
 * 会在「已登记待起 / 尚未起」之间留一个查不到也清不掉的窗口。
 */
export interface PoolRuntimeHost {
  launch(req: PoolLaunchRequest): void;
  stop(sessionId: string): void;
}

/**
 * 池的观测者接口（供 pi 域的 supervisor 挂上）。
 *
 * 定义在这里而不是 supervisor 里：依赖方向必须是 pi → kernel。supervisor
 * `import type` 这个形状，池的接线层实现它，两边不会漂移。
 */
export interface PoolObserver {
  /** 会话拿到真实 sessionId（握手完成）时登记进池。 */
  onAdopt(info: {
    sessionId: string;
    workspaceId: string;
    runtimeId: string;
    generation: number;
    /** 子进程 pid（有则池按拍采样 RSS 回填内存估算）。 */
    pid?: number;
  }): void;
  /** 一条已包信封的事件流过（派生列表任务态；不改变转发本身）。 */
  onEvent(envelope: PiEnvelope<AgentEvent>): void;
  /** 当前代际 runtime 退出（reason 区分主动停止与崩溃）。 */
  onExit(info: { sessionId: string; reason: string }): void;
}

// ---------------------------------------------------------------- 内部记录

interface SessionRecord {
  sessionId: string;
  workspaceId: string | null;
  runtimeId: string;
  generation: number;
  runState: PoolRunState;
  listState: PoolListState;
  unread: boolean;
  /** 最近一次采样到的 RSS（MB）；未采样 / 无进程时为 0。 */
  memoryMb: number;
  /** 当前代际子进程 pid；无进程时 null。只用于 RSS 采样，不进快照。 */
  pid: number | null;
  costUsd: number;
  /** 崩溃时间戳（用于崩溃预算的滑动窗口）。 */
  crashTimes: number[];
  lastActivityAt: number;
  queued: boolean;
  origin: PoolSessionOrigin;
  /** false = 评估权限时忽略 once/session，只认 workspace 预授权。 */
  inheritPermissions: boolean;
  /** 本会话事件序号闸门的上一帧（不串台的落点，per (sessionId, generation)）。 */
  lastFrame: SequencedFrame | null;
  /** 入池顺序，用于公平（FIFO）准入。 */
  seq: number;
}

export interface PoolCoreOptions {
  host: PoolRuntimeHost;
  /** 每次状态变更后回调（用于把快照推到窗口）。缺省无副作用。 */
  onChange?: (snapshot: PoolSnapshot) => void;
  caps?: PoolCaps;
  timing?: Partial<PoolTiming>;
}

// ---------------------------------------------------------------- 池

export class AgentPoolCore {
  private readonly host: PoolRuntimeHost;
  private readonly onChange: ((snapshot: PoolSnapshot) => void) | null;
  private caps: PoolCaps;
  private timing: PoolTiming;

  private sessions = new Map<string, SessionRecord>();
  private inbox: PoolInboxItem[] = [];
  private focusedId: string | null = null;
  private insertionSeq = 0;
  private snapshotSequence = 0;

  /**
   * 被会话事件闸门丢弃的信封计数（诊断用，UI 不展示）。
   *
   * **正常多会话转发下应恒为 0**：每个会话有独立的 per (sessionId, generation)
   * 闸门，两个会话的序号互不影响。只有真正陈旧（同会话内序号回退 / 上一代迟到）
   * 的信封才会被计数。把闸门退化成「全局单计数器」的那一刻，两个会话交错的
   * 事件会互相判成「序号倒退」而被丢——那正是这个计数器要抓的回归。
   */
  droppedEnvelopes = 0;

  constructor(options: PoolCoreOptions) {
    this.host = options.host;
    this.onChange = options.onChange ?? null;
    this.caps = options.caps ?? { ...DEFAULT_POOL_CAPS };
    this.timing = { ...DEFAULT_POOL_TIMING, ...options.timing };
  }

  // -------------------------------------------------------------- 会话准入

  /**
   * 请求一个会话进入池。已存在则原样返回（幂等）。
   *
   * 新会话先进准入队列（`queued:true`）；随即尝试准入——触及上界时留在队列里
   * 公平等待，而不是被拒绝。
   */
  requestSession(input: {
    sessionId: string;
    workspaceId: string | null;
    origin?: PoolSessionOrigin;
    focus?: boolean;
    inheritPermissions?: boolean;
  }): void {
    const origin = input.origin ?? "user";
    const inheritPermissions = input.inheritPermissions ?? origin === "user";
    let record = this.sessions.get(input.sessionId);
    if (!record) {
      record = {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        runtimeId: "",
        generation: 0,
        runState: "background",
        listState: "idle",
        unread: false,
        memoryMb: 0,
        pid: null,
        costUsd: 0,
        crashTimes: [],
        lastActivityAt: 0,
        queued: true,
        origin,
        inheritPermissions,
        lastFrame: null,
        seq: this.insertionSeq++,
      };
      this.sessions.set(input.sessionId, record);
    } else {
      if (record.workspaceId !== input.workspaceId || record.origin !== origin) {
        throw new Error(
          `POOL_SESSION_OWNERSHIP_MISMATCH: ${input.sessionId} belongs to workspace=${String(record.workspaceId)} origin=${record.origin}`
        );
      }
      if (record.runState === "stopped" || record.runState === "crashed") {
        record.runState = "background";
        record.queued = true;
      }
    }
    if (input.focus) {
      this.focusInternal(input.sessionId);
    } else {
      this.admitQueued();
    }
    this.emit();
  }

  /**
   * 登记一个**已经在跑**的会话（由既有 `pi:start` 启动，池只是把它纳入监督）。
   *
   * 与 `requestSession` 的区别：不走准入队列、**不调 host.launch**（进程已经起了，
   * 再 launch 就是重复派生）。这是本批「聚焦会话集成」的入口——单窗口单活跃会话
   * 模型下，被登记的会话即前台会话。将来的后台派生/child 编排走 `requestSession`
   * + host.launch 那条路（已在 core 用例里钉住）。
   */
  adoptRunning(
    info: {
      sessionId: string;
      workspaceId: string | null;
      runtimeId: string;
      generation: number;
      pid?: number;
    },
    now = 0
  ): void {
    let record = this.sessions.get(info.sessionId);
    if (!record) {
      record = {
        sessionId: info.sessionId,
        workspaceId: info.workspaceId,
        runtimeId: info.runtimeId,
        generation: info.generation,
        runState: "background",
        listState: "idle",
        unread: false,
        memoryMb: 0,
        pid: info.pid ?? null,
        costUsd: 0,
        crashTimes: [],
        // 空闲计时从**进程就绪的这一刻**起，而不是 epoch 0——否则一个刚握手、
        // 还没产生任何事件的会话，第一次 tick 就因「自纪元以来一直空闲」被回收成
        // warm（真机实测到的边界）。
        lastActivityAt: now,
        queued: false,
        origin: "user",
        inheritPermissions: true,
        lastFrame: null,
        seq: this.insertionSeq++,
      };
      this.sessions.set(info.sessionId, record);
    } else {
      if (record.workspaceId !== info.workspaceId || record.origin !== "user") {
        throw new Error(
          `POOL_SESSION_OWNERSHIP_MISMATCH: ${info.sessionId} belongs to workspace=${String(record.workspaceId)} origin=${record.origin}`
        );
      }
      record.runtimeId = info.runtimeId;
      record.generation = info.generation;
      record.pid = info.pid ?? null;
      // 换了代际 = 换了进程，上一代的 RSS 不再作数。
      record.memoryMb = 0;
      record.queued = false;
      record.lastFrame = null;
      record.lastActivityAt = now;
      if (record.runState === "stopped" || record.runState === "crashed") {
        record.runState = "background";
      }
    }
    this.focusInternal(info.sessionId);
    this.emit();
  }

  /**
   * host（supervisor 观测者）报告当前代际 runtime 退出。
   *
   *   - `expected-stop` → 主动停止（用户停 / 换会话），置 stopped，不计崩溃；
   *   - 其它 reason      → 由 `onCrash` 按 origin 分派重试所有权。
   */
  handleExit(sessionId: string, reason: string, now: number): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    if (reason === "expected-stop") {
      this.stopRecord(record, "stopped");
      if (this.focusedId === sessionId) this.focusedId = null;
      this.admitQueued();
      this.emit();
      return;
    }
    this.onCrash(sessionId, now);
  }

  /**
   * 聚焦到某个会话（或 null 表示无前台）。
   *
   * focused 会话是用户正看着的那个，**必须在跑**：若它还在排队，聚焦会为它腾位
   * （把最久未活动、且不在 running 的后台/热备会话回收），保证前台会话拿到进程。
   */
  setFocused(sessionId: string | null): void {
    this.focusInternal(sessionId);
    this.emit();
  }

  private focusInternal(sessionId: string | null): void {
    // 旧 focused 降为 background（进程不停——只是不再前台）。
    if (this.focusedId && this.focusedId !== sessionId) {
      const prev = this.sessions.get(this.focusedId);
      if (prev && prev.runState === "focused") prev.runState = "background";
    }
    this.focusedId = sessionId;
    if (!sessionId) return;
    const record = this.sessions.get(sessionId);
    if (!record) return;
    // 前台会话不留未读。
    record.unread = false;
    if (record.runState === "stopped" || record.runState === "crashed") {
      // 聚焦一个已停/崩溃的会话 = 请求恢复它。
      this.launch(record);
    } else if (record.queued) {
      if (!this.canAdmit(record)) this.makeRoomForFocus(sessionId);
      this.launch(record);
    }
    record.runState = "focused";
  }

  /** 前台会话之外，为其腾出一个并发位（回收最久未活动、非 running 的活跃会话）。 */
  private makeRoomForFocus(focusId: string): void {
    while (this.liveCount() >= this.caps.maxConcurrent) {
      const victim = this.reclaimCandidate(focusId);
      if (!victim) break; // 全在 running：宁可前台会话临时超一位，也不能拒绝用户在看的会话
      this.stopRecord(victim, "stopped");
    }
  }

  /** 最久未活动、非 focused、非 running 的活跃会话——回收优先级最高的那个。 */
  private reclaimCandidate(excludeId: string): SessionRecord | null {
    let candidate: SessionRecord | null = null;
    for (const r of this.sessions.values()) {
      if (r.sessionId === excludeId) continue;
      if (r.queued) continue;
      if (!isLiveRunState(r.runState)) continue;
      if (r.runState === "focused") continue;
      if (r.listState === "running") continue;
      if (!candidate || r.lastActivityAt < candidate.lastActivityAt) candidate = r;
    }
    return candidate;
  }

  /** 用户主动停一个会话（窗口关闭**不**走这里——窗口关闭 ≠ 停止）。 */
  stopSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    this.stopRecord(record, "stopped");
    if (this.focusedId === sessionId) this.focusedId = null;
    this.admitQueued();
    this.emit();
  }

  private stopRecord(record: SessionRecord, to: "stopped" | "crashed"): void {
    if (isLiveRunState(record.runState)) this.host.stop(record.sessionId);
    record.runState = to;
    record.queued = false;
    record.memoryMb = 0;
    record.pid = null;
    record.lastFrame = null;
    // 停一个会话 = 它挂在 inbox 里的权限待办一并作废（进程都没了，没人再回答）。
    this.inbox = this.inbox.filter((i) => i.sessionId !== record.sessionId);
    if (record.listState === "waiting_permission") record.listState = "idle";
    this.pruneDeadSessions();
  }

  /** 停掉的会话记录保留一段时间供 UI，但必须有上限，避免 Map 只增不减。 */
  private pruneDeadSessions(keep = 32): void {
    const dead = [...this.sessions.values()]
      .filter((r) => r.runState === "stopped" || r.runState === "crashed")
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const extra = dead.length - keep;
    if (extra <= 0) return;
    for (const record of dead.slice(0, extra)) {
      if (this.focusedId === record.sessionId) continue;
      this.sessions.delete(record.sessionId);
    }
  }

  /** 子 Agent / task 默认 workspace-only；前台 user 继承 session grant。 */
  sessionGrantPolicy(sessionId: string): "inherit" | "workspace-only" {
    const record = this.sessions.get(sessionId);
    if (!record) return "inherit";
    return record.inheritPermissions ? "inherit" : "workspace-only";
  }

  // -------------------------------------------------------------- 准入判定

  private liveCount(): number {
    let n = 0;
    // 排队中的会话还没拿到进程：runState 虽预置为 background，但 queued 为真，
    // 不占并发位。少了 `!r.queued` 这半句，准入判定会把还在排队的会话算成
    // 已在跑，于是并发上界形同虚设。
    for (const r of this.sessions.values()) if (isLiveRunState(r.runState) && !r.queued) n++;
    return n;
  }

  private workspaceLiveCount(workspaceId: string | null): number {
    let n = 0;
    for (const r of this.sessions.values()) {
      if (isLiveRunState(r.runState) && !r.queued && r.workspaceId === workspaceId) n++;
    }
    return n;
  }

  private totalMemoryMb(): number {
    let mb = 0;
    for (const r of this.sessions.values()) mb += r.memoryMb;
    return mb;
  }

  private totalCostUsd(): number {
    let usd = 0;
    for (const r of this.sessions.values()) usd += r.costUsd;
    return usd;
  }

  /** 一个排队会话现在能否被准入（四个上界全过才行）。 */
  private canAdmit(record: SessionRecord): boolean {
    if (this.liveCount() >= this.caps.maxConcurrent) return false;
    if (this.workspaceLiveCount(record.workspaceId) >= this.caps.maxPerWorkspace) return false;
    if (this.totalMemoryMb() >= this.caps.memoryCeilingMb) return false;
    if (this.totalCostUsd() >= this.caps.costCeilingUsd) return false;
    return true;
  }

  /** 尽可能多地准入排队会话，按入池顺序（FIFO 公平）。 */
  private admitQueued(): void {
    const queued = [...this.sessions.values()]
      .filter((r) => r.queued)
      .sort((a, b) => a.seq - b.seq);
    for (const record of queued) {
      if (!this.canAdmit(record)) continue;
      this.launch(record);
    }
  }

  /** 让 host 起进程，并把会话从排队态切成后台活跃态。 */
  private launch(record: SessionRecord): void {
    record.queued = false;
    record.runState = record.sessionId === this.focusedId ? "focused" : "background";
    this.host.launch({
      sessionId: record.sessionId,
      workspaceId: record.workspaceId,
      origin: record.origin,
      inheritPermissions: record.inheritPermissions,
    });
  }

  // -------------------------------------------------------------- host 回调

  /** host 报告某会话的 runtime 已就绪（拿到 runtimeId 与代际）。 */
  onRuntimeReady(
    sessionId: string,
    info: { runtimeId: string; generation: number; pid?: number },
    now: number
  ): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.runtimeId = info.runtimeId;
    record.generation = info.generation;
    record.pid = info.pid ?? null;
    record.memoryMb = 0;
    record.lastActivityAt = now;
    // 新代际 = 会话事件闸门重置（上一代迟到事件不该被当成新事件）。
    record.lastFrame = null;
    this.emit();
  }

  /**
   * host 报告某会话进程意外退出。user 会话按池预算恢复；child / task 只记
   * crashed 并释放资源位，由各自所有者决定是否重试。
   */
  onCrash(sessionId: string, now: number): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.crashTimes = record.crashTimes.filter((t) => now - t < this.timing.crashWindowMs);
    record.crashTimes.push(now);
    record.listState = "failed";
    record.memoryMb = 0;
    record.pid = null;
    record.lastFrame = null;
    this.inbox = this.inbox.filter((i) => i.sessionId !== sessionId);
    if (record.origin !== "user") {
      // ChildAgentCore / scheduler own retry safety for their sessions. The pool
      // records the freed slot only; an approved retry returns via requestSession().
      record.runState = "crashed";
      record.queued = false;
      this.admitQueued();
      this.emit();
      return;
    }
    if (record.crashTimes.length > this.timing.crashBudget) {
      // 预算耗尽：不再自动重起。
      record.runState = "crashed";
      record.queued = false;
      this.admitQueued();
    } else {
      // 预算内：自动恢复（起一个新代际的 runtime）。
      this.launch(record);
    }
    this.emit();
  }

  // -------------------------------------------------------------- 事件路由

  /**
   * 路由一条 pi 事件信封到对应会话。**不串台的落点。**
   *
   * 每个会话有独立的 per (sessionId, generation) 序号闸门：陈旧或重复的信封
   * 被丢弃并计数，而两个会话交错到达的事件互不影响（它们键在不同的 sessionId
   * 上）。这里绝不能退化成一个全局单计数器——那样 B 会话一条序号较小的事件
   * 会被 A 会话刚更新的序号判成「倒退」而丢掉。
   */
  observeEnvelope(env: PiEnvelope<AgentEvent>): void {
    const record = this.sessions.get(env.sessionId);
    if (!record) return;
    if (!shouldAcceptEnvelope(record.lastFrame, env)) {
      this.droppedEnvelopes++;
      return;
    }
    record.lastFrame = { generation: env.generation, sequence: env.sequence };
    record.lastActivityAt = env.occurredAt;
    this.applyEvent(record, env.payload);
    this.emit();
  }

  /** 事件 → 列表任务态 / 未读。镜像 app store 的 reducer 语义，但只取粗粒度态。 */
  private applyEvent(record: SessionRecord, event: AgentEvent): void {
    const type = (event as { type?: string }).type ?? "";
    switch (type) {
      case "agent_start":
        record.listState = "running";
        break;
      case "agent_settled":
        if (record.listState !== "failed") record.listState = "done";
        break;
      case "message_end": {
        const msg = (event as { message?: { role?: string; stopReason?: string } }).message;
        if (msg?.role === "assistant" && msg.stopReason === "error") record.listState = "failed";
        break;
      }
      case "agent_end": {
        const willRetry = (event as { willRetry?: boolean }).willRetry;
        if (!willRetry && record.listState === "running") record.listState = "done";
        break;
      }
      default:
        break;
    }
    // 后台会话有新进展 = 未读（前台会话恒不置未读）。
    if (record.runState !== "focused") record.unread = true;
  }

  /** 会话累计成本上报（按会话记账，绝不混算到别的会话头上）。 */
  recordCost(sessionId: string, costUsd: number): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.costUsd = costUsd;
    this.emit();
  }

  /** 会话内存估算上报（用于内存上界与展示）。 */
  recordMemory(sessionId: string, memoryMb: number): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.memoryMb = Math.max(0, memoryMb);
    this.emit();
  }

  /**
   * 当前有进程在跑、且知道 pid 的会话（供接线层按拍采样 RSS）。
   *
   * 排队中的会话还没有进程；stopped / crashed 的 pid 已在 stopRecord 里清掉。
   */
  livePids(): Array<{ sessionId: string; pid: number }> {
    const out: Array<{ sessionId: string; pid: number }> = [];
    for (const r of this.sessions.values()) {
      if (r.pid === null || r.queued || !isLiveRunState(r.runState)) continue;
      out.push({ sessionId: r.sessionId, pid: r.pid });
    }
    return out;
  }

  /**
   * 一拍 RSS 采样的批量回填。
   *
   * 与逐条 `recordMemory` 的区别：只发一次快照，且回填后重跑一次准入——
   * 总内存跌回上界以下时，排队中的会话应当在这一拍就被放进来，而不是等
   * 下一个别的事件顺带触发。采样缺席的会话保留上一次的值（进程可能刚好
   * 在换代，给 0 会让上界短暂失守）。
   */
  recordMemoryBatch(samples: Iterable<{ sessionId: string; memoryMb: number }>): void {
    let changed = false;
    for (const { sessionId, memoryMb } of samples) {
      const record = this.sessions.get(sessionId);
      if (!record || record.pid === null) continue;
      const next = Math.max(0, Math.round(memoryMb));
      if (record.memoryMb === next) continue;
      record.memoryMb = next;
      changed = true;
    }
    if (!changed) return;
    this.admitQueued();
    this.emit();
  }

  /** 前台看过后清未读（供窗口聚焦但不换 focused 会话时调用）。 */
  markRead(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record || !record.unread) return;
    record.unread = false;
    this.emit();
  }

  // -------------------------------------------------------------- 权限 inbox

  /**
   * 把一条后台会话的权限请求排进统一 inbox。
   *
   * **绝不自动允许**：这里只登记待办 + 设一个超时 deadline，最终裁决走既有
   * `decidePermission`。到 deadline 仍无人响应，`tick` 会把它记为拒绝并移除。
   */
  /** 子 / task 以及非前台 user 会话的权限请求进统一 inbox，不弹前台框。 */
  isInboxCandidate(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    if (record.origin === "child" || record.origin === "task") return true;
    return record.runState !== "focused";
  }

  enqueuePermission(input: {
    id: string;
    sessionId: string;
    capabilityId: string;
    permission: string;
    resource?: string | null;
    now: number;
  }): void {
    if (
      this.inbox.some(
        (item) =>
          item.id === input.id ||
          (item.sessionId === input.sessionId &&
            item.capabilityId === input.capabilityId &&
            item.permission === input.permission &&
            item.resource === (input.resource ?? null))
      )
    ) {
      return;
    }
    const record = this.sessions.get(input.sessionId);
    const item: PoolInboxItem = {
      id: input.id,
      sessionId: input.sessionId,
      workspaceId: record?.workspaceId ?? null,
      capabilityId: input.capabilityId,
      permission: input.permission,
      resource: input.resource ?? null,
      requestedAt: input.now,
      deadlineAt: input.now + this.timing.permissionTimeoutMs,
    };
    this.inbox.push(item);
    if (record) record.listState = "waiting_permission";
    this.emit();
  }

  /**
   * 一条 inbox 待办被裁决（用户在授权中心作答后调用）。
   *
   * 池不做实际裁决（那是权限引擎的事），只把待办从 inbox 摘掉、把会话列表态
   * 从 waiting_permission 恢复。返回被摘掉的待办（供接线层交给权限引擎），
   * 找不到返回 null。
   */
  resolveInbox(id: string): PoolInboxItem | null {
    const idx = this.inbox.findIndex((i) => i.id === id);
    if (idx < 0) return null;
    const [item] = this.inbox.splice(idx, 1);
    const record = this.sessions.get(item.sessionId);
    if (record && record.listState === "waiting_permission") {
      record.listState = this.inbox.some((i) => i.sessionId === item.sessionId)
        ? "waiting_permission"
        : "running";
    }
    this.emit();
    return item;
  }

  /** 用户在权限中心 / inbox 作答后，摘掉被这条决策覆盖的待办。 */
  resolveMatchingInbox(match: {
    capabilityId: string;
    permission: string;
    resource?: string | null;
    workspaceId?: string | null;
    sessionId?: string | null;
  }): number {
    const resource = match.resource ?? null;
    const ids = this.inbox
      .filter((item) => {
        if (item.capabilityId !== match.capabilityId || item.permission !== match.permission) {
          return false;
        }
        if (resource !== null && item.resource !== resource) return false;
        if (
          match.workspaceId != null &&
          item.workspaceId != null &&
          item.workspaceId !== match.workspaceId
        ) {
          return false;
        }
        if (match.sessionId && item.sessionId !== match.sessionId) return false;
        return true;
      })
      .map((item) => item.id);
    for (const id of ids) this.resolveInbox(id);
    return ids.length;
  }

  // -------------------------------------------------------------- 周期性维护

  /**
   * 周期性维护：超时拒绝 + 空闲回收 + 准入排队会话。
   *
   * 返回本次因超时被拒绝的 inbox 待办（接线层据此调 `decidePermission(deny)` 与
   * 记审计）。**超时一律拒绝，绝不允许。**
   */
  tick(now: number): PoolInboxItem[] {
    const expired = this.expirePermissions(now);
    this.reclaimIdle(now);
    this.admitQueued();
    this.emit();
    return expired;
  }

  private expirePermissions(now: number): PoolInboxItem[] {
    if (this.inbox.length === 0) return [];
    const expired: PoolInboxItem[] = [];
    const kept: PoolInboxItem[] = [];
    for (const item of this.inbox) {
      if (now >= item.deadlineAt) expired.push(item);
      else kept.push(item);
    }
    if (expired.length === 0) return [];
    this.inbox = kept;
    for (const item of expired) {
      const record = this.sessions.get(item.sessionId);
      if (record && record.listState === "waiting_permission") {
        record.listState = kept.some((i) => i.sessionId === item.sessionId)
          ? "waiting_permission"
          : "running";
      }
    }
    return expired;
  }

  private reclaimIdle(now: number): void {
    for (const record of this.sessions.values()) {
      if (record.runState === "focused" || record.queued) continue;
      if (record.listState === "running" || record.listState === "waiting_permission") continue;
      const idle = now - record.lastActivityAt;
      if (record.runState === "background" && idle >= this.timing.idleToWarmMs) {
        record.runState = "warm";
      } else if (record.runState === "warm" && idle >= this.timing.warmToStoppedMs) {
        this.stopRecord(record, "stopped");
      }
    }
  }

  // -------------------------------------------------------------- 关闭

  /** 是否还有活跃会话——应用退出/更新时据此让用户选择（窗口关闭不算）。 */
  hasLiveSessions(): boolean {
    return this.liveCount() > 0;
  }

  /** 应用真正退出时停掉全部会话。 */
  shutdownAll(): void {
    for (const record of this.sessions.values()) {
      if (isLiveRunState(record.runState)) this.host.stop(record.sessionId);
      record.runState = "stopped";
      record.queued = false;
      record.memoryMb = 0;
      record.pid = null;
      record.lastFrame = null;
    }
    this.inbox = [];
    this.focusedId = null;
    this.emit();
  }

  // -------------------------------------------------------------- 上界

  setCaps(caps: PoolCaps): void {
    this.caps = { ...caps };
    this.admitQueued();
    this.emit();
  }

  getCaps(): PoolCaps {
    return { ...this.caps };
  }

  // -------------------------------------------------------------- 快照

  snapshot(): PoolSnapshot {
    const sessions: PoolSessionView[] = [...this.sessions.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({
        sessionId: r.sessionId,
        workspaceId: r.workspaceId,
        runtimeId: r.runtimeId,
        generation: r.generation,
        runState: r.runState,
        listState: r.listState,
        unread: r.unread,
        memoryMb: r.memoryMb,
        costUsd: r.costUsd,
        crashCount: r.crashTimes.length,
        lastActivityAt: r.lastActivityAt,
        queued: r.queued,
      }));
    return {
      sequence: this.snapshotSequence,
      caps: { ...this.caps },
      sessions,
      activeCount: this.liveCount(),
      queuedCount: sessions.filter((s) => s.queued).length,
      totalMemoryMb: this.totalMemoryMb(),
      totalCostUsd: this.totalCostUsd(),
      inbox: [...this.inbox],
    };
  }

  /** 快照信封：复用 PiEnvelope，sequence 单调、generation 固定（池不换代）。 */
  snapshotEnvelope(): PiEnvelope<PoolSnapshot> {
    const snap = this.snapshot();
    return wrapEnvelope(
      {
        workspaceId: POOL_ENVELOPE_ID,
        sessionId: POOL_ENVELOPE_ID,
        runtimeId: POOL_ENVELOPE_ID,
        generation: POOL_ENVELOPE_GENERATION,
      },
      snap.sequence,
      snap
    );
  }

  private emit(): void {
    this.snapshotSequence++;
    if (this.onChange) this.onChange(this.snapshot());
  }
}
