/**
 * Memory Router：按 TaskAnalysis 出 MemoryPlan。
 * Adapter 不可用时 recall/reflect 才降级 canonical。
 */
import type { MemoryPlan, TaskAnalysis } from "@pibuddy/contract";

import { isHindsightAvailable } from "./hindsight-adapter.js";
import { compileQuery } from "./query-compiler.js";

export function effectiveMode(mode: MemoryPlan["mode"]): "none" | "canonical" | "recall" | "reflect" {
  if (mode === "none") return "none";
  if ((mode === "recall" || mode === "reflect") && !isHindsightAvailable()) return "canonical";
  return mode;
}

/** @deprecated 用 effectiveMode；保留以免旧调用崩 */
export function degradeMode(mode: MemoryPlan["mode"]): "none" | "canonical" {
  const next = effectiveMode(mode);
  return next === "none" ? "none" : "canonical";
}

function liveRefsFor(message: string, analysis: TaskAnalysis): Array<{ ref: string }> {
  const refs: Array<{ ref: string }> = [];
  if (/会议|日程|calendar/i.test(message)) refs.push({ ref: "calendar" });
  if (/package\.json|包管理器|node|版本/i.test(message) || analysis.currentStateNeed === "required") {
    if (/会议|日程|calendar/i.test(message) && !/package\.json|包管理|node|版本/i.test(message)) {
      return refs;
    }
    refs.push({ ref: "package.json" });
  }
  return refs;
}

export function planMemory(analysis: TaskAnalysis, message = ""): MemoryPlan {
  let mode: MemoryPlan["mode"] = "canonical";
  if (analysis.genericKnowledge && analysis.memorySignal !== "explicit") {
    mode = "none";
  } else if (analysis.historyNeed === "pattern") {
    mode = "reflect";
  } else if (analysis.historyNeed === "episodic" || analysis.historyNeed === "continuation") {
    mode = "recall";
  }

  const query = compileQuery(message, analysis) || (analysis.genericKnowledge ? "" : message);
  const project = analysis.scopes.project;
  const liveValidations = liveRefsFor(message, analysis);
  return {
    mode,
    working: {
      read: mode !== "none",
      write: mode !== "none",
      dedupeLoadedSources: true,
    },
    canonicalReads: project
      ? [
          {
            scope: "project",
            kind: analysis.logicalKinds.includes("procedure") ? "procedure" : "fact",
            route: "l1_pointer",
            key: query || "project",
            maxTokens: 2000,
            validateLive: liveValidations.length > 0 || analysis.currentStateNeed === "required",
          },
        ]
      : [],
    recalls: mode === "recall" || mode === "reflect" ? [{ query: query || message }] : [],
    reflections: mode === "reflect" ? [{ query: query || message }] : [],
    liveValidations,
  };
}
