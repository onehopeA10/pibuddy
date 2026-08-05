/**
 * 池化的真实 Agent run 触发实现（ISS-002：把 task-trigger 的替身接上真实派生）。
 *
 * `task-trigger.ts` 里预留的接线说明在此兑现：拿冻结的输入快照向**后台会话池**
 * 申请一个无人值守会话（`requestSession`，与 child 编排同一条 sanctioned 路），
 * runtime 就绪后下发冻结的 model 与 prompt，等本轮 `agent_settled`，收尾时拉
 * 一次会话统计取成本，最后停掉会话释放并发位。**绝不用交互会话的 pi:prompt 去
 * 驱动**——无人值守任务有自己独立的后台 runtime，受池的并发/内存/成本闸与崩溃
 * 预算管辖。
 *
 * ## 端口可注入
 *
 * 「触发真的派生了会话、超时真的停掉了进程、失败如实落库」必须能在单测里证伪，
 * 而真实端口牵着 electron 与 pi spawn。因此池的五个动作抽成 `PoolTriggerPort`
 * 注入，生产接 `agentPool()` / `poolRuntimeHost()` 单例，单测注入受控假端口。
 *
 * ## 诚实标注的限制
 *
 *   - **预算只在收尾核对**：pi 事件流没有逐 token 的成本推送口，执行中不截断；
 *     超预算会在 run 日志里如实标注。
 *   - **artifactIds 恒空**：产物登记要等 artifacts 域给后台会话开采集口。
 */
import type { UsageRecordRequest } from "@pibuddy/contract";
import { agentPool, poolRuntimeHost } from "../agent-pool/pool.js";
import type { RuntimeTap } from "../agent-pool/pool-runtime-host.js";
import { usageStore } from "../usage/usage-store.js";
import type { AgentRunTrigger, TriggerContext, TriggerOutcome } from "./task-trigger.js";

/** 触发实现需要的池动作面（可注入，便于单测证伪）。 */
export interface PoolTriggerPort {
  requestSession(input: {
    sessionId: string;
    workspaceId: string | null;
    origin: "user" | "child";
    focus: boolean;
  }): void;
  stopSession(sessionId: string): void;
  observe(sessionId: string, tap: RuntimeTap): () => void;
  deliver(sessionId: string, text: string): boolean;
  send(sessionId: string, message: unknown): Promise<unknown>;
}

/** 生产端口：接池单例（惰性取，避免模块加载期就构造池）。 */
const productionPort: PoolTriggerPort = {
  requestSession: (input) => agentPool().requestSession(input),
  stopSession: (sessionId) => agentPool().stopSession(sessionId),
  observe: (sessionId, tap) => poolRuntimeHost().observeRuntime(sessionId, tap),
  deliver: (sessionId, text) => poolRuntimeHost().deliver(sessionId, text),
  send: (sessionId, message) => poolRuntimeHost().send(sessionId, message),
};

/** 用量入账口（R5.2）。注入以便单测证伪「后台会话的用量真的进了账」。 */
export type UsageRecorder = (input: UsageRecordRequest) => void;

/**
 * 生产入账：直接写本地 usage 库。与前台（渲染进程经 usage:record）同一套
 * 差值口径 —— store 按 sessionId 记累计基线，双源重复上报增量为 0。
 * 记不上不影响 run 成败（与拉统计同一条 best-effort 纪律）。
 */
const productionRecordUsage: UsageRecorder = (input) => {
  try {
    usageStore().record(input);
  } catch {
    /* 用量记不上不影响 run 成败 */
  }
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export function createPoolRunTrigger(
  port: PoolTriggerPort = productionPort,
  recordUsage: UsageRecorder = productionRecordUsage
): AgentRunTrigger {
  return {
    async trigger(ctx: TriggerContext): Promise<TriggerOutcome> {
      // 池键用 runId 铸：每条 run 一个独立后台会话，幂等键的唯一性顺带保证
      // 池键不撞车。真实 pi sessionId 在握手时回填（会话历史用它定位）。
      const poolKey = `task:${ctx.runId}`;
      let realSessionId: string | null = null;
      let eventError: string | null = null;
      let exitReason: string | null = null;
      /**
       * 本次尝试是否已经有 assistant 说过话。
       *
       * 调度器据它决定失败后还要不要自动重试（见 `TriggerOutcome.observableOutput`）。
       * 判据取 `message_end` 且 `role === "assistant"`：那一刻这条消息已经落进会话
       * 历史、用户在界面上看得见。**不看 stopReason** —— 以错误收场的消息同样是
       * 已经吐出去的字，重跑会让它出现第二遍。
       */
      let sawAssistantOutput = false;

      const ready = deferred();
      const settledTurn = deferred();

      const unobserve = port.observe(poolKey, {
        onReady: (sid) => {
          realSessionId = sid;
          ready.resolve();
        },
        onEvent: (e) => {
          const ev = e as { type?: string; message?: { role?: string; stopReason?: string } };
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            sawAssistantOutput = true;
            if (ev.message.stopReason === "error") {
              eventError = "助手回复以错误结束（stopReason=error）";
            }
          }
          if (ev.type === "agent_settled") settledTurn.resolve();
        },
        onExit: (reason) => {
          exitReason = reason;
          // 进程没了，两个等待点都不该再挂着。
          ready.resolve();
          settledTurn.resolve();
        },
      });

      // 单次超时统一为一个绝对 deadline：排队 + 握手 + 执行共用，与任务语义一致
      //（用户设的是「这次 run 最多跑多久」，不是每个阶段各自多久）。
      const deadline = ctx.timeoutMs === null ? null : Date.now() + ctx.timeoutMs;
      let timedOut = false;
      const withDeadline = async (p: Promise<void>): Promise<void> => {
        if (deadline === null) return p;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          timedOut = true;
          return;
        }
        let timer: NodeJS.Timeout | null = null;
        await Promise.race([
          p,
          new Promise<void>((r) => {
            timer = setTimeout(() => {
              timedOut = true;
              r();
            }, remaining);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
      };

      const fail = (error: string, note: string): TriggerOutcome => ({
        status: "failed",
        sessionId: realSessionId,
        artifactIds: [],
        costUsd: null,
        error,
        note,
        observableOutput: sawAssistantOutput,
      });

      try {
        port.requestSession({
          sessionId: poolKey,
          workspaceId: ctx.workspaceId,
          origin: "user",
          focus: false,
        });

        await withDeadline(ready.promise);
        if (timedOut) {
          return fail(
            "等待后台会话就绪超时",
            `后台派生在 ${ctx.timeoutMs}ms 内未就绪（可能在池的资源闸排队），已停止`
          );
        }
        if (exitReason) return fail(`后台会话未能启动（${exitReason}）`, "后台派生失败");

        // 冻结的 provider/model 下发到本次 runtime。设不上就如实失败——
        // 默默用别的模型跑完，比失败更糟。
        if (ctx.input.provider && ctx.input.model) {
          try {
            const resp = (await port.send(poolKey, {
              type: "set_model",
              provider: ctx.input.provider,
              modelId: ctx.input.model,
            })) as { success?: boolean; error?: string } | null;
            if (resp && resp.success === false) {
              return fail(`设置模型失败：${resp.error ?? "未知原因"}`, "冻结的 model 未被接受");
            }
          } catch (err) {
            return fail(`设置模型失败：${(err as Error).message}`, "set_model 未送达");
          }
        }

        if (!port.deliver(poolKey, ctx.input.prompt)) {
          return fail("提示词投递失败：会话无活跃 runtime", "deliver 落空");
        }

        await withDeadline(settledTurn.promise);
        if (timedOut) {
          return fail("执行超时", `超过任务超时上限 ${ctx.timeoutMs}ms，已停止后台会话`);
        }
        if (exitReason && exitReason !== "expected-stop") {
          return fail(`后台会话进程退出（${exitReason}）`, "runtime 执行中崩溃");
        }
        if (exitReason === "expected-stop") {
          return fail("后台会话在执行中被停止", "执行中被停止（用户或池回收）");
        }

        // 成本：收尾拉一次会话统计（best-effort，拉不到不改变成败）。
        // 同一份统计顺手结账进本地用量库（R5.2）：后台会话没有渲染进程替它
        // 上报，这里是它唯一的入账点。拉不到统计就不入账 —— 不造数。
        let costUsd: number | null = null;
        try {
          const stats = (await port.send(poolKey, { type: "get_session_stats" })) as {
            success?: boolean;
            data?: { cost?: number; tokens?: { input?: number; output?: number } };
          } | null;
          if (stats?.success && stats.data) {
            if (typeof stats.data.cost === "number") costUsd = stats.data.cost;
            recordUsage({
              // 结账记在真实 pi sessionId 上（与会话历史同一把键）；握手异常
              // 拿不到时退回池键，宁可有一条对不上历史的账，不丢账。
              sessionId: realSessionId ?? poolKey,
              workspaceId: ctx.workspaceId,
              // 冻结输入里的 provider/model 可能为空串（未冻结时由 pi 用默认
              // 模型跑）——如实空着，不猜一个名字填进去。
              provider: ctx.input.provider,
              modelId: ctx.input.model,
              inputTokens: stats.data.tokens?.input ?? 0,
              outputTokens: stats.data.tokens?.output ?? 0,
              cost: typeof stats.data.cost === "number" ? stats.data.cost : 0,
              failed: eventError !== null,
            });
          }
        } catch {
          /* 统计拉不到不影响 run 成败 */
        }

        if (eventError) {
          return {
            status: "failed",
            sessionId: realSessionId,
            artifactIds: [],
            costUsd,
            error: eventError,
            note: "后台会话跑完了，但助手回复以错误收场",
            observableOutput: sawAssistantOutput,
          };
        }

        const overBudget = ctx.budgetUsd !== null && costUsd !== null && costUsd > ctx.budgetUsd;
        return {
          status: "succeeded",
          sessionId: realSessionId,
          artifactIds: [],
          costUsd,
          error: null,
          observableOutput: sawAssistantOutput,
          note: overBudget
            ? `后台会话完成；成本 $${costUsd} 已超预算 $${ctx.budgetUsd}（预算目前只在收尾核对，不做执行中截断）`
            : "后台会话完成",
        };
      } finally {
        unobserve();
        // 无论成败，停掉本次 run 的后台会话，释放池的并发位；进程收尾由
        // host.stop 的四级停止阶梯保证，不留僵尸。
        port.stopSession(poolKey);
      }
    },
  };
}
