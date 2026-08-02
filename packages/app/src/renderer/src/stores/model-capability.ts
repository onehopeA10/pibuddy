/**
 * 模型输入能力的判定（PROV-101）。
 *
 * ## 判据只有一个：`Model.input`
 *
 * 来自 pi 的 `get_available_models`（rpc.md:259，Model 结构见 pi-sdk 的
 * `types.ts:103`）。数组里含 `"image"` 才能收图片。
 *
 * **绝不硬编码模型名单**：名单一旦写进代码，pi 侧新增一个支持图片的模型
 * 之后，PiBuddy 会静默地把它判成「不支持图片」—— 用户拖进去的图被拦住，
 * 而 typecheck、单测、构建全绿。这类失败没有任何报错通道，只能靠「唯一
 * 判据是上游返回的字段」在结构上杜绝。
 *
 * ## 缺字段时保守处理
 *
 * `input` 缺席时按「只支持文本」处理：真发出去的后果是一次 API 报错 +
 * 一次计费，而拦下来的后果只是让用户点一下「切换模型」。两者不对称，
 * 所以往保守一侧倒。**但没有图片时一律放行** —— 纯文本消息绝不能因为
 * 上游少给了一个字段就发不出去。
 */
import type { Model } from "@sdk";

/** 判定用得到的最小模型形状。刻意不要求完整的 `Model`，便于单测直接构造。 */
export interface ModelLike {
  id: string;
  provider?: string;
  name?: string;
  input?: string[];
}

/** 该模型是否收得下图片。 */
export function supportsImage(model: ModelLike | null | undefined): boolean {
  return (model?.input ?? []).includes("image");
}

export type ImageCapabilityVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "no-image-support";
      currentModelId: string;
      /** 可以切过去的模型（按 input 含 image 过滤）。空数组时界面只能提示删图 */
      suggestedModelIds: string[];
    };

/**
 * 发送前的图片能力守卫。
 *
 * `imageCount === 0` 时恒放行 —— 这是**唯一**的短路条件，写在最前面是为了
 * 让「纯文本消息永远发得出去」这件事在代码结构上就成立，而不是靠下面某个
 * 分支恰好没命中。
 */
export function assertImageCapable(
  model: ModelLike | null | undefined,
  imageCount: number,
  available: ModelLike[] = []
): ImageCapabilityVerdict {
  if (imageCount <= 0) return { ok: true };
  if (supportsImage(model)) return { ok: true };
  return {
    ok: false,
    reason: "no-image-support",
    currentModelId: model?.id ?? "(未选择模型)",
    suggestedModelIds: available.filter(supportsImage).map((m) => m.id),
  };
}

/** 供 UI 渲染「切换到支持图片的模型」列表。顺序沿用上游给的顺序。 */
export function imageCapableModels(models: Model[]): Model[] {
  return models.filter((m) => supportsImage(m));
}

/** 拦截时给用户看的那句话。必须带上当前模型 id，否则用户不知道该换掉谁。 */
export function imageBlockedMessage(verdict: Extract<ImageCapabilityVerdict, { ok: false }>): string {
  return verdict.suggestedModelIds.length > 0
    ? `当前模型「${verdict.currentModelId}」不支持图片，请切换到支持图片的模型后再发送`
    : `当前模型「${verdict.currentModelId}」不支持图片，且没有找到支持图片的模型，请先移除图片`;
}
