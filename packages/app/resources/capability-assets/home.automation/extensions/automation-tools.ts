/**
 * pi extension：家居自动化规则的回路内工具（home.automation / 智能家居 Phase B）。
 *
 * 经 R4 物化通道装到 ~/.pi/agent/extensions/，由 pi 加载执行；工具名与能力包
 * manifest.tools 的声明逐字一致（对账在 test/home-automation-e2e.spec.ts）。
 *
 * ## 本文件不做任何 HA 访问、不碰规则库
 *
 * extension 跑在 pi 子进程里，**零 fetch、零直连、零本地 IO**：唯一的 IO 是
 * 连接 PiBuddy 主进程的 tool bridge（home.assistant 基座起的那同一条本机
 * named pipe / unix socket，同一个一次性 token）。规则的增删改查在主进程侧
 * 执行；规则命中后的动作执行更与本文件无关（确定性动作走受控出站三道关，
 * Agent 动作走任务域闸门）。
 *
 * ## env 缺失 = 不注册
 *
 * PIBUDDY_HOME_BRIDGE / PIBUDDY_HOME_BRIDGE_TOKEN 由 PiBuddy 只在基座启用
 * （bridge 已起）时注入。本包 dependencies 基座，正常情况下物化了本文件就有
 * env；缺失说明不在 PiBuddy 里运行——不注册任何工具（引导话术归基座的
 * setup 工具，不重复占一个工具面）。
 *
 * 本文件不参与仓库 typecheck（resources/ 不在 tsconfig include 内），
 * @earendil-works/pi-coding-agent 与 typebox 由 pi 内置提供。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import net from "node:net";

const BRIDGE_PATH = process.env.PIBUDDY_HOME_BRIDGE ?? "";
const BRIDGE_TOKEN = process.env.PIBUDDY_HOME_BRIDGE_TOKEN ?? "";
const BRIDGE_TIMEOUT_MS = 10000;

let requestSeq = 0;

/** 一次桥调用：连管道 → 发一行 JSON → 收一行 JSON（与基座 ha-tools 同款）。 */
function bridgeCall(tool: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `${Date.now().toString(36)}-${++requestSeq}`;
    const socket = net.createConnection(BRIDGE_PATH);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`PiBuddy home bridge 超时（${BRIDGE_TIMEOUT_MS / 1000}s）`))),
      BRIDGE_TIMEOUT_MS
    );
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ id, token: BRIDGE_TOKEN, tool, args, cwd: process.cwd() })}\n`
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      finish(() => {
        try {
          const res = JSON.parse(line) as { ok?: boolean; result?: unknown; error?: string };
          if (res.ok === true) resolve(res.result);
          else reject(new Error(res.error || "bridge 返回错误"));
        } catch {
          reject(new Error("bridge 响应不是合法 JSON"));
        }
      });
    });
    socket.on("error", () =>
      finish(() => reject(new Error("无法连接 PiBuddy home bridge（应用可能已退出）")))
    );
    socket.on("close", () => finish(() => reject(new Error("bridge 连接被关闭"))));
  });
}

export default function (pi: ExtensionAPI) {
  if (!BRIDGE_PATH || !BRIDGE_TOKEN) return;

  pi.registerTool({
    name: "home.automation.manage_rule",
    label: "管理家居自动化规则",
    description:
      "Manage home automation rules (list/create/update/delete/enable/disable). A rule = trigger " +
      "(entity state change, or daily time HH:MM) + optional condition (entity state eq/neq, or " +
      "time window) + actions (call HA service / notify / hand off to a background agent task). " +
      "Use home.assistant.list_entities first to discover entity ids. update replaces the whole " +
      "rule spec. Rules run headlessly in PiBuddy; deterministic actions never start an agent.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("create"),
          Type.Literal("update"),
          Type.Literal("delete"),
          Type.Literal("enable"),
          Type.Literal("disable"),
        ],
        { description: "要执行的动作" }
      ),
      rule_id: Type.Optional(
        Type.String({ description: "规则 id（update/delete/enable/disable 必填，来自 list）" })
      ),
      rule: Type.Optional(
        Type.Object(
          {
            name: Type.String({ description: "规则名，如 “天黑自动开客厅灯”" }),
            trigger: Type.Any({
              description:
                '触发器：{"kind":"state","entityId":"light.x","from"?,"to"?} 或 {"kind":"time","time":"HH:MM"}',
            }),
            condition: Type.Optional(
              Type.Any({
                description:
                  '可选条件：{"kind":"state","entityId","op":"eq"|"neq","value"} 或 {"kind":"time_window","after":"HH:MM","before":"HH:MM"}（after>before 表示跨午夜）',
              })
            ),
            actions: Type.Array(Type.Any(), {
              minItems: 1,
              maxItems: 10,
              description:
                '动作序列：{"kind":"service","domain","service","entityId"?,"data"?} / ' +
                '{"kind":"notify","message"} / {"kind":"agent","prompt"}',
            }),
            timezone: Type.Optional(
              Type.String({ description: "IANA 时区（time 触发用）；省略 = 系统时区" })
            ),
          },
          { description: "规则内容（create 必填；update = 整份替换）" }
        )
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await bridgeCall("home.automation.manage_rule", params);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }], details: {} };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 错误以文本返回（中文），让 agent 修正参数或提示用户；权限被拒 /
        // 依赖未启用的原因也从这里如实带出。
        return { content: [{ type: "text", text: `执行失败：${message}` }], details: {} };
      }
    },
  });
}
