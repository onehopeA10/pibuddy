/**
 * preload 内部的两条原语：invoke 与 subscribe。**都不经 contextBridge 暴露。**
 *
 * ## 为什么 CHANNELS 只能从 `@pibuddy/contract/channels` 引
 *
 * preload 开着 `sandbox: true`，产物必须是自包含的 .cjs —— 沙箱里的 require
 * 只认 electron 与少数内建模块。契约包主入口依赖 zod，从那里做**值**导入会把
 * 140KB 的运行时校验库打进一个从不做校验的安全边界；而如果它没被打进来，
 * 整个 preload 会**静默失败**，window.piBuddy 变成 undefined，界面停在空白且
 * 控制台一行堆栈都没有。类型导入没有这个顾虑（编译期就消失了）。
 */
import { ipcRenderer } from "electron";
import type { InvokeChannel } from "@pibuddy/contract";

/**
 * 唯一的 invoke 出口。
 *
 * 形参类型是 `InvokeChannel` 而不是 `string`：渲染进程既拿不到这个函数，
 * 也无法凭空造出一个不在 CHANNELS 表里的通道名。
 */
export function invoke<T>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

/**
 * 订阅主进程推送。
 *
 * payload 一律是完整的 `PiEnvelope`，preload **不再剥壳**：代际与序号只有
 * 送到渲染进程才能用来丢弃上一代的迟到事件，在这里剥掉就等于把 RUN-002
 * 的判据扔了。
 *
 * 所有监听器登记在 `active` 里，pagehide（窗口刷新 / 关闭）时统一摘除，
 * 避免热重载后同一 channel 上挂着几代回调。
 */
const active = new Set<() => void>();

// preload 的 tsconfig 只带 node 类型（没有 DOM lib），但它实际运行在渲染进程
// 上下文里，window 是存在的。为一处 API 引入整个 DOM lib 不划算，这里最小声明。
declare const window: {
  addEventListener(type: string, listener: () => void): void;
};

export function subscribe(channel: string, callback: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => callback(payload);
  ipcRenderer.on(channel, listener);
  const off = (): void => {
    ipcRenderer.removeListener(channel, listener);
    active.delete(off);
  };
  active.add(off);
  return off;
}

window.addEventListener("pagehide", () => {
  for (const off of [...active]) off();
});
