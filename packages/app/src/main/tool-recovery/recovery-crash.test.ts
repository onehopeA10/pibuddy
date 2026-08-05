/**
 * 真崩溃对拍：子进程 + SIGKILL。
 *
 * 前三个测试各在一个提交边界上把进程**真杀掉**（SIGKILL 不触发 finally、
 * 不 flush、不 ROLLBACK），然后重开库断言状态。这是唯一能证明「原子性来自
 * sqlite 事务，而不是 JS 里那个 try/catch」的办法 —— 后者在真崩溃时根本不会
 * 执行。
 *
 * | 杀在哪   | 重开后必须是                          |
 * |----------|---------------------------------------|
 * | T1 内    | rolled back：账本空、operation 不存在 |
 * | T1 后    | prepared：两条事实都在、进未结算列表  |
 * | T2 内    | prepared：T1 未丢、结果未落           |
 * | T2 后    | outcome_committed：结果已落、不再未结算 |
 *
 * 「T1 后」那一条还额外断言 marker 文件存在 —— 它代表「副作用真的发生过」。
 * 这一格正是整套机制存在的理由：副作用已发生但结果没落库，重开后必须能看到
 * 一条 prepared 的未结算记录，而不是什么都看不到然后自动重跑一遍。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { toolFixture } from "./ledger-fixtures";
import { ToolRecoveryStore } from "./recovery-store";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "crash-child.ts");
const LOADER = pathToFileURL(path.join(HERE, "crash-child-loader.mjs")).href;

type CrashMode = "inside_t1" | "after_t1" | "inside_t2" | "after_t2" | "inside_recovery";

async function withKilledChild(
  mode: CrashMode,
  inspect: (store: ToolRecoveryStore, markerPath: string) => void
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "pibuddy-tool-crash-"));
  const dbPath = path.join(root, "tool-recovery.db");
  const markerPath = path.join(root, "effect.marker");
  const child = spawn(process.execPath, ["--import", LOADER, CHILD], {
    env: {
      ...process.env,
      PIBUDDY_TOOL_CRASH_MODE: mode,
      PIBUDDY_TOOL_CRASH_DB: dbPath,
      PIBUDDY_TOOL_CRASH_MARKER: markerPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForReady(child);
    child.kill("SIGKILL");
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    const store = new ToolRecoveryStore(dbPath);
    try {
      inspect(store, markerPath);
    } finally {
      store.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("READY\n")) resolve();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code, signal) => {
      reject(new Error(`崩溃子进程在 READY 之前退出：code=${code} signal=${signal}\n${stderr}`));
    });
    child.once("error", reject);
  });
}

describe("真崩溃对拍（子进程 + SIGKILL）", () => {
  const fixture = toolFixture({ withProtocolMarker: true });

  it("杀在 T1 内 → 整个事务回滚，账本上什么都没留下", { timeout: 30_000 }, async () => {
    await withKilledChild("inside_t1", (store) => {
      expect(store.readLedger(fixture.workspaceId)).toEqual([]);
      expect(store.readToolOperation(fixture.operationId)).toBeUndefined();
      expect(store.listUnsettledToolOperations()).toEqual([]);
    });
  });

  it(
    "杀在 T1 后（副作用已发生）→ prepared 且进未结算列表",
    { timeout: 30_000 },
    async () => {
      await withKilledChild("after_t1", (store, markerPath) => {
        // 副作用确实发生过：这一格如果丢了记录，重开后就会重跑一次。
        expect(readFileSync(markerPath, "utf8")).toBe("effect-happened");
        expect(store.readLedger(fixture.workspaceId).map((event) => event.id)).toEqual([
          fixture.callEvent.id,
          fixture.dispatchEvent.id,
        ]);
        expect(store.readToolOperation(fixture.operationId)?.currentState).toBe("prepared");
        expect(store.listUnsettledToolOperations().map((o) => o.operationId)).toEqual([
          fixture.operationId,
        ]);
      });
    }
  );

  it("杀在 T2 内 → 回滚到 prepared，T1 的两条事实一条都没丢", { timeout: 30_000 }, async () => {
    await withKilledChild("inside_t2", (store) => {
      expect(store.readLedger(fixture.workspaceId).map((event) => event.id)).toEqual([
        fixture.callEvent.id,
        fixture.dispatchEvent.id,
      ]);
      const operation = store.readToolOperation(fixture.operationId);
      expect(operation?.currentState).toBe("prepared");
      expect(operation?.resultEventId).toBeUndefined();
    });
  });

  it("杀在 T2 后 → outcome_committed，结果已落且不再未结算", { timeout: 30_000 }, async () => {
    await withKilledChild("after_t2", (store) => {
      expect(store.readLedger(fixture.workspaceId).map((event) => event.id)).toEqual([
        fixture.callEvent.id,
        fixture.dispatchEvent.id,
        fixture.responseEvent().id,
      ]);
      expect(store.readToolOperation(fixture.operationId)).toMatchObject({
        currentState: "outcome_committed",
        resultEventId: fixture.responseEvent().id,
      });
      expect(store.listUnsettledToolOperations()).toEqual([]);
    });
  });

  it("杀在恢复包内 → 整包回滚，不留半截观测", { timeout: 30_000 }, async () => {
    await withKilledChild("inside_recovery", (store) => {
      expect(store.readLedger(fixture.workspaceId)).toHaveLength(2);
      expect(store.readToolOperation(fixture.operationId)?.currentState).toBe("prepared");
    });
  });
});
