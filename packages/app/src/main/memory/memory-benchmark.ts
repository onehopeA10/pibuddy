/**
 * Phase 6：比较 memory off / canonical / recall / reflect 四种模式的计数。
 */
import { applyCapabilityResolution, enabledCapabilityIds, isCapabilityAssemblyDone } from "../capability/capability-state.js";
import { MEMORY_CAPABILITY_ID } from "../capability/manifests/memory.manifest.js";
import { isHindsightAvailable, setHindsightAvailable } from "./hindsight-adapter.js";
import { getLastMemoryPrep, injectMemory } from "./memory-inject.js";

export type BenchmarkMode = "off" | "canonical" | "recall" | "reflect";

export interface ModeStats {
  mode: BenchmarkMode;
  retrieved: number;
  injected: boolean;
  plannedMode: string;
}

export async function benchmarkMemoryModes(
  message: string,
  workspaceId: string,
  sessionId: string
): Promise<Record<BenchmarkMode, ModeStats>> {
  const assembled = isCapabilityAssemblyDone();
  const previousCaps = enabledCapabilityIds();
  const previousHindsight = isHindsightAvailable();

  try {
    applyCapabilityResolution([]);
    setHindsightAvailable(false);
    const offMsg = await injectMemory(message, workspaceId, `${sessionId}-off`);
    const off: ModeStats = { mode: "off", retrieved: 0, injected: offMsg !== message, plannedMode: "off" };

    applyCapabilityResolution([MEMORY_CAPABILITY_ID]);
    setHindsightAvailable(false);
    const canMsg = await injectMemory("这个 repo 怎么 build？", workspaceId, `${sessionId}-can`);
    const can = getLastMemoryPrep();
    const canonical: ModeStats = {
      mode: "canonical",
      retrieved: can?.recalled ?? 0,
      injected: canMsg !== "这个 repo 怎么 build？",
      plannedMode: can?.plannedMode ?? "canonical",
    };

    setHindsightAvailable(true);
    const recPrompt = "我之前说过默认喜欢哪个包管理器？";
    const recMsg = await injectMemory(recPrompt, workspaceId, `${sessionId}-rec`);
    const rec = getLastMemoryPrep();
    const recall: ModeStats = {
      mode: "recall",
      retrieved: rec?.recalled ?? 0,
      injected: recMsg !== recPrompt,
      plannedMode: rec?.plannedMode ?? "recall",
    };

    const refPrompt = "为什么最近几次部署总失败？";
    const refMsg = await injectMemory(refPrompt, workspaceId, `${sessionId}-ref`);
    const ref = getLastMemoryPrep();
    const reflect: ModeStats = {
      mode: "reflect",
      retrieved: ref?.recalled ?? 0,
      injected: refMsg !== refPrompt,
      plannedMode: ref?.plannedMode ?? "reflect",
    };

    return { off, canonical, recall, reflect };
  } finally {
    if (assembled) applyCapabilityResolution(previousCaps);
    setHindsightAvailable(previousHindsight);
  }
}
