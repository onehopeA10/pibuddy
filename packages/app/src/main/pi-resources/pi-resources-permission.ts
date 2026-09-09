import {
  CHANNELS,
  PI_RESOURCES_CAPABILITY_ID,
  PI_RESOURCES_GATED_CHANNELS,
  PI_RESOURCES_PERMISSION,
  piPackageCommandRequestSchema,
  piPackagePermissionResource,
  type InvokeChannel,
} from "@pibuddy/contract";

import {
  registerChannelPermissionRequirements,
  type ChannelPermissionRequirement,
} from "../permission/channel-permission-requirements.js";

// The resolver receives only a payload, so each row closes over its immutable action.
function requirement(action: "install" | "remove"): ChannelPermissionRequirement {
  return {
    capabilityId: PI_RESOURCES_CAPABILITY_ID,
    permission: PI_RESOURCES_PERMISSION,
    resource(payload) {
      const parsed = piPackageCommandRequestSchema.safeParse(payload);
      if (!parsed.success) return null;
      return piPackagePermissionResource(
        action,
        parsed.data.scope,
        parsed.data.workspaceId,
        parsed.data.spec
      );
    },
  };
}

// Kept as an exported table so tests can assert the exact two-channel surface.
export const PI_RESOURCES_CHANNEL_REQUIREMENTS: Partial<
  Record<InvokeChannel, ChannelPermissionRequirement>
> = {
  [CHANNELS.piResourcesInstall]: requirement("install"),
  [CHANNELS.piResourcesRemove]: requirement("remove"),
};

export function registerPiResourcesPermissionRequirements(): void {
  if (PI_RESOURCES_GATED_CHANNELS.length !== 2) {
    throw new Error("PI_RESOURCES_GATED_CHANNELS changed without updating permission requirements");
  }
  registerChannelPermissionRequirements(PI_RESOURCES_CHANNEL_REQUIREMENTS);
}
