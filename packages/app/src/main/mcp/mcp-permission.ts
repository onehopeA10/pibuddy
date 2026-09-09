import {
  CHANNELS,
  MCP_CAPABILITY_ID,
  MCP_GATED_CHANNELS,
  MCP_PERMISSION,
  mcpConfigResource,
  mcpIdRequestSchema,
  mcpRemoveRequestSchema,
  mcpSaveRequestSchema,
  type InvokeChannel,
} from "@pibuddy/contract";

import {
  registerChannelPermissionRequirements,
  type ChannelPermissionRequirement,
  type PermissionResourceResolver,
} from "../permission/channel-permission-requirements.js";
import {
  lookupMcpPermissionTarget,
  lookupMcpPermissionTargetByRef,
  mcpExecutionFingerprint,
} from "./mcp-config.js";
import { isOwnedMcpProcess } from "./mcp-service.js";

const runResourceOf: PermissionResourceResolver = (payload) => {
  const parsed = mcpIdRequestSchema.safeParse(payload);
  if (!parsed.success) return null;
  const target = lookupMcpPermissionTarget(parsed.data.workspaceId, parsed.data.id);
  if (!target) return null;
  // HTTP start/test cannot reach child_process in the implemented transport set.
  return target.resource ?? undefined;
};

const configResourceOf: PermissionResourceResolver = (payload) => {
  const parsed = mcpSaveRequestSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { workspaceId, scope, config } = parsed.data;
  // HTTP persistence cannot reach the stdio spawn path implemented by this capability.
  if (config.transport === "http") return undefined;
  return mcpConfigResource(
    workspaceId,
    scope,
    config.name,
    mcpExecutionFingerprint(config)
  );
};

const removeResourceOf: PermissionResourceResolver = (payload) => {
  const parsed = mcpRemoveRequestSchema.safeParse(payload);
  if (!parsed.success) return null;
  const target = lookupMcpPermissionTargetByRef(
    parsed.data.workspaceId,
    parsed.data.scope,
    parsed.data.name
  );
  if (!target) return null;
  return target.resource ?? undefined;
};

const stopResourceOf: PermissionResourceResolver = (payload) => {
  const parsed = mcpIdRequestSchema.safeParse(payload);
  if (!parsed.success) return null;
  // 已经由本工作区启动的进程，停止是生命周期回收，不再消耗新的执行授权。
  if (isOwnedMcpProcess(parsed.data.workspaceId, parsed.data.id)) return undefined;
  return runResourceOf(payload);
};

const RESOURCE_OF: Record<(typeof MCP_GATED_CHANNELS)[number], PermissionResourceResolver> = {
  [CHANNELS.mcpSave]: configResourceOf,
  [CHANNELS.mcpTest]: runResourceOf,
  [CHANNELS.mcpStart]: runResourceOf,
  [CHANNELS.mcpStop]: stopResourceOf,
  [CHANNELS.mcpRemove]: removeResourceOf,
};

export const MCP_CHANNEL_REQUIREMENTS: Partial<
  Record<InvokeChannel, ChannelPermissionRequirement>
> = Object.fromEntries(
  MCP_GATED_CHANNELS.map((channel) => [
    channel,
    {
      capabilityId: MCP_CAPABILITY_ID,
      permission: MCP_PERMISSION,
      resource: RESOURCE_OF[channel],
    },
  ])
);

export function registerMcpPermissionRequirements(): void {
  registerChannelPermissionRequirements(MCP_CHANNEL_REQUIREMENTS);
}
