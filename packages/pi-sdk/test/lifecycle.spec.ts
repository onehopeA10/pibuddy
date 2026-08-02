import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcClient } from "../src/client.js";
import { RpcAbortedError, RpcTimeoutError } from "../src/errors.js";
import { MAX_LINE_BYTES, attachJsonlReader } from "../src/jsonl.js";
import { Readable } from "node:stream";

/**
 * RUN-003 可靠性关键路径。
 *
 * 只写关键路径断言，不写穷举矩阵：
 *   1. spawn 失败（ENOENT）→ crashed，exit 恰好一次，真因不被吞
 *   2. timeout / abort  → reject 且 pending map 归零
 *   3. JSONL 单行超限   → 可捕获错误 + buffer 归零
 *   4. 非法状态转换     → 非 production 抛错
 *   5. stop 阶梯        → 走完之后进程确实没了
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FAKE_PI = fileURLToPath(
  new URL("../../../tools/fake-pi/fake-pi.mjs", import.meta.url)
);

const live: PiRpcClient[] = [];

function makeClient(scenario: string, command = process.execPath): PiRpcClient {
  const client = new PiRpcClient({
    spawn: { command, prefixArgs: [FAKE_PI, "--scenario", scenario] },
    cwd: REPO_ROOT,
  });
  live.push(client);
  return client;
}

/** 读取 private pending map 的大小（断言「不再永久悬挂」必须看得到它）。 */
function pendingSize(client: PiRpcClient): number {
  return (client as unknown as { pending: Map<string, unknown> }).pending.size;
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("until() 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  while (live.length) await live.pop()!.stop();
});

// ---------- 1. spawn 失败：ENOENT ----------

describe("spawn 失败（ENOENT）", () => {
  it("2000ms 内 phase 变为 crashed，且 exit 恰好 emit 一次", async () => {
    const client = makeClient("normal", "definitely-not-a-real-binary-xyz");
    let exitCount = 0;
    client.on("exit", () => {
      exitCount++;
    });
    client.start();

    await until(() => client.phase === "crashed", 2000);
    // 再多等一会儿，确认 close / exit 不会把事件重复打出去。
    await new Promise((r) => setTimeout(r, 300));

    expect(client.phase).toBe("crashed");
    expect(exitCount).toBe(1);
    expect(client.running).toBe(false);
  });

  it("assertUsable 抛出的错误携带 ENOENT 原文，而不是泛化的「尚未启动」", async () => {
    const client = makeClient("normal", "definitely-not-a-real-binary-xyz");
    client.start();
    await until(() => client.phase === "crashed", 2000);

    expect(client.lastSpawnError?.message).toContain("ENOENT");
    let message = "";
    try {
      client.assertUsable();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("ENOENT");
    expect(message).not.toContain("智能体尚未启动");
  });

  it("在途请求被 reject 而非静默挂起，pending 归零", async () => {
    const client = makeClient("normal", "definitely-not-a-real-binary-xyz");
    client.start();
    await expect(client.send({ type: "get_state" })).rejects.toThrow();
    expect(pendingSize(client)).toBe(0);
  });
});

// ---------- 2. timeout / abort ----------

describe("请求级失败", () => {
  it("scenario timeout 下 send() 超时 reject，且 pending map 回到 0", async () => {
    const client = makeClient("timeout");
    client.start();

    const err = await client
      .send({ type: "get_state" }, { timeoutMs: 200 })
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect(pendingSize(client)).toBe(0);
  });

  it("AbortSignal 触发后 reject，且 pending map 回到 0", async () => {
    const client = makeClient("timeout");
    client.start();

    const controller = new AbortController();
    const promise = client
      .send({ type: "get_state" }, { signal: controller.signal })
      .catch((e: Error) => e);
    controller.abort();

    expect(await promise).toBeInstanceOf(RpcAbortedError);
    expect(pendingSize(client)).toBe(0);
  });
});

// ---------- 3. JSONL 上限 ----------

describe("JSONL buffer 上限", () => {
  it("单行超限抛出可捕获错误，且 buffer 归零", async () => {
    const stream = new Readable({ read() {}, highWaterMark: 64 * 1024 * 1024 });
    const errors: Error[] = [];
    const handle = attachJsonlReader(
      stream,
      () => {},
      (e) => errors.push(e)
    );

    // 分片喂入一条永远不换行的超长内容（10MB > MAX_LINE_BYTES 8MB）。
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 10; i++) stream.push(chunk);
    await until(() => errors.length > 0, 2000);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("超限");
    expect(handle.bufferLength()).toBe(0);
    handle.detach();
  });

  it("scenario oversized-line 下客户端不崩，且诊断记录到 jsonl-overflow", async () => {
    const client = makeClient("oversized-line");
    client.start();
    await client.send({ type: "prompt", message: "hi" }, { timeoutMs: 10_000 });

    await until(
      () => client.recentDiagnostics().some((d) => d.kind === "jsonl-overflow"),
      10_000
    );
    expect(MAX_LINE_BYTES).toBe(8 * 1024 * 1024);
    // 越界之后链路仍然活着：进程没被拖死，phase 还是 running。
    expect(client.phase).toBe("running");
  });
});

// ---------- 4. 状态机 ----------

describe("状态机", () => {
  it("非法转换（stopped → running）在非 production 下抛错", () => {
    const client = new PiRpcClient({
      spawn: { command: process.execPath },
      cwd: REPO_ROOT,
    });
    client.transition("starting");
    client.transition("running");
    client.transition("stopping");
    client.transition("stopped");

    expect(process.env.NODE_ENV).not.toBe("production");
    expect(() => client.transition("running")).toThrow(/非法状态转换/);
    // 抛错之后相位不变，状态机不会被半推进到一个不存在的状态。
    expect(client.phase).toBe("stopped");
  });

  it("合法转换链 stopped → recovering → starting 通过", () => {
    const client = new PiRpcClient({
      spawn: { command: process.execPath },
      cwd: REPO_ROOT,
    });
    client.transition("starting");
    client.transition("crashed");
    client.transition("recovering");
    client.transition("starting");
    expect(client.phase).toBe("starting");
  });
});

// ---------- 5. stop 阶梯 ----------

describe("stop 阶梯", () => {
  it("stop() 之后进程确实退出，且 exit 的 reason 是 expected-stop", async () => {
    const client = makeClient("normal");
    const reasons: string[] = [];
    client.on("exit", (_code: number | null, meta: { reason: string }) =>
      reasons.push(meta.reason)
    );
    client.start();
    await client.send({ type: "get_state" });

    await client.stop();

    expect(client.running).toBe(false);
    expect(["stopped", "crashed"]).toContain(client.phase);
    expect(reasons).toEqual(["expected-stop"]);
  });

  it("stopping 之后拒绝新命令", async () => {
    const client = makeClient("normal");
    client.start();
    const stopping = client.stop();
    await expect(client.send({ type: "get_state" })).rejects.toThrow(
      /正在停止|未运行/
    );
    await stopping;
  });
});
