/**
 * 本次进程装配的启用集合（feature gate 的运行期读取面）。
 *
 * ## 为什么它是一份内存里的集合，而不是一次文件读取
 *
 * 启用集合在**装配期**就确定了：主进程侧的 feature gate 等价于「这条通道的
 * `registerHandler` 有没有被调用过」，而那是一件只发生一次、之后不可撤销的事
 * （`ipcMain.handle` 在同一个 channel 上绑第二次直接抛错）。既然如此，运行期
 * 每次都去读一遍偏好文件就只会带来一种可能：读到的值和实际注册面对不上。
 *
 * 因此偏好文件由 `capability-prefs.ts` 在装配期读一次，折成集合塞进这里；
 * 之后的每一处 gate 都读同一份集合。运行期改偏好只改文件，不改这份集合 ——
 * 界面据 `restartRequired` 如实告诉用户「下次启动生效」。
 *
 * ## 本文件刻意不 import electron
 *
 * gate 会被 `changeset/tool-watch.ts` 这种在事件热路径上的模块引用。让它拖进
 * electron，等于让每一个引用它的单测都必须给 electron 打桩 —— 需要打桩才能测
 * 的判据，最后都会变成没人跑的判据。
 */

/**
 * 已启用的能力 id。
 *
 * `null` = **尚未装配**。此时一律视为启用：单测与工具脚本会在不跑装配的
 * 情况下 import 到这些模块，让它们默认「什么都关着」会把大批与能力无关的
 * 用例变成在测 gate。生产路径上 `registerAllIpc()` 必定先调用
 * `applyCapabilityResolution`，因此这个默认值在真机上走不到 ——
 * 这一点由 `capability-gate.spec.ts` 钉住。
 */
let enabled: ReadonlySet<string> | null = null;

/** 装配期写入一次。 */
export function applyCapabilityResolution(ids: Iterable<string>): void {
  enabled = new Set(ids);
}

/** 仅供单测：回到「未装配」状态。 */
export function __resetCapabilityState(): void {
  enabled = null;
}

/** 装配是否已经发生过。 */
export function isCapabilityAssemblyDone(): boolean {
  return enabled !== null;
}

/** 某个能力在本次进程里是否启用。 */
export function isCapabilityEnabled(id: string): boolean {
  return enabled === null || enabled.has(id);
}

/** 本次进程启用的全部能力 id（未装配时为空数组）。 */
export function enabledCapabilityIds(): string[] {
  return enabled === null ? [] : [...enabled].sort();
}
