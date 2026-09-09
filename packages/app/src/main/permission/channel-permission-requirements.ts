import {
  CHANNELS,
  GIT_CAPABILITY_ID,
  GIT_GATED_CHANNELS,
  GIT_PERMISSION,
  PERMISSION_PROBE_CAPABILITY_ID,
  PERMISSION_PROBE_PERMISSION,
  TERMINAL_CAPABILITY_ID,
  TERMINAL_GATED_CHANNELS,
  TERMINAL_PERMISSION,
  type InvokeChannel,
} from "@pibuddy/contract";

/**
 * `undefined` means the requirement does not apply to this payload, `null` means
 * the payload could not be bound to a concrete resource and must fail closed.
 */
export type PermissionResourceResolver = (payload: unknown) => string | null | undefined;

export interface ChannelPermissionRequirement {
  capabilityId: string;
  permission: string;
  resource?: PermissionResourceResolver;
}

/**
 * Kernel-owned channel requirement registry. Optional capabilities register their
 * rows during activation, so the kernel never imports an optional implementation.
 */
export const CHANNEL_PERMISSION_REQUIREMENTS: Partial<
  Record<InvokeChannel, ChannelPermissionRequirement>
> = {
  [CHANNELS.permissionProbe]: {
    capabilityId: PERMISSION_PROBE_CAPABILITY_ID,
    permission: PERMISSION_PROBE_PERMISSION,
  },
  ...Object.fromEntries(
    GIT_GATED_CHANNELS.map((channel) => [
      channel,
      { capabilityId: GIT_CAPABILITY_ID, permission: GIT_PERMISSION },
    ])
  ),
  ...Object.fromEntries(
    TERMINAL_GATED_CHANNELS.map((channel) => [
      channel,
      { capabilityId: TERMINAL_CAPABILITY_ID, permission: TERMINAL_PERMISSION },
    ])
  ),
};

/** Register or refresh a domain's rows. Conflicting ownership is a startup error. */
export function registerChannelPermissionRequirements(
  requirements: Partial<Record<InvokeChannel, ChannelPermissionRequirement>>
): void {
  for (const [rawChannel, requirement] of Object.entries(requirements)) {
    if (!requirement) continue;
    const channel = rawChannel as InvokeChannel;
    const existing = CHANNEL_PERMISSION_REQUIREMENTS[channel];
    if (
      existing &&
      (existing.capabilityId !== requirement.capabilityId ||
        existing.permission !== requirement.permission)
    ) {
      throw new Error(
        `IPC_PERMISSION_REQUIREMENT_CONFLICT: ${channel} belongs to ${existing.capabilityId}/${existing.permission}`
      );
    }
    CHANNEL_PERMISSION_REQUIREMENTS[channel] = requirement;
  }
}
