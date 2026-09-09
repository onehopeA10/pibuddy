/**
 * 定时任务交互面的第五道闸。
 *
 * 无人值守 run 仍只认 workspace 预授权（task-permission.ts）。
 * 这里管的是渲染层 create / update / delete / run-now 等改调度表的通道。
 */
import { CHANNELS, type InvokeChannel } from "@pibuddy/contract";

import {
  registerChannelPermissionRequirements,
  type ChannelPermissionRequirement,
} from "../permission/channel-permission-requirements.js";
import { TASKS_CAPABILITY_ID } from "./task-permission.js";

export const TASKS_PERMISSION = "tasks.manage";

export const TASKS_GATED_CHANNELS = [
  CHANNELS.tasksCreate,
  CHANNELS.tasksUpdate,
  CHANNELS.tasksDelete,
  CHANNELS.tasksPause,
  CHANNELS.tasksResume,
  CHANNELS.tasksRunNow,
  CHANNELS.tasksCancelRun,
  CHANNELS.tasksRetryRun,
  CHANNELS.tasksDuplicate,
] as const;

export const TASKS_CHANNEL_REQUIREMENTS: Partial<
  Record<InvokeChannel, ChannelPermissionRequirement>
> = Object.fromEntries(
  TASKS_GATED_CHANNELS.map((channel) => [
    channel,
    { capabilityId: TASKS_CAPABILITY_ID, permission: TASKS_PERMISSION },
  ])
);

export function registerTasksPermissionRequirements(): void {
  registerChannelPermissionRequirements(TASKS_CHANNEL_REQUIREMENTS);
}
