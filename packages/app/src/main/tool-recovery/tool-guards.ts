/**
 * 工具派发前的三道护栏：循环闸、不确定档、参数违规的教学式回执。
 *
 * 三条都在 **impl 之前**（不确定档是它的镜像：impl 之后判「不知道有没有生效」），
 * 与 T1/T2 夹逼住在同一段路上——所以放在 tool-recovery/ 而不是另起一个域：
 * 「这次调用到底该不该跑 / 跑没跑成」是同一个问题的两半。
 *
 * ## 循环闸为什么必须是「连续」而不是「累计」
 *
 * 判据是「同一个 tool + 同一份实参**连续**失败 N 次」。成功一次、或者任何一次
 * 不同的调用，都把连击清零。这半句不是优化，是这条闸能不能用的前提：
 *
 *   - **轮询**：反复 `status` 直到通过 —— 前几次失败、最后一次成功。累计计数
 *     会在第三次失败时把它拦死，而它本来再等一秒就好了。
 *   - **改了再测**：`edit` 一个文件 → 重跑同一条失败的测试。中间那次 `edit`
 *     是一次不同的调用，连击因此断开；累计计数看不见「中间发生了别的事」，
 *     于是把正常的迭代当成死循环。
 *
 * 被拦住的那一次**不记账**：连击停在阈值上，之后每一次一模一样的重复都继续
 * 被拦。记账的话连击会一直涨，语义不变但数字没意义。
 *
 * ## 不确定档为什么独立于「失败」
 *
 * 「失败」是一条可以放心重试的事实：什么都没发生。「不知道有没有生效」不是
 * ——开灯的请求可能已经送到了，只是回执丢了。把它并进失败档，上层的自动
 * 重试就会把一次可能已经发生的副作用再做一遍。所以它有自己的档，并且带
 * `retrySafe: false`。这与恢复判据的 `indeterminate` 是同一族概念：证据不足以
 * 断言「没发生」，就不许当作「没发生」来处理。
 *
 * ## 参数违规回执为什么要报字段名
 *
 * 只把校验错误原样转回去，模型学不到这个工具**接受什么**，于是原样再发一遍。
 * 报出字段名它才改得动。关键细节在 {@link toolParameterFields}：`[]` 与
 * `undefined` 是两个不同的答案，不能合并。
 */
import { canonicalToolArgsHash } from "./operation-id";

// ---------------------------------------------------------------- 循环闸

/** 连续失败到这个次数即拦截。与 opencode 的 doom-loop 阈值同一口径。 */
export const LOOP_GATE_IDENTICAL_THRESHOLD = 3;

/**
 * 同一 `tool + args` 连续失败的闸门。
 *
 * 只需要两个字段：上一次**失败**的签名，和它连击了几次。历史里更早的东西
 * 一律不需要——连续性判据只关心「上一次是不是同一个、是不是也失败了」。
 */
export class ToolLoopGate {
  private lastFailedSignature: string | undefined;
  private failedStreak = 0;

  /**
   * 一次调用的签名。实参非严格 JSON（含 undefined / NaN / Date 之类）时
   * 退化成一个**每次都不同**的值——签名算不出来就不该被拦，那样拦的是
   * 「我们算不出哈希」而不是「模型在打转」。
   */
  signatureOf(toolName: string, args: unknown, callId: string): string {
    try {
      return canonicalToolArgsHash(toolName, args);
    } catch {
      return `unhashable:${callId}`;
    }
  }

  /** 这次调用是否该被拦下（阈值 - 1 次已连续失败，这次是第 N 次）。 */
  blocked(signature: string): boolean {
    return (
      signature === this.lastFailedSignature &&
      this.failedStreak >= LOOP_GATE_IDENTICAL_THRESHOLD - 1
    );
  }

  /**
   * 记一次终局结果。成功（或任何不同签名）清零，同签名失败续上连击。
   * **被拦住的那次不要调它**（见文件头）。
   */
  record(signature: string, failed: boolean): void {
    if (!failed) {
      this.lastFailedSignature = undefined;
      this.failedStreak = 0;
      return;
    }
    if (signature === this.lastFailedSignature) {
      this.failedStreak += 1;
      return;
    }
    this.lastFailedSignature = signature;
    this.failedStreak = 1;
  }

  /** 换一轮（新 turn / 新会话）时清空。 */
  reset(): void {
    this.lastFailedSignature = undefined;
    this.failedStreak = 0;
  }
}

/** 被循环闸拦下时给模型看的话：说清为什么没跑，以及下一步该换什么。 */
export function formatLoopGateText(toolName: string): string {
    return (
      `已拦截：这次 ${toolName} 调用（实参逐字节相同）已经连续失败 ` +
      `${LOOP_GATE_IDENTICAL_THRESHOLD} 次，两次之间没有任何变化，因此这一次没有真的执行` +
      `——结果不会不同。请改实参，或者先做一件别的事（例如读一下相关文件或状态）再重试。`
    );
}

// ---------------------------------------------------------------- 不确定档

/**
 * 「不知道有没有生效」。**不是失败**：失败可以重试，这个不行。
 *
 * 工具实现在「请求已经送出去、回执没拿到」时抛它（开灯已发出但连接断了、
 * T2 结算失败）。上层据 `retrySafe:false` 决定不自动重跑。
 */
export class ToolOutcomeUnknownError extends Error {
  override readonly name = "ToolOutcomeUnknownError";
  /** 恒 false。这个类存在的全部意义就是这一位。 */
  readonly retrySafe = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** 随结果一起发出的不确定信号。与恢复判据的 `indeterminate` 同一族。 */
export interface ToolUncertainOutcome {
  code: "outcome_unknown";
  /** 恒 false —— 见 {@link ToolOutcomeUnknownError}。 */
  retrySafe: false;
  /** 人能读的原因（写进 run 的 error 文案 / 工具回执）。 */
  detail: string;
}

export function toolUncertainOutcome(detail: string): ToolUncertainOutcome {
  return { code: "outcome_unknown", retrySafe: false, detail };
}

/** 只有 {@link ToolOutcomeUnknownError} 进不确定档；普通失败仍是失败。 */
export function uncertainOutcomeFromError(error: unknown): ToolUncertainOutcome | undefined {
  if (!(error instanceof ToolOutcomeUnknownError)) return undefined;
  return toolUncertainOutcome(error.message);
}

// ------------------------------------------------------- 参数违规的教学回执

/**
 * 从工具的参数 schema 读出它接受的字段名。
 *
 * **`[]` 与 `undefined` 是两个不同的答案，调用方必须分开处理**：`[]` 是
 * 「schema 明说这个工具不收参数」，`undefined` 是「这里读不出 schema」
 * （无法判定分支的联合、不是普通对象的第三方 schema）。把 undefined 渲染成
 * 空列表，等于告诉模型「这个工具不接受任何参数」——而实际上我们什么都不知道。
 * 教一条假事实比什么都不说糟得多：模型会照着它改，然后再被拒一次。
 *
 * 只报字段名，永不报值：实参里可能是文件内容、shell 命令、用户输入的文本。
 */
export function toolParameterFields(parameters: unknown, args?: unknown): string[] | undefined {
  try {
    return readSchemaFields(parameters, args);
  } catch {
    // schema 是第三方对象，可能带 getter。读不动就退回「不知道」，绝不退回一个错的。
    return undefined;
  }
}

function readSchemaFields(schema: unknown, args: unknown): string[] | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const candidate = schema as {
    shape?: unknown;
    options?: unknown;
    def?: { discriminator?: unknown };
    _zod?: { def?: { discriminator?: unknown } };
    jsonSchema?: unknown;
  };

  // z.object(...)（含 .refine()/.superRefine()——它们在 zod 4 里保留 .shape）。
  if (candidate.shape && typeof candidate.shape === "object") {
    return stringKeys(candidate.shape as object);
  }

  if (Array.isArray(candidate.options)) {
    const discriminator = candidate.def?.discriminator ?? candidate._zod?.def?.discriminator;
    // 普通联合没有「哪一支」的判定键。把各支并起来会宣传出 schema 其实拒绝的
    // 组合，所以什么都不说。
    if (typeof discriminator !== "string") return undefined;
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
    const selector = (args as Record<string, unknown>)[discriminator];
    if (selector === undefined) return undefined;
    for (const option of candidate.options) {
      const optionShape = (option as { shape?: unknown }).shape;
      if (!optionShape || typeof optionShape !== "object") continue;
      const literal = (optionShape as Record<string, { value?: unknown }>)[discriminator];
      if (literal?.value === selector) return stringKeys(optionShape as object);
    }
    // 判定键本身就填错了：哪一支都不是，说不出接受什么。
    return undefined;
  }

  // 第三方 / MCP 工具经 JSON Schema 声明的形状。
  const json = candidate.jsonSchema;
  if (json && typeof json === "object") {
    const properties = (json as { properties?: unknown }).properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      return stringKeys(properties as object);
    }
  }
  return undefined;
}

function stringKeys(value: object): string[] {
  return Object.keys(value).sort();
}

/**
 * 参数没通过校验时给模型的回执：错在哪 + 这个工具**接受什么**。
 *
 * 后半句是模型自己拼不出来、也是它最需要的那一半；没有它，一次形状写错的
 * 调用只能靠猜着重发。字段列表读不出来时（undefined）这句话整个不出现。
 */
export function formatToolArgsViolationText(input: {
  toolName: string;
  parameters?: unknown;
  args?: unknown;
  error: unknown;
}): string {
  const fields = toolParameterFields(input.parameters, input.args);
  const guidance =
    fields === undefined
      ? ""
      : fields.length > 0
        ? ` ${input.toolName} 接受这些字段：${fields.map((f) => `\`${f}\``).join("、")}。`
        : ` ${input.toolName} 不接受任何参数。`;
  const detail = input.error instanceof Error ? input.error.message : String(input.error);
  return `工具「${input.toolName}」的实参没通过校验：${detail}${guidance}`;
}
