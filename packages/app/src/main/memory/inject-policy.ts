/**
 * 注入热路径的唯一 skip 决策。
 *
 * 学自 DeepSeek Harness 的 tools/pre-execute：政策在一个挂钩上返回
 * allow / skip，调用方不得再写第二套 if。这里不碰 PermissionEngine——
 * 记忆建议永不参与授权。
 */
export type InjectSkipReason = "capability_disabled" | "missing_workspace" | "injection_inactive";

export type InjectPolicyDecision =
  | { action: "allow" }
  | { action: "skip"; reason: InjectSkipReason };

export function evaluateInjectPolicy(input: {
  capabilityEnabled: boolean;
  workspaceId: string;
  injectionActive: boolean;
}): InjectPolicyDecision {
  if (!input.capabilityEnabled) return { action: "skip", reason: "capability_disabled" };
  if (!input.workspaceId) return { action: "skip", reason: "missing_workspace" };
  if (!input.injectionActive) return { action: "skip", reason: "injection_inactive" };
  return { action: "allow" };
}
