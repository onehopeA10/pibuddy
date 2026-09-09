/**
 * 能力权限决策引擎（ADR-0002 D3 / SEC-003）—— **纯逻辑，不 import electron**。
 *
 * ## 为什么与 electron 分离
 *
 * ADR-0002 D3 明确引用了 CodePilot 的教训：`canUseTool` 在某模式下根本不会
 * 被调用，「统一入口 = 统一拦截」在那套 SDK 上不成立，所以**拦截点必须实测
 * 验证，不得靠架构图推断**。而一个需要给 electron 打桩才能跑的判据，最后都会
 * 变成没人跑的判据。因此本文件只做决策，磁盘 / 原生框 / logger 全部以依赖注入
 * 的形式从 `permission-store.ts` 接进来；决策本身可以被单测直接对拍。
 *
 * ## 决策次序（默认拒绝）
 *
 *   1. **上界**：请求的权限必须在该能力的 manifest 声明集合里。渲染进程即便
 *      被攻陷，也只能申请到某个已启用能力**声明过**的权限——越不过 manifest。
 *      未声明直接拒，且这一步在任何 grant 之前，因此自造一条 grant 也没用。
 *   2. once 授权（用后即焚）。
 *   3. session 授权（本次运行内存）。
 *   4. workspace 授权（落盘，跨重启）。
 *   5. 以上全不命中 —— **拒绝**。没有隐式放行：一条通道进了需求表却没有任何
 *      授权，它就是被挡住的，而不是「先放过去再说」。
 */
import type { CapabilityGrant } from "@pibuddy/contract";

/** 一次授权请求（决策的输入）。 */
export interface PermissionQuery {
  capabilityId: string;
  permission: string;
  /** 更细粒度资源；null = 不限具体资源 */
  resource: string | null;
  /** 当前上下文 workspace；null = 无工作区 */
  workspaceId: string | null;
  /**
   * inherit：once + session + workspace（默认，前台交互）。
   * workspace-only：只认落盘预授权。子 Agent inheritPermissions=false、
   * 定时任务、Remote 批准后的后续评估都走这条，避免前台 allow-session 渗入无人值守。
   */
  sessionGrantPolicy?: "inherit" | "workspace-only";
}

export interface PermissionEngineDecision {
  allowed: boolean;
  reason: string | null;
}

/** 决策引擎的外部依赖（全部可注入，以便对拍不碰 electron）。 */
export interface PermissionEngineDeps {
  /** 某能力 manifest 声明（申请）的权限集合。上界校验的唯一数据源。 */
  declaredPermissions(capabilityId: string): ReadonlySet<string>;
  /** 某 workspace 落盘的授权表；无工作区（null）返回空。 */
  workspaceGrants(workspaceId: string | null): readonly CapabilityGrant[];
}

/** grant 是否覆盖一次请求：id / 权限相等，且 resource 为 null（通配）或同名。 */
export function grantCovers(grant: CapabilityGrant, query: PermissionQuery): boolean {
  if (grant.capabilityId !== query.capabilityId) return false;
  if (grant.permission !== query.permission) return false;
  if (grant.resource === null) return true;
  return grant.resource === query.resource;
}

export class CapabilityPermissionEngine {
  /** 本次运行内存里的 session 授权（重启即失效）。 */
  private readonly sessionGrantList: CapabilityGrant[] = [];
  /** once 授权：命中一次即被移除。 */
  private readonly onceGrantList: CapabilityGrant[] = [];

  constructor(private readonly deps: PermissionEngineDeps) {}

  /** 该能力是否**声明**过这条权限（上界）。grant 创建前必须先过这一关。 */
  isDeclared(capabilityId: string, permission: string): boolean {
    return this.deps.declaredPermissions(capabilityId).has(permission);
  }

  /**
   * 决策。**副作用仅限于消费一条命中的 once 授权**（其余只读）。
   */
  evaluate(query: PermissionQuery): PermissionEngineDecision {
    if (!this.isDeclared(query.capabilityId, query.permission)) {
      return {
        allowed: false,
        reason: `能力 "${query.capabilityId}" 未声明权限 "${query.permission}"`,
      };
    }

    if (query.sessionGrantPolicy !== "workspace-only") {
      const onceIdx = this.onceGrantList.findIndex((g) => grantCovers(g, query));
      if (onceIdx >= 0) {
        this.onceGrantList.splice(onceIdx, 1); // 用后即焚
        return { allowed: true, reason: null };
      }

      if (this.sessionGrantList.some((g) => grantCovers(g, query))) {
        return { allowed: true, reason: null };
      }
    }

    if (this.deps.workspaceGrants(query.workspaceId).some((g) => grantCovers(g, query))) {
      return { allowed: true, reason: null };
    }

    return { allowed: false, reason: `无适用授权：${query.capabilityId} / ${query.permission}` };
  }

  /** 记一条 once 授权。 */
  grantOnce(grant: CapabilityGrant): void {
    this.onceGrantList.push(grant);
  }

  /** 记一条 session 授权（按 id/权限/资源去重）。 */
  grantSession(grant: CapabilityGrant): void {
    const dup = this.sessionGrantList.some(
      (g) =>
        g.capabilityId === grant.capabilityId &&
        g.permission === grant.permission &&
        g.resource === grant.resource
    );
    if (!dup) this.sessionGrantList.push(grant);
  }

  /** 撤销匹配的 session 授权；返回撤掉的条数。 */
  revokeSession(capabilityId: string, permission: string, resource: string | null): number {
    let removed = 0;
    for (let i = this.sessionGrantList.length - 1; i >= 0; i--) {
      const g = this.sessionGrantList[i];
      if (g.capabilityId === capabilityId && g.permission === permission && g.resource === resource) {
        this.sessionGrantList.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** 当前 session 授权快照（副本）。 */
  sessionGrants(): CapabilityGrant[] {
    return this.sessionGrantList.map((g) => ({ ...g }));
  }

  /** 仅供单测：清空内存授权。 */
  resetInMemory(): void {
    this.sessionGrantList.length = 0;
    this.onceGrantList.length = 0;
  }
}
