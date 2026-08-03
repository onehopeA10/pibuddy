/**
 * 权限决策的**主进程接线层**：把纯引擎接到磁盘、审计日志、原生确认框与
 * 第五道闸上（ADR-0002 D3 / SEC-003）。
 *
 * 分工：`permission-engine.ts` 只做决策（可对拍、不碰 electron），本文件负责
 *   - **上界数据源**：从 `CapabilityRegistry` 读某能力 manifest 声明的权限；
 *   - **workspace 授权持久化**：`WorkspaceProfile.capabilityGrants`（与
 *     `permissionRules` 并列的那张新表）；
 *   - **审计**：每次授予 / 拒绝 / 撤销 / 拦截都经 `logger`（脱敏）落盘；
 *   - **原生确认**：危险权限的持久化授权必须过一次主进程原生框；
 *   - **通道需求表 + 第五道闸**：哪条通道需要哪条权限，未授权即拒。
 */
import { dialog } from "electron";
import {
  CHANNELS,
  GIT_CAPABILITY_ID,
  GIT_GATED_CHANNELS,
  GIT_PERMISSION,
  isDangerousPermission,
  PERMISSION_PROBE_CAPABILITY_ID,
  PERMISSION_PROBE_PERMISSION,
  type CapabilityGrant,
  type InvokeChannel,
  type PermissionAuditEntry,
  type PermissionAuditKind,
  type PermissionDecideRequest,
  type PermissionDisposition,
  type PermissionRevokeRequest,
  type PermissionState,
} from "@pibuddy/contract";

import { capabilityRegistry } from "../capability/capability-catalog.js";
import { createLogger, type Logger } from "../logger.js";
import { workspaceStore } from "../workspace/workspace-store.js";
import { CapabilityPermissionEngine, type PermissionQuery } from "./permission-engine.js";

/**
 * 通道 → 需要的能力权限。
 *
 * **本轮只有探针一条**：任何现有通道都不在表里，因此它们的行为在第五道闸
 * 加进来之后完全不变（向后兼容铁律）。将来的 Git 包 / 连接器只需在这里加一行
 * 「这条通道属哪个 capability、需要哪条权限」，决策与拦截就自动生效。
 */
export const CHANNEL_PERMISSION_REQUIREMENTS: Partial<
  Record<InvokeChannel, { capabilityId: string; permission: string }>
> = {
  [CHANNELS.permissionProbe]: {
    capabilityId: PERMISSION_PROBE_CAPABILITY_ID,
    permission: PERMISSION_PROBE_PERMISSION,
  },
  // Git 编码能力包（coding.git）——**第一个真实的 process.git 消费者**。按
  // FEAT-permission-engine §6 的预留入口接入：给每条 git 通道在这张表里加一行
  // `{capabilityId: coding.git, permission: process.git}`，能力 manifest 声明
  // process.git，引擎的上界校验与第五道闸的拦截**自动生效**，无需再动
  // ipc-guard 的任何逻辑（本文件只往这张需求表追加行，不改既有决策逻辑）。
  ...Object.fromEntries(
    GIT_GATED_CHANNELS.map((channel) => [
      channel,
      { capabilityId: GIT_CAPABILITY_ID, permission: GIT_PERMISSION },
    ])
  ),
};

/** 危险权限持久化授权前的原生确认。可注入，便于单测与真机取证。 */
export interface PermissionPrompter {
  /** 展示 capability / 权限 / 资源，要求用户明确确认；默认按钮必须是「取消」。 */
  confirmPersistentGrant(req: PermissionDecideRequest): Promise<boolean>;
}

const nativePrompter: PermissionPrompter = {
  async confirmPersistentGrant(req: PermissionDecideRequest): Promise<boolean> {
    const res = await dialog.showMessageBox({
      type: "warning",
      buttons: ["取消", "允许"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "权限确认",
      message: `是否允许「${req.capabilityId}」持久获得权限？`,
      detail:
        `权限：${req.permission}\n` +
        `资源：${req.resource ?? "（不限）"}\n\n` +
        "此授权将保存到当前工作区，跨重启有效。",
    });
    return res.response === 1;
  },
};

let prompter: PermissionPrompter = nativePrompter;
/** 仅供单测 / 真机取证：替换原生确认框。 */
export function setPermissionPrompter(p: PermissionPrompter): void {
  prompter = p;
}

// ---------------------------------------------------------------- 引擎装配

function declaredPermissions(capabilityId: string): ReadonlySet<string> {
  // 探针用一个不在注册表里的保留 id，其上界固定为 process.git。
  if (capabilityId === PERMISSION_PROBE_CAPABILITY_ID) {
    return new Set([PERMISSION_PROBE_PERMISSION]);
  }
  const reg = capabilityRegistry.get(capabilityId);
  return new Set(reg?.manifest.permissions ?? []);
}

function workspaceGrants(workspaceId: string | null): readonly CapabilityGrant[] {
  if (workspaceId === null) return [];
  return workspaceStore().get(workspaceId)?.capabilityGrants ?? [];
}

const engine = new CapabilityPermissionEngine({ declaredPermissions, workspaceGrants });

/** 供第五道闸的接线（permission-ipc）取用的单例。 */
export function permissionEngine(): CapabilityPermissionEngine {
  return engine;
}

// ---------------------------------------------------------------- 审计

let auditLogger: Logger | null = null;
function log(): Logger {
  if (!auditLogger) auditLogger = createLogger("permission");
  return auditLogger;
}

const AUDIT_RING = 100;
const auditRing: PermissionAuditEntry[] = [];

function audit(
  kind: PermissionAuditKind,
  entry: {
    capabilityId: string;
    permission: string;
    resource: string | null;
    disposition?: PermissionDisposition | null;
    detail?: string | null;
  }
): void {
  const record: PermissionAuditEntry = {
    at: Date.now(),
    kind,
    capabilityId: entry.capabilityId,
    permission: entry.permission,
    resource: entry.resource,
    disposition: entry.disposition ?? null,
    detail: entry.detail ?? null,
  };
  auditRing.push(record);
  if (auditRing.length > AUDIT_RING) auditRing.splice(0, auditRing.length - AUDIT_RING);
  // 走 kernel logger，message 经 logger-redact 脱敏后落盘。
  log().info(`permission_${kind}`, {
    capabilityId: record.capabilityId,
    permission: record.permission,
    resource: record.resource,
    disposition: record.disposition,
    detail: record.detail,
  });
}

// ---------------------------------------------------------------- 对外操作

/** 当前状态快照。 */
export function describePermissions(workspaceId: string | null): PermissionState {
  return {
    workspaceId,
    workspaceGrants: [...workspaceGrants(workspaceId)],
    sessionGrants: engine.sessionGrants(),
    audit: [...auditRing],
  };
}

function persistWorkspaceGrant(workspaceId: string, grant: CapabilityGrant): boolean {
  const profile = workspaceStore().get(workspaceId);
  if (!profile) return false;
  const exists = profile.capabilityGrants.some(
    (g) =>
      g.capabilityId === grant.capabilityId &&
      g.permission === grant.permission &&
      g.resource === grant.resource
  );
  if (!exists) {
    workspaceStore().update(workspaceId, {
      capabilityGrants: [...profile.capabilityGrants, grant],
    });
  }
  return true;
}

/**
 * 记录一次决策。
 *
 * 无论哪一档，都先过**上界**：请求的权限必须在该能力 manifest 的声明集合里，
 * 否则直接拒——这一步在任何 grant 之前，因此渲染进程即便被攻陷也自造不出
 * 一条越过 manifest 的授权。
 */
export async function decidePermission(req: PermissionDecideRequest): Promise<PermissionState> {
  const { capabilityId, permission, resource, disposition, workspaceId } = req;

  if (!engine.isDeclared(capabilityId, permission)) {
    audit("denied", {
      capabilityId,
      permission,
      resource,
      disposition,
      detail: "越过 manifest 声明的上界，拒绝",
    });
    return describePermissions(workspaceId);
  }

  if (disposition === "deny") {
    audit("denied", { capabilityId, permission, resource, disposition, detail: "用户拒绝" });
    return describePermissions(workspaceId);
  }

  const grant: CapabilityGrant = { capabilityId, permission, resource, grantedAt: Date.now() };

  if (disposition === "allow-once") {
    engine.grantOnce(grant);
    audit("granted", { capabilityId, permission, resource, disposition });
    return describePermissions(workspaceId);
  }

  if (disposition === "allow-session") {
    engine.grantSession(grant);
    audit("granted", { capabilityId, permission, resource, disposition });
    return describePermissions(workspaceId);
  }

  // allow-workspace：持久化。
  if (workspaceId === null) {
    audit("denied", {
      capabilityId,
      permission,
      resource,
      disposition,
      detail: "无工作区上下文，无法持久化授权",
    });
    return describePermissions(workspaceId);
  }
  // 危险权限的持久化必须过一次主进程原生确认框（渲染进程伪造不了、绕不开）。
  if (isDangerousPermission(permission)) {
    const confirmed = await prompter.confirmPersistentGrant(req);
    if (!confirmed) {
      audit("denied", { capabilityId, permission, resource, disposition, detail: "原生确认被取消" });
      return describePermissions(workspaceId);
    }
  }
  const persisted = persistWorkspaceGrant(workspaceId, grant);
  audit(persisted ? "granted" : "denied", {
    capabilityId,
    permission,
    resource,
    disposition,
    detail: persisted ? null : "工作区未建档，无法持久化",
  });
  return describePermissions(workspaceId);
}

/** 撤销一条 session 或 workspace 授权。 */
export function revokePermission(req: PermissionRevokeRequest): PermissionState {
  const { capabilityId, permission, resource, scope, workspaceId } = req;
  if (scope === "session") {
    const removed = engine.revokeSession(capabilityId, permission, resource);
    audit("revoked", { capabilityId, permission, resource, detail: `session ×${removed}` });
    return describePermissions(workspaceId);
  }
  // workspace
  if (workspaceId !== null) {
    const profile = workspaceStore().get(workspaceId);
    if (profile) {
      const next = profile.capabilityGrants.filter(
        (g) =>
          !(g.capabilityId === capabilityId && g.permission === permission && g.resource === resource)
      );
      workspaceStore().update(workspaceId, { capabilityGrants: next });
    }
  }
  audit("revoked", { capabilityId, permission, resource, detail: "workspace" });
  return describePermissions(workspaceId);
}

// ---------------------------------------------------------------- 第五道闸

/**
 * 从任意 payload 里安全地取 workspaceId（决策的资源上下文）。
 *
 * payload 是跨进程 structured-clone 之后的任意值，因此这里做防御式读取，
 * 只认「顶层有一个字符串 workspaceId」这一种形态。
 */
function workspaceIdOf(payload: unknown): string | null {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const wid = (payload as Record<string, unknown>).workspaceId;
    if (typeof wid === "string" && wid.length > 0) return wid;
  }
  return null;
}

/**
 * 第五道闸的判定：给 `ipc-guard` 调用。**未在需求表里的通道一律放行**
 * （无适用规则 = 放行），保证现有全部通道行为不变。
 */
export function gateForChannel(channel: InvokeChannel, payload: unknown): void {
  const requirement = CHANNEL_PERMISSION_REQUIREMENTS[channel];
  if (!requirement) return; // 无适用规则 → 放行（向后兼容）

  const query: PermissionQuery = {
    capabilityId: requirement.capabilityId,
    permission: requirement.permission,
    resource: null,
    workspaceId: workspaceIdOf(payload),
  };
  const decision = engine.evaluate(query);
  if (!decision.allowed) {
    audit("blocked", {
      capabilityId: requirement.capabilityId,
      permission: requirement.permission,
      resource: null,
      detail: decision.reason,
    });
    throw new Error(`IPC_PERMISSION_DENIED: ${channel} ${decision.reason ?? ""}`.trim());
  }
}

/** 仅供单测：清空内存授权与审计环。 */
export function __resetPermissionStore(): void {
  engine.resetInMemory();
  auditRing.length = 0;
  prompter = nativePrompter;
}
