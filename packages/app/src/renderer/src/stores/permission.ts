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
import type {
  CapabilityGrant,
  PermissionAuditEntry,
  PermissionDisposition,
  PermissionState,
} from "@contract";

/** 一次待用户裁决的授权申请。 */
export interface PendingPermission {
  capabilityId: string;
  permission: string;
  resource: string | null;
}

export const usePermissionStore = defineStore("permission", () => {
  const workspaceId = ref<string | null>(null);
  const workspaceGrants = shallowRef<CapabilityGrant[]>([]);
  const sessionGrants = shallowRef<CapabilityGrant[]>([]);
  const audit = shallowRef<PermissionAuditEntry[]>([]);
  const lastError = ref("");

  /** 授权中心（列表 + 撤销）是否打开。 */
  const centerOpen = ref(false);
  /** 当前待裁决的申请；null = 无弹窗。 */
  const pending = ref<PendingPermission | null>(null);

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

  /** 打开裁决弹窗（例如某个动作被第五道闸挡下后，界面据此发起申请）。 */
  function request(req: PendingPermission): void {
    pending.value = req;
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
    grantCount,
    refresh,
    request,
    decide,
    revoke,
  };
});
