/**
 * 可视化工作流的 IPC handler（common.workflow）——**恰 8 条通道**。
 *
 * 工作流是**通用能力**（可关闭）：未启用时 `activate`（registerWorkflowIpc）一次
 * 都不调用，八条通道因此不进 ipc-guard 的注册表（feature gate 的主进程侧）。
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 *
 * ## Agent 节点如何触发 pi run —— 清晰调用点，不重造、不改池
 *
 * `poolAgentHost` 是本能力对后台会话池的**唯一调用点**，只用池 / host 的公开
 * 方法（`agentPool().requestSession/stopSession`、`poolRuntimeHost().deliver`、
 * `agentPool().snapshot()` 读运行态），**不改池 / child-agent 的任何文件**：
 *
 *   1. `requestSession({origin:"user", focus:false})` 让池按并发 / 内存 / 成本闸
 *      与崩溃预算派生一个后台会话 —— 与 child 编排复用同一套触发机制；
 *   2. runtime 就绪（快照里 runtimeId 非空）后 `deliver(prompt)` 下发提示词；
 *   3. 轮询池快照的列表态到 done / failed，据此收口节点；
 *   4. `stopSession` 清理。
 *
 * 用 `origin:"user"`（而非 `"child"`）是刻意的：child 的结构化事件汇聚 sink 只对
 * `origin:"child"` 触发且被 child 编排独占，用 "user" 就与它彻底不相干，两条路
 * 互不串台。节点产出的**文本**目前不从池快照取（快照只暴露列表态），产出富化
 * 是后续接线点（见 FEAT-workflow.md §未做）；DAG 的节点间传数据机制在纯内核里
 * 已由 `workflow-runner.spec` 用真实产出证伪。
 */
import {
  CHANNELS,
  PUSH_CHANNELS,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  WORKFLOW_ENVELOPE_GENERATION,
  WORKFLOW_ENVELOPE_ID,
  wrapEnvelope,
  workflowDefinitionSchema,
  workflowListRequestSchema,
  workflowSaveRequestSchema,
  workflowDeleteRequestSchema,
  workflowExportRequestSchema,
  workflowImportRequestSchema,
  workflowRunRequestSchema,
  workflowStopRequestSchema,
  workflowRunsRequestSchema,
  type InvokeChannel,
  type WorkflowDefinition,
  type WorkflowDefinitionsResponse,
  type WorkflowExportResponse,
  type WorkflowImportResponse,
  type WorkflowListRequest,
  type WorkflowSaveRequest,
  type WorkflowDeleteRequest,
  type WorkflowExportRequest,
  type WorkflowImportRequest,
  type WorkflowRun,
  type WorkflowRunRequest,
  type WorkflowRunSnapshot,
  type WorkflowRunsRequest,
  type WorkflowStopRequest,
} from "@pibuddy/contract";
import { BrowserWindow } from "electron";

import { agentPool, poolRuntimeHost } from "../agent-pool/pool.js";
import { log } from "../log.js";
import { registerHandler } from "../ipc-guard.js";
import {
  WorkflowRunner,
  type WorkflowAgentHost,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "./workflow-runner.js";
import { closeWorkflowStore, workflowStore } from "./workflow-store.js";

/** 本域注册的全部通道。drift test 据它逐条对账。 */
export const WORKFLOW_CHANNELS: InvokeChannel[] = [
  CHANNELS.workflowList,
  CHANNELS.workflowSave,
  CHANNELS.workflowDelete,
  CHANNELS.workflowExport,
  CHANNELS.workflowImport,
  CHANNELS.workflowRun,
  CHANNELS.workflowStop,
  CHANNELS.workflowRuns,
];

// ---------------------------------------------------------------- Agent host（池调用点）

/** 后台会话就绪 / 完成的轮询参数。 */
const READY_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** runId → 该运行派生出的后台会话 id 集合（供 cancelRun 清理）。 */
const runSessions = new Map<string, Set<string>>();

function poolSessionView(sessionId: string) {
  return agentPool()
    .snapshot()
    .sessions.find((s) => s.sessionId === sessionId);
}

/**
 * 生产用 Agent host：把一个 Agent 节点接到后台会话池上（唯一调用点）。
 */
const poolAgentHost: WorkflowAgentHost = {
  async runAgent(req: WorkflowAgentRequest): Promise<WorkflowAgentResult> {
    if (!req.workspaceId) {
      return { ok: false, output: "", error: "Agent 节点需要一个工作区才能运行 pi" };
    }
    const sessionId = `wf:${req.runId}:${req.nodeId}`;
    const set = runSessions.get(req.runId) ?? new Set<string>();
    set.add(sessionId);
    runSessions.set(req.runId, set);

    try {
      // 1. 派生后台会话（池按 origin:"user" 的并发 / 资源闸管辖）。
      agentPool().requestSession({
        sessionId,
        workspaceId: req.workspaceId,
        origin: "user",
        focus: false,
      });

      // 2. 等 runtime 就绪（快照里 runtimeId 非空 = 握手完成）。
      const readyDeadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        const view = poolSessionView(sessionId);
        if (!view) return { ok: false, output: "", error: "后台会话未能进入池" };
        if (view.runState === "crashed") {
          return { ok: false, output: "", error: "后台会话启动即崩溃" };
        }
        if (view.runtimeId !== "") break;
        if (Date.now() > readyDeadline) {
          return { ok: false, output: "", error: "后台会话握手超时（可能资源受限排队中）" };
        }
        await sleep(POLL_INTERVAL_MS);
      }

      // 3. 下发提示词。
      poolRuntimeHost().deliver(sessionId, req.prompt);

      // 4. 轮询列表态到 done / failed（或进程崩溃 / 被停）。
      const runDeadline = Date.now() + RUN_TIMEOUT_MS;
      for (;;) {
        const view = poolSessionView(sessionId);
        if (!view) return { ok: false, output: "", error: "后台会话在运行中消失" };
        if (view.listState === "done") return { ok: true, output: "" };
        if (view.listState === "failed" || view.runState === "crashed") {
          return { ok: false, output: "", error: "Agent 节点的 pi run 失败" };
        }
        if (view.runState === "stopped") {
          return { ok: false, output: "", error: "后台会话被停止" };
        }
        if (Date.now() > runDeadline) {
          return { ok: false, output: "", error: "Agent 节点的 pi run 超时" };
        }
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    } finally {
      agentPool().stopSession(sessionId);
      runSessions.get(req.runId)?.delete(sessionId);
    }
  },

  cancelRun(runId: string): void {
    const set = runSessions.get(runId);
    if (!set) return;
    for (const sessionId of set) agentPool().stopSession(sessionId);
    runSessions.delete(runId);
  },
};

// ---------------------------------------------------------------- runner 单例 + 广播

let runner: WorkflowRunner | null = null;

function broadcast(snapshot: WorkflowRunSnapshot): void {
  const envelope = wrapEnvelope(
    {
      workspaceId: WORKFLOW_ENVELOPE_ID,
      sessionId: WORKFLOW_ENVELOPE_ID,
      runtimeId: WORKFLOW_ENVELOPE_ID,
      generation: WORKFLOW_ENVELOPE_GENERATION,
    },
    snapshot.sequence,
    snapshot
  );
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(PUSH_CHANNELS.workflowEvent, envelope);
  }
}

export function workflowRunner(): WorkflowRunner {
  if (!runner) {
    runner = new WorkflowRunner({
      host: poolAgentHost,
      onChange: broadcast,
      onSettled: (run: WorkflowRun) => {
        // 运行进入终态 → 落历史（按工作区分区）。null 工作区的运行不落盘。
        if (run.workspaceId) {
          try {
            workflowStore().appendRun(run.workspaceId, run);
          } catch (err) {
            log().warn("workflow_run_persist_failed", {
              runId: run.id,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
    });
  }
  return runner;
}

/**
 * 合出「一个工作区可见的运行快照」：内存里活跃 / 本次会话的运行 + 已落盘历史，
 * 按 id 去重，按开始时间倒序。
 */
function runsSnapshotForWorkspace(workspaceId: string): WorkflowRunSnapshot {
  const live = workflowRunner()
    .snapshot()
    .runs.filter((r) => r.workspaceId === workspaceId);
  const persisted = workflowStore().listRuns(workspaceId);
  const byId = new Map<string, WorkflowRun>();
  for (const run of persisted) byId.set(run.id, run);
  // 内存里的更新（含活跃运行的最新态）覆盖已落盘的同 id 记录。
  for (const run of live) byId.set(run.id, run);
  const runs = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
  return { sequence: workflowRunner().snapshot().sequence, runs };
}

// ---------------------------------------------------------------- 拆卸

/** 禁用能力时拆掉运行期资源：停全部活跃运行、摘广播、关 sqlite 句柄。**不删数据**。 */
export function disposeWorkflowResources(): void {
  if (runner) {
    for (const run of runner.activeRuns()) runner.stop(run.id);
  }
  for (const set of runSessions.values()) {
    for (const sessionId of set) agentPool().stopSession(sessionId);
  }
  runSessions.clear();
  runner = null;
  closeWorkflowStore();
}

/** 仅供单测：清掉单例。 */
export function __resetWorkflowIpc(): void {
  runner = null;
  runSessions.clear();
}

// ---------------------------------------------------------------- 注册

export function registerWorkflowIpc(): void {
  registerHandler<WorkflowListRequest, WorkflowDefinitionsResponse>(
    CHANNELS.workflowList,
    workflowListRequestSchema,
    (payload) => ({ definitions: workflowStore().listDefinitions(payload.workspaceId) })
  );

  registerHandler<WorkflowSaveRequest, WorkflowDefinitionsResponse>(
    CHANNELS.workflowSave,
    workflowSaveRequestSchema,
    (payload) => {
      workflowStore().saveDefinition(payload.workspaceId, payload.definition);
      return { definitions: workflowStore().listDefinitions(payload.workspaceId) };
    }
  );

  registerHandler<WorkflowDeleteRequest, WorkflowDefinitionsResponse>(
    CHANNELS.workflowDelete,
    workflowDeleteRequestSchema,
    (payload) => {
      workflowStore().deleteDefinition(payload.workspaceId, payload.definitionId);
      return { definitions: workflowStore().listDefinitions(payload.workspaceId) };
    }
  );

  registerHandler<WorkflowExportRequest, WorkflowExportResponse>(
    CHANNELS.workflowExport,
    workflowExportRequestSchema,
    (payload) => {
      const def = workflowStore().getDefinition(payload.workspaceId, payload.definitionId);
      if (!def) throw new Error(`WORKFLOW_NOT_FOUND: ${payload.definitionId}`);
      return { json: JSON.stringify(def, null, 2) };
    }
  );

  registerHandler<WorkflowImportRequest, WorkflowImportResponse>(
    CHANNELS.workflowImport,
    workflowImportRequestSchema,
    (payload) => {
      const parsed = workflowDefinitionSchema.safeParse(JSON.parse(payload.json));
      if (!parsed.success) {
        throw new Error(`WORKFLOW_IMPORT_INVALID: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      }
      // 导入分配一个新 id + 时间戳，避免覆盖同 id 的已有定义（导入是复制，不是替换）。
      const now = Date.now();
      const definition: WorkflowDefinition = {
        ...parsed.data,
        id: `wf-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
      };
      workflowStore().saveDefinition(payload.workspaceId, definition);
      return { definition, definitions: workflowStore().listDefinitions(payload.workspaceId) };
    }
  );

  registerHandler<WorkflowRunRequest, WorkflowRunSnapshot>(
    CHANNELS.workflowRun,
    workflowRunRequestSchema,
    (payload) => {
      const def = workflowStore().getDefinition(payload.workspaceId, payload.definitionId);
      if (!def) throw new Error(`WORKFLOW_NOT_FOUND: ${payload.definitionId}`);
      workflowRunner().start(def, payload.workspaceId);
      return runsSnapshotForWorkspace(payload.workspaceId);
    }
  );

  registerHandler<WorkflowStopRequest, WorkflowRunSnapshot>(
    CHANNELS.workflowStop,
    workflowStopRequestSchema,
    (payload) => {
      workflowRunner().stop(payload.runId);
      return runsSnapshotForWorkspace(payload.workspaceId);
    }
  );

  registerHandler<WorkflowRunsRequest, WorkflowRunSnapshot>(
    CHANNELS.workflowRuns,
    workflowRunsRequestSchema,
    (payload) => runsSnapshotForWorkspace(payload.workspaceId)
  );
}
