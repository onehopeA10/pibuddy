import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { shouldAcceptEnvelope } from "@pibuddy/contract";
import { TerminalRingBuffer } from "../src/main/terminal/ring-buffer.js";
import {
  PtyManager,
  type PtyLib,
  type PtyProcess,
  type TerminalEmit,
} from "../src/main/terminal/pty-manager.js";

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

class FakePty implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose: () => undefined };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose: () => undefined };
  }

  write(data: string | Buffer): void {
    this.writes.push(data.toString());
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed = true;
  }

  fireData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  fireExit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

class FakePtyLib implements PtyLib {
  readonly children: FakePty[] = [];
  spawnCount = 0;
  private readonly failures = new Map<number, Error>();

  failSpawn(call: number, error: Error): void {
    this.failures.set(call, error);
  }

  spawn(): FakePty {
    this.spawnCount += 1;
    const failure = this.failures.get(this.spawnCount);
    if (failure) throw failure;
    const child = new FakePty();
    this.children.push(child);
    return child;
  }
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

describe("PtyManager：确定性 PTY 竞态与 workspace 所有权", () => {
  it("open spawn 同步失败会回滚会话并原样抛错", () => {
    const lib = new FakePtyLib();
    const manager = new PtyManager(lib);
    const failure = new Error("fake open spawn failure");
    lib.failSpawn(1, failure);

    expect(() =>
      manager.open({
        workspaceId: "wsA",
        cwd: os.tmpdir(),
        profileId: null,
        cols: 80,
        rows: 24,
      })
    ).toThrow(failure);
    expect(lib.spawnCount).toBe(1);
    expect(lib.children).toEqual([]);
    expect(manager.list("wsA")).toEqual([]);
    expect(manager.list("wsB")).toEqual([]);

    const opened = manager.open({
      workspaceId: "wsA",
      cwd: os.tmpdir(),
      profileId: null,
      cols: 80,
      rows: 24,
    });
    expect(manager.list("wsA").map((tab) => tab.tabId)).toEqual([opened.tabId]);
    manager.disposeAll();
  });

  it("restart spawn 同步失败保留 stopped 原代际，清掉旧 child，且可再次重启", () => {
    const lib = new FakePtyLib();
    const manager = new PtyManager(lib);
    const emits: TerminalEmit[] = [];
    manager.setEmitter((event) => emits.push(event));
    const opened = manager.open({
      workspaceId: "wsA",
      cwd: os.tmpdir(),
      profileId: null,
      cols: 80,
      rows: 24,
    });
    const oldChild = lib.children[0];
    oldChild.fireData("preserved-output".padEnd(64 * 1024, "x"));
    const emittedBeforeFailure = emits.length;
    const failure = new Error("fake restart spawn failure");
    lib.failSpawn(2, failure);

    expect(() => manager.restart("wsA", opened.tabId)).toThrow(failure);
    expect(lib.spawnCount).toBe(2);
    expect(lib.children).toEqual([oldChild]);
    expect(oldChild.killed).toBe(true);
    expect(manager.input("wsA", opened.tabId, "blocked-after-failure")).toBe(false);
    expect(manager.snapshot("wsA", opened.tabId)).toMatchObject({
      found: true,
      generation: 0,
      text: expect.stringContaining("preserved-output"),
      running: false,
      exitCode: null,
      exitSignal: null,
    });
    expect(manager.list("wsA")).toHaveLength(1);
    expect(manager.list("wsA")[0]).toMatchObject({
      tabId: opened.tabId,
      generation: 0,
      running: false,
    });

    oldChild.fireData("late-old-data");
    oldChild.fireExit(17, 9);
    expect(emits).toHaveLength(emittedBeforeFailure);

    const restarted = manager.restart("wsA", opened.tabId);
    expect(restarted).toMatchObject({ generation: 1, running: true });
    expect(lib.children).toHaveLength(2);
    expect(manager.snapshot("wsA", opened.tabId)).toMatchObject({
      generation: 1,
      text: "",
      sequence: 0,
      running: true,
    });
    manager.disposeAll();
  });

  it("restart 后旧 child 的延迟 data/exit 不得污染或结束新代际", () => {
    const lib = new FakePtyLib();
    const manager = new PtyManager(lib);
    const emits: TerminalEmit[] = [];
    manager.setEmitter((event) => emits.push(event));

    const opened = manager.open({
      workspaceId: "wsA",
      cwd: os.tmpdir(),
      profileId: null,
      cols: 80,
      rows: 24,
    });
    const oldChild = lib.children[0];
    const restarted = manager.restart("wsA", opened.tabId);
    const newChild = lib.children[1];

    expect(restarted?.generation).toBe(1);
    expect(oldChild.killed).toBe(true);

    oldChild.fireData("old-generation-data");
    oldChild.fireExit(17, 9);

    expect(emits).toEqual([]);
    expect(manager.snapshot("wsA", opened.tabId)).toMatchObject({
      found: true,
      generation: 1,
      text: "",
      sequence: 0,
      running: true,
      exitCode: null,
      exitSignal: null,
    });

    newChild.fireData("new-generation-data");
    newChild.fireExit(0);

    expect(emits.map((event) => event.generation)).toEqual([1, 1]);
    expect(emits.map((event) => event.payload.kind)).toEqual(["data", "exit"]);
    expect(manager.snapshot("wsA", opened.tabId)).toMatchObject({
      generation: 1,
      text: "new-generation-data",
      running: false,
      exitCode: 0,
    });
    manager.disposeAll();
  });

  it("七种 tab 操作都拒绝 workspace B，且 workspace A 仍可操作", () => {
    const lib = new FakePtyLib();
    const manager = new PtyManager(lib);
    const opened = manager.open({
      workspaceId: "wsA",
      cwd: os.tmpdir(),
      profileId: null,
      cols: 80,
      rows: 24,
    });
    const child = lib.children[0];

    expect(manager.input("wsB", opened.tabId, "blocked")).toBe(false);
    expect(manager.resize("wsB", opened.tabId, 100, 30)).toBe(false);
    expect(manager.snapshot("wsB", opened.tabId).found).toBe(false);
    expect(manager.clear("wsB", opened.tabId)).toBe(false);
    expect(manager.kill("wsB", opened.tabId)).toBe(false);
    expect(manager.restart("wsB", opened.tabId)).toBeNull();
    expect(manager.rename("wsB", opened.tabId, "blocked")).toBeNull();
    expect(child.writes).toEqual([]);
    expect(child.resizes).toEqual([]);
    expect(child.killed).toBe(false);

    expect(manager.input("wsA", opened.tabId, "allowed")).toBe(true);
    expect(manager.resize("wsA", opened.tabId, 120, 40)).toBe(true);
    expect(manager.snapshot("wsA", opened.tabId).found).toBe(true);
    expect(manager.clear("wsA", opened.tabId)).toBe(true);
    expect(manager.rename("wsA", opened.tabId, "allowed")?.title).toBe("allowed");
    expect(manager.restart("wsA", opened.tabId)?.generation).toBe(1);
    expect(manager.kill("wsA", opened.tabId)).toBe(true);
    expect(child.writes).toEqual(["allowed"]);
    expect(child.resizes).toEqual([[120, 40]]);
    expect(child.killed).toBe(true);
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
    m.input("ws1", meta.tabId, echoCmd(marker));

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
    m.input("ws1", meta.tabId, echoCmd(marker1));
    await waitFor(() => m.snapshot("ws1", meta.tabId).text.includes(marker1));

    // 模拟 reload：渲染进程只有 snapshot 这一份初始状态。
    const snap = m.snapshot("ws1", meta.tabId);
    expect(snap.found).toBe(true);
    expect(snap.text).toContain(marker1);
    const prevFrame = { generation: snap.generation, sequence: snap.sequence };

    // 一个「等于快照序号」的迟到块 → 渲染进程应当丢弃（去重）。
    expect(shouldAcceptEnvelope(prevFrame, { generation: snap.generation, sequence: snap.sequence })).toBe(false);

    // 续接：再 echo 一段，等到一个序号更大的块。
    const marker2 = "reconnect-marker-2";
    const before = emits.length;
    m.input("ws1", meta.tabId, echoCmd(marker2));
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

    m.input("ws1", meta.tabId, "exit\r");
    const exited = await waitFor(() => emits.some((e) => e.payload.kind === "exit"));
    expect(exited).toBe(true);

    const exitEmit = emits.find((e) => e.payload.kind === "exit");
    expect(exitEmit).toBeTruthy();
    expect(typeof (exitEmit!.payload as { exitCode: number | null }).exitCode).not.toBe("undefined");

    const snap = m.snapshot("ws1", meta.tabId);
    expect(snap.running).toBe(false);
    // 退出事件的序号严格大于最后一段数据的序号（渲染进程先回放数据再处理退出）。
    const lastData = Math.max(0, ...emits.filter((e) => e.payload.kind === "data").map((e) => e.sequence));
    expect(exitEmit!.sequence).toBeGreaterThan(lastData);
  });

  it("restart：代际 +1、换新 ring buffer；旧代际输出被丢弃规则挡下", async () => {
    const m = make();
    m.setEmitter(() => undefined);
    const meta = m.open({ workspaceId: "ws1", cwd: os.tmpdir(), profileId: null, cols: 80, rows: 24 });
    m.input("ws1", meta.tabId, echoCmd("before-restart"));
    await waitFor(() => m.snapshot("ws1", meta.tabId).text.includes("before-restart"));

    const restarted = m.restart("ws1", meta.tabId);
    expect(restarted).toBeTruthy();
    expect(restarted!.generation).toBe(meta.generation + 1);
    // 新代际的 ring buffer 是空的（旧输出不再在册）。
    const snap = m.snapshot("ws1", meta.tabId);
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

    expect(m.kill("ws1", a.tabId)).toBe(true);
    expect(m.snapshot("ws1", a.tabId).found).toBe(false);
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

    const renamed = m.rename("wsA", a.tabId, "构建");
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
