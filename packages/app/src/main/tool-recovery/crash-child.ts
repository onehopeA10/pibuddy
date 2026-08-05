/**
 * 真崩溃对拍的子进程。**仅供 recovery-crash.test.ts 使用，生产不引用。**
 *
 * 它按 `PIBUDDY_TOOL_CRASH_MODE` 走到某个提交边界，在那一刻打印 `READY` 然后
 * 永久阻塞；父进程收到 READY 就 SIGKILL 它。SIGKILL 不给进程任何收尾机会 ——
 * 没有 finally、没有 flush、没有 ROLLBACK。这正是真崩溃现场的样子，也是唯一
 * 能证明「事务边界是 sqlite 给的，不是 JS 里那个 try/catch 给的」的办法。
 *
 * 用 `Atomics.wait` 而不是 `setTimeout(…, 1e9)` 阻塞：前者真的把主线程停住，
 * 事件循环里不会再有任何东西被处理，进程状态在被杀那一刻是冻结的。
 */
import { writeSync } from "node:fs";
import { writeFileSync } from "node:fs";

import { toolFixture } from "./ledger-fixtures";
import { ToolRecoveryStore, type ToolRecoveryFailpoint } from "./recovery-store";

const mode = requiredEnv("PIBUDDY_TOOL_CRASH_MODE");
const dbPath = requiredEnv("PIBUDDY_TOOL_CRASH_DB");
const markerPath = requiredEnv("PIBUDDY_TOOL_CRASH_MARKER");

await runCrashChild();

async function runCrashChild(): Promise<never> {
  let ledgerInserts = 0;
  let t1Done = false;
  const failpoint = (point: ToolRecoveryFailpoint): void => {
    if (point === "after_ledger_event_insert") {
      ledgerInserts += 1;
      // T1 里第一条账本行（call）刚插进去、事务还没提交 —— 在这里被杀，
      // 重开后必须什么都没有。
      if (mode === "inside_t1" && !t1Done && ledgerInserts === 1) blockUntilKilled();
      // T2 的账本行插进去了、CAS 还没跑 —— 在这里被杀，重开后必须回到
      // prepared，且 T1 的两条事实一条都不能丢。
      if (mode === "inside_t2" && t1Done) blockUntilKilled();
    }
    if (mode === "inside_recovery" && point === "after_recovery_reconcile") blockUntilKilled();
  };

  const store = new ToolRecoveryStore(dbPath, { failpoint });
  const fixture = toolFixture({ withProtocolMarker: true });

  await store.commitToolPrepared(fixture.preparedCommit());
  t1Done = true;
  if (mode === "after_t1") {
    // T1 已提交，然后「副作用真的发生了」。这一刻被杀正是整套夹逼要覆盖的
    // 最危险窗口：重开后必须看到一条 prepared 的未结算记录。
    writeFileSync(markerPath, "effect-happened");
    blockUntilKilled();
  }
  if (mode === "inside_recovery") {
    await store.commitToolRecoveryBundle(fixture.bundleCommit("diverged"));
    blockUntilKilled();
  }

  await store.commitToolOutcome(fixture.outcomeCommit());
  if (mode === "after_t2") blockUntilKilled();
  throw new Error(`未知的崩溃模式 ${mode}`);
}

function blockUntilKilled(): never {
  writeSync(1, "READY\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}
