/**
 * 能力清单：预置办公提示词库（common / REQ-0001 R1）。
 *
 * 面向非程序员办公用户的开箱内容资产：五类中文办公提示词（邮件、表格、
 * 总结、翻译、汇报）随包分发（extraResources 的 prompt-library/），首启动
 * 物化成 **pi 原生 prompts 资源**（~/.pi/agent/prompts/*.md）—— pi 在会话
 * 里 `/名字` 就能展开，PiBuddy 面板提供浏览 / 搜索 / 一键填入输入框 / 收藏。
 * 预置项带归属标记（frontmatter 的 pibuddy-preset），可隐藏不可删；用户
 * 自建项与预置同列，可增删改。
 */
import { defineCapability, CHANNELS } from "@pibuddy/contract";

export const PROMPT_LIBRARY_CAPABILITY_ID = "common.prompt-library";

export const promptLibraryCapability = defineCapability({
  manifestVersion: 1,
  id: PROMPT_LIBRARY_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "提示词库",
  description:
    "开箱即用的中文办公提示词（邮件、表格、总结、翻译、汇报五类），可浏览、搜索、一键填入输入框、收藏；支持自建提示词，落盘为 pi 原生 prompt 模板。",
  // appMin 是 "0.0.0"：内置能力不可能比宿主更老。真正生效的是 contractMin/Max。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // 权限有二（drift 3 按 fs 调用对账）：
  //   workspace.read —— 读预置资源目录与 pi 用户级 prompts 目录
  //     （readdir / readFile，见 prompt-library-files.ts 的扫描与物化）。
  //   workspace.write —— 物化预置、写用户自建提示词到 ~/.pi/agent/prompts/，
  //     以及收藏 / 隐藏偏好的 userData JSON（writeFile / writeJsonAtomic）。
  //     写入面收敛在这两个目录：物化绝不覆盖无归属标记的用户文件，删除
  //     只对用户自建项开放（预置只可隐藏）。
  permissions: ["workspace.read", "workspace.write"],
  channels: [
    CHANNELS.promptLibraryList,
    CHANNELS.promptLibraryCreate,
    CHANNELS.promptLibraryUpdate,
    CHANNELS.promptLibraryDelete,
    CHANNELS.promptLibrarySetFavorite,
    CHANNELS.promptLibrarySetHidden,
  ],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.prompt-library.panel",
      title: "提示词库",
      module: "renderer/src/components/PromptLibraryPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  // 数据 = prompts 目录里的 .md（pi 的资源，禁用不动）+ 偏好 JSON（v1）。
  dataSchemaVersion: 1,
  runtime: {
    loading: "inline",
    heavyDependencies: [],
    // 不持有 watcher / worker / 子进程 / 常驻句柄：扫描缓存只是一张 Map，
    // 禁用后无需拆卸（teardown 为空，与 session-tree 同款）。
    teardown: [],
  },
  exposure: {
    module: "main/prompt-library/prompt-library-ipc.ts",
    register: "registerPromptLibraryIpc",
  },
});
