/**
 * 提示词注入钩子（MEM-101 第一版的唯一内核接触点）。
 *
 * ## 零成本门控（feature gate）
 *
 * `injectMemory` 的**第一行**就是能力启用判定：`common.memory` 未启用时立即
 * 原样返回，不碰记忆库、不开 sqlite、不抽词、不查询。这条钩子被挂在 pi:prompt
 * 这条热路径上，未启用时它必须等价于「不存在」——否则「关掉记忆」会变成
 * 「关掉记忆但每发一句话还是白跑一遍检索」。对拍见 memory-inject.spec
 * （拆掉这道门 → disabled 路径也去开库 → 变红）。
 *
 * ## 命中记录只存脱敏摘要
 *
 * 注入了哪些记忆要能被用户在隐私 / 调试视图里看到（「这一轮我被塞了什么」）。
 * 但命中记录**不存正文全文**：只存一段短摘要。sensitive 的记忆在 store 侧的
 * SQL 里就被挡在候选之外，因此根本不会走到这里，也不会进命中记录。
 *
 * ## 删除必须让命中也归零
 *
 * 「保存 → 命中 → 删除 → 再查零命中」这条时序里，删除之后连**历史命中记录**
 * 里都不该再出现那条记忆 —— 否则隐私视图会一直显示一条已经不存在的记忆的摘要。
 * `clearHitsForMemory` 由 IPC 层在删除 / 合并时调用。
 */
import { isCapabilityEnabled } from "../capability/capability-state.js";
import { MEMORY_CAPABILITY_ID } from "../capability/manifests/memory.manifest.js";
import { extractTerms, memoryStore, type InjectionCandidate } from "./memory-store.js";
import type { MemoryHit } from "@pibuddy/contract";

/** 一轮最多注入几条：太多会挤占上下文，也稀释相关性。 */
const MAX_INJECTED = 8;
/** 每个工作区保留的命中历史条数上限（内存 cache）。 */
const MAX_HITS_PER_WS = 100;

/** workspaceId → 最近的注入命中（新在前）。删除记忆时会从这里一并清掉。 */
const recentHits = new Map<string, MemoryHit[]>();

/** 类别标签 → 中文，注入块里给模型一点结构提示。 */
const TYPE_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  instruction: "指令",
  context: "背景",
};

function previewOf(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/**
 * 把命中的记忆折成一段注入块。返回空串表示这一轮什么都不注入。
 */
function buildBlock(hits: InjectionCandidate[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => `- （${TYPE_LABEL[h.type] ?? h.type}）${h.content}`);
  return ["[长期记忆]", "以下是之前记住的信息，供参考（可能已过时，以当前对话为准）：", ...lines, "[/长期记忆]"].join(
    "\n"
  );
}

/**
 * 在一条 prompt 前注入相关记忆。
 *
 * @returns 注入后的 message；未启用 / 未命中 / 注入被关时原样返回入参。
 */
export function injectMemory(message: string, workspaceId: string): string {
  // —— 零成本门：未启用时到此为止，绝不触碰记忆库 ——
  if (!isCapabilityEnabled(MEMORY_CAPABILITY_ID)) return message;
  if (!workspaceId) return message;

  const store = memoryStore();
  if (!store.injectionActive(workspaceId)) return message;

  const terms = extractTerms(message);
  if (terms.length === 0) return message;

  const hits = store.injectionCandidates(workspaceId, terms, MAX_INJECTED);
  if (hits.length === 0) return message;

  recordHits(workspaceId, hits);
  const block = buildBlock(hits);
  return `${block}\n\n${message}`;
}

function recordHits(workspaceId: string, hits: InjectionCandidate[]): void {
  const at = Date.now();
  const entries: MemoryHit[] = hits.map((h) => ({
    id: h.id,
    type: h.type,
    scope: h.scope,
    preview: previewOf(h.content),
    at,
  }));
  const list = [...entries, ...(recentHits.get(workspaceId) ?? [])].slice(0, MAX_HITS_PER_WS);
  recentHits.set(workspaceId, list);
}

/** 某工作区的注入命中历史（新在前）。 */
export function memoryHitsFor(workspaceId: string): MemoryHit[] {
  return [...(recentHits.get(workspaceId) ?? [])];
}

/**
 * 从命中历史里抹掉某条记忆的所有痕迹（删除 / 合并时调用）。
 *
 * 不这么做的话，一条被删掉的记忆的摘要会一直挂在隐私视图里，
 * 「删除后不再出现」这条承诺就只兑现了一半。
 */
export function clearHitsForMemory(id: string): void {
  for (const [ws, hits] of recentHits) {
    const filtered = hits.filter((h) => h.id !== id);
    if (filtered.length !== hits.length) recentHits.set(ws, filtered);
  }
}

/** 拆卸：清空命中 cache（禁用能力 / 单测）。**不删任何记忆**。 */
export function disposeMemoryInject(): void {
  recentHits.clear();
}
