/**
 * `window.piBuddy.permission`（ADR-0002 D3 / SEC-003）。
 *
 * 四个方法、四条通道。渲染进程能表达的极限是「告诉我当前授权」、「记一次
 * 决策」、「撤销一条授权」、以及一条**探针**（本轮的可证伪拦截点，也是将来
 * process.git 之类真实消费者的预留入口）。
 *
 * 授权决策**在主进程做**：这里没有任何「直接执行 Git/Shell」的入口，也没有
 * `invoke(channel, args)` 那种无约束通道（D4 规则 1）。渲染进程即便被攻陷，
 * 也只能申请到某个已启用能力**声明过**的权限——主进程按 manifest 上界二次
 * 校验，越不过去。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod）。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  PermissionDisposition,
  PermissionProbeResponse,
  PermissionState,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const permission = {
  /** 当前 workspace 的授权表 + session 授权 + 审计。 */
  describe: (workspaceId: string | null = null) =>
    invoke<PermissionState>(CHANNELS.permissionDescribe, { workspaceId }),

  /**
   * 记录一次决策。渲染进程只收集用户选择；grant 的合法性与持久化由主进程
   * 按 manifest 上界二次校验（危险权限的持久化还要过一次主进程原生确认框）。
   */
  decide: (input: {
    capabilityId: string;
    permission: string;
    resource?: string | null;
    disposition: PermissionDisposition;
    workspaceId?: string | null;
  }) =>
    invoke<PermissionState>(CHANNELS.permissionDecide, {
      capabilityId: input.capabilityId,
      permission: input.permission,
      resource: input.resource ?? null,
      disposition: input.disposition,
      workspaceId: input.workspaceId ?? null,
    }),

  /** 撤销一条 session 或 workspace 授权。 */
  revoke: (input: {
    capabilityId: string;
    permission: string;
    resource?: string | null;
    scope: "session" | "workspace";
    workspaceId?: string | null;
  }) =>
    invoke<PermissionState>(CHANNELS.permissionRevoke, {
      capabilityId: input.capabilityId,
      permission: input.permission,
      resource: input.resource ?? null,
      scope: input.scope,
      workspaceId: input.workspaceId ?? null,
    }),

  /**
   * 权限探针：声明自己需要 process.git，未授权时被第五道闸挡在 handler 之外
   * （抛 IPC_PERMISSION_DENIED）。授权后才返回 `{ok:true}`。
   */
  probe: (workspaceId: string | null = null) =>
    invoke<PermissionProbeResponse>(CHANNELS.permissionProbe, { workspaceId }),
};
