/**
 * 主进程 push 的窗口订阅表（F-002）。
 *
 * 默认把**当前所有未销毁窗口**都当成订阅者，因此单窗口行为与昔日
 * `BrowserWindow.getAllWindows()` 全发等价；远程窗口只要已经创建，就不会漏事件。
 * 显式 `unsubscribeWindow` 才退出投递。每次 fanout 都按现存窗口重算，
 * 避免「第一次 seed 之后才出现的窗口」收不到快照。
 */
import { BrowserWindow } from "electron";

const unsubscribed = new Set<number>();

export function subscribeWindow(webContentsId: number): void {
  unsubscribed.delete(webContentsId);
}

export function unsubscribeWindow(webContentsId: number): void {
  unsubscribed.add(webContentsId);
}

/** 仅供单测：清空退订表。 */
export function __resetWindowFanout(): void {
  unsubscribed.clear();
}

export function fanoutToSubscribed(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const id = win.webContents.id;
    if (unsubscribed.has(id)) continue;
    win.webContents.send(channel, payload);
  }
}
