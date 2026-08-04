import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { shouldAcceptEnvelope } from "@pibuddy/contract";
import { TerminalRingBuffer } from "../src/main/terminal/ring-buffer.js";
import { PtyManager, type TerminalEmit } from "../src/main/terminal/pty-manager.js";

/**
 * 终端能力包（coding.terminal / PTY-101）的判据。**大量用真 PTY 子进程**——方案 B
 * 的核心不变量（node-pty 真能起、有界 ring buffer 真的有界、reload 后靠 snapshot
 * 真能重连去重、显式 kill 真的清进程）没法靠打桩证明，只有让 PtyManager 真 spawn
 * 一个 shell、再断言输出 / 退出码 / 序号 / 拆卸才作数。
 *
 * 三条可证伪的重点（对拍见 FEAT-terminal.md §对拍）：
 *
 *  1. **ring buffer 真的有界**：喂 10 倍容量的数据 → size 恒 ≤ 容量，且发生过驱逐
 *     （累计喂入 > 当前 size）。把 append 里那段 `while(...)` 驱逐删掉，size 会涨到
 *     累计喂入量，本条立刻红。
 *  2. **reload 后重连取 snapshot 去重**：snapshot 拿到 text + 最后序号后，一个
 *     `sequence <= snapshot.sequence` 的迟到块被 shouldAcceptEnvelope 丢弃、更大序号
 *     的新块被接受——这正是渲染进程 reload 后不重复写屏的机制。
 *  3. **显式 kill / disposeAll 不留在册 PTY**：kill 后 snapshot found=false、list 为空。
 */

/** 轮询等待，直到 predicate 为真或超时。 */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe("TerminalRingBuffer：有界 + 单调序号（纯逻辑对拍）", () => {
  it("append 分配严格递增的序号", () => {
    const rb = new TerminalRingBuffer(1000);
    expect(rb.append("a")).toBe(1);
    expect(rb.append("b")).toBe(2);
    expect(rb.append("c")).toBe(3);
    expect(rb.sequence).toBe(3);
  });

  it("超容量时从头驱逐，size 恒 ≤ 容量，且保留的是最近内容（有界的核心判据）", () => {
    const cap = 100;
    const rb = new TerminalRingBuffer(cap);
    let fed = 0;
    for (let i = 0; i < 50; i++) {
      const chunk = `chunk-${i}-`.padEnd(20, "x"); // 每块 20 字符
      fed += chunk.length;
      rb.append(chunk);
    }
    // 有界：任何时刻都不超过容量。
    expect(rb.size).toBeLessThanOrEqual(cap);
    // 非空：确实还留着最近的内容（不是被清空了糊弄）。
    expect(rb.size).toBeGreaterThan(0);
    // 发生过驱逐：累计喂入远大于当前 size —— 删掉驱逐逻辑这条会红。
    expect(fed).toBeGreaterThan(rb.size);
    // 留下的是尾部：最后一块的标记在，最早一块的标记不在。
    expect(rb.text()).toContain("chunk-49-");
    expect(rb.text()).not.toContain("chunk-0-x");
  });

  it("单块自身超容量时只保留尾部", () => {
    const rb = new TerminalRingBuffer(10);
    rb.append("0123456789ABCDEF"); // 16 字符 > 10
    expect(rb.size).toBe(10);
    expect(rb.text()).toBe("6789ABCDEF");
  });

  it("advance 推进序号但不写内容；clear 清内容但不重置序号", () => {
    const rb = new TerminalRingBuffer(1000);
    rb.append("hello");
    const s = rb.advance();
    expect(s).toBe(2);
    expect(rb.text()).toBe("hello"); // advance 不加内容
    rb.clear();
    expect(rb.text()).toBe("");
    expect(rb.sequence).toBe(2); // clear 不重置序号
  });
});

describe("PtyManager：真 PTY 子进程（node-pty，方案 B）", () => {
  const managers: PtyManager[] = [];
  function make(): PtyManager {
    const m = new PtyManager();
    managers.push(m);
    return m;
  }

  afterEach(() => {
    // 每个用例后杀掉全部在册 PTY，不留孤儿进程。
    for (const m of managers) m.disposeAll();
    managers.length = 0;
  });

  /** cmd 用 `echo x`，posix shell 也认 `echo x`——统一用它做可见标记。 */
  function echoCmd(marker: string): string {
    return `echo ${marker}\r`;
  }

  it("open 真的 spawn 一个 shell，输出经 emitter 分帧下发", async () => {
    const m = make();
    const emits: TerminalEmit[] = [];
    m.setEmitter((e) => emits.push(e));

    const meta = m.open({ workspaceId: "ws1", cwd: os.tmpdir(), profileId: null, cols: 80, rows: 24 });
    expect(meta.running).toBe(true);
    expect(meta.tabId).toBeTruthy();

    const marker = "pty-marker-open-777";
    m.input(meta.tabId, echoCmd(marker));

    const seen = await waitFor(() =>
      emits.some((e) => e.payload.kind === "data" && e.payload.data.includes(marker))
    );
    expect(seen).toBe(true);

    // 分帧下发的序号是严格递增的（信封的 sequence 位）。
    const dataSeqs = emits.filter((e) => e.payload.kind === "data").map((e) => e.sequence);
    for (let i = 1; i < dataSeqs.length; i++) {
      expect(dataSeqs[i]).toBeGreaterThan(dataSeqs[i - 1]);
    }
  });

  it("reload 后重连：snapshot 取回 text + 序号，更旧序号被丢弃、更新序号被接受", async () => {
    const m = make();
    const emits: TerminalEmit[] = [];
    m.setEmitter((e) => emits.push(e));
    const meta = m.open({ workspaceId: "ws1", cwd: os.tmpdir(), profileId: null, cols: 80, rows: 24 });

    const marker1 = "reconnect-marker-1";
    m.input(meta.tabId, echoCmd(marker1));
    await waitFor(() => m.snapshot(meta.tabId).text.includes(marker1));

    // 模拟 reload：渲染进程只有 snapshot 这一份初始状态。
    const snap = m.snapshot(meta.tabId);
    expect(snap.found).toBe(true);
    expect(snap.text).toContain(marker1);
    const prevFrame = { generation: snap.generation, sequence: snap.sequence };

    // 一个「等于快照序号」的迟到块 → 渲染进程应当丢弃（去重）。
    expect(shouldAcceptEnvelope(prevFrame, { generation: snap.generation, sequence: snap.sequence })).toBe(false);

    // 续接：再 echo 一段，等到一个序号更大的块。
    const marker2 = "reconnect-marker-2";
    const before = emits.length;
    m.input(meta.tabId, echoCmd(marker2));
    await waitFor(() =>
      emits
        .slice(before)
        .some((e) => e.sequence > snap.sequence && e.payload.kind === "data")
    );
    const newer = emits.find((e) => e.sequence > snap.sequence && e.payload.kind === "data");
    expect(newer).toBeTruthy();
    // 更大序号的新块 → 渲染进程应当接受（续接）。
    expect(
      shouldAcceptEnvelope(prevFrame, { generation: newer!.generation, sequence: newer!.sequence })
    ).toBe(true);
  });

  it("shell 退出：emitter 收到 exit 事件 + 退出码，snapshot.running 变 false", async () => {
    const m = make();
    const emits: TerminalEmit[] = [];
    m.setEmitter((e) => emits.push(e));
    const meta = m.open({ workspaceId: "ws1", cwd: os.tmpdir(), profileId: null, cols: 80, rows: 24 });

    m.input(meta.tabId, "exit\r");
    const exited = await waitFor(() => emits.some((e) => e.payload.kind === "exit"));
    expect(exited).toBe(true);

    const exitEmit = emits.find((e) => e.payload.kind === "exit");
    expect(exitEmit).toBeTruthy();
    expect(typeof (exitEmit!.payload as { exitCode: number | null }).exitCode).not.toBe("undefined");

    const snap = m.snapshot(meta.tabId);
    expect(snap.running).toBe(false);
    // 退出事件的序号严格大于最后一段数据的序号（渲染进程先回放数据再处理退出）。
    const lastData = Math.max(0, ...emits.filter((e) => e.payload.kind === "data").map((e) => e.sequence));
    expect(exitEmit!.sequence).toBeGreaterThan(lastData);
  });

  it("restart：代际 +1、换新 ring buffer；旧代际输出被丢弃规则挡下", async () => {
    const m = make();
    m.setEmitter(() => undefined);
    const meta = m.open({ workspaceId: "ws1", cwd: os.tmpdir(), profileId: null, cols: 80, rows: 24 });
    m.input(meta.tabId, echoCmd("before-restart"));
    await waitFor(() => m.snapshot(meta.tabId).text.includes("before-restart"));

    const restarted = m.restart(meta.tabId);
    expect(restarted).toBeTruthy();
    expect(restarted!.generation).toBe(meta.generation + 1);
    // 新代际的 ring buffer 是空的（旧输出不再在册）。
    const snap = m.snapshot(meta.tabId);
    expect(snap.generation).toBe(meta.generation + 1);
    expect(snap.text).not.toContain("before-restart");
    // 上一代的迟到块（generation 更小）被丢弃规则挡下。
    expect(
      shouldAcceptEnvelope(
        { generation: restarted!.generation, sequence: 5 },
        { generation: meta.generation, sequence: 999 }
      )
    ).toBe(false);
  });

  it("显式 kill / disposeAll 不留在册 PTY", async () => {
    const m = make();
    m.setEmitter(() => undefined);
    const a = m.open({ workspaceId: "ws1", cwd: os.tmpdir(), profileId: null, cols: 80, rows: 24 });
    const b = m.open({ workspaceId: "ws1", cwd: os.tmpdir(), profileId: null, cols: 80, rows: 24 });
    expect(m.list("ws1").length).toBe(2);

    expect(m.kill(a.tabId)).toBe(true);
    expect(m.snapshot(a.tabId).found).toBe(false);
    expect(m.list("ws1").map((t) => t.tabId)).toEqual([b.tabId]);

    m.disposeAll();
    expect(m.list("ws1").length).toBe(0);
  });

  it("list 只返回本工作区的 tab；rename 改标题", () => {
    const m = make();
    m.setEmitter(() => undefined);
    const a = m.open({ workspaceId: "wsA", cwd: os.tmpdir(), profileId: null, cols: 80, rows: 24 });
    m.open({ workspaceId: "wsB", cwd: os.tmpdir(), profileId: null, cols: 80, rows: 24 });
    expect(m.list("wsA").map((t) => t.tabId)).toEqual([a.tabId]);

    const renamed = m.rename(a.tabId, "构建");
    expect(renamed?.title).toBe("构建");
    expect(m.list("wsA")[0].title).toBe("构建");
  });

  it("listProfiles 至少给一个 shell + 一个默认 id", () => {
    const m = make();
    const { profiles, defaultId } = m.listProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    expect(defaultId).toBeTruthy();
    expect(profiles.some((p) => p.id === defaultId)).toBe(true);
  });
});
