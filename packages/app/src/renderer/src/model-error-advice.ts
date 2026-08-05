/**
 * 归一化 kind → **可操作的中文提示**（MDL-101 的渲染层一半）。
 *
 * 判据不在这里（那在主进程的 `main/model-errors/`），文案也不该在那里：
 * 主进程给的是一个类别，界面给的是「现在该点哪个按钮」。两层各自拥有自己的
 * 抽象级别，谁都不重复另一层的内容。
 *
 * ## 一条纪律：每个 kind 必须给出一个**动作**
 *
 * 「模型服务返回错误，请稍后再试」这种话与原文透传没有区别 —— 它把判断留给
 * 了本来就不知道怎么判断的人。因此每一项都带一个 `action`：要么是界面上真
 * 存在的一个入口（Provider 中心 / 额度页 / 压缩会话），要么诚实地写 `none`
 * （比如 provider 侧 5xx，用户确实无事可做，此时告诉他「不是你的问题」本身
 * 就是有用信息）。
 */
import type { ModelErrorKind, ModelErrorSource } from "@contract";

/** 提示要把用户送到哪里去。渲染层据此决定按钮文案与点击行为。 */
export type ModelErrorAction = "compact" | "provider" | "usage" | "wait" | "none";

export interface ModelErrorAdvice {
  /** 一行标题，用户扫一眼就知道发生了什么 */
  title: string;
  /** 下一步该做什么，一句话，带具体入口名 */
  hint: string;
  action: ModelErrorAction;
  /** 动作按钮上的字；action 为 none / wait 时无按钮 */
  actionLabel?: string;
}

/** 把毫秒说成人话。不足 1 秒按 1 秒说 —— 「等 0 秒」是句废话。 */
export function formatRetryAfter(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} 分钟`;
}

const ADVICE: Record<ModelErrorKind, ModelErrorAdvice> = {
  context_overflow: {
    title: "这次对话太长了，模型装不下",
    hint: "先整理一次对话记忆（会保留要点、丢掉细节），或者换一个上下文窗口更大的模型。",
    action: "compact",
    actionLabel: "整理对话记忆",
  },
  rate_limit: {
    title: "请求太频繁，服务商暂时限流了",
    hint: "等一会儿再发同一句话就行，不用改任何设置。",
    action: "wait",
  },
  auth: {
    title: "这个服务商的密钥不对或已失效",
    hint: "去 Provider 中心重新填一次 API Key，填完可以直接点「测试连接」验证。",
    action: "provider",
    actionLabel: "打开 Provider 中心",
  },
  provider_billing: {
    title: "服务商说账户余额或额度不够了",
    hint: "先在额度页看看最近的用量，再去服务商官网充值或调高限额。",
    action: "usage",
    actionLabel: "查看额度与用量",
  },
  provider_unavailable: {
    title: "服务商那边出问题了，不是你的操作有误",
    hint: "稍等几分钟重试；一直不好就先换一个服务商的模型顶上。",
    action: "none",
  },
  network: {
    title: "连不上服务商",
    hint: "检查一下网络或代理；地址填错也会是这个症状，可以在 Provider 中心点「测试连接」确认。",
    action: "provider",
    actionLabel: "测试连接",
  },
  timeout: {
    title: "等太久，这次请求超时了",
    hint: "直接重发一次；反复超时通常是网络不稳或选的模型太慢。",
    action: "wait",
  },
  abort: {
    title: "已按你的要求停止",
    hint: "没有出错，随时可以继续。",
    action: "none",
  },
  unknown: {
    title: "出了点问题",
    hint: "展开下面的原始报错看看细节；如果看不懂，把那段话连同这句提示一起反馈给我们。",
    action: "none",
  },
};

/**
 * 取某个 kind 的中文建议。
 *
 * `retryAfterMs` 只对限流有意义：服务端明说了要等多久时，把那个数字讲出来
 * 比「稍后再试」有用得多 —— 后者不回答用户唯一关心的「多久」。
 */
export function adviseModelError(
  kind: ModelErrorKind,
  options?: { retryAfterMs?: number }
): ModelErrorAdvice {
  const base = ADVICE[kind] ?? ADVICE.unknown;
  if (kind === "rate_limit" && options?.retryAfterMs !== undefined) {
    return { ...base, hint: `服务商建议等 ${formatRetryAfter(options.retryAfterMs)} 再试。` };
  }
  return base;
}

/**
 * 这条报告要不要在界面上抢用户的注意力。
 *
 * `retry` 是「pi 正在自愈」，弹一个带按钮的横幅会让用户在系统本来能自己
 * 恢复的时候动手；它只配一行状态文字。`abort` 根本不是故障。
 */
export function shouldSurfaceModelError(
  source: ModelErrorSource,
  kind: ModelErrorKind
): boolean {
  if (kind === "abort") return false;
  return source !== "retry";
}

/**
 * 自动重试期间的状态条文案。
 *
 * 收敛前这里恒为「网络繁忙，正在重试」—— 而实际触发重试的绝大多数是限流，
 * 说成「网络繁忙」会把用户引去查网络。
 */
export function retryStatusText(
  kind: ModelErrorKind,
  attempt: number,
  maxAttempts: number
): string {
  const what =
    kind === "rate_limit"
      ? "服务商限流"
      : kind === "provider_unavailable"
        ? "服务商暂时不可用"
        : kind === "timeout"
          ? "上次请求超时"
          : kind === "network"
            ? "网络不稳"
            : "上次请求失败";
  return `${what}，正在重试 (${attempt}/${maxAttempts})…`;
}
