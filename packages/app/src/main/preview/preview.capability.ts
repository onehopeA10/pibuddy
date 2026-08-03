/**
 * 能力清单：文档预览（common / ART-101）。
 */
import { defineCapability, CHANNELS } from "@pibuddy/contract";

export const PREVIEW_CAPABILITY_ID = "common.preview";

export const previewCapability = defineCapability({
  manifestVersion: 1,
  id: PREVIEW_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "文档预览",
  description: "在沙箱窗口里预览 PDF / Office / CSV / 图片。",
  // appMin 是 "0.0.0" 而不是当前版本号：**内置能力不可能比宿主更老**，它就是
  // 随这一份构建一起出厂的。写一个具体版本号在这里只会制造一条恒真的判据。
  // 真正对内置能力生效的那一半是 contractMin/contractMax —— 宿主契约代际一旦
  // +1，每一份没跟着改的 manifest 都会被当场拒绝。appMin/appBelow 是给第三阶段
  // 的第三方包留的，其行为由 capability-registry.spec.ts 用合成 manifest 钉住。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // 只读工作区 + 往缓存目录写转换产物。**没有 external.open**：预览窗口是
  // 应用自己的 BrowserWindow（partition sandbox:preview、javascript:false、
  // webRequest 全拦），不是把文件交给系统默认程序打开 —— 后者是一条完全
  // 不同的、绕过全部沙箱设定的路径。
  permissions: ["workspace.read", "workspace.write"],
  channels: [CHANNELS.previewOpen, CHANNELS.previewConvert, CHANNELS.previewClose],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.preview.pane",
      title: "预览",
      module: "renderer/src/components/PreviewPane.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    loading: "inline",
    heavyDependencies: [],
    // 转换跑在 utilityProcess 里（convert-host.ts），预览窗口是独立的
    // BrowserWindow。禁用时两者都要收掉，否则用户看到的是「功能已关闭，
    // 但那个预览窗口还开着」。
    teardown: ["child-process"],
  },
  exposure: {
    module: "main/preview/preview-ipc.ts",
    register: "registerPreviewIpc",
    dispose: "disposePreviewResources",
  },
});
