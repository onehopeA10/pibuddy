/**
 * 能力清单：儿童教育能力包（vertical / edu.kids / REQ-0001 R3）。
 *
 * **首个真内容垂直包**（「装了货」的样板）：四类内容齐备——
 *
 *   - prompts ×6（piResources.prompts）：单词卡 / 情景对话陪练 / 应用题引导 /
 *     看图写话 / 古诗讲解背诵 / 按龄科普，全部前置「引导思考、不代做作业」
 *     的辅导原则与儿童安全约束；
 *   - skills ×2（piResources.skills）：练习卷生成（edu-worksheet）、错题本
 *     整理（edu-mistake-book，数据文件约定见其 SKILL.md）；
 *   - 回路内工具 ×1（piResources.extensions + tools）：`edu.kids.math_worksheet`
 *     确定性出题器——**出题判分走代码保真，讲解归因走模型**是本包的核心
 *     设计原则；
 *   - UI ×1（uiContributions）：学习面板（档案 / 一键出卷 / 错题本）。
 *
 * 资源经 R4 物化通道装卸：启用 → 物化到 ~/.pi/agent，停用 → 经账本收回，
 * 通用能力零残留（R3.2，判据在 test/edu-assets.spec.ts）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。
 * drift test 要能直接 import 它做对账，一旦反过来依赖实现，「声明与实现是否
 * 一致」就退化成「实现与自己是否一致」，恒真。
 */
import { defineCapability, CHANNELS, EDU_CAPABILITY_ID } from "@pibuddy/contract";

// capabilityId 的唯一定义在契约包（EDU_CAPABILITY_ID = "edu.kids"），这里只
// 引用、不再 export 同名常量——契约唯一性闸门不允许两处 export 同名符号。

export const eduKidsCapability = defineCapability({
  manifestVersion: 1,
  id: EDU_CAPABILITY_ID,
  version: "1.0.0",
  tier: "vertical",
  displayName: "儿童教育",
  description:
    "给家长/辅导者的备课与练习工具（英语/数学/语文/科学，孩子在家长陪同下使用）：" +
    "辅导提示词、练习卷生成与错题本技能、回路内确定性数学出题器（代码保证答案正确）、" +
    "学习面板（孩子档案/一键出卷/错题本）。零网络权限。",
  // appMin 是 "0.0.0"：内置能力不可能比宿主更老，真正生效的是 contractMin/Max。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  // 不依赖任何其它可选能力：档案在自有分区，错题本经内核 workspace-registry
  // 收容读取，不经手 common.workspace-files 的通道。
  dependencies: [],
  // 最小集（R3.1 安全条款：零网络）：workspace.read 供面板读错题本
  // （edu-kids/mistakes.jsonl），workspace.write 供档案落盘（writeJsonAtomic，
  // 能力自有分区）。不申请 process.* / network / secret / external.open。
  permissions: ["workspace.read", "workspace.write"],
  channels: [CHANNELS.eduProfileGet, CHANNELS.eduProfileSet, CHANNELS.eduMistakeList],
  pushChannels: [],
  tools: [
    {
      // 回路内工具（pi extension 注册，R4.3：权限需求经本声明进权限面）。
      // 纯计算：不读写文件、不联网、不开进程，因此 permissions 为空——
      // 它要是哪天想读文件，必须先来这里申请，装配期校验会逼它。
      name: "edu.kids.math_worksheet",
      description:
        "确定性小学数学出题器：按年级(1-6)/运算(加减乘除混合)/题量/难度生成题目与标准答案，" +
        "答案由代码构造并经独立自校验保证正确；同一种子可完整复现一份卷。纯计算，零 IO。",
      permissions: [],
    },
  ],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "edu.kids.panel",
      title: "学习面板",
      module: "renderer/src/components/EduPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    // 面板是普通 Vue 组件，无重依赖，随内核 bundle 内联（与 git/terminal 一致）。
    loading: "inline",
    heavyDependencies: [],
    // 不持有 worker / watcher / 子进程：三条通道都是一次性读写，无需 dispose。
    teardown: [],
  },
  exposure: {
    module: "main/edu/edu-ipc.ts",
    register: "registerEduIpc",
  },
  // 随包携带的 pi 资源（R4.1）。路径相对 resources/capability-assets/edu.kids/，
  // 结构断言（verifyCapabilityAssets 对真实资源根）保证每条都真实存在。
  piResources: {
    prompts: [
      "prompts/edu-word-cards.md",
      "prompts/edu-scene-talk.md",
      "prompts/edu-math-coach.md",
      "prompts/edu-picture-writing.md",
      "prompts/edu-poem-tutor.md",
      "prompts/edu-explain.md",
    ],
    skills: ["skills/edu-worksheet", "skills/edu-mistake-book"],
    extensions: ["extensions/edu-math-worksheet.ts"],
  },
});
