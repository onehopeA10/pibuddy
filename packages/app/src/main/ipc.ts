/**
 * IPC 的门面。
 *
 * TASK-009 之前这里挤着全部 30 多个 handler；handler 已按域拆到
 * `pi/pi-ipc.ts`、`sessions/sessions-ipc.ts`、`misc-ipc.ts`，由
 * `ipc-registry.ts` 统一装配。本文件只剩两件事：把 guard 的日志接上，
 * 以及把注册这件事触发一次。
 *
 * 日志取自 `log.ts`（内核设施）而不是 `pi/pi-ipc.ts`：ADR-0002 要求
 * pi runtime 可替换，内核门面不能反过来从它那里取日志出口。
 *
 * `disposeClientFor` 从这里再导出一次，是为了 main/index.ts 的窗口 closed
 * 回调不必知道 client 索引搬到了哪个文件里。
 */
import { setGuardLogger } from "./ipc-guard.js";
import { registerAllIpc } from "./ipc-registry.js";
import { log } from "./log.js";

export { disposeClientFor } from "./pi/pi-ipc.js";
export { MAX_AUDIO_BYTES } from "./misc-ipc.js";

export function registerIpc(): void {
  setGuardLogger({ warn: (event, fields) => log().warn(event, fields) });
  registerAllIpc();
}
