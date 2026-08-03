/**
 * child Agent 编排的**纯**内核状态机（AGT-102）。
 *
 * ## 为什么是纯的（不 import electron / 不碰进程 / 不 import pi 域）
 *
 * 与 `agent-pool/pool-core.ts`、`permission/permission-engine.ts` 同一理由：
 * cancel 向子树传播、非幂等任务断线不自动重放、超时收口、Provider 限流协调、
 * 有限重试——这五件事**只有单测查得住**，而它们恰恰是「制造一个父子拓扑 +
 * 一次断线时序」才能证伪的行为。把决策与副作用分开（真正起停子进程、发提示词
 * 由注入的 `ChildHost` 承担，接线在 `child-orchestrator.ts`），父子并发编排就能
 * 在一个纯函数环境里被真正制造出来，而不是靠断言「某函数被调用过」。
 *
 * ## 它管什么、不管什么
 *
 * 管：父子拓扑、每个子节点的编排状态、结构化消息（progress/question/evidence/
 * result）的落点、cancel 向整棵子树传播、超时、有限重试、Provider 限流协调
 * （按 provider 的在飞闸）、结果收敛、**非幂等任务断线不自动重放**、worktree
 * 合并裁决的门。
 *
 * 不管：怎么起子进程（`ChildHost.launch`，接线层走后台池的 origin:"child" 派生）、
 * 权限最终怎么裁决（既有 permission engine）、拓扑快照怎么推到窗口（`onChange`）。
 */
import {
  childMessageSchema,
  isTerminalChildStatus,
  type ChildEvidence,
  type ChildMessage,
  type ChildModel,
  type ChildNodeView,
  type ChildProgress,
  type ChildQuestion,
  type ChildResult,
  type ChildSpec,
  type ChildStatus,
  type ChildTopologySnapshot,
} from "@pibuddy/contract";

// ---------------------------------------------------------------- host 接缝

/** 一次子 Agent 启动请求（host 据此经后台池真正派生 runtime 并发出目标提示词）。 */
export interface ChildLaunchRequest {
  nodeId: string;
  parentId: string | null;
  workspaceId: string | null;
  model: ChildModel | null;
  goal: string;
  input: string;
  inheritPermissions: boolean;
  isolatedWorktree: boolean;
}

/**
 * 启停子 Agent 进程 / 发提示词的唯一接缝。
 *
 * 核心只决策「该起 / 该停 / 该重发哪个子」，具体怎么起（走后台池的
 * `requestSession(origin:"child")` + 真实进程派生、分配 worktree、发目标提示词）
 * 由实现方在 `child-orchestrator.ts` 里落地。方法**必须同步返回**：核心在调用
 * 之后立即更新自身状态，任何 await 都会在「已登记待起 / 尚未起」之间留一个查
 * 不到也清不掉的窗口（与池 host 同一约束）。
 */
export interface ChildHost {
  launch(req: ChildLaunchRequest): void;
  stop(nodeId: string): void;
  /** 把一条父的回答 / 续发提示词转给子（结构化，不经自然语言拼接）。 */
  deliver(nodeId: string, text: string): void;
}

// ---------------------------------------------------------------- 内部记录

interface NodeRecord {
  nodeId: string;
  parentId: string | null;
  childIds: string[];
  spec: ChildSpec;
  provider: string;
  status: ChildStatus;
  costUsd: number;
  createdAt: number;
  lastActivityAt: number;
  deadlineAt: number;
  blockedReason: string | null;
  retryCount: number;
  evidence: ChildEvidence[];
  question: ChildQuestion | null;
  progress: ChildProgress | null;
  result: ChildResult | null;
  pendingMerge: { patchTitle: string; hasConflict: boolean } | null;
  /** 是否已经让 host 起过进程（用于取消时判断要不要 stop）。 */
  launched: boolean;
}

export interface ChildCoreOptions {
  host: ChildHost;
  onChange?: (snapshot: ChildTopologySnapshot) => void;
  /** 每个 provider 允许的最大在飞（running）子 Agent 数（限流协调闸）。 */
  providerConcurrencyCap?: number;
  /** 未指定模型时归属的默认 provider（用于限流分桶）。 */
  defaultProvider?: string;
  /** id 工厂（可注入，便于单测确定性）。 */
  idFactory?: () => string;
}

// ---------------------------------------------------------------- 核心

export class ChildAgentCore {
  private readonly host: ChildHost;
  private readonly onChange: ((snapshot: ChildTopologySnapshot) => void) | null;
  private readonly providerCap: number;
  private readonly defaultProvider: string;
  private readonly idFactory: () => string;

  private nodes = new Map<string, NodeRecord>();
  private snapshotSequence = 0;
  private nodeSeq = 0;

  constructor(options: ChildCoreOptions) {
    this.host = options.host;
    this.onChange = options.onChange ?? null;
    this.providerCap = options.providerConcurrencyCap ?? 3;
    this.defaultProvider = options.defaultProvider ?? "default";
    this.idFactory = options.idFactory ?? (() => `child_${++this.nodeSeq}`);
  }

  // -------------------------------------------------------------- 创建

  /**
   * 父创建一个子 Agent。
   *
   * **重复任务检测**（supervisor 职责之一）：同一父下、目标相同、且尚未进入终态
   * 的子 Agent 已存在时，直接返回既有节点、**不重复派生**——否则一次「重试」点击
   * 会变成两个抢同一目标的子进程。
   */
  createChild(
    parentId: string | null,
    spec: ChildSpec,
    now: number
  ): { nodeId: string; duplicate: boolean } {
    if (parentId !== null && !this.nodes.has(parentId)) {
      throw new Error(`CHILD_PARENT_UNKNOWN: ${parentId}`);
    }
    const dup = this.findDuplicate(parentId, spec.goal);
    if (dup) return { nodeId: dup.nodeId, duplicate: true };

    // 工作区继承：子未指定则用父的工作区（顶层子无父则为 null）。落进 spec，
    // 后续 launch / 快照都读同一处，不再二次推断。
    const effectiveSpec: ChildSpec =
      spec.workspaceId === null && parentId !== null
        ? { ...spec, workspaceId: this.nodes.get(parentId)!.spec.workspaceId }
        : spec;
    const nodeId = this.idFactory();
    const record: NodeRecord = {
      nodeId,
      parentId,
      childIds: [],
      spec: effectiveSpec,
      provider: effectiveSpec.model?.provider ?? this.defaultProvider,
      status: "pending",
      costUsd: 0,
      createdAt: now,
      lastActivityAt: now,
      deadlineAt: spec.timeoutMs > 0 ? now + spec.timeoutMs : 0,
      blockedReason: null,
      retryCount: 0,
      evidence: [],
      question: null,
      progress: null,
      result: null,
      pendingMerge: null,
      launched: false,
    };
    this.nodes.set(nodeId, record);
    if (parentId) this.nodes.get(parentId)!.childIds.push(nodeId);
    this.admit(now);
    this.emit();
    return { nodeId, duplicate: false };
  }

  /** 同一父下、目标相同、非终态的既有子（重复任务检测）。 */
  private findDuplicate(parentId: string | null, goal: string): NodeRecord | null {
    for (const r of this.nodes.values()) {
      if (r.parentId === parentId && r.spec.goal === goal && !isTerminalChildStatus(r.status)) {
        return r;
      }
    }
    return null;
  }

  // -------------------------------------------------------------- 准入 / 限流

  /** provider 当前在飞（running）子 Agent 数。 */
  private inFlight(provider: string): number {
    let n = 0;
    for (const r of this.nodes.values()) if (r.provider === provider && r.status === "running") n++;
    return n;
  }

  /**
   * 尽量多地把 pending 子准入为 running（按创建顺序公平），受 Provider 限流闸约束。
   *
   * 少了 provider 在飞闸这半句，一批同 provider 的子 Agent 会同时起、同时打向
   * 同一个 Provider 的速率限制——这正是「Provider 限流协调」要挡的回归。
   */
  private admit(now: number): void {
    const pending = [...this.nodes.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt || a.nodeId.localeCompare(b.nodeId));
    for (const node of pending) {
      if (this.inFlight(node.provider) >= this.providerCap) continue;
      this.launchNode(node, now);
    }
  }

  private launchNode(node: NodeRecord, now: number): void {
    node.status = "running";
    node.lastActivityAt = now;
    node.launched = true;
    this.host.launch({
      nodeId: node.nodeId,
      parentId: node.parentId,
      workspaceId: node.spec.workspaceId,
      model: node.spec.model,
      goal: node.spec.goal,
      input: node.spec.input,
      inheritPermissions: node.spec.inheritPermissions,
      isolatedWorktree: node.spec.isolatedWorktree,
    });
  }

  // -------------------------------------------------------------- 结构化消息

  /**
   * 落一条子 Agent 的结构化消息。**这是「不靠解析自然语言日志」的落点。**
   *
   * `raw` 由接线层从子运行时的一次**结构化上报**（专用工具调用的类型化参数）
   * 解出，经 schema 校验后进来；核心只按 `type` 分派，绝不去匹配散文。校验
   * 失败直接丢弃（返回 false），不猜、不容错。
   */
  ingestMessage(nodeId: string, raw: unknown, now: number): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || isTerminalChildStatus(node.status)) return false;
    const parsed = childMessageSchema.safeParse(raw);
    if (!parsed.success) return false;
    this.applyMessage(node, parsed.data, now);
    node.lastActivityAt = now;
    this.admit(now);
    this.emit();
    return true;
  }

  private applyMessage(node: NodeRecord, message: ChildMessage, now: number): void {
    switch (message.type) {
      case "progress":
        node.progress = message.progress;
        if (node.status === "waiting_answer" || node.status === "blocked") {
          node.status = "running";
          node.blockedReason = null;
        }
        break;
      case "question":
        node.question = message.question;
        // 提问 = 暂停等待父作答，让出 Provider 在飞位（限流协调）。
        node.status = "waiting_answer";
        break;
      case "evidence":
        node.evidence.push(message.evidence);
        break;
      case "result":
        this.settleResult(node, message.result, now);
        break;
    }
  }

  private settleResult(node: NodeRecord, result: ChildResult, now: number): void {
    node.result = result;
    node.question = null;
    if (result.ok && node.spec.isolatedWorktree) {
      // coding 子的 worktree 改动：合并前要父裁决（展示 diff/测试/冲突），
      // 因此不直接 succeeded，而是 blocked 等 resolveMerge。
      node.status = "blocked";
      node.blockedReason = "等待父裁决合并";
      node.pendingMerge = {
        patchTitle: node.evidence.find((e) => e.kind === "patch")?.title ?? node.spec.goal,
        hasConflict: false,
      };
      this.host.stop(node.nodeId);
      return;
    }
    if (result.ok) {
      node.status = "succeeded";
      this.host.stop(node.nodeId);
      return;
    }
    // 失败：仅在幂等且预算内自动重试（有限重试）。
    if (node.spec.idempotent && node.retryCount < node.spec.retryBudget) {
      node.retryCount++;
      node.result = null;
      node.status = "pending";
      this.host.stop(node.nodeId);
      node.launched = false;
      return;
    }
    node.status = "failed";
    this.host.stop(node.nodeId);
  }

  // -------------------------------------------------------------- 父回答

  /** 父回答子的一条提问。清空提问、恢复运行、把回答经 host 转给子。 */
  answer(nodeId: string, questionId: string, answer: string, now: number): void {
    const node = this.nodes.get(nodeId);
    if (!node || node.status !== "waiting_answer") return;
    if (!node.question || node.question.id !== questionId) return;
    node.question = null;
    node.status = "running";
    node.lastActivityAt = now;
    this.host.deliver(nodeId, answer);
    this.emit();
  }

  // -------------------------------------------------------------- 合并裁决

  /** 父对子 worktree 改动的合并裁决（accept → succeeded；reject → failed）。 */
  resolveMerge(nodeId: string, accept: boolean, now: number): void {
    const node = this.nodes.get(nodeId);
    if (!node || !node.pendingMerge) return;
    node.pendingMerge = null;
    node.blockedReason = null;
    node.lastActivityAt = now;
    node.status = accept ? "succeeded" : "failed";
    this.emit();
  }

  // -------------------------------------------------------------- 运行时回调

  /** host 报告某子 runtime 就绪（拿到进程）。此处只记活动时间。 */
  onRuntimeReady(nodeId: string, now: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.lastActivityAt = now;
    this.emit();
  }

  /** 会话成本上报（按节点记账，超预算即收口）。 */
  recordCost(nodeId: string, costUsd: number, now: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.costUsd = costUsd;
    node.lastActivityAt = now;
    if (
      node.spec.budgetUsd > 0 &&
      costUsd >= node.spec.budgetUsd &&
      !isTerminalChildStatus(node.status)
    ) {
      node.status = "failed";
      node.blockedReason = "超出成本预算";
      if (node.launched) this.host.stop(node.nodeId);
      this.admit(now);
    }
    this.emit();
  }

  /**
   * host 报告某子 runtime 退出。
   *
   * **非幂等任务不因断线自动重放**：reason 为崩溃/断线时，只有 idempotent 且
   * 重试预算未耗尽的子才会被自动重起；非幂等子一律置 blocked，等人工确认重试。
   * 这是本模块最关键的可证伪行为，绝不能退化成「一律重起」。
   */
  onRuntimeExit(nodeId: string, reason: string, now: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    // 已收敛 / 已被取消 / 正等合并的节点，退出是预期内的，不触发重放。
    if (isTerminalChildStatus(node.status)) return;
    if (node.status === "blocked" || node.status === "waiting_answer") return;
    if (reason === "expected-stop") return;

    node.lastActivityAt = now;
    if (node.spec.idempotent && node.retryCount < node.spec.retryBudget) {
      // 幂等 + 预算内：自动重放（起一个新 runtime）。
      node.retryCount++;
      node.status = "pending";
      node.launched = false;
      node.blockedReason = null;
      this.admit(now);
      this.emit();
      return;
    }
    if (node.spec.idempotent) {
      // 幂等但预算耗尽。
      node.status = "failed";
      node.blockedReason = "重试预算耗尽";
    } else {
      // 非幂等：**不自动重放**，置 blocked 等人工确认。
      node.status = "blocked";
      node.blockedReason = "非幂等任务在运行中断线，不自动重放，需人工确认重试";
    }
    this.admit(now);
    this.emit();
  }

  // -------------------------------------------------------------- 取消传播

  /**
   * 取消一个节点，**向它的整棵子树传播**。
   *
   * 后序遍历：先取消最深的后代再取消自己，保证任何子进程被停时它的父还知道
   * 它存在（拓扑不会在中途缺一环）。返回被真正停掉进程的节点 id 列表（供接线
   * 层核对 / 记账）。取消是用户显式手势，凌驾于「非幂等不重放」之上——它本就
   * 不是自动重放。
   */
  cancel(nodeId: string, now: number): string[] {
    const node = this.nodes.get(nodeId);
    if (!node) return [];
    const order: string[] = [];
    this.collectPostOrder(nodeId, order);
    const stopped: string[] = [];
    for (const id of order) {
      const n = this.nodes.get(id);
      if (!n || isTerminalChildStatus(n.status)) continue;
      if (n.launched) {
        this.host.stop(id);
        stopped.push(id);
      }
      n.status = "cancelled";
      n.question = null;
      n.pendingMerge = null;
      n.blockedReason = null;
    }
    this.admit(now);
    this.emit();
    return stopped;
  }

  private collectPostOrder(nodeId: string, out: string[]): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    for (const child of node.childIds) this.collectPostOrder(child, out);
    out.push(nodeId);
  }

  // -------------------------------------------------------------- 周期性维护

  /**
   * 超时收口。返回本次因超时被收口的节点 id（接线层据此记审计）。
   *
   * 超过 deadline 的非终态节点置 timed_out 并取消其子树——一个跑飞的子 Agent
   * 不该无限占着进程与预算。
   */
  tick(now: number): string[] {
    const expired: string[] = [];
    for (const node of [...this.nodes.values()]) {
      if (isTerminalChildStatus(node.status)) continue;
      if (node.deadlineAt <= 0 || now < node.deadlineAt) continue;
      expired.push(node.nodeId);
      // 取消子树，再把自己从 cancelled 覆写为 timed_out（区分「用户取消」与「超时」）。
      this.cancel(node.nodeId, now);
      const self = this.nodes.get(node.nodeId);
      if (self) self.status = "timed_out";
    }
    if (expired.length > 0) this.emit();
    return expired;
  }

  // -------------------------------------------------------------- 快照

  private viewOf(r: NodeRecord): ChildNodeView {
    return {
      nodeId: r.nodeId,
      parentId: r.parentId,
      goal: r.spec.goal,
      workspaceId: r.spec.workspaceId,
      model: r.spec.model,
      status: r.status,
      costUsd: r.costUsd,
      budgetUsd: r.spec.budgetUsd,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
      deadlineAt: r.deadlineAt,
      blockedReason: r.blockedReason,
      retryCount: r.retryCount,
      retryBudget: r.spec.retryBudget,
      idempotent: r.spec.idempotent,
      inheritPermissions: r.spec.inheritPermissions,
      isolatedWorktree: r.spec.isolatedWorktree,
      deliverables: [...r.spec.deliverables],
      evidence: [...r.evidence],
      question: r.question,
      progress: r.progress,
      result: r.result,
      pendingMerge: r.pendingMerge,
    };
  }

  snapshot(): ChildTopologySnapshot {
    const nodes = [...this.nodes.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.nodeId.localeCompare(b.nodeId))
      .map((r) => this.viewOf(r));
    const providerInFlight: Record<string, number> = {};
    for (const r of this.nodes.values()) {
      if (r.status === "running") {
        providerInFlight[r.provider] = (providerInFlight[r.provider] ?? 0) + 1;
      }
    }
    return {
      sequence: this.snapshotSequence,
      nodes,
      providerInFlight,
      providerConcurrencyCap: this.providerCap,
    };
  }

  /** 当前快照序号（供接线层包信封）。 */
  currentSequence(): number {
    return this.snapshotSequence;
  }

  private emit(): void {
    this.snapshotSequence++;
    if (this.onChange) this.onChange(this.snapshot());
  }
}
