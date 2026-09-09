/**
 * 远程服务与**既有内核设施**之间的唯一桥（REM-101）。
 *
 * 远程 HTTP/WS handler 不直接 import pi / pool / sessions / permission —— 它们只认
 * 这个 `RemoteBackend` 接口。这样做有两个后果，都是要的：
 *
 *   1. 远程服务的鉴权 / 路由 / 帧解析可以在**不启动 electron**的情况下被单测
 *      （注入一个假 backend），与本仓 permission-engine 的 DI 姿态一致。
 *   2. 「远程能做什么」这件事被收敛成这个接口的方法集：v1 只有看会话 / 历史、
 *      发 prompt、停止、后台快照、看权限、裁决权限。多一个能力 = 多一个方法。
 *
 * ## 为什么走 agent-pool 而不是直连 pi runtime
 *
 * 「发 prompt / 停止」经**后台会话池**（agent-pool）投递，与 child-agent / workflow
 * 驱动 runtime 走的是同一条路——那是 ADR-0002 给可选能力留的、面向 runtime 的
 * 唯一 sanctioned 入口。远程能力因此**一条 `pi/` 域 import 都没有**，kernel-boundary
 * 的「内核 / 能力不得依赖 pi 域」判据据此成立。代价是诚实标注的 v1 限制：deliver
 * 只对**池托管的会话**生效，前台 supervisor 独占的那个会话不在其列（接它需要动
 * pi-ipc，越出任务边界）。
 *
 * 本文件不出现任何 fs / 子进程 / 出站 / 密钥标记调用，因此 `connector.remote` 的
 * 权限对账（drift 3）不因它多出任何一条权限。
 */
import type {
  PermissionState,
  PoolInboxItem,
  PoolSnapshot,
  SessionHistoryPage,
} from "@pibuddy/contract";

import { agentPool, poolRuntimeHost } from "../agent-pool/pool.js";
import { readEntriesBefore } from "../sessions/session-history.js";
import { sessionIndex } from "../sessions/session-index.js";
import { decidePermission, describePermissions } from "../permission/permission-store.js";

export interface RemoteActionResult {
  ok: boolean;
  reason: string;
}

/** 远程服务能触达的内核动作集合（v1）。 */
export interface RemoteBackend {
  /** 后台会话池快照：会话列表 + 后台状态 + 统一权限 inbox。 */
  poolSnapshot(): PoolSnapshot;
  /** 某会话最近 limit 条消息（反向读 JSONL，最早的在前）。 */
  sessionHistory(sessionId: string, workspaceId: string, limit: number): Promise<SessionHistoryPage>;
  /** 向某个池托管会话投递一条 prompt（走既有 pi prompt 命令，池负责实际派发）。 */
  sendPrompt(sessionId: string, text: string): RemoteActionResult;
  /** 停止某会话（走池的 stopSession，与前台「停止」同一入口）。 */
  stopSession(sessionId: string): RemoteActionResult;
  /** 当前工作区的授权表 + 审计（权限只读视图）。 */
  permissionState(workspaceId: string | null): PermissionState;
  /** 裁决一条 permission inbox 待办（allow-once / deny）。需 permission.approve scope。 */
  decideInbox(inboxId: string, allow: boolean): Promise<RemoteActionResult>;
}

/** 生产环境的 backend：把接口方法接到既有内核导出上（复用，绝不修改其逻辑）。 */
export function productionBackend(): RemoteBackend {
  return {
    poolSnapshot(): PoolSnapshot {
      return agentPool().snapshot();
    },

    async sessionHistory(
      sessionId: string,
      workspaceId: string,
      limit: number
    ): Promise<SessionHistoryPage> {
      const row = sessionIndex().bySessionId(sessionId, workspaceId);
      if (!row) {
        return { entries: [], nextBeforeOffset: null, stale: false, skippedPartial: 0 };
      }
      return readEntriesBefore({
        sourcePath: row.sourcePath,
        beforeOffset: row.sizeBytes,
        limit,
        expect: { mtimeMs: row.mtimeMs, sizeBytes: row.sizeBytes },
      });
    },

    sendPrompt(sessionId: string, text: string): RemoteActionResult {
      // deliver 对无活跃 runtime 的会话静默丢弃（会话已停）——best-effort，不抛。
      poolRuntimeHost().deliver(sessionId, text);
      return { ok: true, reason: "ok" };
    },

    stopSession(sessionId: string): RemoteActionResult {
      agentPool().stopSession(sessionId);
      return { ok: true, reason: "ok" };
    },

    permissionState(workspaceId: string | null): PermissionState {
      return describePermissions(workspaceId);
    },

    async decideInbox(inboxId: string, allow: boolean): Promise<RemoteActionResult> {
      const item: PoolInboxItem | null = agentPool().resolveInbox(inboxId);
      if (!item) return { ok: false, reason: "inbox item gone" };
      await decidePermission({
        capabilityId: item.capabilityId,
        permission: item.permission,
        resource: item.resource,
        disposition: allow ? "allow-once" : "deny",
        workspaceId: item.workspaceId,
      });
      return { ok: true, reason: "ok" };
    },
  };
}
