/**
 * 智能家居自动化规则包的 IPC handler 与运行期装配（home.automation，恰 4 条通道）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame → zod → 尺寸 → 限流）写死在那里。
 *
 * ## 四条通道就是全部的主进程面
 *
 * 列表 / upsert / 删除 / 启停，每条返回权威快照（整表列表）。规则的**创建与
 * 修改**主要不在面板上（v1 面板不做编辑器）：走会话里的 `manage_rule` 工具
 * ——经 home.assistant 基座的 tool bridge（同一条管道、同一个一次性 token），
 * 本文件在 activate 时用 registerBridgeTool 把 handler 挂进桥的跨包注册表，
 * deactivate 时摘掉。extension 侧零 fetch 零直连（与基座工具同款纪律）。
 *
 * ## 两条执行路的生产接线
 *
 *   - 确定性动作 → homeAssistantService().executeTool(call_service)：内部
 *     **每次执行**都重过 authorizeLocalEndpoint 三道关 + safeLocalFetch，
 *     撤权即拒、零出站（对拍见 home-automation-e2e.spec）；
 *   - Agent 动作 → tasks 域：保存时经 taskStore() 落成 kind:"event" 的真
 *     task，命中时经 deliverTaskEvent 投递（runNow 纪律：workspace 预授权 /
 *     幂等 key / 池化触发 / 审计全继承）。manifest.dependencies 里的
 *     common.tasks 保证「automation 开而 tasks 关」在装配期就被拒绝。
 *
 * ## activate / deactivate
 *
 * registerAutomationIpc：注册 4 条通道 + 挂 bridge 工具 + 把每个有规则的
 * 工作区的引擎拉起来（headless：状态触发订阅 + 30s 对齐 tick，有启用中的
 * 状态规则时向实体缓存登记常驻消费者）。disposeAutomationResources
 * （runtime.teardown:["listener"]）：摘 bridge 工具、停引擎与订阅、释放
 * 消费者、关 sqlite 句柄。**规则数据留在磁盘不动**（D4 规则 5）。
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import {
  AUTOMATION_TOOL_MANAGE_RULE,
  CHANNELS,
  automationRuleIdRequestSchema,
  automationRuleSetEnabledRequestSchema,
  automationRuleUpsertRequestSchema,
  automationRulesListRequestSchema,
  homeCallServiceArgsSchema,
  manageRuleArgsSchema,
  HOME_TOOL_CALL_SERVICE,
  type AutomationRulesResult,
  type ManageRuleArgs,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { createLogger, type Logger } from "../logger.js";
import { lookupWorkspace, workspaceIdFor } from "../workspace-registry.js";
import { deliverTaskEvent } from "../tasks/tasks-ipc.js";
import { taskStore } from "../tasks/task-store.js";
import { homeAssistantService } from "../home/home-ipc.js";
import {
  registerBridgeTool,
  setBridgeDispatchGuard,
  type HomeBridgeDispatchGuard,
} from "../home/tool-bridge.js";
import {
  closeToolRecoveryLedger,
  toolDispatchBoundary,
} from "../tool-recovery/recovery-ledger.js";
import {
  AutomationService,
  type AutomationHomePort,
  type AutomationTaskPort,
} from "./automation-service.js";
import { automationStore, closeAutomationStore } from "./automation-store.js";

/** 本能力注册的全部通道。导出成常量供对账「恰 4 条」。 */
export const AUTOMATION_CHANNELS = [
  CHANNELS.autoRulesList,
  CHANNELS.autoRuleUpsert,
  CHANNELS.autoRuleDelete,
  CHANNELS.autoRuleSetEnabled,
] as const;

let logger: Logger | null = null;
function log(): Logger {
  if (!logger) logger = createLogger("home-automation");
  return logger;
}

// ---------------------------------------------------------------- 生产端口

/**
 * 基座动作面：全部收敛到 homeAssistantService() 那一台机器上——与面板 / 基座
 * 工具共享同一份实体缓存与 WS 会话，出站纪律（每次重过三道关）原封继承。
 */
const productionHomePort: AutomationHomePort = {
  async callService(workspaceId, args) {
    const parsed = homeCallServiceArgsSchema.parse(args);
    await homeAssistantService().executeTool(HOME_TOOL_CALL_SERVICE, parsed, workspaceId);
  },
  async getStates(workspaceId, entityIds) {
    const rows = await homeAssistantService().cache(workspaceId).getStates(entityIds);
    return rows.map((r) => ({ id: r.id, state: r.state }));
  },
  onStateChanged(workspaceId, fn) {
    return homeAssistantService().cache(workspaceId).onStateChanged(fn);
  },
  acquireConsumer(workspaceId) {
    return homeAssistantService().cache(workspaceId).acquire();
  },
};

/**
 * tasks 动作面：backing task 是 tasks 域的一等公民（在任务面板可见、可暂停、
 * 可看 run 历史）。schedule 恒为 kind:"event"（不由时钟驱动，等本域投递）。
 */
const productionTaskPort: AutomationTaskPort = {
  ensureTask({ workspaceId, ruleId, ruleName, prompt, timezone, existingTaskId }) {
    const store = taskStore();
    const now = Date.now();
    const name = `自动化规则「${ruleName}」的 Agent 动作`;
    if (existingTaskId !== null) {
      const current = store.getTask(existingTaskId);
      if (current !== null && current.workspaceId === workspaceId) {
        store.updateTask(
          existingTaskId,
          { name, timezone, agent: { ...current.agent, prompt } },
          now
        );
        return existingTaskId;
      }
    }
    const task = store.createTask(
      {
        workspaceId,
        name,
        schedule: { kind: "event", event: `home.automation:${ruleId}` },
        timezone,
        agent: { provider: "", model: "", prompt },
        requiredPermissions: [],
        budgetUsd: null,
        timeoutMs: null,
        misfirePolicy: "skip",
        concurrencyPolicy: "forbid",
        failurePolicy: { retry: false, maxAttempts: 1, backoffMs: 0 },
      },
      now,
      null // event 计划不由时钟驱动：nextRunAt 恒 null（schedule.ts 语义位）
    );
    return task.id;
  },
  deleteTask(taskId) {
    taskStore().deleteTask(taskId);
  },
  async deliver(taskId) {
    const run = await deliverTaskEvent(taskId);
    if (run === null) {
      throw new Error("AUTOMATION_EVENT_UNDELIVERED: backing task 不存在或已暂停");
    }
  },
};

// ---------------------------------------------------------------- 服务装配

let serviceInstance: AutomationService | null = null;

function service(): AutomationService {
  if (!serviceInstance) {
    serviceInstance = new AutomationService({
      store: automationStore(),
      home: productionHomePort,
      tasks: productionTaskPort,
      log: (event, fields) => log().info(event, fields),
      // 确定性动作（开灯 / 关锁 / 推通知）夹进 T1/T2：这些是真实世界的副作用，
      // 重复执行的代价实实在在。
      recovery: toolDispatchBoundary(),
    });
  }
  return serviceInstance;
}

// ---------------------------------------------------------------- manage_rule

/**
 * bridge 请求里的 cwd（pi 子进程的工作目录）→ workspaceId。
 *
 * 与 home-ipc 的口径一致：只认**已注册**的工作区，realpath 用系统实现做
 * 规范化。不从 home-ipc export 复用——那是基座的模块内部件，六行的判定
 * 抄一份比在基座上多开一个导出面更小。
 */
function workspaceIdOfCwd(cwd: string | null): string {
  if (cwd === null) throw new Error("AUTOMATION_BRIDGE_NO_CWD: bridge 请求缺少工作目录");
  let real: string;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    throw new Error("AUTOMATION_BRIDGE_BAD_CWD: 工作目录不存在");
  }
  const workspaceId = workspaceIdFor(real);
  if (lookupWorkspace(workspaceId) === null) {
    throw new Error("AUTOMATION_BRIDGE_UNKNOWN_WORKSPACE: 工作目录不是已注册的工作区");
  }
  return workspaceId;
}

// ------------------------------------------------------------ bridge 派发闸

/**
 * 桥的派发闸（T1/T2 + 派发护栏）。
 *
 * **装在这里而不是基座**：闸保护的是「真实世界副作用」，而基座桥上跑的
 * `call_service` 与本包的 `manage_rule` 都属于这一类，本包又是唯一因为副作用
 * 代价而存在的家居包。代价说清楚：本包被禁用时闸随之卸掉，基座工具回到零夹逼
 * 的原行为。要让它与基座同生死，得把这段搬进 home-ipc（不在本次文件域内）。
 *
 * 身份：一次运行的随机段 + 单调序号。桥的线协议里没有 invocation / tool_call
 * 标识（那是 extension 侧的事），因此这里只保证**不撞号**，不保证崩溃后可重算
 * ——桥这条路上没有需要与在途调用对号入座的恢复流程。
 */
const bridgeScope = randomUUID().slice(0, 8);
let bridgeSeq = 0;

const bridgeDispatchGuard: HomeBridgeDispatchGuard = (request, impl) => {
  let workspaceId: string;
  try {
    workspaceId = workspaceIdOfCwd(request.cwd);
  } catch {
    // 解不出工作区就没有账本分区键。降级成不夹逼直接执行，把「为什么不行」
    // 留给工具自己去报 —— 闸不该把一条本来就要失败的调用改写成另一种失败。
    return impl();
  }
  return toolDispatchBoundary().run(
    {
      workspaceId,
      sessionId: `home-bridge:${bridgeScope}`,
      // invocationId 带上 workspaceId：账本要求同 invocation 的事实落在同一条
      // (workspace, session, run, turn) 脊上，而一条桥会服务多个工作区。
      invocationId: `home-bridge:${bridgeScope}:${workspaceId}`,
      runId: bridgeScope,
      turnId: "bridge",
      providerToolCallId: `req-${++bridgeSeq}`,
      toolName: request.tool,
      args: request.args ?? null,
    },
    impl
  );
};

function requireRuleId(parsed: ManageRuleArgs): string {
  if (parsed.rule_id === undefined) {
    throw new Error(`AUTOMATION_ARGS: 动作 ${parsed.action} 需要 rule_id`);
  }
  return parsed.rule_id;
}

/** 给 LLM 看的紧凑规则行（工具返回，token 成本最低）。 */
function compactRules(workspaceId: string): { total: number; rules: unknown[] } {
  const rules = service().list(workspaceId);
  return {
    total: rules.length,
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      trigger: r.trigger,
      condition: r.condition ?? undefined,
      actions: r.actions,
      timezone: r.timezone,
      last_fired_at: r.lastFiredAt,
      last_error: r.lastError,
    })),
  };
}

/**
 * manage_rule 的执行面（经基座 tool bridge 进来：token 已验、cwd 已带）。
 *
 * 本工具自身零权限原子（manifest.tools 里 permissions 为空）：管理规则只写
 * 自己的 sqlite。危险面在**执行时**——确定性动作每次经基座三道关（撤权即
 * 拒），Agent 动作经 tasks 的 workspace 预授权判定，两条路都不因「规则是
 * 工具建的」而少过任何一道闸。
 */
async function executeManageRule(tool: string, args: unknown, cwd: string | null): Promise<unknown> {
  if (tool !== AUTOMATION_TOOL_MANAGE_RULE) {
    throw new Error(`AUTOMATION_UNKNOWN_TOOL: ${tool}`);
  }
  const workspaceId = workspaceIdOfCwd(cwd);
  const parsed = manageRuleArgsSchema.parse(args ?? {});
  switch (parsed.action) {
    case "list":
      return compactRules(workspaceId);
    case "create": {
      if (parsed.rule === undefined) throw new Error("AUTOMATION_ARGS: create 需要 rule");
      const rule = service().upsert(workspaceId, null, parsed.rule);
      return { ok: true, rule_id: rule.id, ...compactRules(workspaceId) };
    }
    case "update": {
      const id = requireRuleId(parsed);
      if (parsed.rule === undefined) throw new Error("AUTOMATION_ARGS: update 需要 rule（整份替换）");
      service().upsert(workspaceId, id, parsed.rule);
      return { ok: true, rule_id: id, ...compactRules(workspaceId) };
    }
    case "delete": {
      const id = requireRuleId(parsed);
      service().remove(workspaceId, id);
      return { ok: true, ...compactRules(workspaceId) };
    }
    case "enable":
    case "disable": {
      const id = requireRuleId(parsed);
      service().setEnabled(workspaceId, id, parsed.action === "enable");
      return { ok: true, ...compactRules(workspaceId) };
    }
  }
}

// ---------------------------------------------------------------- 装配 / 拆卸

function snapshot(workspaceId: string): AutomationRulesResult {
  return { rules: service().list(workspaceId) };
}

/** 禁用 / 退出时的拆卸（runtime.teardown:["listener"]）。规则数据不动。 */
export function disposeAutomationResources(): void {
  registerBridgeTool(AUTOMATION_TOOL_MANAGE_RULE, null);
  setBridgeDispatchGuard(null);
  if (serviceInstance) {
    serviceInstance.dispose();
    serviceInstance = null;
  }
  closeAutomationStore();
  // 账本只关句柄，数据一个字节不动（惰性单例，tasks 之后再用会自己重开）。
  closeToolRecoveryLedger();
}

export function registerAutomationIpc(): void {
  // manage_rule 挂进基座 bridge 的跨包注册表：extension 经同一条管道、同一个
  // 一次性 token 调进来。依赖关系（home.assistant）保证 bridge 一定在。
  registerBridgeTool(AUTOMATION_TOOL_MANAGE_RULE, executeManageRule);

  // 桥的派发闸：装上之后桥上每次工具执行都被 T1/T2 夹住，并过循环闸与参数
  // 违规回执。装 / 卸的取舍见 bridgeDispatchGuard 的说明。
  setBridgeDispatchGuard(bridgeDispatchGuard);

  // headless 引擎：有规则的工作区在 activate 时就把状态订阅 / 对齐 tick 拉起
  // 来——用户不开面板、不开会话，规则照样触发。**测试进程里不拉**（VITEST
  // 置位时跳过）：单测直接构造自己的 AutomationService 注入假端口与时钟。
  if (!process.env.VITEST) {
    try {
      service().startAll();
    } catch (err) {
      log().warn("automation_start_failed", {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  registerHandler(
    CHANNELS.autoRulesList,
    automationRulesListRequestSchema,
    async (payload): Promise<AutomationRulesResult> => snapshot(payload.workspaceId)
  );

  registerHandler(
    CHANNELS.autoRuleUpsert,
    automationRuleUpsertRequestSchema,
    async (payload): Promise<AutomationRulesResult> => {
      service().upsert(payload.workspaceId, payload.id ?? null, payload.rule);
      return snapshot(payload.workspaceId);
    }
  );

  registerHandler(
    CHANNELS.autoRuleDelete,
    automationRuleIdRequestSchema,
    async (payload): Promise<AutomationRulesResult> => {
      service().remove(payload.workspaceId, payload.id);
      return snapshot(payload.workspaceId);
    }
  );

  registerHandler(
    CHANNELS.autoRuleSetEnabled,
    automationRuleSetEnabledRequestSchema,
    async (payload): Promise<AutomationRulesResult> => {
      service().setEnabled(payload.workspaceId, payload.id, payload.enabled);
      return snapshot(payload.workspaceId);
    }
  );
}
