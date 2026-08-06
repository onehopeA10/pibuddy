/**
 * 全计划唯一的 IPC handler 注册入口（裁定1）。
 *
 * ## 为什么必须唯一
 *
 * 「每个 handler 都要校验来源」这条要求，如果靠各 handler 自己手写，就等价于
 * 「每次新增 channel 都记得抄四行」—— 收敛前全仓 senderFrame 命中数为 0，
 * 13 个 handler 无一做校验，正是这种写法的必然结果。把 `ipcMain.handle` 收进
 * 本文件、其余任何文件都不许直接调用之后，「漏写校验」这件事在结构上就不再
 * 可能发生：新 channel 想被注册，只有一条路，而那条路上四道闸是写死的。
 *
 * 对应的结构性断言（不钉死任何 handler 文件名，handler 迁到别的目录后依然成立）：
 *
 *     rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main \
 *        -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'   # 必须为 0
 *
 * ## 四道闸的顺序
 *
 *   1. assertMainFrame —— 发送者必须是主窗口的主 frame。子 frame / iframe /
 *      webview 即便同源也一律拒绝：渲染进程被注入后第一步就是找一个能发 IPC
 *      的执行上下文。
 *   2. 限流            —— 在任何解析工作之前先计费，畸形载荷同样消耗配额。
 *   3. 原始尺寸/深度   —— schema.parse 前先挡住过大或过深的 structured clone。
 *   4. schema.parse    —— 结构必须匹配该 channel 的契约；解析后再复核尺寸。
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  CHANNEL_CONTRACTS,
  MAX_PROMPT_MESSAGE_BYTES,
  isKnownChannel,
  type InvokeChannel,
  type PermissionDecision,
  type PermissionEngine,
  type PermissionRule,
  type RuntimeSchema,
} from "@pibuddy/contract";

/** 通用载荷上限：8MB。够任何一次正常的产品动作，远小于「拿 IPC 打满内存」所需。 */
export const MAX_IPC_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * 单个**顶层字符串字段**的上限：256KB。
 *
 * 只看顶层是刻意的：图片附件的 base64 挂在 `images[].data` 上，动辄几 MB，
 * 用这个阈值去卡它会直接打断多模态输入。顶层字符串（message / name /
 * customInstructions / value）才是「用户敲进来的文本」，256KB 约等于
 * 十几万汉字，正常使用碰不到。
 */
export const MAX_TEXT_PAYLOAD_BYTES = MAX_PROMPT_MESSAGE_BYTES;
/** structured-clone 载荷允许递归估算的最大深度；超出即失败关闭。 */
export const MAX_IPC_PAYLOAD_DEPTH = 12;

/**
 * 按 channel 覆盖的尺寸上限。
 *
 * 没有这张表的话，通用 8MB 会先于 attachment-registry 的 MAX_IMAGE_BYTES(10MB)
 * 与语音的 25MB 生效，后两个常量就成了永远走不到的死代码 —— 表现是用户录了
 * 一段 20 秒的语音，报的错却是一句和音频无关的「载荷过大」。
 */
export const CHANNEL_MAX_BYTES: Partial<Record<InvokeChannel, number>> = {
  "stt:transcribe": 25 * 1024 * 1024,
  "file:read-attachment": 10 * 1024 * 1024,
  "pi:prompt": 25 * 1024 * 1024,
  "pi:steer": 25 * 1024 * 1024,
  "pi:follow-up": 25 * 1024 * 1024,
};

/** 限流窗口长度（ms）。 */
export const RATE_WINDOW_MS = 10_000;
/** 发消息类通道的窗口配额：10 秒 10 次。 */
export const RATE_LIMIT_PROMPT = 10;
/** 其余通道的窗口配额：10 秒 30 次。 */
export const RATE_LIMIT_DEFAULT = 30;

/** 走 prompt 配额的通道（真正会驱动模型跑起来的那几个）。 */
const PROMPT_CHANNELS = new Set<string>(["pi:prompt", "pi:steer", "pi:follow-up"]);
const MODEL_ACTION_BUCKET = "model-action";

export function limitFor(channel: string): number {
  return PROMPT_CHANNELS.has(channel) ? RATE_LIMIT_PROMPT : RATE_LIMIT_DEFAULT;
}

export function rateBucketFor(channel: string): string {
  return PROMPT_CHANNELS.has(channel) ? MODEL_ACTION_BUCKET : channel;
}

/** 某 channel 的完整准入规则（CT-20 的运行时投影）。 */
export function ruleFor(channel: InvokeChannel): PermissionRule {
  return {
    channel,
    maxBytes: CHANNEL_MAX_BYTES[channel] ?? MAX_IPC_PAYLOAD_BYTES,
    windowMs: RATE_WINDOW_MS,
    maxPerWindow: limitFor(channel),
  };
}

// ---------------------------------------------------------------- 闸 1：来源

/**
 * 发送者必须是主窗口的**主 frame**。
 *
 * `event.senderFrame` 是真正发起这次 invoke 的 frame，`event.sender.mainFrame`
 * 是该 WebContents 的顶层 frame。两者不等 = 调用来自子 frame，一律拒绝。
 */
export function assertMainFrame(event: IpcMainInvokeEvent): void {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error("IPC_FRAME_REJECTED");
  }
}

// ---------------------------------------------------------------- 闸 3：尺寸

/**
 * 估算 structured-clone 值的字节数。
 *
 * 不用 JSON.stringify：ArrayBuffer / TypedArray 在 JSON 里会变成 `{}`，
 * 一段 20MB 的音频会被算成 2 字节。
 */
export function estimateBytes(value: unknown, depth = 0): number {
  const CONTAINER_OVERHEAD = 16;
  const MEMBER_OVERHEAD = 8;
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth }];
  let total = 0;

  const add = (bytes: number): boolean => {
    total += bytes;
    return Number.isSafeInteger(total);
  };
  const queueEntries = (entries: [string, unknown][], entryDepth: number): boolean => {
    for (const [key, item] of entries) {
      if (!add(MEMBER_OVERHEAD + Buffer.byteLength(key, "utf8"))) return false;
      pending.push({ value: item, depth: entryDepth });
    }
    return true;
  };

  while (pending.length > 0) {
    const current = pending.pop()!;
    const item = current.value;
    if (item === null || item === undefined) continue;

    switch (typeof item) {
      case "string":
        if (!add(Buffer.byteLength(item, "utf8"))) return Number.POSITIVE_INFINITY;
        continue;
      case "number":
      case "boolean":
        if (!add(8)) return Number.POSITIVE_INFINITY;
        continue;
      case "bigint":
        if (!add(16)) return Number.POSITIVE_INFINITY;
        continue;
      case "object":
        break;
      default:
        return Number.POSITIVE_INFINITY;
    }

    if (seen.has(item)) continue;
    seen.add(item);
    if (current.depth > MAX_IPC_PAYLOAD_DEPTH) return Number.POSITIVE_INFINITY;

    if (item instanceof ArrayBuffer) {
      if (!add(CONTAINER_OVERHEAD + item.byteLength)) return Number.POSITIVE_INFINITY;
      continue;
    }
    if (typeof SharedArrayBuffer !== "undefined" && item instanceof SharedArrayBuffer) {
      if (!add(CONTAINER_OVERHEAD + item.byteLength)) return Number.POSITIVE_INFINITY;
      continue;
    }
    if (ArrayBuffer.isView(item)) {
      if (!add(CONTAINER_OVERHEAD + item.byteLength)) return Number.POSITIVE_INFINITY;
      continue;
    }
    if (typeof Blob !== "undefined" && item instanceof Blob) {
      if (!add(CONTAINER_OVERHEAD + item.size)) return Number.POSITIVE_INFINITY;
      continue;
    }
    if (item instanceof Date) {
      if (!add(CONTAINER_OVERHEAD + 8)) return Number.POSITIVE_INFINITY;
      continue;
    }
    if (item instanceof RegExp) {
      if (
        !add(
          CONTAINER_OVERHEAD +
            Buffer.byteLength(item.source, "utf8") +
            Buffer.byteLength(item.flags, "utf8")
        )
      ) {
        return Number.POSITIVE_INFINITY;
      }
      continue;
    }
    if (item instanceof Error) {
      if (!add(CONTAINER_OVERHEAD)) return Number.POSITIVE_INFINITY;
      const standard: [string, unknown][] = [
        ["name", item.name],
        ["message", item.message],
        ["stack", item.stack],
      ];
      if ("cause" in item) standard.push(["cause", item.cause]);
      if (!queueEntries(standard, current.depth + 1)) return Number.POSITIVE_INFINITY;
      if (!queueEntries(Object.entries(item), current.depth + 1)) {
        return Number.POSITIVE_INFINITY;
      }
      continue;
    }
    if (item instanceof Map) {
      if (!add(CONTAINER_OVERHEAD + item.size * MEMBER_OVERHEAD * 2)) {
        return Number.POSITIVE_INFINITY;
      }
      for (const [key, mapValue] of item) {
        pending.push({ value: key, depth: current.depth + 1 });
        pending.push({ value: mapValue, depth: current.depth + 1 });
      }
      continue;
    }
    if (item instanceof Set) {
      if (!add(CONTAINER_OVERHEAD + item.size * MEMBER_OVERHEAD)) {
        return Number.POSITIVE_INFINITY;
      }
      for (const setValue of item) {
        pending.push({ value: setValue, depth: current.depth + 1 });
      }
      continue;
    }
    if (Array.isArray(item)) {
      if (!add(CONTAINER_OVERHEAD + item.length * MEMBER_OVERHEAD)) {
        return Number.POSITIVE_INFINITY;
      }
      for (const arrayValue of item) {
        pending.push({ value: arrayValue, depth: current.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      return Number.POSITIVE_INFINITY;
    }
    if (Object.getOwnPropertySymbols(item).length > 0) return Number.POSITIVE_INFINITY;
    if (!add(CONTAINER_OVERHEAD)) return Number.POSITIVE_INFINITY;
    if (!queueEntries(Object.entries(item), current.depth + 1)) {
      return Number.POSITIVE_INFINITY;
    }
  }

  return total;
}

/** 尺寸校验：整体载荷按 channel 查表封顶，顶层字符串字段单独按文本上限封顶。 */
export function assertSizeWithin(channel: string, payload: unknown, limit: number): void {
  const total = estimateBytes(payload);
  if (!Number.isFinite(total)) {
    throw new Error(`IPC_PAYLOAD_TOO_DEEP_OR_UNSUPPORTED: ${channel}`);
  }
  if (total > limit) {
    throw new Error(`IPC_PAYLOAD_TOO_LARGE: ${channel} ${total} > ${limit}`);
  }
  if (typeof payload === "string") {
    if (Buffer.byteLength(payload, "utf8") > MAX_TEXT_PAYLOAD_BYTES) {
      throw new Error(`IPC_TEXT_TOO_LARGE: ${channel}`);
    }
    return;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
  for (const [key, item] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof item !== "string") continue;
    if (Buffer.byteLength(item, "utf8") > MAX_TEXT_PAYLOAD_BYTES) {
      throw new Error(`IPC_TEXT_TOO_LARGE: ${channel}.${key}`);
    }
  }
}

// ---------------------------------------------------------------- 闸 2：限流

/**
 * 按 (bucket, senderId) 计数的滑动窗口限流器。
 *
 * 三条模型动作共用一个 bucket；其余通道仍各自计数。一次正常的会话切换会
 * 在同一瞬间打出 switch_session /
 * get_messages / get_state / get_session_stats 四条不同通道的调用，全局计数会
 * 把正常操作误伤成攻击。
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number = RATE_WINDOW_MS) {}

  /** 越界时抛错；未越界则记一次。 */
  check(channel: string, senderId: number, now: number = Date.now()): void {
    const decision = this.evaluate(channel, senderId, now);
    if (!decision.allowed) throw new Error(`IPC_RATE_LIMITED: ${channel}`);
  }

  evaluate(channel: string, senderId: number, now: number = Date.now()): PermissionDecision {
    const key = `${rateBucketFor(channel)}#${senderId}`;
    const limit = limitFor(channel);
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return { allowed: false, reason: `${channel} 超过 ${limit} 次/${this.windowMs}ms` };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }

  /** 窗口关闭时清掉它的计数，避免 webContents id 复用后继承上一个窗口的额度。 */
  forget(senderId: number): void {
    for (const key of [...this.hits.keys()]) {
      if (key.endsWith(`#${senderId}`)) this.hits.delete(key);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}

/** 全进程唯一的限流器实例。 */
export const rateLimiter = new RateLimiter();

// ---------------------------------------------------------------- 准入引擎

/**
 * `PermissionEngine` 的实现（CT-20）。
 *
 * 三道闸各管一件事：checkFrame 管「这个 channel 是不是我们认识的」，
 * checkPayload 管结构与体积，checkRate 管频率。registerHandler 把它们与
 * assertMainFrame 串成一条固定的流水线；本类另外提供**不抛错**的判定形式，
 * 供 TASK-015 的策略面板与单测直接查询。
 */
export class IpcGuard implements PermissionEngine {
  constructor(private readonly limiter: RateLimiter = rateLimiter) {}

  checkFrame(channel: string, senderId: number): PermissionDecision {
    if (!isKnownChannel(channel)) {
      return { allowed: false, reason: `未知通道 ${channel}` };
    }
    if (!Number.isInteger(senderId) || senderId < 0) {
      return { allowed: false, reason: "非法的 senderId" };
    }
    return { allowed: true };
  }

  checkPayload(channel: string, payload: unknown): PermissionDecision {
    const limit = CHANNEL_MAX_BYTES[channel as InvokeChannel] ?? MAX_IPC_PAYLOAD_BYTES;
    try {
      assertSizeWithin(channel, payload, limit);
      return { allowed: true };
    } catch (err) {
      return { allowed: false, reason: (err as Error).message };
    }
  }

  checkRate(channel: string, senderId: number, now?: number): PermissionDecision {
    return this.limiter.evaluate(channel, senderId, now);
  }
}

export const ipcGuard = new IpcGuard();

// ---------------------------------------------------------------- 注册入口

export interface GuardLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
}

let guardLogger: GuardLogger | null = null;
export function setGuardLogger(logger: GuardLogger): void {
  guardLogger = logger;
}

export type GuardedHandler<Req, Res> = (
  payload: Req,
  event: IpcMainInvokeEvent
) => Res | Promise<Res>;

/**
 * 第五道闸（可选）：能力权限决策。**默认不装**——没有它时，四道闸的行为
 * 与从前一字不差。装上之后，它对「无适用规则」的通道一律放行（现有全部通道
 * 都不在权限需求表里），只对声明了权限需求的通道做决策，未授权即抛错。
 *
 * 决策主体在 `main/permission/**`；这里只留一个注入点，把它接进那条写死的
 * 流水线，且不改动前四道闸的任何签名或既有逻辑。
 */
export type PermissionGate = (channel: InvokeChannel, payload: unknown) => void;
let permissionGate: PermissionGate | null = null;
export function setPermissionGate(gate: PermissionGate | null): void {
  permissionGate = gate;
}

/**
 * 已注册通道表。
 *
 * handler 从 ipc.ts 拆到各域的 *-ipc.ts 之后，「这个 channel 到底被注册了
 * 没有」不再能靠读某一个文件回答。这张表是唯一的运行时答案，单测据它断言
 * 注册面（而不是断言某个 handler 文件的存在，那种断言在文件改名后会空洞
 * 通过）。
 */
const registered = new Set<InvokeChannel>();

/** 已经注册进来的全部通道，按名字排序。 */
export function registeredChannels(): InvokeChannel[] {
  return [...registered].sort();
}

/** 仅供单测：清空注册记录（模块级 Set 会跨用例累积）。 */
export function __resetRegisteredChannels(): void {
  registered.clear();
}

/**
 * 注册一个受保护的 invoke handler。**这是全仓唯一允许调用 ipcMain.handle 的地方。**
 *
 * 四道闸的顺序在函数体内写死，handler 拿到的 payload 已经是校验过的类型，
 * 因此各 handler 文件里不会、也不需要再出现 assertMainFrame。
 *
 * ## 注册期契约核对（ISS-001）
 *
 * 闸 4 用的 schema 由调用点传入，但**必须就是** CHANNEL_CONTRACTS 里那一个
 * 对象（同一性，不是结构等价）：结构相同的两份 schema 今天等价，明天有人
 * 只改其中一份，gate2 实际校验的就悄悄偏离了契约表 —— 而契约表才是
 * preload / 渲染层 / 策略面板共同引用的唯一真相源。同一性在注册期（也就是
 * 应用启动 / 单测装配期）核对，不一致当场抛错，不存在「默默放过」的状态。
 */
export function registerHandler<Req, Res>(
  channel: InvokeChannel,
  schema: RuntimeSchema<Req>,
  handler: GuardedHandler<Req, Res>
): void {
  const contract = (
    CHANNEL_CONTRACTS as Partial<Record<InvokeChannel, { request: unknown }>>
  )[channel];
  if (!contract) {
    throw new Error(`IPC_CONTRACT_MISSING: ${channel} 不在 CHANNEL_CONTRACTS 里`);
  }
  if (contract.request !== (schema as unknown)) {
    throw new Error(
      `IPC_SCHEMA_MISMATCH: ${channel} 注册传入的 schema 不是 CHANNEL_CONTRACTS 里的那一个实例`
    );
  }
  registered.add(channel);
  ipcMain.handle(channel, async (event, raw: unknown) => {
    try {
      assertMainFrame(event);
      rateLimiter.check(channel, event.sender.id);
      const limit = CHANNEL_MAX_BYTES[channel] ?? MAX_IPC_PAYLOAD_BYTES;
      assertSizeWithin(channel, raw, limit);
      const payload = schema.parse(raw);
      // zod 会剥掉未知字段并做变换；保留解析后的尺寸复核，避免契约变换扩大载荷。
      assertSizeWithin(channel, payload, limit);
      permissionGate?.(channel, payload); // 闸 5：能力权限（无适用规则则放行）
      return await handler(payload, event);
    } catch (err) {
      // 拒绝路径必须留痕：没有日志的话，「功能突然不好使」和「被限流挡了」
      // 在现场是同一种表现。message 经 logger-redact 脱敏后落盘。
      guardLogger?.warn("ipc_rejected", {
        channel,
        senderId: event.sender.id,
        reason: (err as Error).message,
      });
      throw err;
    }
  });
}

/** 窗口销毁时释放它占用的限流计数。 */
export function forgetSender(senderId: number): void {
  rateLimiter.forget(senderId);
}
