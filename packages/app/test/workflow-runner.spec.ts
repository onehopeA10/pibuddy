import { describe, expect, it } from "vitest";

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowRun } from "@pibuddy/contract";
import {
  planWorkflow,
  evaluateCondition,
  renderAgentPrompt,
  WorkflowRunner,
  type WorkflowAgentHost,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../src/main/workflow/workflow-runner.js";

/**
 * 可视化工作流内核的可证伪测试（common.workflow）。
 *
 * 本项目铁律：DAG 判据必须**真的制造那个图**，不能只断言 `nodes.length==N`。
 * 因此「按依赖顺序执行」交错投喂一个真实的菱形图并记录 host 的调用顺序；
 * 「循环依赖被检测」真的构造一个环、断言运行被置 failed 并报出环。
 *
 * 对拍（临时拆掉机制确认变红）两次输出记在
 * `.workflow/scratch/capability-research/FEAT-workflow.md`。
 */

let idSeq = 0;
function def(nodes: WorkflowNode[], edges: WorkflowEdge[], name = "t"): WorkflowDefinition {
  return {
    id: `d-${idSeq++}`,
    name,
    schemaVersion: 1,
    nodes,
    edges,
    createdAt: 0,
    updatedAt: 0,
  };
}
function agent(id: string, prompt = ""): WorkflowNode {
  return { kind: "agent", id, title: "", position: { x: 0, y: 0 }, prompt };
}
function input(id: string, value: string): WorkflowNode {
  return { kind: "input", id, title: "", position: { x: 0, y: 0 }, value };
}
function output(id: string): WorkflowNode {
  return { kind: "output", id, title: "", position: { x: 0, y: 0 } };
}
function cond(id: string, mode: "contains" | "equals" | "non-empty", value = ""): WorkflowNode {
  return { kind: "condition", id, title: "", position: { x: 0, y: 0 }, condition: { mode, value } };
}
function edge(source: string, target: string, sourceHandle: "true" | "false" | null = null): WorkflowEdge {
  return { id: `${source}->${target}:${sourceHandle ?? ""}`, source, target, sourceHandle };
}

/** 记录 host 调用顺序 + 可配置产出的假 host。 */
function recordingHost(
  fn: (req: WorkflowAgentRequest) => WorkflowAgentResult = () => ({ ok: true, output: "" })
): { host: WorkflowAgentHost; order: string[]; inputs: Map<string, string> } {
  const order: string[] = [];
  const inputs = new Map<string, string>();
  const host: WorkflowAgentHost = {
    async runAgent(req) {
      order.push(req.nodeId);
      inputs.set(req.nodeId, req.input);
      return fn(req);
    },
  };
  return { host, order, inputs };
}

/** 跑到终态，返回最终运行。 */
function runToCompletion(
  definition: WorkflowDefinition,
  host: WorkflowAgentHost,
  workspaceId: string | null = "ws"
): Promise<WorkflowRun> {
  return new Promise((resolve) => {
    const runner = new WorkflowRunner({ host, onSettled: (run) => resolve(run) });
    runner.start(definition, workspaceId);
  });
}

describe("planWorkflow：拓扑排序与成环检测", () => {
  it("线性链 A→B→C 排出 [A,B,C]", () => {
    const plan = planWorkflow(def([agent("A"), agent("B"), agent("C")], [edge("A", "B"), edge("B", "C")]));
    expect(plan).toEqual({ ok: true, order: ["A", "B", "C"] });
  });

  it("成环 A→B→A 被检测出来，报出环上节点", () => {
    const plan = planWorkflow(def([agent("A"), agent("B")], [edge("A", "B"), edge("B", "A")]));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect([...plan.cycle].sort()).toEqual(["A", "B"]);
  });

  it("自环也是环", () => {
    const plan = planWorkflow(def([agent("A")], [edge("A", "A")]));
    expect(plan.ok).toBe(false);
  });
});

describe("evaluateCondition / renderAgentPrompt", () => {
  it("三种判定模式", () => {
    expect(evaluateCondition({ mode: "non-empty", value: "" }, "x")).toBe(true);
    expect(evaluateCondition({ mode: "non-empty", value: "" }, "  ")).toBe(false);
    expect(evaluateCondition({ mode: "contains", value: "ab" }, "xabx")).toBe(true);
    expect(evaluateCondition({ mode: "contains", value: "ab" }, "x")).toBe(false);
    expect(evaluateCondition({ mode: "equals", value: "ab" }, "ab")).toBe(true);
    expect(evaluateCondition({ mode: "equals", value: "ab" }, "abc")).toBe(false);
  });

  it("提示词模板替换 {{input}}；无占位符时以输入兜底", () => {
    expect(renderAgentPrompt("前言 {{input}} 后语", "X")).toBe("前言 X 后语");
    expect(renderAgentPrompt("", "X")).toBe("X");
    expect(renderAgentPrompt("只有模板", "料")).toBe("只有模板\n\n料");
  });
});

describe("WorkflowRunner：按依赖顺序执行（真的制造菱形图）", () => {
  it("菱形 A→{B,C}→D：A 先于 B/C，B/C 先于 D", async () => {
    const { host, order } = recordingHost();
    const run = await runToCompletion(
      def(
        [agent("A"), agent("B"), agent("C"), agent("D")],
        [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")]
      ),
      host
    );
    expect(run.state).toBe("succeeded");
    // A 最先，D 最后，B/C 在中间。
    expect(order[0]).toBe("A");
    expect(order[3]).toBe("D");
    expect([order[1], order[2]].sort()).toEqual(["B", "C"]);
  });

  it("成环的定义 → 运行置 failed 并报出环，一个节点都不执行", async () => {
    const { host, order } = recordingHost();
    const run = await runToCompletion(def([agent("A"), agent("B")], [edge("A", "B"), edge("B", "A")]), host);
    expect(run.state).toBe("failed");
    expect(run.error).toContain("成环");
    expect(order).toEqual([]);
  });
});

describe("WorkflowRunner：节点间传数据", () => {
  it("input(X) → agent(echo) → output：产出一路传到 output", async () => {
    // 假 host 把输入回显成 echo:<input>。
    const { host } = recordingHost((req) => ({ ok: true, output: `echo:${req.input}` }));
    const run = await runToCompletion(
      def([input("I", "X"), agent("A"), output("O")], [edge("I", "A"), edge("A", "O")]),
      host
    );
    expect(run.state).toBe("succeeded");
    const nodeOut = (id: string) => run.nodes.find((n) => n.nodeId === id)!.output;
    expect(nodeOut("I")).toBe("X"); // 输入节点产出种子
    expect(nodeOut("A")).toBe("echo:X"); // agent 收到 X，产出 echo:X
    expect(nodeOut("O")).toBe("echo:X"); // 输出节点汇聚上游产出
  });

  it("agent 提示词模板真的收到上游产出替换后的文本", async () => {
    const { host, inputs } = recordingHost((req) => ({ ok: true, output: req.prompt }));
    const run = await runToCompletion(
      def([input("I", "料"), agent("A", "干活：{{input}}")], [edge("I", "A")]),
      host
    );
    expect(run.state).toBe("succeeded");
    expect(inputs.get("A")).toBe("料");
    expect(run.nodes.find((n) => n.nodeId === "A")!.output).toBe("干活：料");
  });
});

describe("WorkflowRunner：条件分支路由", () => {
  it("条件命中 → true 分支执行，false 分支跳过", async () => {
    const { host, order } = recordingHost();
    // input 非空 → 条件 non-empty 为真 → 只有 true 分支的 T 执行，F 跳过。
    const run = await runToCompletion(
      def(
        [input("I", "有内容"), cond("C", "non-empty"), agent("T"), agent("F")],
        [edge("I", "C"), edge("C", "T", "true"), edge("C", "F", "false")]
      ),
      host
    );
    expect(run.state).toBe("succeeded");
    expect(order).toEqual(["T"]); // 只有 true 分支跑了
    expect(run.nodes.find((n) => n.nodeId === "F")!.state).toBe("skipped");
    expect(run.nodes.find((n) => n.nodeId === "T")!.state).toBe("succeeded");
  });

  it("条件未命中 → false 分支执行，true 分支跳过", async () => {
    const { host, order } = recordingHost();
    const run = await runToCompletion(
      def(
        [input("I", "  "), cond("C", "non-empty"), agent("T"), agent("F")],
        [edge("I", "C"), edge("C", "T", "true"), edge("C", "F", "false")]
      ),
      host
    );
    expect(order).toEqual(["F"]);
    expect(run.nodes.find((n) => n.nodeId === "T")!.state).toBe("skipped");
  });
});

describe("WorkflowRunner：失败传播 / 停止 / 重跑", () => {
  it("agent 失败 → 下游跳过，运行置 failed（独立分支不受影响）", async () => {
    // A 失败；A→B 使 B 跳过；独立的 C 照常成功。
    const { host } = recordingHost((req) => (req.nodeId === "A" ? { ok: false, output: "", error: "boom" } : { ok: true, output: "" }));
    const run = await runToCompletion(
      def([agent("A"), agent("B"), agent("C")], [edge("A", "B")]),
      host
    );
    expect(run.state).toBe("failed");
    expect(run.nodes.find((n) => n.nodeId === "A")!.state).toBe("failed");
    expect(run.nodes.find((n) => n.nodeId === "B")!.state).toBe("skipped");
    expect(run.nodes.find((n) => n.nodeId === "C")!.state).toBe("succeeded");
  });

  it("运行中停止 → 进行中节点作废、剩余跳过，运行置 stopped", async () => {
    // 用一个可控 host：第一个 agent 挂起，直到测试释放。
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const host: WorkflowAgentHost = {
      async runAgent(): Promise<WorkflowAgentResult> {
        await gate;
        return { ok: true, output: "" };
      },
    };

    let finalRun: WorkflowRun | null = null;
    const r = new WorkflowRunner({ host, onSettled: (run) => (finalRun = run) });
    const started = r.start(def([agent("A"), agent("B")], [edge("A", "B")]), "ws");
    // A 正在 await（running）；此刻停止。
    r.stop(started.id);
    release();
    // 等微任务把收口跑完。
    await new Promise((res) => setTimeout(res, 0));
    expect(finalRun).not.toBeNull();
    expect(finalRun!.state).toBe("stopped");
    expect(finalRun!.nodes.find((n) => n.nodeId === "B")!.state).toBe("skipped");
  });

  it("host 永不返回时 stop 仍立即结算", async () => {
    const host: WorkflowAgentHost = {
      runAgent: () => new Promise<WorkflowAgentResult>(() => undefined),
    };
    let finalRun: WorkflowRun | null = null;
    const runner = new WorkflowRunner({ host, onSettled: (run) => (finalRun = run) });
    const started = runner.start(def([agent("A")], []), "ws");
    await new Promise((resolve) => setTimeout(resolve, 0));
    runner.stop(started.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finalRun?.state).toBe("stopped");
  });

  it("host 永不返回时由 runner 超时结算为 failed", async () => {
    const host: WorkflowAgentHost = {
      runAgent: () => new Promise<WorkflowAgentResult>(() => undefined),
    };
    let finalRun: WorkflowRun | null = null;
    const runner = new WorkflowRunner({
      host,
      agentTimeoutMs: 5,
      onSettled: (run) => (finalRun = run),
    });
    runner.start(def([agent("A")], []), "ws");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finalRun?.state).toBe("failed");
    expect(finalRun?.nodes[0].error).toContain("超时");
  });

  it("重跑同一定义产生两次独立运行", async () => {
    const { host } = recordingHost();
    const runner = new WorkflowRunner({ host });
    const d = def([agent("A")], []);
    const r1 = runner.start(d, "ws");
    await new Promise((res) => setTimeout(res, 0));
    const r2 = runner.start(d, "ws");
    await new Promise((res) => setTimeout(res, 0));
    expect(r1.id).not.toBe(r2.id);
    expect(runner.snapshot().runs.length).toBe(2);
  });
});
