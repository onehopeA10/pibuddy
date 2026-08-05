/**
 * pi extension：智能家居基座的回路内工具（home.assistant / 智能家居 Phase B）。
 *
 * 经 R4 物化通道装到 ~/.pi/agent/extensions/，由 pi 加载执行；工具名与能力包
 * manifest.tools 的声明逐字一致（对账在 test/home-assistant-e2e.spec.ts）。
 *
 * ## 本文件不做任何 HA 访问
 *
 * extension 跑在 pi 子进程里，**零 fetch、零直连 HA**：全部实现经 PiBuddy 主
 * 进程的 tool bridge 转发（唯一的 IO 是连接主进程的本机 named pipe / unix
 * socket——那是桥本身，不是出站）。主进程侧验一次性 token → 按 manifest 的
 * 工具权限逐条 evaluate → 经受控出站原语（safeLocalFetch 三道关）执行。
 *
 * ## env 缺失 = 引导态
 *
 * PIBUDDY_HOME_BRIDGE / PIBUDDY_HOME_BRIDGE_TOKEN 由 PiBuddy 只在
 * home.assistant 启用（bridge 已起）时注入。缺失说明包未启用或不在 PiBuddy
 * 里运行——此时只注册 1 个 home.assistant.setup 引导工具（3→1，常驻工具
 * schema 不占上下文），提示去设置面配置。
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

/** 一次桥调用：连管道 → 发一行 JSON → 收一行 JSON。 */
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
    // setEncoding 而不是逐 chunk 的 chunk.toString("utf8")：一个 3 字节的汉字
    // 会被切在两个 chunk 之间，逐 chunk 解码把它变成两个 U+FFFD——中文结果
    // 一大就必然撞见。大结果护栏（tool-archive）归档失败时回的正是完整原文，
    // 「证据一字不丢」要求这条解码路径也不能丢字。setEncoding 内部用
    // StringDecoder 跨 chunk 保留半个字符，这是唯一正确的做法。
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ id, token: BRIDGE_TOKEN, tool, args, cwd: process.cwd() })}\n`
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
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

interface ToolResultShape {
  content: { type: "text"; text: string }[];
  details: Record<string, never>;
}

async function viaBridge(tool: string, params: unknown): Promise<ToolResultShape> {
  try {
    const result = await bridgeCall(tool, params);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }], details: {} };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 错误以文本返回（中文），让 agent 修正参数或提示用户，而不是让工具调用
    // 栈爆炸。权限被拒 / 未授权端点的原因也从这里如实带出。
    return { content: [{ type: "text", text: `执行失败：${message}` }], details: {} };
  }
}

export default function (pi: ExtensionAPI) {
  if (!BRIDGE_PATH || !BRIDGE_TOKEN) {
    // 引导态：只注册 1 个 setup 工具（不占常驻工具面）。
    pi.registerTool({
      name: "home.assistant.setup",
      label: "智能家居配置引导",
      description:
        "Home Assistant is not configured in PiBuddy yet. Call this tool when the user asks about " +
        "smart-home/设备控制 to get setup instructions (where to configure the endpoint and token).",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [
            {
              type: "text",
              text:
                "智能家居尚未配置。请引导用户：打开 PiBuddy 设置 → 「智能家居（Home Assistant）」" +
                "区块 → 填写 HA 地址（如 homeassistant.local:8123）与长效访问令牌 → 点「保存并授权」" +
                "并在系统确认框中允许 → 重启会话后即可使用设备控制工具。",
            },
          ],
          details: {},
        };
      },
    });
    return;
  }

  pi.registerTool({
    name: "home.assistant.list_entities",
    label: "列出家居实体",
    description:
      "List Home Assistant entities (compact rows: id | name | state | area). Filter by domain " +
      "(light/switch/sensor/climate/...), area or keyword. Use this first to discover entity ids.",
    parameters: Type.Object({
      domain: Type.Optional(Type.String({ description: "按 domain 过滤，如 light / switch / sensor" })),
      area: Type.Optional(Type.String({ description: "按区域名过滤，如 客厅" })),
      query: Type.Optional(Type.String({ description: "按 id / 名称关键词过滤" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "返回条数上限，默认 50" })),
    }),
    async execute(_toolCallId, params) {
      return viaBridge("home.assistant.list_entities", params);
    },
  });

  pi.registerTool({
    name: "home.assistant.get_state",
    label: "查询实体状态",
    description:
      "Get current states for specific Home Assistant entities by id (up to 20 at once).",
    parameters: Type.Object({
      entity_ids: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 20,
        description: "实体 id 列表，如 [\"light.living_room\"]",
      }),
    }),
    async execute(_toolCallId, params) {
      return viaBridge("home.assistant.get_state", params);
    },
  });

  pi.registerTool({
    name: "home.assistant.call_service",
    label: "调用家居服务",
    description:
      "Call a Home Assistant service to control devices, e.g. domain=light service=turn_on " +
      "entity_id=light.living_room data={\"brightness\":128}. Covers all HA control surface.",
    parameters: Type.Object({
      domain: Type.String({ description: "服务 domain，如 light / switch / climate" }),
      service: Type.String({ description: "服务名，如 turn_on / turn_off / toggle" }),
      entity_id: Type.Optional(Type.String({ description: "目标实体 id" })),
      data: Type.Optional(Type.Any({ description: "服务附加参数对象，如 {\"brightness\":128}" })),
    }),
    async execute(_toolCallId, params) {
      return viaBridge("home.assistant.call_service", params);
    },
  });

  // 大结果护栏（tool-archive）的恢复读取口。
  //
  // 桥的回包路径上，超阈值的工具结果会先完整落归档、回包只留一个带 ref 的
  // 占位符（占位符自带 readInstructions，里面明写「不要用 Glob 去找归档」）。
  // 这是把原文读回来的唯一入口。
  //
  // description 里写死那条**自指约束**：响应严格有界（主进程侧按估算 token
  // 二分收敛，恒低于归档阈值），所以读归档不会再触发一次归档——不写清楚，
  // 模型会担心「读回来又太大」而不敢用它。
  pi.registerTool({
    name: "home.assistant.read_archived_result",
    label: "读回归档的工具结果",
    description:
      "Read back a tool result that was archived because it was too large. Pass the `ref` from the " +
      "placeholder object, optionally with offset/limit, to page through the original text. " +
      "Responses are strictly bounded, so reading an archive can never trigger another archive. " +
      "Do not use Glob or file search to find the archive — it lives outside the workspace and is " +
      "only reachable through this tool.",
    parameters: Type.Object({
      ref: Type.String({ description: "占位符里的 ref（pibuddy://tool-archive/...）" }),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: "起始字符偏移，默认 0；续读传上一页的 nextOffset" })
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 6000, description: "请求页宽（字符），实际可能被收窄" })
      ),
    }),
    async execute(_toolCallId, params) {
      return viaBridge("home.assistant.read_archived_result", params);
    },
  });
}
