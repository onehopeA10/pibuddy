/**
 * `window.piBuddy.capabilities`（ADR-0002 第一阶段）。
 *
 * 三个方法、三条通道。渲染进程能表达的极限是「告诉我有哪些能力」、
 * 「换成这个 Profile」、「把这个能力开/关」——**没有**注册入口，也没有
 * 任何形参能承载一份 manifest。能力集合在主进程装配期由
 * `CapabilityRegistry` 封口，界面只是在一张已经定死的表上勾选。
 *
 * 这也是 ADR-0002 D4 规则 1 的一次具体落地：这里不存在
 * `invoke(channel, args)` 那种无约束入口，三个方法各自对应一条窄通道。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { CapabilityState } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const capabilities = {
  /** 当前 Profile、全部已注册能力及其启用态与未启用原因。 */
  describe: () => invoke<CapabilityState>(CHANNELS.capabilitiesDescribe),

  /**
   * 切换 Profile。返回切换后的状态快照 —— 其中的 `restartRequired` 会告诉
   * 界面「主进程侧要下次启动才生效」，那不是可以省略的礼貌用语：通道注册
   * 发生在装配期且不可撤销。
   */
  setProfile: (profileId: string) =>
    invoke<CapabilityState>(CHANNELS.capabilitiesSetProfile, { profileId }),

  /** 在当前 Profile 之上单独开关一个能力。 */
  setEnabled: (capabilityId: string, enabled: boolean) =>
    invoke<CapabilityState>(CHANNELS.capabilitiesSetEnabled, { capabilityId, enabled }),
};
