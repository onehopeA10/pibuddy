/**
 * 工具操作的**确定性身份派生**（T1/T2 夹逼的地基之一）。
 *
 * ## 为什么必须确定性
 *
 * 崩溃恢复要回答的是「上次那次调用到底跑没跑」。如果 operationId 是随机生成
 * 的（randomUUID），进程一崩这个值就丢了：重开之后拿着账本里的
 * `(invocationId, providerToolCallId)` 算不出同一个 id，也就无法把账本行和
 * 内存里正在发起的这次调用对上号 —— 只能保守判「不确定」。
 *
 * 所以 id 一律由 `sha256(JSON([invocationId, providerToolCallId]))` 派生。
 * 崩溃后重算得到同一个值，幂等重试才有主键可比，CAS 才有 WHERE 可写。
 *
 * ## 为什么是元组而不是裸 providerToolCallId
 *
 * provider 侧的 tool_call_id 只保证在**一次 invocation 内**唯一。不同
 * invocation 之间复用同一个字符串是允许的，甚至常见（有的 provider 用
 * `call_1` / `call_2` 这种序号）。裸拿 toolCallId 做主键，跨 invocation 的两
 * 次不同调用会撞成一条记录 —— 表现是「第二次调用被幂等短路了，工具压根没
 * 执行，但上层以为执行过」。元组把 invocation 编进身份里，这条路被堵死。
 *
 * JSON 数组而不是字符串拼接：`["a","b_c"]` 与 `["a_b","c"]` 序列化后不同，
 * 而 `a + "_" + b_c` 与 `a_b + "_" + c` 拼出来是同一个串。分隔符注入是哈希
 * 身份最经典的碰撞来源。
 *
 * ## 事件 id 也从 operationId 派生
 *
 * 同理：崩溃后要能重算出「这次操作的 call / dispatch / response 事件叫什么」，
 * 否则写入侧无法做「同 id 逐字节比对」的幂等重试。
 */
import { createHash } from "node:crypto";

/** 工具边界协议标记。版本变了必须换这个常量，禁止原地改语义。 */
export const TOOL_BOUNDARY_PROTOCOL_V1 = "pibuddy.tool_boundary.v1" as const;
export type ToolBoundaryProtocol = typeof TOOL_BOUNDARY_PROTOCOL_V1;

/** T1 落地的 dispatch 事实协议。 */
export const TOOL_DISPATCH_PROTOCOL_V1 = "t1_after_preflight_v1" as const;

/** 恢复模式：本期只实现 reconcile（读回真实世界状态再判）。 */
export type ToolRecoveryMode = "reconcile" | "manual";

export interface ToolOperationIdInput {
  invocationId: string;
  providerToolCallId: string;
}

/**
 * `toolop_` + sha256(JSON([invocationId, providerToolCallId])) 前 32 位十六进制。
 *
 * 截断到 32 位（128 bit）：身份空间远大于单机账本规模，而完整 64 位在日志
 * 和 SQL 里太长，反而没人愿意贴出来对。
 */
export function buildToolOperationId(input: ToolOperationIdInput): string {
  if (!input.invocationId || !input.providerToolCallId) {
    throw new Error("TOOL_OPERATION_IDENTITY_INCOMPLETE: 需要 invocationId 与 providerToolCallId");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([input.invocationId, input.providerToolCallId]))
    .digest("hex")
    .slice(0, 32);
  return `toolop_${digest}`;
}

/** 三个派生事件 id。崩溃后可重算，是幂等重试能逐字节比对的前提。 */
export function toolCallEventId(operationId: string): string {
  return `${operationId}_call`;
}

export function toolDispatchEventId(operationId: string): string {
  return `${operationId}_dispatch`;
}

export function toolResponseEventId(operationId: string): string {
  return `${operationId}_response`;
}

/**
 * 实参身份哈希：`sha256:<64 hex>`，对 (toolName, args) 的严格 JSON 规范化。
 *
 * 「严格」的意思是**拒绝**而不是强转：`undefined` / bigint / Date / NaN /
 * getter / 非普通原型统统抛错。悄悄强转会让两组 provider 并不认可为相同的
 * 实参撞出同一个哈希 —— 而这个哈希正是 dispatch 事实用来证明「我派发的就是
 * 模型要的那次调用」的凭据。凭据能撞，夹逼就不成立。
 *
 * `__proto__` 用 null 原型对象承载：赋值到普通对象上会触发 Object.prototype
 * 的历史 setter，键直接消失，两组不同实参又撞了。
 */
export function canonicalToolArgsHash(toolName: string, args: unknown): `sha256:${string}` {
  if (toolName.length === 0) {
    throw new Error("TOOL_ARGS_IDENTITY_INVALID: 需要非空 toolName");
  }
  const body = JSON.stringify([toolName, canonicalizeStrictJson(args)]);
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function canonicalizeStrictJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw strictJsonError();
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw strictJsonError();
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      // 数组洞（hole）没有 descriptor：JSON 会写 null，但那是**发明**了一个
      // 值。派发身份不接受发明出来的字节。
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw strictJsonError();
      result.push(canonicalizeStrictJson(descriptor.value));
    }
    return result;
  }
  if (typeof value !== "object") throw strictJsonError();

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw strictJsonError();
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).some(
      (key) => typeof key !== "string" || !Object.getOwnPropertyDescriptor(record, key)?.enumerable
    )
  ) {
    throw strictJsonError();
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw strictJsonError();
    result[key] = canonicalizeStrictJson(descriptor.value);
  }
  return result;
}

function strictJsonError(): Error {
  return new Error("TOOL_ARGS_IDENTITY_INVALID: 工具实参必须是严格 JSON 值");
}

/** sha256 摘要的强校验。多一位少一位、大写十六进制统统拒。 */
export function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
