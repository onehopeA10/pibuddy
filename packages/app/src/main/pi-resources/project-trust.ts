import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProjectTrustState } from "@pibuddy/contract";

import { requireWorkspaceRoot } from "../workspace-registry.js";
import { describeTrust } from "./trust-store.js";

/** Decisions that apply only to this app process and are not written to trust.json. */
const sessionTrust = new Map<string, "allow" | "deny">();
type ProjectTrustListener = (
  workspaceId: string,
  state: ProjectTrustState
) => void | Promise<void>;
const trustListeners = new Set<ProjectTrustListener>();

export function sessionTrustFor(workspaceId: string): "allow" | "deny" | undefined {
  return sessionTrust.get(workspaceId);
}

export function setSessionTrustDecision(
  workspaceId: string,
  decision: "allow" | "deny" | undefined
): void {
  if (decision === undefined) sessionTrust.delete(workspaceId);
  else sessionTrust.set(workspaceId, decision);
}

export function __resetProjectTrustState(): void {
  sessionTrust.clear();
}

/** 可选能力向内核订阅 trust 变化；返回值用于能力 deactivate 时解除订阅。 */
export function onProjectTrustChange(listener: ProjectTrustListener): () => void {
  trustListeners.add(listener);
  return () => trustListeners.delete(listener);
}

/** trust 决定落地后通知运行期消费者先完成收敛，再把新状态返回 renderer。 */
export async function notifyProjectTrustChange(
  workspaceId: string,
  state: ProjectTrustState
): Promise<void> {
  await Promise.all([...trustListeners].map((listener) => listener(workspaceId, state)));
}

async function readPiUserSettings(): Promise<Record<string, unknown>> {
  const file = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Resolve the same project-trust decision for Pi package operations, Pi runtime
 * startup, and project-scoped MCP. A session-only answer wins only when there is
 * no persisted decision, matching the existing resource-center behavior.
 */
export async function currentProjectTrust(
  workspaceId: string,
  workspaceRoot: string = requireWorkspaceRoot(workspaceId)
): Promise<ProjectTrustState> {
  const piSettings = await readPiUserSettings();
  const raw = piSettings.defaultProjectTrust;
  const defaultProjectTrust =
    raw === "always" || raw === "never" || raw === "ask" ? raw : "ask";
  const state = await describeTrust({
    workspaceId,
    workspaceRoot,
    defaultProjectTrust,
  });
  const once = sessionTrust.get(workspaceId);
  if (once && state.saved === "none") {
    return { ...state, effective: once, needsPrompt: false };
  }
  return state;
}
