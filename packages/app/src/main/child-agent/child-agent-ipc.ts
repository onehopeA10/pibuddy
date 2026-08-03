/**
 * child Agent 编排的 IPC handler（AGT-102）——**恰 5 条通道**。
 *
 * child 编排是**通用能力** `common.child-agent`（可关闭）：未启用时 `activate`
 * 一次都不调用，五条通道因此不进 ipc-guard 的注册表（feature gate 的主进程侧）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 * 五条通道逐一与 `manifest.channels` / 契约分片键集合对账（capability-drift）。
 */
import {
  CHANNELS,
  childAnswerRequestSchema,
  childCancelRequestSchema,
  childCreateRequestSchema,
  childDescribeRequestSchema,
  childResolveMergeRequestSchema,
  type ChildAnswerRequest,
  type ChildCancelRequest,
  type ChildCreateRequest,
  type ChildDescribeRequest,
  type ChildResolveMergeRequest,
  type ChildTopologySnapshot,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import {
  childAgent,
  disposeChildOrchestration,
  startChildOrchestration,
} from "./child-orchestrator.js";

/** 禁用能力时拆掉运行期资源（维护节拍 + 池的子事件汇聚 / 就绪回调）。 */
export function disposeChildAgentResources(): void {
  disposeChildOrchestration();
}

/** 本域注册的全部通道。drift test 据它逐条对账。 */
export const CHILD_AGENT_CHANNELS: InvokeChannel[] = [
  CHANNELS.childAgentDescribe,
  CHANNELS.childAgentCreate,
  CHANNELS.childAgentCancel,
  CHANNELS.childAgentAnswer,
  CHANNELS.childAgentResolveMerge,
];

export function registerChildAgentIpc(): void {
  // 装配：结构化事件汇聚 + 就绪下发 + 超时节拍。
  startChildOrchestration();

  registerHandler<ChildDescribeRequest, ChildTopologySnapshot>(
    CHANNELS.childAgentDescribe,
    childDescribeRequestSchema,
    () => childAgent().snapshot()
  );

  registerHandler<ChildCreateRequest, ChildTopologySnapshot>(
    CHANNELS.childAgentCreate,
    childCreateRequestSchema,
    (payload) => {
      childAgent().createChild(payload.parentId, payload.spec, Date.now());
      return childAgent().snapshot();
    }
  );

  registerHandler<ChildCancelRequest, ChildTopologySnapshot>(
    CHANNELS.childAgentCancel,
    childCancelRequestSchema,
    (payload) => {
      childAgent().cancel(payload.nodeId, Date.now());
      return childAgent().snapshot();
    }
  );

  registerHandler<ChildAnswerRequest, ChildTopologySnapshot>(
    CHANNELS.childAgentAnswer,
    childAnswerRequestSchema,
    (payload) => {
      childAgent().answer(payload.nodeId, payload.questionId, payload.answer, Date.now());
      return childAgent().snapshot();
    }
  );

  registerHandler<ChildResolveMergeRequest, ChildTopologySnapshot>(
    CHANNELS.childAgentResolveMerge,
    childResolveMergeRequestSchema,
    (payload) => {
      childAgent().resolveMerge(payload.nodeId, payload.accept, Date.now());
      return childAgent().snapshot();
    }
  );
}
