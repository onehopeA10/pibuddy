/**
 * 模型作用域的三层解析（PROV-101）。
 *
 * ## 为什么必须是三层
 *
 * 合成一层的后果很具体：用户在设置里把默认模型改成 A，然后打开一条三个月前
 * 用 B 跑的会话 —— 如果只有「全局默认」这一层，那条会话会被**静默地**换成
 * A 继续跑。它不报错、不提示，只是从那一刻起回答风格变了、价格变了，而
 * 会话文件里已经记着的 B 被覆盖掉。
 *
 * 优先级写死为 **session > workspace > global**，没有任何条件分支能改变它。
 * 「这条会话当时用的是什么」永远赢，因为那是一个**事实**，而另外两层只是
 * 偏好。
 *
 * ## mismatch 只是事实，不再弹询问
 *
 * 当 session 层与 workspace/global 不一致时，本模块仍返回 `mismatch: true`
 * 供调用方对照。界面**不再询问「是否切换」**：打开历史会话一律沿用会话
 * 记下的模型；全局 / workspace 默认只作用于新会话。
 */
import type { ModelRef, ModelScope } from "@pibuddy/contract";

export interface ResolveModelInput {
  /** 会话文件里记着的模型（恢复历史会话时来自 pi 的 AgentState） */
  sessionModel?: ModelRef | null;
  /** 当前 workspace 的默认模型 */
  workspaceDefault?: ModelRef | null;
  /** 全局默认模型 */
  globalDefault?: ModelRef | null;
}

export interface ResolveModelResult {
  /** 最终应当生效的模型；三层都空时为 null（界面走 no-model 空状态） */
  model: ModelRef | null;
  /** 生效值来自哪一层 */
  source: ModelScope | "none";
  /**
   * session 层与「若无 session 层则会生效的那一层」是否不同。
   *
   * 只有恢复历史会话时才可能为 true。界面不再据此弹询问，只沿用 session。
   */
  mismatch: boolean;
  /** 若无 session 层则会生效的那个模型（对照用，不再驱动切换询问） */
  wouldBe: ModelRef | null;
}

function same(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  if (!a || !b) return false;
  return a.provider === b.provider && a.modelId === b.modelId;
}

/** 规范化：字段缺失或空串一律当成「这一层没设」。 */
function normalize(ref: ModelRef | null | undefined): ModelRef | null {
  if (!ref) return null;
  if (typeof ref.provider !== "string" || typeof ref.modelId !== "string") return null;
  if (ref.provider.trim() === "" || ref.modelId.trim() === "") return null;
  return { provider: ref.provider, modelId: ref.modelId };
}

export function resolveModel(input: ResolveModelInput): ResolveModelResult {
  const session = normalize(input.sessionModel);
  const workspace = normalize(input.workspaceDefault);
  const global = normalize(input.globalDefault);

  /** 没有 session 层时会生效的那个值 —— 也就是「切换」按钮的目标。 */
  const fallback = workspace ?? global;

  if (session) {
    return {
      model: session,
      source: "session",
      // fallback 为空时不算 mismatch：没有可切换的目标，问也白问
      mismatch: fallback !== null && !same(session, fallback),
      wouldBe: fallback,
    };
  }
  if (workspace) {
    return { model: workspace, source: "workspace", mismatch: false, wouldBe: null };
  }
  if (global) {
    return { model: global, source: "global", mismatch: false, wouldBe: null };
  }
  return { model: null, source: "none", mismatch: false, wouldBe: null };
}
