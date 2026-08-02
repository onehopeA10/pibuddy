import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcClient } from "../src/client.js";
import type { AgentEvent, AssistantMessageEvent } from "../src/types.js";

/**
 * PiRpcClient 基线回归。
 *
 * 只覆盖 4 条关键路径（其余场景由 fake-pi.mjs 提供、留给后续任务按需取用）：
 *   1. 正常流式响应        —— id 关联、文本增量、thinking、tool 卡片事件转发
 *   2. 畸形 JSON            —— 坏行被跳过且不影响后续 response / event
 *   3. 进程 crash / ENOENT  —— exit 事件、在途请求 reject
 *   4. 旧 generation 延迟事件 —— abort 之后迟到的上一代事件仍会送达客户端
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FAKE_PI = fileURLToPath(
  new URL("../../../tools/fake-pi/fake-pi.mjs", import.meta.url)
);

type Scenario =
  | "normal"
  | "malformed-json"
  | "crash-mid-stream"
  | "exit-immediately"
  | "stale-generation";

const live: PiRpcClient[] = [];

function makeClient(scenario: Scenario, command = process.execPath): PiRpcClient {
  const client = new PiRpcClient({
    spawn: { command, prefixArgs: [FAKE_PI, "--scenario", scenario] },
    cwd: REPO_ROOT,
  });
  live.push(client);
  return client;
}

/** 收集所有透出的 event，供断言检查。 */
function collect(client: PiRpcClient): AgentEvent[] {
  const events: AgentEvent[] = [];
  client.on("event", (e) => events.push(e));
  return events;
}

/** 等到 predicate 为真或超时。 */
async function until(
  predicate: () => boolean,
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("until() 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function onceExit(client: PiRpcClient): Promise<number | null> {
  return new Promise((resolve) => client.on("exit", resolve));
}

/**
 * 取出 message_update 里的 assistantMessageEvent。
 * AgentEvent 联合类型末尾有 `{ type: string; [key: string]: unknown }` 兜底成员，
 * 按 type 判别只能收窄到「具体成员 | 兜底成员」，字段仍是 unknown，故手工取值。
 */
function deltaOf(e: AgentEvent): AssistantMessageEvent | null {
  if (e.type !== "message_update") return null;
  const ame = (e as { assistantMessageEvent?: unknown }).assistantMessageEvent;
  return ame && typeof ame === "object"
    ? (ame as AssistantMessageEvent)
    : null;
}

function deltasOfType(events: AgentEvent[], type: string): string[] {
  return events.flatMap((e) => {
    const ame = deltaOf(e);
    return ame?.type === type ? [ame.delta ?? ""] : [];
  });
}

function textDeltas(events: AgentEvent[]): string[] {
  return deltasOfType(events, "text_delta");
}

afterEach(async () => {
  while (live.length) await live.pop()!.stop();
});

// ---------- 路径 1：正常流式响应 ----------

describe("scenario normal", () => {
  it("send() 的 id 与 response.id 一一对应", async () => {
    const client = makeClient("normal");
    client.start();
    const first = await client.send({ type: "prompt", message: "hi" });
    const second = await client.send({ type: "get_state" });

    // id 以 runtimeId 为前缀：跨代际重启后序号从 1 重来，不带前缀的话
    // 上一代的迟到 response 会被新一代的 pending 认领。
    expect(first.id).toBe(`${client.runtimeId}:1`);
    expect(first.command).toBe("prompt");
    expect(first.success).toBe(true);
    expect(second.id).toBe(`${client.runtimeId}:2`);
    expect(second.command).toBe("get_state");
  });

  it("透传显式指定的 id，不被内部序号覆盖", async () => {
    const client = makeClient("normal");
    client.start();
    const resp = await client.send({ id: "req-custom", type: "get_state" });
    expect(resp.id).toBe("req-custom");
  });

  it("按顺序转发文本增量事件", async () => {
    const client = makeClient("normal");
    const events = collect(client);
    client.start();
    await client.prompt("hi");
    await until(() => events.some((e) => e.type === "agent_settled"));

    expect(textDeltas(events).join("")).toBe("你好，世界");
  });

  it("转发 thinking 增量与 tool 执行事件", async () => {
    const client = makeClient("normal");
    const events = collect(client);
    client.start();
    await client.prompt("hi");
    await until(() => events.some((e) => e.type === "agent_settled"));

    expect(deltasOfType(events, "thinking_delta")).toEqual([
      "先看看目录",
      "……",
    ]);

    const toolStart = events.find((e) => e.type === "tool_execution_start");
    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
    expect(
      toolStart && "toolCallId" in toolStart ? toolStart.toolCallId : null
    ).toBe("call_fake_001");
  });
});

// ---------- 路径 2：畸形 JSON ----------

describe("scenario malformed-json", () => {
  it("畸形行不抛异常，随后的 response 仍能关联", async () => {
    const client = makeClient("malformed-json");
    client.start();
    const resp = await client.send({ type: "prompt", message: "hi" });

    expect(resp.id).toBe(`${client.runtimeId}:1`);
    expect(resp.success).toBe(true);
  });

  it("畸形行之后的合法事件依旧被转发", async () => {
    const client = makeClient("malformed-json");
    const events = collect(client);
    client.start();
    await client.prompt("hi");
    await until(() => events.some((e) => e.type === "agent_settled"));

    expect(textDeltas(events)).toEqual(["你好，世界"]);
    // 两行坏输入（截断 JSON + 纯文本噪声）都不该被当成事件透出。
    expect(events.every((e) => typeof e.type === "string")).toBe(true);
  });
});

// ---------- 路径 3：进程 crash / ENOENT ----------

describe("scenario exit-immediately / crash / ENOENT", () => {
  it("exit-immediately 场景触发一次 exit 事件", async () => {
    const client = makeClient("exit-immediately");
    const exited = onceExit(client);
    client.start();

    expect(await exited).toBe(0);
    expect(client.running).toBe(false);
  });

  it("crash-mid-stream 以非零码退出并 reject 在途请求", async () => {
    const client = makeClient("crash-mid-stream");
    const exited = onceExit(client);
    client.start();

    await client.prompt("hi");
    // 崩溃后发出的请求永远等不到响应，必须被 exit 处理器 reject。
    const pending = client.send({ type: "get_state" }).catch((e: Error) => e);

    expect(await exited).toBe(1);
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("pi 进程已退出");
  });

  it("可执行文件不存在（ENOENT）时在途请求被 reject 而非静默挂起", async () => {
    const client = makeClient("normal", "definitely-not-a-real-binary-xyz");
    client.start();

    await expect(client.send({ type: "get_state" })).rejects.toThrow();
  });
});

// ---------- 路径 4：旧 generation 延迟事件 ----------

describe("scenario stale-generation", () => {
  it("abort 响应之后迟到的上一代事件仍会送达（供上层按代际丢弃）", async () => {
    const client = makeClient("stale-generation");
    const events = collect(client);
    client.start();

    await client.prompt("hi");
    const abortResp = await client.abort();
    expect(abortResp.command).toBe("abort");

    const beforeStale = events.length;
    await until(() =>
      textDeltas(events).includes("STALE")
    );
    expect(events.length).toBeGreaterThan(beforeStale);
  });
});
