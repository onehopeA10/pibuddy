/**
 * 可视化工作流的**纯**执行内核（common.workflow）。
 *
 * ## 为什么是纯的（不 import electron / 不碰 pi 进程）
 *
 * 这个文件里没有一行 `ipcMain` / `BrowserWindow` / `PiRpcClient`。真正触发一次
 * pi run 的活儿由注入的 `WorkflowAgentHost` 承担（接线在 `workflow-ipc.ts`，
 * 那里复用后台会话池）。理由与 `pool-core.ts`、`capability-registry.ts` 一致：
 * 「DAG 按依赖顺序执行」「循环依赖被检测」「条件分支路由」「节点间传数据」这
 * 四件事**只有单测查得住**，而需要给 electron / pi 打桩才能跑的判据最后都会
 * 变成没人跑的判据。把决策与副作用分开，DAG 语义就能在一个纯函数环境里被真正
 * 制造出来并证伪。
 *
 * ## 它管什么、不管什么
 *
 * 管：拓扑排序与成环检测、节点按依赖顺序执行、上游产出注入下游输入、条件分支
 * 把执行路由到 true / false 边、失败 / 跳过沿出边传播、停止后剩余节点跳过、
 * 单调快照序号。
 *
 * 不管：怎么触发一次 pi run（`WorkflowAgentHost.runAgent`）、定义 / 运行历史
 * 怎么落盘（`workflow-store.ts`）、快照怎么推到窗口（`onChange`）。
 */
import type {
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunNode,
  WorkflowRunSnapshot,
} from "@pibuddy/contract";

// ---------------------------------------------------------------- host 接缝

/** 一个 Agent 节点触发一次 pi run 的请求。 */
export interface WorkflowAgentRequest {
  runId: string;
  nodeId: string;
  workspaceId: string | null;
  /** 已把 `{{input}}` 替换为上游产出之后的最终提示词。 */
  prompt: string;
  /** 上游注入的原始输入（供 host 记账 / 展示）。 */
  input: string;
}

/** 一次 Agent 节点执行的结果。 */
export interface WorkflowAgentResult {
  ok: boolean;
  /** 本节点产出（向下游传递）。 */
  output: string;
  error?: string | null;
}

/**
 * 触发一次 pi run 的唯一接缝。
 *
 * 内核只决策「该跑哪个 Agent 节点、给它什么提示词」，具体怎么起 pi 进程（复用
 * 后台会话池的 `requestSession` + 后台 runtime host）由实现方在 `workflow-ipc.ts`
 * 里落地。本能力**不重造触发机制**——与 child Agent 编排复用同一套。
 */
export interface WorkflowAgentHost {
  runAgent(req: WorkflowAgentRequest): Promise<WorkflowAgentResult>;
  /** 停止某次运行相关的进行中 Agent（可选）。 */
  cancelRun?(runId: string): void;
}

// ---------------------------------------------------------------- 拓扑

export type WorkflowPlan =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly cycle: readonly string[] };

/**
 * 拓扑排序（Kahn）。有环时返回环上的节点，**不静默降级**。
 *
 * 成环检测是本内核最要命的一条判据：一张成环的图若被当成可执行的图跑，表现是
 * 某些节点永远等不到它的依赖、运行悬在半空——那正是「静默降级」的典型形态。
 * 因此这里显式把「排不出完整顺序」翻译成一个可读的环，交给运行层置为 failed。
 */
export function planWorkflow(def: WorkflowDefinition): WorkflowPlan {
  const ids = new Set(def.nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of def.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of def.edges) {
    // 指向 / 来自不存在节点的边不参与拓扑（渲染层允许悬空边短暂存在）。
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  // 入度 0 的节点按定义顺序入队，保证同层节点的执行顺序是稳定可断言的。
  const queue = def.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (order.length === def.nodes.length) {
    return { ok: true, order };
  }
  // 排不进顺序的节点即处于 / 依赖于某个环。
  const cycle = def.nodes.map((n) => n.id).filter((id) => !order.includes(id));
  return { ok: false, cycle };
}

/** 条件判定（纯，无副作用）。 */
export function evaluateCondition(cond: WorkflowCondition, input: string): boolean {
  switch (cond.mode) {
    case "contains":
      return input.includes(cond.value);
    case "equals":
      return input === cond.value;
    case "non-empty":
      return input.trim().length > 0;
    default:
      return false;
  }
}

/** 把上游产出注入提示词模板：替换 `{{input}}`；模板不含占位符时以输入兜底。 */
export function renderAgentPrompt(template: string, input: string): string {
  if (template.includes("{{input}}")) {
    return template.split("{{input}}").join(input);
  }
  if (template.trim().length === 0) return input;
  return input.length > 0 ? `${template}\n\n${input}` : template;
}

// ---------------------------------------------------------------- 运行内核

interface InternalRun {
  run: WorkflowRun;
  def: WorkflowDefinition;
  /** 已被主动停止。 */
  stopped: boolean;
  /** nodeId → 产出（供下游取用）。 */
  outputs: Map<string, string>;
  /** edgeId → 是否活（沿它传播执行）。 */
  edgeLive: Map<string, boolean>;
}

export interface WorkflowRunnerOptions {
  host: WorkflowAgentHost;
  /** 每次状态变更后回调（用于把快照推到窗口 / 落盘）。 */
  onChange?: (snapshot: WorkflowRunSnapshot) => void;
  /** 运行进入终态时回调（用于把历史落盘）。 */
  onSettled?: (run: WorkflowRun) => void;
  now?: () => number;
  /** 内存里保留的运行数上界（活跃 + 历史）。 */
  maxRuns?: number;
  /** Agent 节点硬超时；host 自身失灵时内核仍必须结算。 */
  agentTimeoutMs?: number;
}

/** 运行进入终态即不再有后续转移。 */
export function isTerminalRunState(state: WorkflowRun["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "stopped";
}

export class WorkflowRunner {
  private readonly host: WorkflowAgentHost;
  private readonly onChange: ((snapshot: WorkflowRunSnapshot) => void) | null;
  private readonly onSettled: ((run: WorkflowRun) => void) | null;
  private readonly now: () => number;
  private readonly maxRuns: number;
  private readonly agentTimeoutMs: number;
  private readonly stopWaiters = new Map<string, Set<() => void>>();

  /** 全部运行，按插入顺序（活跃 + 近期历史）。 */
  private runs: InternalRun[] = [];
  private snapshotSequence = 0;
  private runSeq = 0;

  constructor(options: WorkflowRunnerOptions) {
    this.host = options.host;
    this.onChange = options.onChange ?? null;
    this.onSettled = options.onSettled ?? null;
    this.now = options.now ?? (() => Date.now());
    this.maxRuns = options.maxRuns ?? 50;
    this.agentTimeoutMs = options.agentTimeoutMs ?? 5 * 60_000;
  }

  /**
   * 用一份已落盘的历史给内核播种（启动装配期调用）。
   *
   * 历史运行一律是终态，直接作为只读记录进内存，不重新执行。
   */
  seedRuns(runs: readonly WorkflowRun[]): void {
    for (const run of runs) {
      this.runs.push({
        run: { ...run },
        def: { id: run.definitionId, name: run.definitionName, schemaVersion: 1, nodes: [], edges: [], createdAt: 0, updatedAt: 0 },
        stopped: run.state === "stopped",
        outputs: new Map(),
        edgeLive: new Map(),
      });
    }
    this.trim();
  }

  /**
   * 开始一次运行。**同步返回**初始运行（DAG 执行走一个不阻塞的异步尾巴）。
   *
   * 立即返回是为了让调用方拿到 runId 并推第一帧快照；真正的逐节点执行在
   * 微任务里推进，每完成一个节点推一次快照。
   */
  start(def: WorkflowDefinition, workspaceId: string | null): WorkflowRun {
    const runId = `wfr-${this.runSeq++}-${this.now().toString(36)}`;
    const nodes: WorkflowRunNode[] = def.nodes.map((n) => ({
      nodeId: n.id,
      state: "pending",
      output: "",
      error: null,
      startedAt: 0,
      endedAt: 0,
    }));
    const run: WorkflowRun = {
      id: runId,
      definitionId: def.id,
      definitionName: def.name,
      workspaceId,
      state: "running",
      nodes,
      error: null,
      startedAt: this.now(),
      endedAt: 0,
      sequence: 0,
    };
    const internal: InternalRun = {
      run,
      def,
      stopped: false,
      outputs: new Map(),
      edgeLive: new Map(),
    };
    this.runs.push(internal);
    this.trim();
    this.emit(internal);
    void this.execute(internal);
    return { ...run, nodes: run.nodes.map((n) => ({ ...n })) };
  }

  /** 停止一次运行：置停止标志，尚未开始的节点将被跳过。 */
  stop(runId: string): void {
    const internal = this.runs.find((r) => r.run.id === runId);
    if (!internal) return;
    if (isTerminalRunState(internal.run.state)) return;
    internal.stopped = true;
    this.host.cancelRun?.(runId);
    for (const resolve of this.stopWaiters.get(runId) ?? []) resolve();
  }

  activeRuns(): WorkflowRun[] {
    return this.runs
      .filter((r) => !isTerminalRunState(r.run.state))
      .map((r) => this.viewOf(r));
  }

  snapshot(): WorkflowRunSnapshot {
    return {
      sequence: this.snapshotSequence,
      runs: this.runs.map((r) => this.viewOf(r)),
    };
  }

  /** 仅供单测：清空内核。 */
  reset(): void {
    this.runs = [];
    this.snapshotSequence = 0;
    this.runSeq = 0;
  }

  // -------------------------------------------------------------- 执行

  private async execute(internal: InternalRun): Promise<void> {
    const { def, run } = internal;
    const plan = planWorkflow(def);
    if (!plan.ok) {
      run.state = "failed";
      run.error = `工作流成环，无法执行：${plan.cycle.join(" → ")} → ${plan.cycle[0]}`;
      run.endedAt = this.now();
      this.emit(internal);
      this.settle(internal);
      return;
    }

    const nodeById = new Map(def.nodes.map((n) => [n.id, n] as const));
    const incoming = new Map<string, typeof def.edges>();
    const outgoing = new Map<string, typeof def.edges>();
    for (const node of def.nodes) {
      incoming.set(node.id, []);
      outgoing.set(node.id, []);
    }
    for (const edge of def.edges) {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
      incoming.get(edge.target)!.push(edge);
      outgoing.get(edge.source)!.push(edge);
    }

    for (const nodeId of plan.order) {
      const node = nodeById.get(nodeId)!;
      const runNode = run.nodes.find((n) => n.nodeId === nodeId)!;
      const inEdges = incoming.get(nodeId) ?? [];
      const outEdges = outgoing.get(nodeId) ?? [];

      // 停止后：尚未开始的节点一律跳过（其出边失活，继续沿链传播跳过）。
      if (internal.stopped) {
        runNode.state = "skipped";
        for (const e of outEdges) internal.edgeLive.set(e.id, false);
        this.emit(internal);
        continue;
      }

      // 有入边但没有一条活 → 本节点被跳过（条件未命中 / 上游失败传播到此）。
      const liveIn = inEdges.filter((e) => internal.edgeLive.get(e.id) === true);
      if (inEdges.length > 0 && liveIn.length === 0) {
        runNode.state = "skipped";
        for (const e of outEdges) internal.edgeLive.set(e.id, false);
        this.emit(internal);
        continue;
      }

      // 输入 = 全部活入边的源节点产出，按边顺序拼接（节点间传数据的落点）。
      const input = liveIn
        .map((e) => internal.outputs.get(e.source) ?? "")
        .filter((s) => s.length > 0)
        .join("\n");

      runNode.state = "running";
      runNode.startedAt = this.now();
      this.emit(internal);

      let output = "";
      let failed = false;
      let error: string | null = null;

      switch (node.kind) {
        case "start":
        case "end":
        case "output":
          output = input;
          break;
        case "input":
          output = node.value;
          break;
        case "condition": {
          output = input;
          const branch = evaluateCondition(node.condition, input);
          // 条件节点的出边按 handle 定活：命中分支的边活，另一分支失活；
          // 无 handle 的边（无分支连线）视为无条件活。
          for (const e of outEdges) {
            const live =
              e.sourceHandle === null ? true : e.sourceHandle === (branch ? "true" : "false");
            internal.edgeLive.set(e.id, live);
          }
          runNode.state = "succeeded";
          runNode.output = output;
          runNode.endedAt = this.now();
          internal.outputs.set(nodeId, output);
          this.emit(internal);
          continue;
        }
        case "agent": {
          try {
            const request = {
              runId: run.id,
              nodeId,
              workspaceId: run.workspaceId,
              prompt: renderAgentPrompt(node.prompt, input),
              input,
            };
            const result = await this.runAgentBounded(request);
            output = result.output;
            failed = !result.ok;
            error = result.error ?? (result.ok ? null : "Agent 节点执行失败");
          } catch (err) {
            failed = true;
            error = err instanceof Error ? err.message : String(err);
          }
          // 执行期间被停止：本节点结果作废，运行按停止收口。
          if (internal.stopped) {
            runNode.state = "skipped";
            runNode.endedAt = this.now();
            for (const e of outEdges) internal.edgeLive.set(e.id, false);
            this.emit(internal);
            continue;
          }
          break;
        }
        default:
          break;
      }

      runNode.endedAt = this.now();
      if (failed) {
        runNode.state = "failed";
        runNode.error = error;
        // 失败节点的出边全部失活 → 下游跳过（独立分支不受影响）。
        for (const e of outEdges) internal.edgeLive.set(e.id, false);
      } else {
        runNode.state = "succeeded";
        runNode.output = output;
        internal.outputs.set(nodeId, output);
        for (const e of outEdges) internal.edgeLive.set(e.id, true);
      }
      this.emit(internal);
    }

    // 收口：被停止 → stopped；有失败节点 → failed；否则 succeeded。
    run.endedAt = this.now();
    if (internal.stopped) {
      run.state = "stopped";
    } else if (run.nodes.some((n) => n.state === "failed")) {
      run.state = "failed";
      run.error = run.error ?? "至少一个节点执行失败";
    } else {
      run.state = "succeeded";
    }
    this.emit(internal);
    this.settle(internal);
  }

  // -------------------------------------------------------------- 快照 / 落盘

  private async runAgentBounded(request: WorkflowAgentRequest): Promise<WorkflowAgentResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopResolver: (() => void) | null = null;
    const stopped = new Promise<WorkflowAgentResult>((resolve) => {
      stopResolver = () => resolve({ ok: false, output: "", error: "Agent 节点已停止" });
      const waiters = this.stopWaiters.get(request.runId) ?? new Set<() => void>();
      waiters.add(stopResolver);
      this.stopWaiters.set(request.runId, waiters);
    });
    const timedOut = new Promise<WorkflowAgentResult>((resolve) => {
      timer = setTimeout(() => {
        this.host.cancelRun?.(request.runId);
        resolve({ ok: false, output: "", error: "Agent 节点执行超时" });
      }, this.agentTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.host.runAgent(request), stopped, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      const waiters = this.stopWaiters.get(request.runId);
      if (stopResolver) waiters?.delete(stopResolver);
      if (waiters?.size === 0) this.stopWaiters.delete(request.runId);
    }
  }

  private viewOf(internal: InternalRun): WorkflowRun {
    return {
      ...internal.run,
      nodes: internal.run.nodes.map((n) => ({ ...n })),
    };
  }

  private emit(internal: InternalRun): void {
    this.snapshotSequence++;
    internal.run.sequence = this.snapshotSequence;
    if (this.onChange) this.onChange(this.snapshot());
  }

  private settle(internal: InternalRun): void {
    if (this.onSettled) this.onSettled(this.viewOf(internal));
  }

  /** 超过上界时丢弃最老的已终态运行（活跃运行永不丢）。 */
  private trim(): void {
    while (this.runs.length > this.maxRuns) {
      const idx = this.runs.findIndex((r) => isTerminalRunState(r.run.state));
      if (idx < 0) break;
      this.runs.splice(idx, 1);
    }
  }
}
