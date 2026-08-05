/**
 * 能力权限的渲染侧状态（ADR-0002 D3 / SEC-003）。
 *
 * 渲染进程只做两件事：**把当前授权画出来**、**把用户的选择交给主进程**。
 * 决策与拦截都在主进程（第五道闸），因此这里没有任何「直接执行」的能力——
 * 一个被攻陷的渲染进程能做的极限也只是弹一个它自己的框，而框里点出来的
 * 授权最终仍要被主进程按 manifest 上界二次校验。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { projectPermissionPrompt } from "@contract";
import type {
  CapabilityGrant,
  PermissionAuditEntry,
  PermissionDisposition,
  PermissionPromptView,
  PermissionState,
} from "@contract";

/** 一次待用户裁决的授权申请（**原始输入**，尚未投影）。 */
export interface PendingPermission {
  capabilityId: string;
  permission: string;
  resource: string | null;
  /**
   * 危险命令原文（终端 / git 之类的消费者提供）。给了就要显示，于是
   * 「截断后类别必须不变」这条判据生效——不变才弹窗，变了就拒绝弹窗。
   */
  command?: string | null;
}

export const usePermissionStore = defineStore("permission", () => {
  const workspaceId = ref<string | null>(null);
  const workspaceGrants = shallowRef<CapabilityGrant[]>([]);
  const sessionGrants = shallowRef<CapabilityGrant[]>([]);
  const audit = shallowRef<PermissionAuditEntry[]>([]);
  const lastError = ref("");

  /** 授权中心（列表 + 撤销）是否打开。 */
  const centerOpen = ref(false);
  /** 当前待裁决的申请**的投影**；null = 无弹窗。弹窗只读这一份。 */
  const pending = ref<PermissionPromptView | null>(null);
  /**
   * 被投影拒绝的上一次申请（fail-closed 的可见形态）。
   *
   * 不弹窗不等于"什么都没发生"：那次动作被拒绝了，用户有权知道原因。留一条
   * 而不是静默丢弃——静默丢弃会让"权限框没弹出来"和"功能坏了"变成同一种表现。
   */
  const lastRejectedPrompt = ref("");

  const grantCount = computed(() => workspaceGrants.value.length + sessionGrants.value.length);

  function apply(state: PermissionState): void {
    workspaceId.value = state.workspaceId;
    workspaceGrants.value = state.workspaceGrants;
    sessionGrants.value = state.sessionGrants;
    audit.value = state.audit;
  }

  async function refresh(wsId: string | null = workspaceId.value): Promise<void> {
    try {
      apply(await window.piBuddy.permission.describe(wsId));
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  /**
   * 打开裁决弹窗（例如某个动作被第五道闸挡下后，界面据此发起申请）。
   *
   * **先投影再弹窗**：所有要显示给用户的字符串都经 `projectPermissionPrompt`
   * 剥掉控制字符与 BiDi 覆写字符、做有界化，命令还要再过一遍「截断后类别不变」。
   * 投影抛错 = 这次申请弹不出一个诚实的框 → **不弹**（返回 false），而不是弹一个
   * 会误导用户的框。渲染进程本来就不放行任何东西，所以这里 fail-closed 的代价
   * 只是"这次动作做不成"。
   */
  function request(req: PendingPermission): boolean {
    try {
      pending.value = projectPermissionPrompt(req);
      lastRejectedPrompt.value = "";
      return true;
    } catch (err) {
      pending.value = null;
      lastRejectedPrompt.value = (err as Error).message;
      return false;
    }
  }

  /** 用户在弹窗上选定一档。deny 也会被如实记入审计。 */
  async function decide(disposition: PermissionDisposition): Promise<void> {
    const req = pending.value;
    if (!req) return;
    try {
      apply(
        await window.piBuddy.permission.decide({
          capabilityId: req.capabilityId,
          permission: req.permission,
          resource: req.resource,
          disposition,
          workspaceId: workspaceId.value,
        })
      );
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      pending.value = null;
    }
  }

  async function revoke(
    grant: CapabilityGrant,
    scope: "session" | "workspace"
  ): Promise<void> {
    try {
      apply(
        await window.piBuddy.permission.revoke({
          capabilityId: grant.capabilityId,
          permission: grant.permission,
          resource: grant.resource,
          scope,
          workspaceId: workspaceId.value,
        })
      );
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  return {
    workspaceId,
    workspaceGrants,
    sessionGrants,
    audit,
    lastError,
    centerOpen,
    pending,
    lastRejectedPrompt,
    grantCount,
    refresh,
    request,
    decide,
    revoke,
  };
});
