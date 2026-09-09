/**
 * 定时任务的权限判定——**这是本能力的关键安全点**（ADR-0002 D3 / SEC-003）。
 *
 * ## 无人值守的定时 run 只认 workspace（预授权、落盘）授权
 *
 * 交互会话里的 allow-once / allow-session 活在**主进程内存**里，是「用户此刻
 * 就在屏幕前、为紧接着这一次点了同意」的语义。定时任务是无人值守的：它触发
 * 时用户可能在睡觉。如果它能拿到 once/session 授权，就等于「用户三天前为某次
 * 交互点的同意，被一个凌晨自动跑的任务借用了」——那就绕开了人工确认，正是
 * ADR D3 要防的事。
 *
 * 因此本模块**只读 workspace 授权**（`WorkspaceProfile.capabilityGrants`，那张
 * 落盘、跨重启、危险权限需过原生确认框才能写进去的表）。它在结构上就够不到
 * 交互引擎的 once/session 列表——不是「我们记得别去读」，而是这个函数的入参
 * 里根本没有那两个列表。
 *
 * 缺授权时的动作是**等待 owner**：run 被登记为 blocked（附上缺哪几条权限），
 * 不执行、不静默失败。用户在权限中心给这个工作区补上 allow-workspace（危险
 * 权限会弹原生框），下一次触发就通得过。
 *
 * ## 只调用、不改权限引擎
 *
 * `grantCovers` 从 `permission-engine` 直接引用（纯函数，read-only）。本模块
 * 不碰 `main/permission/**` 的任何既有逻辑，只复用它对「一条授权是否覆盖一次
 * 请求」的唯一定义，避免两处判据漂移。
 */
import type { CapabilityGrant } from "@pibuddy/contract";

import { grantCovers } from "../permission/permission-engine.js";

/** 定时任务权限授予时归属的 capabilityId（授权中心里以此为键落 allow-workspace）。 */
export const TASKS_CAPABILITY_ID = "common.tasks";

/** inbox / 裁决弹窗要用声明了该权限的能力，否则 decidePermission 会因越上界拒掉。 */
export function inboxCapabilityOf(permission: string): string {
  if (permission === "process.git") return "coding.git";
  if (permission === "process.shell") return "coding.terminal";
  if (permission === "workspace.read" || permission === "workspace.write") {
    return "common.workspace-files";
  }
  if (permission === "network.local") return "home.assistant";
  if (permission === "tasks.manage") return TASKS_CAPABILITY_ID;
  return TASKS_CAPABILITY_ID;
}

export interface ScheduledPermissionResult {
  allowed: boolean;
  /** requiredPermissions 里当前 workspace 尚无落盘授权的那些；空=已就绪。 */
  missing: string[];
}

/**
 * 判定一次定时 run 需要的权限是否都已被 workspace 预授权。
 *
 * **只看 `workspaceGrants`**——绝不接受、也无从接受交互会话的 once/session
 * 授权。这正是「定时任务不继承 allow-once」的落地：入参里没有那两个列表。
 */
export function evaluateScheduledPermissions(
  required: readonly string[],
  workspaceId: string | null,
  workspaceGrants: readonly CapabilityGrant[]
): ScheduledPermissionResult {
  const missing: string[] = [];
  for (const permission of required) {
    const covered = workspaceGrants.some((grant) =>
      grantCovers(grant, {
        capabilityId: grant.capabilityId,
        permission,
        resource: null,
        workspaceId,
      })
    );
    if (!covered) missing.push(permission);
  }
  return { allowed: missing.length === 0, missing };
}
