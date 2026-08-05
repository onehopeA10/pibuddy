/**
 * 工具操作账本的持久层：T1 / T2 / recovery bundle 三个**真事务**。
 *
 * ## node:sqlite，与 task-store / automation-store 同一口径
 *
 * 不引原生依赖（check-pure-js-deps 闸门）。schema 有版本 + migration，改 DDL
 * 必须 +1 并在 migrate() 里补分支，绝不静默重建 —— 这张表是崩溃恢复的唯一
 * 依据，静默重建等于把「上次到底跑没跑」的答案直接删掉。
 *
 * 按 workspaceId 分区：每条 SQL 都带 `WHERE workspace_id = ?`。
 *
 * ## 本文件刻意不 import electron
 *
 * 构造函数收一个明确的文件路径，不去问 `app.getPath("userData")`。两个原因：
 *   1. 真崩溃对拍测试要在**子进程**里用裸 node 跑这个 store 然后 SIGKILL 它。
 *      一旦这里 import 了 electron，子进程根本起不来，对拍就只能退化成假的。
 *   2. 本任务只交付原语，不接线。路径归属是接线方的决定。
 *
 * ## 三个事务的边界为什么长这样
 *
 * - **T1 `commitToolPrepared`**：把 call 事实 + dispatch 事实 + operation 行
 *   一次性落地。它必须在工具 impl 之前完成 —— dispatch 事实的存在与否就是
 *   「impl 有没有可能跑过」的判据本身。
 * - **T2 `commitToolOutcome`**：CAS 写结算。`WHERE current_state='prepared'
 *   AND result_event_id IS NULL`，`changes !== 1` 直接抛。见下方 CAS 说理。
 * - **recovery bundle**：reconcile 观测 + 可选 outcome + 终局裁决，一个事务。
 *   拆开写的失败模式是「观测落了、裁决没落」—— 下次启动看到一条无主的观测，
 *   既不能当没发生（它可能已经影响过判断），也不知道当时判了什么。
 *
 * ## T2 为什么必须是 CAS 而不是无条件 UPDATE
 *
 * 无条件 `UPDATE ... WHERE operation_id = ?` 在并发双写下**两次都成功**：
 * 第二次静默覆盖第一次的 result_event_id。表现是账本上只剩一条结算，另一次
 * 真实发生过的执行凭空消失 —— 而消失的那条可能才是产生了副作用的那次。
 * 带上 `current_state='prepared' AND result_event_id IS NULL` 之后，第二个
 * 写入者的 `changes` 是 0，立刻抛错，冲突变成可见的失败而不是静默的数据丢失。
 */
import { DatabaseSync } from "node:sqlite";

import {
  buildToolOperationId,
  canonicalToolArgsHash,
  toolCallEventId,
  toolDispatchEventId,
  toolResponseEventId,
  type ToolRecoveryMode,
} from "./operation-id";
import {
  isToolRecoveryFactEnvelope,
  parkReasonFor,
  TOOL_RECONCILE_RESULT_FACT_KIND,
  TOOL_RECOVERY_DECISION_FACT_KIND,
} from "./recovery-fact";
import {
  validateToolLedgerTransition,
  type ToolLedgerEvent,
  type ToolLedgerTransitionKind,
} from "./ledger-scanner";
import type {
  RuntimeCommitResult,
  RuntimeCommitSink,
  ToolOutcomeCommit,
  ToolPreparedCommit,
} from "./commit-sink";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const TOOL_RECOVERY_STORE_SCHEMA_VERSION = 1;

/** operation 的四个终态之一 + 起点 prepared。 */
export type ToolOperationState =
  | "prepared"
  | "outcome_committed"
  | "recovery_completed"
  | "recovery_parked";

/** 账本行的语义标签。与 ledger-scanner 的 lane 一一对应。 */
export type ToolJournalState =
  | "call"
  | "prepared"
  | "outcome_committed"
  | "reconcile_observed"
  | "recovery_completed"
  | "recovery_parked";

export interface ToolOperationRecord {
  operationId: string;
  workspaceId: string;
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  currentState: ToolOperationState;
  callEventId: string;
  dispatchEventId?: string;
  resultEventId?: string;
  version: number;
}

export interface ToolJournalRecord {
  journalSeq: number;
  journalEventId: string;
  workspaceId: string;
  operationId: string;
  eventId: string;
  state: ToolJournalState;
  event: ToolLedgerEvent;
  committedAt: number;
}

export interface ToolRecoveryBundleCommit {
  workspaceId: string;
  operationId: string;
  reconcileEvent: ToolLedgerEvent;
  outcomeEvent?: ToolLedgerEvent;
  decisionEvent: ToolLedgerEvent;
}

export type ToolRecoveryStoreErrorCode =
  | "input_identity_conflict"
  | "ledger_transition_conflict"
  | "idempotent_retry_conflict"
  | "unknown_operation"
  | "compare_and_set_failed"
  | "bundle_conflict";

export class ToolRecoveryStoreError extends Error {
  override readonly name = "ToolRecoveryStoreError";
  readonly code: ToolRecoveryStoreErrorCode;
  readonly operationId: string | undefined;

  // 不用构造函数参数属性：崩溃对拍的子进程用 Node 的 strip-only 模式直接跑
  // 这个文件，参数属性是它唯一不支持的一类语法。
  constructor(code: ToolRecoveryStoreErrorCode, message: string, operationId?: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.operationId = operationId;
  }
}

/** 崩溃对拍用的失败注入点。生产不传，开销为零。 */
export type ToolRecoveryFailpoint =
  | "after_ledger_event_insert"
  | "after_operation_insert"
  | "after_recovery_reconcile"
  | "after_recovery_outcome"
  | "after_recovery_decision";

export interface ToolRecoveryStoreOptions {
  failpoint?: (point: ToolRecoveryFailpoint) => void;
}

const DDL_OPERATIONS = `CREATE TABLE IF NOT EXISTS tool_operations (
  operation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  provider_tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  canonical_args_hash TEXT NOT NULL,
  recovery_mode TEXT NOT NULL,
  current_state TEXT NOT NULL,
  call_event_id TEXT NOT NULL,
  dispatch_event_id TEXT,
  result_event_id TEXT,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const DDL_JOURNAL = `CREATE TABLE IF NOT EXISTS tool_journal_events (
  journal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_event_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  committed_at INTEGER NOT NULL
)`;

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_tool_ops_ws ON tool_operations(workspace_id)",
  "CREATE INDEX IF NOT EXISTS idx_tool_ops_unsettled ON tool_operations(workspace_id, current_state)",
  "CREATE INDEX IF NOT EXISTS idx_tool_journal_ws ON tool_journal_events(workspace_id, journal_seq)",
  "CREATE INDEX IF NOT EXISTS idx_tool_journal_op ON tool_journal_events(operation_id, journal_seq)",
];

interface OperationRow {
  operation_id: string;
  workspace_id: string;
  session_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  provider_tool_call_id: string;
  tool_name: string;
  canonical_args_hash: string;
  recovery_mode: string;
  current_state: string;
  call_event_id: string;
  dispatch_event_id: string | null;
  result_event_id: string | null;
  version: number;
}

interface JournalRow {
  journal_seq: number;
  journal_event_id: string;
  workspace_id: string;
  operation_id: string;
  event_id: string;
  state: string;
  payload_json: string;
  committed_at: number;
}

const OPERATION_COLUMNS = `operation_id, workspace_id, session_id, invocation_id, run_id, turn_id,
  provider_tool_call_id, tool_name, canonical_args_hash, recovery_mode, current_state,
  call_event_id, dispatch_event_id, result_event_id, version`;

function operationFromRow(row: OperationRow): ToolOperationRecord {
  return {
    operationId: row.operation_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    invocationId: row.invocation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    providerToolCallId: row.provider_tool_call_id,
    toolName: row.tool_name,
    canonicalArgsHash: row.canonical_args_hash,
    recoveryMode: row.recovery_mode as ToolRecoveryMode,
    currentState: row.current_state as ToolOperationState,
    callEventId: row.call_event_id,
    ...(row.dispatch_event_id === null ? {} : { dispatchEventId: row.dispatch_event_id }),
    ...(row.result_event_id === null ? {} : { resultEventId: row.result_event_id }),
    version: row.version,
  };
}

export class ToolRecoveryStore implements RuntimeCommitSink {
  private readonly db: DatabaseSync;
  private readonly options: ToolRecoveryStoreOptions;

  constructor(file: string, options: ToolRecoveryStoreOptions = {}) {
    this.options = options;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    // 崩溃对拍的前提：已提交的事务必须真的落盘，而不是留在 OS 缓冲里。
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(DDL_OPERATIONS);
    this.db.exec(DDL_JOURNAL);
    for (const index of INDEXES) this.db.exec(index);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current >= TOOL_RECOVERY_STORE_SCHEMA_VERSION) return;
    // v0 → v1：首次建库。将来改 DDL 时在这里按 current 补 ALTER 分支，绝不重建。
    this.db.exec(`PRAGMA user_version = ${TOOL_RECOVERY_STORE_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------ 读

  readToolOperation(operationId: string): ToolOperationRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${OPERATION_COLUMNS} FROM tool_operations WHERE operation_id = ?`)
      .get(operationId) as OperationRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  /**
   * 未结算的 operation：`prepared` + 无结果 + **有 dispatch**。
   *
   * 第三个条件不能省。没有 dispatch 事实的 prepared 行只可能来自 pre-T1 的
   * 老数据，它无法证明自己处在夹逼里 —— 把它交给恢复流程去 reconcile，等于
   * 用新协议的语义解释老数据，正是三态判据禁止的事。
   */
  listUnsettledToolOperations(workspaceId?: string): ToolOperationRecord[] {
    const where =
      workspaceId === undefined
        ? ""
        : "AND workspace_id = ?";
    const statement = this.db.prepare(`
      SELECT ${OPERATION_COLUMNS} FROM tool_operations
      WHERE current_state = 'prepared'
        AND result_event_id IS NULL
        AND dispatch_event_id IS NOT NULL
        ${where}
      ORDER BY invocation_id ASC, operation_id ASC
    `);
    const rows = (
      workspaceId === undefined ? statement.all() : statement.all(workspaceId)
    ) as unknown as OperationRow[];
    return rows.map(operationFromRow);
  }

  /** 一个工作区的账本，物理顺序。喂给 scanToolLedger / resolveToolRecovery。 */
  readLedger(workspaceId: string): ToolLedgerEvent[] {
    return this.readJournal(workspaceId).map((record) => record.event);
  }

  readJournal(workspaceId: string, operationId?: string): ToolJournalRecord[] {
    const statement = this.db.prepare(`
      SELECT journal_seq, journal_event_id, workspace_id, operation_id, event_id, state,
        payload_json, committed_at
      FROM tool_journal_events
      WHERE workspace_id = ? ${operationId === undefined ? "" : "AND operation_id = ?"}
      ORDER BY journal_seq ASC
    `);
    const rows = (
      operationId === undefined
        ? statement.all(workspaceId)
        : statement.all(workspaceId, operationId)
    ) as unknown as JournalRow[];
    return rows.map((row) => ({
      journalSeq: row.journal_seq,
      journalEventId: row.journal_event_id,
      workspaceId: row.workspace_id,
      operationId: row.operation_id,
      eventId: row.event_id,
      state: row.state as ToolJournalState,
      event: JSON.parse(row.payload_json) as ToolLedgerEvent,
      committedAt: row.committed_at,
    }));
  }

  // --------------------------------------------------------------- T1

  async commitToolPrepared(input: ToolPreparedCommit): Promise<RuntimeCommitResult> {
    assertPreparedInput(input);
    return this.transaction(() => {
      const existing = this.readToolOperation(input.operationId);
      if (existing) {
        // 幂等重试：逐字节比对已存记录。相同则短路，不同则冲突抛错。
        // 「差不多相同」不算 —— 差的那一点可能正好是实参。
        assertPreparedIdentity(existing, input);
        this.assertStoredEventEquals(input.callEvent);
        this.assertStoredEventEquals(input.dispatchEvent);
        return { created: false, ledgerSeq: this.ledgerSeq(input.operationId) };
      }

      this.assertLedgerTransition(
        input.workspaceId,
        [input.callEvent, input.dispatchEvent],
        "t1_prepare"
      );
      this.insertJournalEvent(input.operationId, input.callEvent, "call", input.committedAt);
      this.insertJournalEvent(
        input.operationId,
        input.dispatchEvent,
        "prepared",
        input.committedAt
      );
      this.db
        .prepare(`
          INSERT INTO tool_operations (
            operation_id, workspace_id, session_id, invocation_id, run_id, turn_id,
            provider_tool_call_id, tool_name, canonical_args_hash, recovery_mode,
            current_state, call_event_id, dispatch_event_id, result_event_id, version,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, NULL, 1, ?, ?)
        `)
        .run(
          input.operationId,
          input.workspaceId,
          input.callEvent.sessionId,
          input.callEvent.invocationId,
          input.callEvent.runId,
          input.callEvent.turnId,
          input.providerToolCallId,
          input.toolName,
          input.canonicalArgsHash,
          input.recoveryMode,
          input.callEvent.id,
          input.dispatchEvent.id,
          input.committedAt,
          input.committedAt
        );
      this.options.failpoint?.("after_operation_insert");
      return { created: true, ledgerSeq: this.ledgerSeq(input.operationId) };
    });
  }

  // --------------------------------------------------------------- T2

  async commitToolOutcome(input: ToolOutcomeCommit): Promise<RuntimeCommitResult> {
    return this.transaction(() => this.commitToolOutcomeSync(input));
  }

  private commitToolOutcomeSync(input: ToolOutcomeCommit): RuntimeCommitResult {
    const operation = this.readToolOperation(input.operationId);
    if (!operation || operation.workspaceId !== input.workspaceId) {
      throw new ToolRecoveryStoreError(
        "unknown_operation",
        `未知的工具操作 ${input.operationId}`,
        input.operationId
      );
    }
    assertOutcomeIdentity(operation, input.outcomeEvent);

    if (operation.resultEventId) {
      if (operation.resultEventId !== input.outcomeEvent.id) {
        throw new ToolRecoveryStoreError(
          "idempotent_retry_conflict",
          `已结算为 ${operation.resultEventId}，与本次 ${input.outcomeEvent.id} 冲突`,
          input.operationId
        );
      }
      this.assertStoredEventEquals(input.outcomeEvent);
      return { created: false, ledgerSeq: this.ledgerSeq(input.operationId) };
    }

    this.assertLedgerTransition(input.workspaceId, [input.outcomeEvent], "t2_outcome");
    this.insertJournalEvent(
      input.operationId,
      input.outcomeEvent,
      "outcome_committed",
      input.committedAt
    );
    // CAS：见文件头说理。changes !== 1 就是并发双写，必须抛。
    const updated = this.db
      .prepare(`
        UPDATE tool_operations
        SET current_state = 'outcome_committed', result_event_id = ?, version = version + 1,
          updated_at = ?
        WHERE operation_id = ? AND workspace_id = ?
          AND current_state = 'prepared' AND result_event_id IS NULL
      `)
      .run(input.outcomeEvent.id, input.committedAt, input.operationId, input.workspaceId);
    if (updated.changes !== 1) {
      throw new ToolRecoveryStoreError(
        "compare_and_set_failed",
        `T2 比较并置换失败（changes=${updated.changes}）`,
        input.operationId
      );
    }
    return { created: true, ledgerSeq: this.ledgerSeq(input.operationId) };
  }

  // ---------------------------------------------------- recovery bundle

  /**
   * 恢复包：reconcile 观测 + 可选 outcome + 终局裁决，**一个事务**。
   *
   * 已结算的 operation 只接受**完全相同**的重试（同样的三条事件、同样的终态）。
   * 「差不多的重试」会把一次 parked 悄悄改写成 completed，或者反过来。
   */
  async commitToolRecoveryBundle(input: ToolRecoveryBundleCommit): Promise<void> {
    this.transaction(() => {
      const operation = this.readToolOperation(input.operationId);
      if (!operation || operation.workspaceId !== input.workspaceId) {
        throw new ToolRecoveryStoreError(
          "unknown_operation",
          `未知的工具操作 ${input.operationId}`,
          input.operationId
        );
      }
      if (!operation.dispatchEventId) {
        throw new ToolRecoveryStoreError(
          "bundle_conflict",
          "恢复包要求 operation 有持久化的 dispatch 事实",
          input.operationId
        );
      }
      const disposition = assertRecoveryBundle(operation, input);

      if (operation.currentState !== "prepared" || operation.resultEventId !== undefined) {
        this.assertExactBundleAlreadyCommitted(operation, input, disposition);
        return;
      }

      this.assertLedgerTransition(
        input.workspaceId,
        [
          input.reconcileEvent,
          ...(input.outcomeEvent ? [input.outcomeEvent] : []),
          input.decisionEvent,
        ],
        "recovery_bundle"
      );

      this.insertJournalEvent(
        input.operationId,
        input.reconcileEvent,
        "reconcile_observed",
        input.reconcileEvent.ts
      );
      this.bumpVersion(input.operationId, input.reconcileEvent.ts);
      this.options.failpoint?.("after_recovery_reconcile");

      if (input.outcomeEvent) {
        this.commitToolOutcomeSync({
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          outcomeEvent: input.outcomeEvent,
          committedAt: input.outcomeEvent.ts,
        });
        this.options.failpoint?.("after_recovery_outcome");
      }

      const terminalState =
        disposition === "completed" ? "recovery_completed" : "recovery_parked";
      this.insertJournalEvent(
        input.operationId,
        input.decisionEvent,
        terminalState,
        input.decisionEvent.ts
      );
      const expectedPriorState = disposition === "completed" ? "outcome_committed" : "prepared";
      const updated = this.db
        .prepare(`
          UPDATE tool_operations
          SET current_state = ?, version = version + 1, updated_at = ?
          WHERE operation_id = ? AND workspace_id = ? AND current_state = ?
        `)
        .run(
          terminalState,
          input.decisionEvent.ts,
          input.operationId,
          input.workspaceId,
          expectedPriorState
        );
      if (updated.changes !== 1) {
        throw new ToolRecoveryStoreError(
          "compare_and_set_failed",
          `恢复裁决比较并置换失败（changes=${updated.changes}）`,
          input.operationId
        );
      }
      this.options.failpoint?.("after_recovery_decision");
    });
  }

  // ------------------------------------------------------------ 内部工具

  private assertExactBundleAlreadyCommitted(
    operation: ToolOperationRecord,
    input: ToolRecoveryBundleCommit,
    disposition: "completed" | "parked"
  ): void {
    const expectedState = disposition === "completed" ? "recovery_completed" : "recovery_parked";
    if (
      operation.currentState !== expectedState ||
      (disposition === "completed"
        ? operation.resultEventId !== input.outcomeEvent?.id
        : operation.resultEventId !== undefined)
    ) {
      throw new ToolRecoveryStoreError(
        "bundle_conflict",
        `工具操作 ${operation.operationId} 已结算，拒绝不同的恢复包`,
        operation.operationId
      );
    }
    for (const event of [
      input.reconcileEvent,
      ...(input.outcomeEvent ? [input.outcomeEvent] : []),
      input.decisionEvent,
    ]) {
      this.assertStoredEventEquals(event);
    }
  }

  private bumpVersion(operationId: string, at: number): void {
    const updated = this.db
      .prepare("UPDATE tool_operations SET version = version + 1, updated_at = ? WHERE operation_id = ?")
      .run(at, operationId);
    if (updated.changes !== 1) {
      throw new ToolRecoveryStoreError(
        "compare_and_set_failed",
        `版本递增失败（changes=${updated.changes}）`,
        operationId
      );
    }
  }

  private assertLedgerTransition(
    workspaceId: string,
    candidateEvents: readonly ToolLedgerEvent[],
    expectedTransition: ToolLedgerTransitionKind
  ): void {
    const validation = validateToolLedgerTransition({
      existingEvents: this.readLedger(workspaceId),
      candidateEvents,
      expectedTransition,
    });
    if (!validation.ok) {
      throw new ToolRecoveryStoreError(
        "ledger_transition_conflict",
        `${validation.code} @ ${validation.eventId}`,
        validation.operationId
      );
    }
  }

  private assertStoredEventEquals(event: ToolLedgerEvent): void {
    const row = this.db
      .prepare("SELECT payload_json FROM tool_journal_events WHERE event_id = ?")
      .get(event.id) as { payload_json: string } | undefined;
    if (row === undefined) {
      throw new ToolRecoveryStoreError(
        "idempotent_retry_conflict",
        `账本缺少事件 ${event.id}，无法确认这是一次幂等重试`
      );
    }
    if (row.payload_json !== JSON.stringify(event)) {
      throw new ToolRecoveryStoreError(
        "idempotent_retry_conflict",
        `事件 ${event.id} 与已存记录不同，拒绝当作幂等重试`
      );
    }
  }

  private insertJournalEvent(
    operationId: string,
    event: ToolLedgerEvent,
    state: ToolJournalState,
    committedAt: number
  ): void {
    this.db
      .prepare(`
        INSERT INTO tool_journal_events (
          journal_event_id, workspace_id, operation_id, event_id, state, payload_json, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        `${event.id}_journal`,
        event.workspaceId,
        operationId,
        event.id,
        state,
        JSON.stringify(event),
        committedAt
      );
    this.options.failpoint?.("after_ledger_event_insert");
  }

  private ledgerSeq(operationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM tool_journal_events WHERE operation_id = ?")
      .get(operationId) as { count: number };
    return row.count;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务已因错误自行回滚时 ROLLBACK 会再抛一次。原始错误更重要。
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------- 入参校验

/**
 * T1 入参的身份自洽校验。
 *
 * 全部字段都要能从 `(invocationId, providerToolCallId)` 和 call 事实推出来。
 * 只信写入方自述的后果：恢复时算出来的 operationId 和账本里那个对不上，
 * 整条记录就成了孤儿 —— 而它明明已经产生过副作用。
 */
function assertPreparedInput(input: ToolPreparedCommit): void {
  const call = input.callEvent.call;
  const dispatch = input.dispatchEvent.dispatch;
  const fail = (message: string): never => {
    throw new ToolRecoveryStoreError("input_identity_conflict", message, input.operationId);
  };

  if (!call) fail("callEvent 必须携带 function_call 事实");
  if (!dispatch) fail("dispatchEvent 必须携带 dispatch 事实");
  const derived = buildToolOperationId({
    invocationId: input.callEvent.invocationId,
    providerToolCallId: input.providerToolCallId,
  });
  if (derived !== input.operationId) {
    fail(`operationId 必须由 (invocationId, providerToolCallId) 确定性派生，期望 ${derived}`);
  }
  if (input.callEvent.id !== toolCallEventId(input.operationId)) {
    fail(`callEvent.id 必须是 ${toolCallEventId(input.operationId)}`);
  }
  if (input.dispatchEvent.id !== toolDispatchEventId(input.operationId)) {
    fail(`dispatchEvent.id 必须是 ${toolDispatchEventId(input.operationId)}`);
  }
  if (
    input.callEvent.workspaceId !== input.workspaceId ||
    input.dispatchEvent.workspaceId !== input.workspaceId
  ) {
    fail("两条事件的 workspaceId 必须与入参一致");
  }
  if (
    call!.toolCallId !== input.providerToolCallId ||
    call!.toolName !== input.toolName ||
    dispatch!.operationId !== input.operationId ||
    dispatch!.providerToolCallId !== input.providerToolCallId ||
    dispatch!.toolName !== input.toolName ||
    dispatch!.recoveryMode !== input.recoveryMode
  ) {
    fail("call / dispatch 事实与入参身份不一致");
  }
  // 实参重新哈希：不接受写入方自述的 canonicalArgsHash。
  const actual = canonicalToolArgsHash(call!.toolName, call!.args);
  if (actual !== input.canonicalArgsHash || dispatch!.canonicalArgsHash !== actual) {
    fail(`canonicalArgsHash 与实参重算结果不符，期望 ${actual}`);
  }
  if (
    input.dispatchEvent.invocationId !== input.callEvent.invocationId ||
    input.dispatchEvent.sessionId !== input.callEvent.sessionId ||
    input.dispatchEvent.runId !== input.callEvent.runId ||
    input.dispatchEvent.turnId !== input.callEvent.turnId
  ) {
    fail("dispatch 与 call 必须处在同一执行身份上");
  }
}

/** 幂等重试的身份比对：任何一处不同都是冲突，不是重试。 */
function assertPreparedIdentity(
  existing: ToolOperationRecord,
  input: ToolPreparedCommit
): void {
  if (
    existing.workspaceId !== input.workspaceId ||
    existing.sessionId !== input.callEvent.sessionId ||
    existing.invocationId !== input.callEvent.invocationId ||
    existing.runId !== input.callEvent.runId ||
    existing.turnId !== input.callEvent.turnId ||
    existing.providerToolCallId !== input.providerToolCallId ||
    existing.toolName !== input.toolName ||
    existing.canonicalArgsHash !== input.canonicalArgsHash ||
    existing.recoveryMode !== input.recoveryMode ||
    existing.callEventId !== input.callEvent.id ||
    existing.dispatchEventId !== input.dispatchEvent.id
  ) {
    throw new ToolRecoveryStoreError(
      "idempotent_retry_conflict",
      `operationId ${input.operationId} 已存在但身份不同，拒绝当作幂等重试`,
      input.operationId
    );
  }
}

function assertOutcomeIdentity(
  operation: ToolOperationRecord,
  outcomeEvent: ToolLedgerEvent
): void {
  const response = outcomeEvent.response;
  const fail = (message: string): never => {
    throw new ToolRecoveryStoreError(
      "input_identity_conflict",
      message,
      operation.operationId
    );
  };
  if (!response) fail("outcomeEvent 必须携带 function_response 事实");
  if (outcomeEvent.id !== toolResponseEventId(operation.operationId)) {
    fail(`outcomeEvent.id 必须是 ${toolResponseEventId(operation.operationId)}`);
  }
  if (
    response!.toolCallId !== operation.providerToolCallId ||
    response!.toolName !== operation.toolName ||
    outcomeEvent.refs?.operationId !== operation.operationId ||
    outcomeEvent.refs?.toolCallId !== operation.providerToolCallId ||
    outcomeEvent.workspaceId !== operation.workspaceId ||
    outcomeEvent.sessionId !== operation.sessionId ||
    outcomeEvent.invocationId !== operation.invocationId ||
    outcomeEvent.runId !== operation.runId ||
    outcomeEvent.turnId !== operation.turnId
  ) {
    fail("结算事件与 operation 身份不一致");
  }
}

/**
 * 恢复包的交叉校验：两条事实必须互相印证，且证据链顺序固定。
 *
 * 证据顺序 `[call, dispatch, reconcile, (outcome)]` 是**因果**顺序。允许乱序
 * 就等于允许一条裁决声称它依据了一个当时还不存在的观测。
 */
function assertRecoveryBundle(
  operation: ToolOperationRecord,
  input: ToolRecoveryBundleCommit
): "completed" | "parked" {
  const bad = (message: string): ToolRecoveryStoreError =>
    new ToolRecoveryStoreError("bundle_conflict", message, operation.operationId);

  const reconcileEnvelope = input.reconcileEvent.recovery;
  if (
    !isToolRecoveryFactEnvelope(reconcileEnvelope) ||
    reconcileEnvelope.kind !== TOOL_RECONCILE_RESULT_FACT_KIND
  ) {
    throw bad("恢复包要求一条规范的 reconcile 事实");
  }
  const decisionEnvelope = input.decisionEvent.recovery;
  if (
    !isToolRecoveryFactEnvelope(decisionEnvelope) ||
    decisionEnvelope.kind !== TOOL_RECOVERY_DECISION_FACT_KIND
  ) {
    throw bad("恢复包要求一条规范的 recovery decision 事实");
  }
  const reconcile = reconcileEnvelope.payload;
  const decision = decisionEnvelope.payload;

  if (
    reconcile.operationId !== operation.operationId ||
    decision.operationId !== operation.operationId
  ) {
    throw bad("恢复事实的 operationId 与 operation 不一致");
  }
  if (operation.recoveryMode !== "reconcile") {
    throw bad("恢复包仅支持 reconcile 恢复模式");
  }
  for (const event of [input.reconcileEvent, input.decisionEvent]) {
    if (
      event.workspaceId !== operation.workspaceId ||
      event.sessionId !== operation.sessionId ||
      event.invocationId !== operation.invocationId ||
      event.runId !== operation.runId ||
      event.turnId !== operation.turnId ||
      event.refs?.operationId !== operation.operationId ||
      event.refs?.toolCallId !== operation.providerToolCallId
    ) {
      throw bad(`恢复事实 ${event.id} 与 operation 执行身份不一致`);
    }
  }
  const dispatchEventId = operation.dispatchEventId;
  if (dispatchEventId === undefined) throw bad("恢复包要求持久化的 dispatch 事实");

  const evidence = [operation.callEventId, dispatchEventId, input.reconcileEvent.id];
  if (decision.disposition === "completed") {
    const outcomeEvent = input.outcomeEvent;
    if (!outcomeEvent) throw bad("completed 裁决必须带一条落地的 outcome");
    if (reconcile.observation !== "matches_expected_state") {
      throw bad("completed 裁决要求观测为 matches_expected_state");
    }
    if (outcomeEvent.response?.isError === true) {
      throw bad("completed 裁决要求一条成功的合成结果");
    }
    if (decision.outcomeEventId !== outcomeEvent.id) {
      throw bad("completed 裁决引用的 outcome 与提交的不一致");
    }
    assertOutcomeIdentity(operation, outcomeEvent);
    evidence.push(outcomeEvent.id);
  } else {
    if (input.outcomeEvent) throw bad("parked 裁决不得提交 outcome");
    if (reconcile.observation === "matches_expected_state") {
      throw bad("parked 裁决与 matches_expected_state 观测矛盾");
    }
    const expected = parkReasonFor(reconcile.observation);
    if (decision.reasonCode !== expected) throw bad(`parked 原因必须是 ${expected}`);
  }
  const evidenceIds = decision.evidenceEventIds;
  if (
    evidenceIds.length !== evidence.length ||
    evidenceIds.some((id, index) => id !== evidence[index])
  ) {
    throw bad("恢复裁决的证据链与规范因果顺序不符");
  }
  return decision.disposition;
}
