/**
 * 把对话意图落到已有后端（记忆 / 定时任务 / 办公技能）。
 *
 * 挂在 `pi:prompt` 上，和 injectMemory 同一条缝：不改 Pi runtime，
 * 每个动作各自看能力开关。关掉对应能力 = 这段不存在。
 *
 * 聊天里说「每天九点提醒我」视为用户亲自建任务，不走渲染层 tasks.manage
 * 表单；无人值守 run 该要的预授权仍写在 requiredPermissions 里。
 */
import { isCapabilityEnabled } from "../capability/capability-state.js";
import { MEMORY_CAPABILITY_ID } from "../capability/manifests/memory.manifest.js";
import { OFFICE_SKILLS_CAPABILITY_ID } from "../capability/manifests/office-skills.manifest.js";
import { TASKS_CAPABILITY_ID } from "../capability/manifests/tasks.manifest.js";
import { memoryStore } from "../memory/memory-store.js";
import { humanTaskCreated } from "../../lib/task-plain.js";
import { computeNextRun, wallToEpoch, zonedParts } from "../tasks/schedule.js";
import { taskStore } from "../tasks/task-store.js";
import {
  parseConversationIntents,
  skillCommand,
  type ConversationIntent,
  type ScheduleIntent,
} from "./intent.js";

export interface ConversationActionContext {
  workspaceId?: string;
  sessionId?: string;
  now?: number;
  timeZone?: string;
}

export interface AppliedConversationActions {
  message: string;
  remembered: number;
  tasksCreated: number;
  skillAttached: string | null;
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function tomorrowEpoch(wallTime: string, timeZone: string, now: number): number {
  const [hour, minute] = wallTime.split(":").map(Number);
  const p = zonedParts(now, timeZone);
  const today = wallToEpoch(
    { year: p.year, month: p.month, day: p.day, hour, minute, second: 0 },
    timeZone
  );
  const probe = today.epoch + 24 * 60 * 60 * 1000;
  const np = zonedParts(probe, timeZone);
  return wallToEpoch(
    { year: np.year, month: np.month, day: np.day, hour, minute, second: 0 },
    timeZone
  ).epoch;
}

function resolveSchedule(intent: ScheduleIntent, timeZone: string, now: number): ScheduleIntent {
  if (intent.resolve === "tomorrow" && intent.wallTime) {
    const at = tomorrowEpoch(intent.wallTime, timeZone, now);
    return {
      ...intent,
      schedule: { kind: "once", at },
      name: `明天 ${intent.wallTime} · ${intent.prompt.replace(/\s+/g, " ").trim().slice(0, 16)}`,
    };
  }
  return intent;
}

function saveRemember(content: string, workspaceId: string, sessionId?: string): boolean {
  const outcome = memoryStore().save({
    workspaceId,
    content,
    type: "fact",
    scope: "workspace",
    sourceSessionId: sessionId ?? null,
    origin: "user",
  });
  return outcome.ok;
}

function createScheduleTask(
  intent: ScheduleIntent,
  workspaceId: string,
  timeZone: string,
  now: number
): boolean {
  const store = taskStore();
  const resolved = resolveSchedule(intent, timeZone, now);
  const dup = store.listTasks(workspaceId).some(
    (task) =>
      task.status === "active" &&
      JSON.stringify(task.schedule) === JSON.stringify(resolved.schedule) &&
      task.agent.prompt === resolved.prompt
  );
  if (dup) return false;
  const nextRunAt = computeNextRun(resolved.schedule, timeZone, now);
  store.createTask(
    {
      workspaceId,
      name: resolved.name.slice(0, 80),
      schedule: resolved.schedule,
      timezone: timeZone,
      agent: { provider: "", model: "", prompt: resolved.prompt },
      requiredPermissions: [],
      budgetUsd: null,
      timeoutMs: null,
      misfirePolicy: "skip",
      concurrencyPolicy: "forbid",
      failurePolicy: { retry: false, maxAttempts: 1, backoffMs: 0 },
    },
    now,
    nextRunAt
  );
  return true;
}

function describe(
  intent: ConversationIntent,
  extras?: { nextRunAt: number | null; timeZone: string; now: number }
): string {
  if (intent.kind === "remember") return `已记下：${intent.content}`;
  if (intent.kind === "schedule") {
    return humanTaskCreated({
      nextRunAt: extras?.nextRunAt ?? null,
      timeZone: extras?.timeZone ?? defaultTimeZone(),
      schedule: intent.schedule,
      now: extras?.now ?? Date.now(),
    });
  }
  return `已挂上办公技能 ${skillCommand(intent.skillName)}`;
}

function rewrite(message: string, notes: string[], skillName: string | null): string {
  let next = message;
  if (skillName && !next.includes(skillCommand(skillName))) {
    next = `${skillCommand(skillName)}\n\n${next}`;
  }
  if (notes.length === 0) return next;
  return `${next}\n\n[PiBuddy 已处理]\n${notes.map((n) => `- ${n}`).join("\n")}\n请用一句话向用户确认这些已经办好的事，不要假装还没做。`;
}

/**
 * 能力未开或没有 workspace 时原样返回，不写库。
 */
export function applyConversationActions(
  message: string,
  ctx: ConversationActionContext
): AppliedConversationActions {
  const empty: AppliedConversationActions = {
    message,
    remembered: 0,
    tasksCreated: 0,
    skillAttached: null,
  };
  if (!message.trim() || message.includes("[PiBuddy 已处理]")) return empty;

  const intents = parseConversationIntents(message);
  if (intents.length === 0) return empty;

  const workspaceId = ctx.workspaceId?.trim() || "";
  const now = ctx.now ?? Date.now();
  const timeZone = ctx.timeZone || defaultTimeZone();
  const notes: string[] = [];
  let remembered = 0;
  let tasksCreated = 0;
  let skillAttached: string | null = null;

  for (const intent of intents) {
    if (intent.kind === "remember") {
      if (!workspaceId || !isCapabilityEnabled(MEMORY_CAPABILITY_ID)) continue;
      if (saveRemember(intent.content, workspaceId, ctx.sessionId)) {
        remembered += 1;
        notes.push(describe(intent));
      }
      continue;
    }
    if (intent.kind === "schedule") {
      if (!workspaceId || !isCapabilityEnabled(TASKS_CAPABILITY_ID)) continue;
      const resolved = resolveSchedule(intent, timeZone, now);
      if (createScheduleTask(intent, workspaceId, timeZone, now)) {
        tasksCreated += 1;
        notes.push(
          describe(resolved, {
            nextRunAt: computeNextRun(resolved.schedule, timeZone, now),
            timeZone,
            now,
          })
        );
      } else {
        notes.push("相同的定时任务已经存在，没有重复创建");
      }
      continue;
    }
    if (isCapabilityEnabled(OFFICE_SKILLS_CAPABILITY_ID)) {
      skillAttached = intent.skillName;
      notes.push(describe(intent));
    }
  }

  if (remembered === 0 && tasksCreated === 0 && !skillAttached) return empty;
  return {
    message: rewrite(message, notes, skillAttached),
    remembered,
    tasksCreated,
    skillAttached,
  };
}
