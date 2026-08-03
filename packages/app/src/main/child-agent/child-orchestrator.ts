/**
 * child Agent 编排的**主进程接线层**（AGT-102）。
 *
 * 把纯内核 `ChildAgentCore` 接到三样有副作用的东西上：
 *   - **进程派生**：走后台池的 `requestSession(origin:"child")` + 真实后台
 *     runtime（`pool-runtime-host`）。子 Agent 因此照样受池的并发/内存/成本闸
 *     与崩溃预算管辖——child 子进程独立 runtime 有资源上界，正是靠复用池。
 *   - **结构化消息汇聚**：从子会话的事件流里**只认一个约定的结构化上报点**
 *     （子运行时对 `pibuddy_child_report` 工具的调用，其**类型化 args** 即为
 *     `ChildMessage`），绝不解析子进程的自然语言输出。
 *   - **广播**：核心每次变更 → 一份 `PiEnvelope<ChildTopologySnapshot>` 推给
 *     全部窗口（snapshot + sequence，任一窗口据此对齐）。
 *
 * ## 边界
 *
 * 本文件在 `main/child-agent/**`（child 能力域）。它**只调用**池（`agentPool`）
 * 与后台派生 host（`poolRuntimeHost`），不重写池状态机；不直接 spawn / execFile /
 * readFile / writeFile（那些副作用都在池域的 host 里），因此 child 能力的权限
 * 申请集为空、drift 的权限对账两个方向都成立。
 */
import type { AgentEvent } from "@pibuddy/pi-sdk";
import {
  CHILD_ENVELOPE_GENERATION,
  CHILD_ENVELOPE_ID,
  PUSH_CHANNELS,
  wrapEnvelope,
  type ChildSpec,
  type ChildTopologySnapshot,
} from "@pibuddy/contract";
import { BrowserWindow } from "electron";

import { agentPool, poolRuntimeHost } from "../agent-pool/pool.js";
import { log } from "../log.js";
import { ChildAgentCore, type ChildHost, type ChildLaunchRequest } from "./child-core.js";

/**
 * 子运行时的结构化上报工具名。
 *
 * 子 Agent 用它上报 progress / question / evidence / result：一次工具调用的
 * **类型化参数**就是一条 `ChildMessage`。父只认这一个工具的 args，永不去匹配
 * 子进程的散文——这是「不靠解析自然语言日志」的落点。
 */
export const CHILD_REPORT_TOOL = "pibuddy_child_report";

/** child 编排维护节拍（超时收口）。分钟级足够。 */
const TICK_INTERVAL_MS = 15_000;

let instance: ChildAgentCore | null = null;
let tickTimer: NodeJS.Timeout | null = null;
/** 待运行时就绪后下发的目标提示词（nodeId → 提示词）。 */
const pendingGoals = new Map<string, string>();

function broadcast(_snapshot: ChildTopologySnapshot): void {
  const core = childAgent();
  const envelope = wrapEnvelope(
    {
      workspaceId: CHILD_ENVELOPE_ID,
      sessionId: CHILD_ENVELOPE_ID,
      runtimeId: CHILD_ENVELOPE_ID,
      generation: CHILD_ENVELOPE_GENERATION,
    },
    core.currentSequence(),
    core.snapshot()
  );
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(PUSH_CHANNELS.childAgentEvent, envelope);
  }
}

/** 把目标 + 输入拼成子的首条提示词（结构化前言 + 材料）。 */
function goalPrompt(req: ChildLaunchRequest): string {
  const header = [
    `# 目标`,
    req.goal,
    ``,
    `# 交付方式`,
    `完成进展 / 提问 / 证据 / 最终结果，请通过 ${CHILD_REPORT_TOOL} 工具结构化上报，`,
    `不要只在正文里叙述。`,
  ];
  if (req.input.trim()) {
    header.push(``, `# 输入`, req.input);
  }
  return header.join("\n");
}

const host: ChildHost = {
  launch(req) {
    // 记下目标，待 runtime 就绪再下发（子可能因资源闸先排队）。
    pendingGoals.set(req.nodeId, goalPrompt(req));
    // 走池派生：origin:"child" 让池按并发/内存/成本闸与崩溃预算管辖它。
    agentPool().requestSession({
      sessionId: req.nodeId,
      workspaceId: req.workspaceId,
      origin: "child",
      focus: false,
    });
  },
  stop(nodeId) {
    pendingGoals.delete(nodeId);
    // 停子进程走池的 stopSession（→ pool-runtime-host.stop 真停 runtime）。
    agentPool().stopSession(nodeId);
  },
  deliver(nodeId, text) {
    poolRuntimeHost().deliver(nodeId, text);
  },
};

export function childAgent(): ChildAgentCore {
  if (!instance) {
    instance = new ChildAgentCore({ host, onChange: broadcast });
  }
  return instance;
}

/**
 * 从一条子会话事件里抽出结构化 `ChildMessage`（若它是一次结构化上报）。
 *
 * **只认 `tool_execution_start` 且 toolName 命中约定工具**的 `args`——args 是
 * pi 协议里工具调用的**类型化参数**，不是自然语言。非本工具一律返回 null。
 */
export function extractChildMessage(event: AgentEvent): unknown | null {
  const e = event as { type?: string; toolName?: string; args?: unknown };
  if (e.type !== "tool_execution_start") return null;
  if (e.toolName !== CHILD_REPORT_TOOL) return null;
  return e.args ?? null;
}

/**
 * 装配：起维护节拍 + 注册子会话结构化事件汇聚。
 *
 * 汇聚只收 origin:"child" 的会话事件（pool-runtime-host 已按 origin 过滤）：
 * 命中结构化上报点就落进核心，其余事件（自然语言流）一概不喂给编排状态机。
 */
export function startChildOrchestration(): void {
  const core = childAgent();
  poolRuntimeHost().setChildEventSink((sessionId, event) => {
    const raw = extractChildMessage(event);
    if (raw !== null) core.ingestMessage(sessionId, raw, Date.now());
  });
  // 子 runtime 就绪 → 下发暂存的目标提示词（排队的子也在此刻拿到目标）。
  poolRuntimeHost().setChildReadySink((sessionId) => {
    const goal = pendingGoals.get(sessionId);
    if (goal === undefined) return;
    pendingGoals.delete(sessionId);
    core.onRuntimeReady(sessionId, Date.now());
    poolRuntimeHost().deliver(sessionId, goal);
  });
  if (!tickTimer) {
    tickTimer = setInterval(() => {
      const expired = core.tick(Date.now());
      for (const nodeId of expired) {
        log().warn("child_agent_timed_out", { nodeId });
      }
    }, TICK_INTERVAL_MS);
    if (typeof tickTimer.unref === "function") tickTimer.unref();
  }
}

/** 供 IPC 层直接操作核心的便捷句柄。 */
export function createChild(parentId: string | null, spec: ChildSpec, now = Date.now()) {
  return childAgent().createChild(parentId, spec, now);
}

/**
 * 拆卸运行期资源（能力被禁用时调用）。
 *
 * 停维护节拍、摘掉池的子事件汇聚与就绪回调——D4 规则 4：拆 listener，但
 * **不动核心里的编排数据**（那是运行时状态，随进程走，不落盘）。
 */
export function disposeChildOrchestration(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  poolRuntimeHost().setChildEventSink(null);
  poolRuntimeHost().setChildReadySink(null);
  pendingGoals.clear();
}

/** 仅供单测：拆掉单例与节拍。 */
export function __resetChildOrchestration(): void {
  disposeChildOrchestration();
  instance = null;
}
