/**
 * 工具账本扫描：按**物理顺序单次**扫过所有事件，聚合成 operation。
 *
 * ## 一次扫描，一个解释权
 *
 * 恢复分类（recovery-resolver）和存储事务（recovery-store）都要知道「这条
 * operation 有没有 call / dispatch / response、有没有重复、身份对不对得上」。
 * 如果两边各自建一遍 Map，迟早会在某个边界上给出不同答案 —— 而这类分歧的
 * 表现是「恢复说没跑，存储说跑过了」，最后靠掷硬币收场。所以这里是唯一的
 * 聚合入口，两个消费者都只能读它的输出。
 *
 * ## 主键是元组，不是裸 toolCallId
 *
 * provider 的 tool_call_id 只在一次 invocation 内唯一。裸拿它当 key，跨
 * invocation 的复用会把两次不同调用并成一条 —— 第二次会被当成「重复」而
 * 短路，工具实际没跑。所以 key 是 `JSON([invocationId, toolCallId])`。
 *
 * ## lane 语义：一行记录只能属于一个语义 lane
 *
 * 一条账本行要么是 call、要么是 dispatch、要么是 response、要么是恢复事实，
 * 不能同时是两样。允许并存的后果是同一行会被在线投影、重建、恢复三条路径
 * 解释成不同的东西 —— 这是最难查的一类不一致，因为每条路径单看都自洽。
 * 违反即 `semantic_lane_conflict`，扫描立刻把整个账本判损坏。
 *
 * ## dispatch 落地时回溯校验已存在的 response
 *
 * 物理顺序里 response 出现在 dispatch 之前是**可能**的（pre-T1 的老数据里，
 * 结果先落、派发事实根本不存在）。但如果之后又来了一条 dispatch 把这条
 * operation 绑上了 operationId，那条先到的 response 必须重新按新身份校验一次
 * ——它当时是无主的，现在有主了。不回溯就等于默认「先到的一定属于后来的
 * 那个 operation」，而这正是需要证明的东西。
 */
import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  TOOL_DISPATCH_PROTOCOL_V1,
  canonicalToolArgsHash,
  type ToolBoundaryProtocol,
  type ToolRecoveryMode,
} from "./operation-id";
import {
  TOOL_RECONCILE_RESULT_FACT_KIND,
  TOOL_RECOVERY_DECISION_FACT_KIND,
  isToolRecoveryFactEnvelope,
  type ToolRecoveryFactEnvelope,
} from "./recovery-fact";

// ----------------------------------------------------------------- 账本事件

export interface ToolCallFact {
  toolCallId: string;
  toolName: string;
  /** 模型给出的原始实参。dispatch 落地时会拿它重新哈希比对。 */
  args: unknown;
}

export interface ToolDispatchFact {
  protocol: typeof TOOL_DISPATCH_PROTOCOL_V1;
  operationId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
}

export interface ToolResponseFact {
  toolCallId: string;
  toolName: string;
  isError: boolean;
}

export interface ToolLedgerRefs {
  operationId?: string;
  toolCallId?: string;
}

/**
 * 账本上的一行。四个 lane 字段**至多一个**可以出现（见文件头）。
 *
 * `protocol` 是工具边界协议标记，只允许出现在账本首位（第 0 行）——它宣告
 * 的是「从这一行起，本账本承诺 dispatch 事实必然先于任何副作用落地」。
 * 出现在中间就意味着这条承诺对前面的行不成立，而账本读者无法分辨边界在哪。
 */
export interface ToolLedgerEvent {
  id: string;
  workspaceId: string;
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  ts: number;
  protocol?: { toolBoundary: string };
  call?: ToolCallFact;
  dispatch?: ToolDispatchFact;
  response?: ToolResponseFact;
  recovery?: ToolRecoveryFactEnvelope;
  refs?: ToolLedgerRefs;
}

export type ToolLedgerLane =
  | "ordinary"
  | "function_call"
  | "tool_dispatch"
  | "function_response"
  | "reconcile_result"
  | "recovery_decision";

export type ToolLedgerIssueCode =
  | "duplicate_event_id"
  | "semantic_lane_conflict"
  | "protocol_marker_invalid"
  | "duplicate_call"
  | "duplicate_operation"
  | "duplicate_dispatch"
  | "duplicate_response"
  | "orphan_dispatch"
  | "orphan_response"
  | "canonical_args_hash_conflict"
  | "invocation_identity_conflict"
  | "identity_conflict"
  | "event_order_conflict";

export interface ToolLedgerIssue {
  code: ToolLedgerIssueCode;
  eventId: string;
  operationId?: string;
  toolCallId?: string;
}

export interface ToolLedgerScanOperation {
  invocationId: string;
  toolCallId: string;
  toolName?: string;
  operationId?: string;
  callEvent?: ToolLedgerEvent;
  dispatchEvent?: ToolLedgerEvent;
  responseEvent?: ToolLedgerEvent;
  reconcileEvents: ToolLedgerEvent[];
  decisionEvents: ToolLedgerEvent[];
  issues: ToolLedgerIssue[];
}

/**
 * 协议标记的**三态**（这是分类算法的核心判据来源，见 recovery-resolver）。
 *
 *   - `absent`  ：账本里根本没有标记 → legacy 数据，一律保守。
 *   - `valid`   ：首位有、且版本认识 → 新协议，缺 dispatch 可判「没派发」。
 *   - `invalid` ：首位有但版本不认识、或标记出现在非首位 → 直接判损坏。
 *
 * 没有第四态。尤其没有「标记坏了就当 legacy 继续用」这一态 —— 那等于把
 * 一份自称新协议、实则无法解释的账本降级成可用，然后按 legacy 的宽松规则
 * 继续读它。
 */
export type ToolLedgerProtocolMarker =
  | { status: "absent" }
  | { status: "valid"; protocol: ToolBoundaryProtocol }
  | { status: "invalid"; eventId: string; reason: "unknown_version" | "not_first" };

export interface ToolLedgerScanResult {
  operations: ToolLedgerScanOperation[];
  issues: ToolLedgerIssue[];
  hasCorruption: boolean;
  protocolMarker: ToolLedgerProtocolMarker;
}

export type ToolLedgerLaneValidation =
  | { ok: true; lane: ToolLedgerLane }
  | { ok: false; code: "semantic_lane_conflict"; eventId: string };

export type ToolLedgerTransitionKind = "t1_prepare" | "t2_outcome" | "recovery_bundle";

export type ToolLedgerTransitionValidation =
  | { ok: true }
  | {
      ok: false;
      code: ToolLedgerIssueCode | "transition_shape_conflict";
      eventId: string;
      operationId?: string;
      toolCallId?: string;
    };

// ------------------------------------------------------------------- lane

/**
 * 判定一行属于哪个语义 lane，并校验它的信封形状。
 *
 * 形状校验不是洁癖：dispatch 行如果允许带 content，它就能同时被读成一次
 * 模型输出；response 行如果允许缺 refs.operationId，它就无法证明自己结算的
 * 是哪次派发。
 */
export function validateToolLedgerEventLane(event: ToolLedgerEvent): ToolLedgerLaneValidation {
  const recoveryKind = event.recovery?.kind;
  const lanes = [
    event.call ? "function_call" : undefined,
    event.dispatch ? "tool_dispatch" : undefined,
    event.response ? "function_response" : undefined,
    recoveryKind === TOOL_RECONCILE_RESULT_FACT_KIND ? "reconcile_result" : undefined,
    recoveryKind === TOOL_RECOVERY_DECISION_FACT_KIND ? "recovery_decision" : undefined,
  ].filter((lane): lane is Exclude<ToolLedgerLane, "ordinary"> => lane !== undefined);

  // recovery 字段在但 kind 认不出来：它既不是 reconcile 也不是 decision，
  // 却占着 recovery 这个位置 —— 这是形状冲突，不是「普通行」。
  if (event.recovery !== undefined && lanes.length === 0) {
    return { ok: false, code: "semantic_lane_conflict", eventId: event.id };
  }
  if (lanes.length === 0) return { ok: true, lane: "ordinary" };
  const lane = lanes[0]!;
  if (lanes.length !== 1 || !matchesLaneEnvelope(event, lane)) {
    return { ok: false, code: "semantic_lane_conflict", eventId: event.id };
  }
  return { ok: true, lane };
}

function matchesLaneEnvelope(
  event: ToolLedgerEvent,
  lane: Exclude<ToolLedgerLane, "ordinary">
): boolean {
  switch (lane) {
    case "function_call":
      // call 行不带 refs：它发生在 operationId 存在之前。
      return event.refs === undefined;
    case "tool_dispatch": {
      const dispatch = event.dispatch;
      return (
        dispatch !== undefined &&
        dispatch.protocol === TOOL_DISPATCH_PROTOCOL_V1 &&
        hasOnlyKeys(event.refs, ["operationId", "toolCallId"]) &&
        event.refs?.operationId === dispatch.operationId &&
        event.refs?.toolCallId === dispatch.providerToolCallId
      );
    }
    case "function_response":
      // 允许两种：pre-T1 无 refs 的老 response；T2 落地的带 refs 的 response。
      return event.refs === undefined || hasOnlyKeys(event.refs, ["operationId", "toolCallId"]);
    case "reconcile_result":
    case "recovery_decision":
      return (
        isToolRecoveryFactEnvelope(event.recovery) &&
        hasOnlyKeys(event.refs, ["operationId", "toolCallId"])
      );
  }
}

// ------------------------------------------------------------------ 扫描

export function scanToolLedger(events: readonly ToolLedgerEvent[]): ToolLedgerScanResult {
  const operations: ToolLedgerScanOperation[] = [];
  const issues: ToolLedgerIssue[] = [];
  const seenEventIds = new Set<string>();
  const byToolCall = new Map<string, ToolLedgerScanOperation>();
  const byOperation = new Map<string, ToolLedgerScanOperation>();
  const invocationSpines = new Map<string, string>();

  const addIssue = (operation: ToolLedgerScanOperation | undefined, issue: ToolLedgerIssue) => {
    issues.push(issue);
    operation?.issues.push(issue);
  };

  const protocolMarker = readProtocolMarker(events);
  if (protocolMarker.status === "invalid") {
    issues.push({ code: "protocol_marker_invalid", eventId: protocolMarker.eventId });
  }

  for (const event of events) {
    if (seenEventIds.has(event.id)) {
      addIssue(undefined, { code: "duplicate_event_id", eventId: event.id });
      continue;
    }
    seenEventIds.add(event.id);

    // 同一个 invocation 的所有行必须落在同一条 (session, run, turn) 脊上。
    // 不然「元组主键」的 invocation 部分就不再是一个确定的执行上下文。
    const spine = JSON.stringify([event.workspaceId, event.sessionId, event.runId, event.turnId]);
    const existingSpine = invocationSpines.get(event.invocationId);
    if (existingSpine !== undefined && existingSpine !== spine) {
      addIssue(undefined, { code: "invocation_identity_conflict", eventId: event.id });
    } else {
      invocationSpines.set(event.invocationId, spine);
    }

    const lane = validateToolLedgerEventLane(event);
    if (!lane.ok) {
      addIssue(undefined, { code: lane.code, eventId: lane.eventId });
      continue;
    }

    if (lane.lane === "function_call") {
      scanCall(event, byToolCall, operations, addIssue);
      continue;
    }
    if (lane.lane === "tool_dispatch") {
      scanDispatch(event, byToolCall, byOperation, operations, addIssue);
      continue;
    }
    if (lane.lane === "function_response") {
      scanResponse(event, byToolCall, operations, addIssue);
      continue;
    }
    if (lane.lane === "reconcile_result" || lane.lane === "recovery_decision") {
      const fact = event.recovery;
      if (!fact) continue;
      const operation = byOperation.get(fact.payload.operationId);
      if (!operation) {
        // 恢复事实指向一个此刻还不存在的 operation：要么派发事实丢了，
        // 要么这两行的物理顺序被人动过。两种都不允许继续解释。
        addIssue(undefined, {
          code: "event_order_conflict",
          eventId: event.id,
          operationId: fact.payload.operationId,
          ...(event.refs?.toolCallId ? { toolCallId: event.refs.toolCallId } : {}),
        });
        continue;
      }
      if (lane.lane === "reconcile_result") operation.reconcileEvents.push(event);
      else operation.decisionEvents.push(event);
    }
  }

  return { operations, issues, hasCorruption: issues.length > 0, protocolMarker };
}

type AddIssue = (operation: ToolLedgerScanOperation | undefined, issue: ToolLedgerIssue) => void;

function scanCall(
  event: ToolLedgerEvent,
  byToolCall: Map<string, ToolLedgerScanOperation>,
  operations: ToolLedgerScanOperation[],
  addIssue: AddIssue
): void {
  const call = event.call;
  if (!call) return;
  const key = toolCallIdentity(event.invocationId, call.toolCallId);
  const existing = byToolCall.get(key);
  if (existing) {
    if (!existing.callEvent) {
      // 先前由 dispatch/response 建出来的壳，现在 call 补上了。
      existing.callEvent = event;
      if (existing.toolName !== call.toolName) {
        addIssue(existing, identityIssue(event, existing, call.toolCallId));
      }
      return;
    }
    addIssue(existing, {
      code: "duplicate_call",
      eventId: event.id,
      toolCallId: call.toolCallId,
      ...(existing.operationId ? { operationId: existing.operationId } : {}),
    });
    return;
  }
  const operation: ToolLedgerScanOperation = {
    invocationId: event.invocationId,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    callEvent: event,
    reconcileEvents: [],
    decisionEvents: [],
    issues: [],
  };
  byToolCall.set(key, operation);
  operations.push(operation);
}

function scanDispatch(
  event: ToolLedgerEvent,
  byToolCall: Map<string, ToolLedgerScanOperation>,
  byOperation: Map<string, ToolLedgerScanOperation>,
  operations: ToolLedgerScanOperation[],
  addIssue: AddIssue
): void {
  const dispatch = event.dispatch;
  if (!dispatch) return;
  const key = toolCallIdentity(event.invocationId, dispatch.providerToolCallId);
  let operation = byToolCall.get(key);
  if (!operation) {
    // 无 call 的 dispatch：孤儿。仍然建壳登记，让 resolver 能报出 orphan。
    operation = {
      invocationId: event.invocationId,
      toolCallId: dispatch.providerToolCallId,
      toolName: dispatch.toolName,
      operationId: dispatch.operationId,
      dispatchEvent: event,
      reconcileEvents: [],
      decisionEvents: [],
      issues: [],
    };
    byToolCall.set(key, operation);
    byOperation.set(dispatch.operationId, operation);
    operations.push(operation);
    addIssue(operation, {
      code: "orphan_dispatch",
      eventId: event.id,
      operationId: dispatch.operationId,
      toolCallId: dispatch.providerToolCallId,
    });
    return;
  }
  if (operation.dispatchEvent) {
    addIssue(operation, {
      code: "duplicate_dispatch",
      eventId: event.id,
      operationId: dispatch.operationId,
      toolCallId: dispatch.providerToolCallId,
    });
    return;
  }

  const existingOperation = byOperation.get(dispatch.operationId);
  if (existingOperation && existingOperation !== operation) {
    const issue: ToolLedgerIssue = {
      code: "duplicate_operation",
      eventId: event.id,
      operationId: dispatch.operationId,
      toolCallId: dispatch.providerToolCallId,
    };
    addIssue(operation, issue);
    existingOperation.issues.push(issue);
    return;
  }

  operation.operationId = dispatch.operationId;
  operation.dispatchEvent = event;
  byOperation.set(dispatch.operationId, operation);

  if (
    operation.toolName !== dispatch.toolName ||
    (operation.callEvent !== undefined && !sameExecutionIdentity(operation.callEvent, event))
  ) {
    addIssue(operation, identityIssue(event, operation, dispatch.providerToolCallId));
  }

  // 实参重新哈希比对：dispatch 声称的 canonicalArgsHash 必须真的等于对
  // call 行实参重算出来的值。不重算就等于相信写入方的自述。
  const call = operation.callEvent?.call;
  if (call) {
    let actual: string | undefined;
    try {
      actual = canonicalToolArgsHash(call.toolName, call.args);
    } catch {
      // 非严格 JSON 的实参无法产生身份 —— 它authenticate 不了这次 T1。
      actual = undefined;
    }
    if (actual !== dispatch.canonicalArgsHash) {
      addIssue(operation, {
        code: "canonical_args_hash_conflict",
        eventId: event.id,
        operationId: dispatch.operationId,
        toolCallId: dispatch.providerToolCallId,
      });
    }
  }

  // 回溯校验：response 先于 dispatch 落地时它是无主的，现在有主了，得重判。
  if (operation.responseEvent) {
    addIssue(operation, {
      code: "event_order_conflict",
      eventId: event.id,
      operationId: dispatch.operationId,
      toolCallId: dispatch.providerToolCallId,
    });
    const response = operation.responseEvent;
    if (
      (response.refs?.operationId !== undefined &&
        response.refs.operationId !== dispatch.operationId) ||
      (response.refs?.toolCallId !== undefined &&
        response.refs.toolCallId !== dispatch.providerToolCallId) ||
      !sameExecutionIdentity(event, response)
    ) {
      addIssue(operation, identityIssue(response, operation, dispatch.providerToolCallId));
    }
  }
}

function scanResponse(
  event: ToolLedgerEvent,
  byToolCall: Map<string, ToolLedgerScanOperation>,
  operations: ToolLedgerScanOperation[],
  addIssue: AddIssue
): void {
  const response = event.response;
  if (!response) return;
  const key = toolCallIdentity(event.invocationId, response.toolCallId);
  const operation = byToolCall.get(key);
  if (!operation) {
    const orphan: ToolLedgerScanOperation = {
      invocationId: event.invocationId,
      toolCallId: response.toolCallId,
      toolName: response.toolName,
      responseEvent: event,
      reconcileEvents: [],
      decisionEvents: [],
      issues: [],
    };
    byToolCall.set(key, orphan);
    operations.push(orphan);
    addIssue(orphan, {
      code: "orphan_response",
      eventId: event.id,
      toolCallId: response.toolCallId,
    });
    return;
  }
  if (operation.responseEvent) {
    addIssue(operation, {
      code: "duplicate_response",
      eventId: event.id,
      toolCallId: response.toolCallId,
      ...(operation.operationId ? { operationId: operation.operationId } : {}),
    });
    return;
  }
  operation.responseEvent = event;
  if (
    operation.toolName !== response.toolName ||
    !sameExecutionIdentity(operation.callEvent, event) ||
    (operation.operationId !== undefined &&
      (event.refs?.operationId !== operation.operationId ||
        event.refs.toolCallId !== operation.toolCallId))
  ) {
    addIssue(operation, identityIssue(event, operation, response.toolCallId));
  }
}

// --------------------------------------------------------------- 协议标记

function readProtocolMarker(events: readonly ToolLedgerEvent[]): ToolLedgerProtocolMarker {
  const misplaced = events.slice(1).find((event) => event.protocol !== undefined);
  if (misplaced) {
    return { status: "invalid", eventId: misplaced.id, reason: "not_first" };
  }
  const first = events[0];
  if (!first?.protocol) return { status: "absent" };
  if (first.protocol.toolBoundary !== TOOL_BOUNDARY_PROTOCOL_V1) {
    return { status: "invalid", eventId: first.id, reason: "unknown_version" };
  }
  return { status: "valid", protocol: TOOL_BOUNDARY_PROTOCOL_V1 };
}

// --------------------------------------------------------- 写入事务前置校验

/**
 * 校验「这个写入事务提交之后的账本」是否仍然自洽。
 *
 * 单行的 lane 校验看不出重复 call、看不出一条 response 会因为后来的 dispatch
 * 而失效 —— 这些都是**前缀相关**的损坏。所以每个写入方在提交前都要拿
 * existing + candidate 整体重扫一遍。贵，但它是唯一能在写入侧拦住损坏的地方。
 */
export function validateToolLedgerTransition(input: {
  existingEvents: readonly ToolLedgerEvent[];
  candidateEvents: readonly ToolLedgerEvent[];
  expectedTransition: ToolLedgerTransitionKind;
}): ToolLedgerTransitionValidation {
  const existing = scanToolLedger(input.existingEvents);
  if (existing.hasCorruption) return issueValidation(existing.issues[0]!);

  const existingById = new Map(input.existingEvents.map((event) => [event.id, event]));
  const candidates: ToolLedgerEvent[] = [];
  for (const candidate of input.candidateEvents) {
    const prior = existingById.get(candidate.id);
    if (!prior) {
      candidates.push(candidate);
      continue;
    }
    // 同 id 已存在：只有逐字节相同才算幂等重试，否则是身份撞车。
    if (JSON.stringify(prior) !== JSON.stringify(candidate)) {
      return { ok: false, code: "duplicate_event_id", eventId: candidate.id };
    }
  }
  const shape = validateTransitionShape(candidates, input.expectedTransition);
  if (!shape.ok) return shape;

  const prospective = scanToolLedger([...input.existingEvents, ...candidates]);
  if (prospective.hasCorruption) return issueValidation(prospective.issues[0]!);
  return { ok: true };
}

function validateTransitionShape(
  events: readonly ToolLedgerEvent[],
  expectedTransition: ToolLedgerTransitionKind
): ToolLedgerTransitionValidation {
  if (events.length === 0) return { ok: true };
  const lanes = events.map((event) => validateToolLedgerEventLane(event));
  const invalid = lanes.find((lane) => !lane.ok);
  if (invalid && !invalid.ok) return invalid;

  const actual = lanes.map((lane) => (lane.ok ? lane.lane : "ordinary"));
  const valid =
    (expectedTransition === "t1_prepare" &&
      ((actual.length === 2 && actual[0] === "function_call" && actual[1] === "tool_dispatch") ||
        (actual.length === 1 && actual[0] === "tool_dispatch"))) ||
    (expectedTransition === "t2_outcome" &&
      actual.length === 1 &&
      actual[0] === "function_response" &&
      events[0]?.refs?.operationId !== undefined) ||
    (expectedTransition === "recovery_bundle" &&
      ((actual.length === 2 &&
        actual[0] === "reconcile_result" &&
        actual[1] === "recovery_decision") ||
        (actual.length === 3 &&
          actual[0] === "reconcile_result" &&
          actual[1] === "function_response" &&
          actual[2] === "recovery_decision")));
  if (valid) return { ok: true };
  return { ok: false, code: "transition_shape_conflict", eventId: events[0]?.id ?? "unknown" };
}

function issueValidation(issue: ToolLedgerIssue): ToolLedgerTransitionValidation {
  return {
    ok: false,
    code: issue.code,
    eventId: issue.eventId,
    ...(issue.operationId ? { operationId: issue.operationId } : {}),
    ...(issue.toolCallId ? { toolCallId: issue.toolCallId } : {}),
  };
}

// ------------------------------------------------------------------- 工具

function identityIssue(
  event: ToolLedgerEvent,
  operation: ToolLedgerScanOperation,
  toolCallId: string
): ToolLedgerIssue {
  return {
    code: "identity_conflict",
    eventId: event.id,
    toolCallId,
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
  };
}

function sameExecutionIdentity(
  first: ToolLedgerEvent | undefined,
  second: ToolLedgerEvent
): boolean {
  return (
    first !== undefined &&
    first.workspaceId === second.workspaceId &&
    first.sessionId === second.sessionId &&
    first.invocationId === second.invocationId &&
    first.runId === second.runId &&
    first.turnId === second.turnId
  );
}

function hasOnlyKeys(value: object | undefined, expected: readonly string[]): boolean {
  if (!value) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/** 元组主键。JSON 数组而非拼接：分隔符注入撞不出同一个 key。 */
export function toolCallIdentity(invocationId: string, toolCallId: string): string {
  return JSON.stringify([invocationId, toolCallId]);
}
