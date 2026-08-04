/**
 * 能力清单：智能家居监控面板（vertical / home.dashboard）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。
 * drift test 要能直接 import 它做对账。
 *
 * ## 它是基座诚实遗留 #7 的落点
 *
 * home.assistant 的实体缓存是引用计数消费者模型，但「面板开着」一直没有接上
 * 消费者信令。本包补上这条：面板打开 = dashboard:subscribe 登记一个消费者
 * （基座维持 WS 实时订阅），关闭 = unsubscribe 释放（归零后 5min linger
 * 拆线）。增量经 dashboard:event 推送信封下发（与 terminal:event 同一套
 * 代际 + 序号丢弃规则）。
 *
 * ## 为什么权限是空集
 *
 * 面板是纯只读视图：数据全部经基座的 HomeAssistantService / EntityCache 取得，
 * 出站（network.local）与配置落盘（workspace.read/write）的权限归属基座——
 * 本包自己的主进程目录（main/home-dashboard/）一个权限特征都没有，drift 3
 * 的双向对账据此闭合。tools 也是空的：面板零工具 = 上下文零成本，设备控制
 * 走会话对话（基座的 call_service 工具），不在面板上做控制按钮（v1 取舍，
 * 见 HomeDashboardPanel.vue 头注释）。
 *
 * ## 首个 loading:"lazy" 包
 *
 * 面板组件在 AppShell 里经 defineAsyncComponent(() => import(...)) 动态加载：
 * 不开面板不进主 chunk。它没有重依赖，lazy 的意义在于把「按需加载 + 预算
 * 上界」这条机制第一次立起来——contract capability.ts 的懒加载闸门（lazy
 * 必须给 entry / inline 不得给 entry）此前对全体 inline 清单恒真，本清单
 * 让它首次非空生效（对照见 test/home-dashboard.spec.ts 的红绿对拍）。
 */
import {
  defineCapability,
  CHANNELS,
  PUSH_CHANNELS,
  HOME_DASHBOARD_CAPABILITY_ID,
} from "@pibuddy/contract";

export const homeDashboardCapability = defineCapability({
  manifestVersion: 1,
  id: HOME_DASHBOARD_CAPABILITY_ID,
  version: "1.0.0",
  tier: "vertical",
  displayName: "家居监控面板",
  description:
    "按房间分组的智能家居实体状态总览（灯/开关/传感器/温控分类图标与状态徽标）：面板打开时向基座" +
    "登记实体缓存消费者（维持 WS 实时增量），关闭即释放；断线如实显示 stale 横幅。纯只读视图，" +
    "零常驻工具——设备控制走会话对话（基座的回路内工具），面板不做控制按钮。",
  // 内置能力不可能比宿主更老（同一份构建一起出厂），appMin 恒 "0.0.0"。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  // 基座未启用时装配期直接拒绝（"依赖未启用"，reason 下发 UI），不静默降级。
  dependencies: ["home.assistant"],
  // 纯只读视图：出站与落盘的权限归属基座，本包目录零权限特征（见文件头）。
  permissions: [],
  channels: [
    CHANNELS.dashboardSubscribe,
    CHANNELS.dashboardUnsubscribe,
    CHANNELS.dashboardSnapshot,
  ],
  pushChannels: [PUSH_CHANNELS.dashboardEvent],
  // 面板零工具 = 上下文零成本（家居四包的成本剖面切分：工具面归基座）。
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "home.dashboard.panel",
      title: "家居面板",
      module: "renderer/src/components/HomeDashboardPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  // 本包不持有自有持久化数据（快照与配置归基座分区），因此 0。
  dataSchemaVersion: 0,
  runtime: {
    // 首个 lazy 包：面板组件独立 chunk，开面板才加载（defineAsyncComponent）。
    loading: "lazy",
    entry: "renderer/src/components/HomeDashboardPanel.vue",
    // 预算上界：单文件组件 + 既有内核依赖（vue/naive-ui 不重复计入 chunk），
    // 64KB 对一个纯视图组件绰绰有余，超了说明有人往面板里塞了重依赖。
    bundleBudgetKb: 64,
    heavyDependencies: [],
    // 面板消费者登记 + 缓存变更监听是运行期资源：禁用时必须释放，否则基座
    // 的引用计数永不归零、WS 长连接成为死角（dispose 见 home-dashboard-ipc）。
    teardown: ["listener"],
  },
  exposure: {
    module: "main/home-dashboard/home-dashboard-ipc.ts",
    register: "registerHomeDashboardIpc",
    dispose: "disposeHomeDashboardResources",
  },
  // 不携带任何 pi 资源：面板是宿主 UI，不进 pi 的 prompts/skills/extensions。
});
