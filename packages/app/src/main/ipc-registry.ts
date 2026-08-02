/**
 * IPC 注册的集中入口。
 *
 * 各域的 `register*Ipc()` 在这里被依次调用。新增一个功能域 = 新增一个
 * `<域>-ipc.ts` 并在这里加一行，既不用改 ipc.ts，也不用和别的任务抢同一处。
 *
 * 顺序有一处不能换：pi-ipc 先注册 —— sessions-ipc 的 rename / export 要经
 * pi-ipc 持有的 client 索引取当前 runtime，虽然那是运行期才解引用的，但把
 * 「谁持有 client」这件事在注册顺序上也表达一次，日后读代码少绕一圈。
 */
import { registerDiagnosticsIpc } from "./diagnostics/diagnostics-ipc.js";
import { registerMiscIpc } from "./misc-ipc.js";
import { registerPiIpc } from "./pi/pi-ipc.js";
import { registerPiResourcesIpc } from "./pi-resources/pi-resources-ipc.js";
import { registerSessionsIpc } from "./sessions/sessions-ipc.js";
import { registerUpdateIpc } from "./update/update-ipc.js";

export function registerAllIpc(): void {
  registerPiIpc();
  registerPiResourcesIpc();
  registerSessionsIpc();
  registerMiscIpc();
  registerUpdateIpc();
  registerDiagnosticsIpc();
}
