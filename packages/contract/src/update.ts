/**
 * 应用自更新的跨进程契约（UPD-001 ~ UPD-004）。
 *
 * ## 为什么状态类型必须住在契约包里
 *
 * 更新状态同时被四方消费：main 的 UpdateService 产生它，preload 原样透传，
 * renderer 的 store 与三个组件读它。这个形状如果在 main/update/update-types.ts
 * 本地声明、renderer 再抄一份，两份声明会在第一次加字段时漂移，而漂移的
 * 表现是「界面上少了一块信息」——没有任何编译错误。
 *
 * ## renderer 在这里看不到什么
 *
 * 没有 feedURL、没有 token、没有任何文件路径、没有 raw updater 句柄。
 * 渲染进程能表达的极限是「请检查 / 请下载 / 请安装 / 稍后再说」，
 * 「往哪检查、下到哪、装哪个文件」全部由主进程独占。
 */
import { z } from "zod";

/**
 * 更新状态机的十个状态。**这是唯一的枚举定义处。**
 *
 * - `unsupported`       本环境不支持自更新（dev / 未打包 / 商店分发）
 * - `idle`              空闲，未在检查也无待处理版本
 * - `checking`          正在向 feed 询问
 * - `available`         发现新版本，等待用户决定是否下载（autoDownload=false）
 * - `not-available`     已是最新
 * - `downloading`       正在下载
 * - `downloaded`        已下载完毕，等待安装
 * - `waiting-for-agent` 用户选择「等任务结束后安装」，正在等 agent_settled
 * - `installing`        安装前校验已通过，即将退出并安装
 * - `error`             出错，errorCode / retryable 描述可恢复性
 */
export const UPDATE_STATUSES = [
  "unsupported",
  "idle",
  "checking",
  "available",
  "not-available",
  "downloading",
  "downloaded",
  "waiting-for-agent",
  "installing",
  "error",
] as const;

export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/**
 * 错误分类。七类**必须**互斥且穷尽 —— mapUpdaterError 的 switch 有
 * default 分支落到 'unknown'，绝不允许返回 undefined：UI 拿到 undefined
 * 会渲染出一条没有文案也没有重试按钮的空错误。
 */
export type UpdateErrorCode =
  | "network"
  | "disk"
  | "permission"
  | "signature"
  | "metadata"
  | "unsupported"
  | "unknown";

/**
 * 七类错误的用户文案。**唯一一份**，main 的 describeUpdateError 与渲染侧的
 * 横幅都读它 —— 各写一份的结果是同一个错误在设置页和横幅里说两种话。
 */
export const UPDATE_ERROR_MESSAGES: Record<UpdateErrorCode, string> = {
  network: "连不上更新服务器，请检查网络后重试。",
  disk: "磁盘空间不足，清理一些空间后再试。",
  permission: "没有写入权限，安装目录可能需要管理员权限。",
  signature: "更新包校验失败，已中止安装。请到官网重新下载。",
  metadata: "更新信息读不出来，可能是发布源暂时有问题，稍后再试。",
  unsupported: "当前运行方式不支持自动更新。",
  unknown: "更新失败，可以稍后重试。",
};

export const UPDATE_ERROR_CODES = [
  "network",
  "disk",
  "permission",
  "signature",
  "metadata",
  "unsupported",
  "unknown",
] as const satisfies readonly UpdateErrorCode[];

/**
 * **产品层**发布通道。配置、持久化与 UI 一律只用这两个字面量；
 * 「stable → latest」这种 electron-updater 内部叫法只在适配器里出现一次。
 */
export type UpdateChannel = "stable" | "beta";

/** 本次检查是谁发起的。manual 不受静默节流约束。 */
export type UpdateCheckSource = "auto" | "manual" | "startup";

/** 阻断安装的四类原因。 */
export type UpdateBlockerKind = "agent" | "draft" | "recording" | "permission";

/** 一条阻断项的渲染侧视图（只有类型与人类可读描述，没有任何句柄）。 */
export interface UpdateBlocker {
  kind: UpdateBlockerKind;
  /** 该类阻断项的数量（recording 恒为 1） */
  count: number;
  /** 直接展示给用户的中文描述 */
  label: string;
}

/**
 * 更新子系统的完整状态快照。**唯一状态源在 main。**
 *
 * `stateSequence` 是 update 域内的单调计数器，只用于「快照 vs 事件」的对账：
 * renderer 刷新后先 getState() 拿快照，再订阅事件；此后任何 stateSequence
 * 不大于已知值的事件都是迟到的重复推送，直接丢弃。它**不**承担传输层的
 * 去重职责 —— 那是信封上的 generation/sequence 与 shouldAcceptEnvelope 的事。
 */
export interface UpdateState {
  status: UpdateStatus;
  stateSequence: number;
  /** 当前运行的版本，取自 app.getVersion()，renderer 侧禁止硬编码 */
  currentVersion: string;
  /** 候选版本；无候选时为 null */
  candidateVersion: string | null;
  channel: UpdateChannel;
  checkSource: UpdateCheckSource | null;
  lastCheckedAt: number | null;
  releaseDate: string | null;
  /** 已净化为纯文本的发布说明（当不可信内容处理，绝不 v-html） */
  releaseNotes: string | null;
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  bytesPerSecond: number;
  errorCode: UpdateErrorCode | null;
  retryable: boolean;
  dismissedVersion: string | null;
  /** 自动检查开关 */
  autoCheck: boolean;
  /** 自动下载开关（默认 false：先让用户看到版本说明与体积） */
  autoDownload: boolean;
  /** 当前 electron-updater 是否支持真正的下载取消；false 时不渲染取消按钮 */
  cancelSupported: boolean;
  /** 安装被阻断时的阻断项清单；无阻断为空数组 */
  blockers: UpdateBlocker[];
}

export const updateBlockerSchema = z.object({
  kind: z.enum(["agent", "draft", "recording", "permission"]),
  count: z.number().int().nonnegative(),
  label: z.string(),
});

export const updateStateSchema = z.object({
  status: z.enum(UPDATE_STATUSES),
  stateSequence: z.number().int().nonnegative(),
  currentVersion: z.string(),
  candidateVersion: z.string().nullable(),
  channel: z.enum(["stable", "beta"]),
  checkSource: z.enum(["auto", "manual", "startup"]).nullable(),
  lastCheckedAt: z.number().nullable(),
  releaseDate: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  bytesTransferred: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  percent: z.number(),
  bytesPerSecond: z.number(),
  errorCode: z.enum(UPDATE_ERROR_CODES).nullable(),
  retryable: z.boolean(),
  dismissedVersion: z.string().nullable(),
  autoCheck: z.boolean(),
  autoDownload: z.boolean(),
  cancelSupported: z.boolean(),
  blockers: z.array(updateBlockerSchema),
});

// ---------------------------------------------------------------- 请求 schema

export const updateCheckRequestSchema = z.object({
  source: z.enum(["auto", "manual", "startup"]),
});

export const updateSetChannelRequestSchema = z.object({
  channel: z.enum(["stable", "beta"]),
});

export const updateToggleRequestSchema = z.object({ enabled: z.boolean() });

export const updateDismissRequestSchema = z.object({ version: z.string().min(1) });

/**
 * update:install 的入参。
 *
 * `mode` 是用户在 InstallBlockerDialog 上的三选一在协议上的投影：
 * - `now`   立即安装（无阻断项，或用户选了「停止任务并安装」）
 * - `wait`  等任务结束后安装 → 进入 waiting-for-agent
 * - `force` 停止任务并安装
 */
export const updateInstallRequestSchema = z.object({
  mode: z.enum(["now", "wait", "force"]).default("now"),
});

// ---------------------------------------------------------------- 推送信封

/**
 * update 域的推送信封。
 *
 * 刻意**不**复用 PiEnvelope：那个信封的 workspaceId / sessionId / runtimeId
 * 三个必填字段在更新语境下没有任何含义，硬塞常量进去只会让日后读代码的人
 * 以为更新事件和某个会话有关。两者共用的是同一条丢弃规则
 * （`shouldAcceptEnvelope`），那才是真正需要唯一的东西。
 *
 * - `generation` 主进程一次运行的代际，进程内恒定；窗口 reload 不变，
 *   主进程重启后 +1，用于丢弃跨进程的陈旧事件。
 * - `sequence`   传输层单调计数，每发一条 +1。
 */
export interface UpdateEnvelope {
  protocolVersion: number;
  generation: number;
  sequence: number;
  occurredAt: number;
  payload: UpdateState;
}

export const updateEnvelopeSchema = z.object({
  protocolVersion: z.number().int(),
  generation: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.number().int().nonnegative(),
  payload: updateStateSchema,
});

/**
 * 把发布说明当**不可信内容**处理：剥掉全部 HTML 标签与危险协议，只留纯文本
 * 与换行。发布说明来自远端 feed，若直接 v-html 进渲染进程，等价于把
 * XSS 入口开在一个开着 contextBridge 的窗口上。
 *
 * 净化在 main 侧完成一次，渲染侧组件只做纯文本插值（`{{ }}`），
 * 因此 UpdateBanner / UpdateSettingsPanel 里不允许出现任何 v-html。
 */
export function sanitizeReleaseNotes(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  // electron-updater 的 releaseNotes 可能是 string，也可能是
  // Array<{version, note}>（GitHub 多版本聚合）。
  const text = Array.isArray(raw)
    ? raw
        .map((item) =>
          item && typeof item === "object"
            ? String((item as { note?: unknown }).note ?? "")
            : String(item)
        )
        .join("\n")
    : String(raw);

  return (
    text
      // 先拆 <br> / </p> 为换行，否则整段会被压成一行
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
      // script / style 连同内容一起剥掉：只剥标签会把 alert(1) 留成正文
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
      // 剩余标签一律剥掉；未闭合的 `<` 也一并清掉，保证输出中不含 `<`
      .replace(/<[^>]*>/g, "")
      .replace(/</g, "")
      .replace(/&lt;/gi, "")
      .replace(/&gt;/gi, "")
      // 危险协议（含被空白/换行拆开的写法）
      .replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, "")
      .replace(/data\s*:/gi, "")
      .replace(/vbscript\s*:/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
