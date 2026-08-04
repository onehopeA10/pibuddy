/**
 * 能力清单：智能家居基座（connector / home.assistant / 智能家居 Phase B）。
 *
 * dashboard / automation / advisor 三个上层家居包的公共地基：端点配置与授权
 * 流、HA REST/WS 受控出站（local-network 车道的**首个在册声明方**——它让
 * capability-drift 的 network.local 双向对账与 import census 首次非空生效）、
 * 实体缓存、pi 回路内工具的 tool bridge。
 *
 * ## 工具面 = 上下文预算核心
 *
 * 常驻工具恰 3 个，实体 id 参数化，绝不每设备一工具：list_entities /
 * get_state / call_service 以单工具 1:1 覆盖 HA 全部控制面。第 4 个 setup
 * 只在端点未配置时由 extension 注册（3→1 引导态）。extension 自身零 fetch
 * 零直连 HA——全部经主进程 tool bridge（验一次性 token → 按本清单
 * tools[].permissions evaluate → safeLocalFetch / 缓存查询）。
 *
 * ## 权限
 *
 *   - network.local：受控私网出站（REST + WS），端点须经用户逐一确认
 *     （host:port 进 grant.resource，危险权限原生确认框）；
 *   - workspace.read / workspace.write：端点配置在能力自有分区落盘
 *     （userData/home-assistant/config.json，readFileSync + writeJsonAtomic）
 *     ——与 edu.kids 档案同一口径。token 归 secret-store，不在此列。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。
 */
import { defineCapability, CHANNELS, HOME_ASSISTANT_CAPABILITY_ID } from "@pibuddy/contract";
import {
  HOME_TOOL_CALL_SERVICE,
  HOME_TOOL_GET_STATE,
  HOME_TOOL_LIST_ENTITIES,
  HOME_TOOL_SETUP,
} from "@pibuddy/contract";

export const homeAssistantCapability = defineCapability({
  manifestVersion: 1,
  id: HOME_ASSISTANT_CAPABILITY_ID,
  version: "1.0.0",
  tier: "connector",
  displayName: "智能家居（Home Assistant）",
  description:
    "连接本地 Home Assistant 中枢（REST + WebSocket，聚合各品牌设备）：端点配置与逐端点授权、" +
    "实体状态缓存（引用计数消费者，默认无常驻连接）、回路内设备控制工具（列实体/查状态/调服务，" +
    "全部经主进程受控出站，绝不触达公网）。是家居面板/自动化/场景建议包的公共基座。",
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  // 基座不依赖任何其它可选能力；上层家居包（dashboard/automation/advisor）
  // 将各自 dependencies 本包（装配期不动点拒绝「上层开而基座关」）。
  dependencies: [],
  permissions: ["network.local", "workspace.read", "workspace.write"],
  channels: [
    CHANNELS.haConfigGet,
    CHANNELS.haConfigSet,
    CHANNELS.haTestConnection,
    CHANNELS.haEntities,
    CHANNELS.haStatus,
  ],
  pushChannels: [],
  tools: [
    {
      name: HOME_TOOL_LIST_ENTITIES,
      description:
        "列出家中实体（可按 domain/area/关键词过滤，limit≤50），返回紧凑行 id/名称/状态/区域。" +
        "读缓存，无缓存时经受控本地出站按需拉取。",
      permissions: ["network.local"],
    },
    {
      name: HOME_TOOL_GET_STATE,
      description: "查询指定实体（entity_ids ≤20）的当前状态。读缓存，过期时经受控本地出站刷新。",
      permissions: ["network.local"],
    },
    {
      name: HOME_TOOL_CALL_SERVICE,
      description:
        "调用 HA 服务控制设备（domain/service/entity_id/data，如 light.turn_on）。" +
        "经主进程受控本地出站（safeLocalFetch 三道关）执行，目标端点须已获用户授权。",
      permissions: ["network.local"],
    },
    {
      // 引导工具：端点未配置（bridge env 缺失）时 extension 只注册它，
      // 纯文本指引去设置面配置——零 IO、零网络，permissions 为空。
      name: HOME_TOOL_SETUP,
      description:
        "智能家居尚未配置时的引导：提示用户到 PiBuddy 设置面填写 Home Assistant 地址与访问令牌并完成授权。纯文本，零 IO。",
      permissions: [],
    },
  ],
  uiContributions: [
    {
      slot: "settings.section",
      id: "home.assistant.settings",
      title: "智能家居",
      module: "renderer/src/components/HomeAssistantSettings.vue",
      host: "renderer/src/components/SettingsModal.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    // 设置区块是轻量表单，无重依赖，随内核 bundle 内联。
    loading: "inline",
    heavyDependencies: [],
    // tool bridge 是一个 named pipe 入站 listener；WS 会话与缓存定时器随
    // dispose 一并收（见 home-ipc 的 disposeHomeResources）。
    teardown: ["listener"],
  },
  exposure: {
    module: "main/home/home-ipc.ts",
    register: "registerHomeIpc",
    dispose: "disposeHomeResources",
  },
  // 随包携带的 pi extension（R4 物化通道装卸）：回路内工具的注册端。
  piResources: {
    extensions: ["extensions/ha-tools.ts"],
  },
});
