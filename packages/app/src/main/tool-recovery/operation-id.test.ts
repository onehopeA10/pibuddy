import { describe, expect, it } from "vitest";

import {
  buildToolOperationId,
  canonicalToolArgsHash,
  isSha256Digest,
  toolCallEventId,
  toolDispatchEventId,
  toolResponseEventId,
} from "./operation-id";

describe("buildToolOperationId", () => {
  it("确定性派生：同样的入参永远得到同一个 id（崩溃后可重算）", () => {
    const first = buildToolOperationId({
      invocationId: "inv-1",
      providerToolCallId: "call-1",
    });
    const second = buildToolOperationId({
      invocationId: "inv-1",
      providerToolCallId: "call-1",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^toolop_[0-9a-f]{32}$/);
  });

  it("元组身份：同一个 toolCallId 在不同 invocation 下是不同的 operation", () => {
    const a = buildToolOperationId({ invocationId: "inv-1", providerToolCallId: "call_1" });
    const b = buildToolOperationId({ invocationId: "inv-2", providerToolCallId: "call_1" });
    expect(a).not.toBe(b);
  });

  it("分隔符注入撞不出同一个 id（JSON 数组而非字符串拼接）", () => {
    const a = buildToolOperationId({ invocationId: "inv", providerToolCallId: "1_call" });
    const b = buildToolOperationId({ invocationId: "inv_1", providerToolCallId: "call" });
    expect(a).not.toBe(b);
  });

  it("缺任一分量直接抛：没有 fallback 到随机数这条路", () => {
    expect(() => buildToolOperationId({ invocationId: "", providerToolCallId: "c" })).toThrow(
      /TOOL_OPERATION_IDENTITY_INCOMPLETE/
    );
    expect(() => buildToolOperationId({ invocationId: "i", providerToolCallId: "" })).toThrow(
      /TOOL_OPERATION_IDENTITY_INCOMPLETE/
    );
  });
});

describe("派生事件 id", () => {
  it("三个事件 id 都从 operationId 推出，互不相同", () => {
    const operationId = buildToolOperationId({
      invocationId: "inv-1",
      providerToolCallId: "call-1",
    });
    expect(toolCallEventId(operationId)).toBe(`${operationId}_call`);
    expect(toolDispatchEventId(operationId)).toBe(`${operationId}_dispatch`);
    expect(toolResponseEventId(operationId)).toBe(`${operationId}_response`);
    expect(
      new Set([
        toolCallEventId(operationId),
        toolDispatchEventId(operationId),
        toolResponseEventId(operationId),
      ]).size
    ).toBe(3);
  });
});

describe("canonicalToolArgsHash", () => {
  it("键序无关：对象字段顺序不影响身份", () => {
    expect(canonicalToolArgsHash("t", { b: 1, a: 2 })).toBe(
      canonicalToolArgsHash("t", { a: 2, b: 1 })
    );
  });

  it("toolName 参与身份：同样实参、不同工具不是同一次调用", () => {
    expect(canonicalToolArgsHash("a", { x: 1 })).not.toBe(canonicalToolArgsHash("b", { x: 1 }));
  });

  it("数组顺序敏感", () => {
    expect(canonicalToolArgsHash("t", [1, 2])).not.toBe(canonicalToolArgsHash("t", [2, 1]));
  });

  it("拒绝而不是强转：undefined / NaN / Date / bigint 一律抛", () => {
    expect(() => canonicalToolArgsHash("t", { a: undefined })).toThrow(/严格 JSON/);
    expect(() => canonicalToolArgsHash("t", { a: Number.NaN })).toThrow(/严格 JSON/);
    expect(() => canonicalToolArgsHash("t", { a: new Date() })).toThrow(/严格 JSON/);
    expect(() => canonicalToolArgsHash("t", { a: 1n })).toThrow(/严格 JSON/);
  });

  it("拒绝 getter：读一次可能有副作用，身份不能建立在它上面", () => {
    const args = {};
    Object.defineProperty(args, "a", { get: () => 1, enumerable: true });
    expect(() => canonicalToolArgsHash("t", args)).toThrow(/严格 JSON/);
  });

  it("__proto__ 作为数据键不会被 Object.prototype 的 setter 吞掉", () => {
    const withProto = JSON.parse('{"__proto__": {"a": 1}}') as unknown;
    const without = JSON.parse("{}") as unknown;
    expect(canonicalToolArgsHash("t", withProto)).not.toBe(canonicalToolArgsHash("t", without));
  });

  it("空 toolName 抛错", () => {
    expect(() => canonicalToolArgsHash("", {})).toThrow(/TOOL_ARGS_IDENTITY_INVALID/);
  });

  it("输出恒为强格式摘要", () => {
    expect(isSha256Digest(canonicalToolArgsHash("t", { a: 1 }))).toBe(true);
  });
});

describe("isSha256Digest", () => {
  it("多一位、少一位、大写十六进制统统拒", () => {
    expect(isSha256Digest(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isSha256Digest(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isSha256Digest(`sha256:${"a".repeat(65)}`)).toBe(false);
    expect(isSha256Digest(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isSha256Digest("a".repeat(64))).toBe(false);
    expect(isSha256Digest(undefined)).toBe(false);
  });
});
