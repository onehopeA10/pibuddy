/**
 * IPC 注册的集中入口。
 *
 * ## 两段结构：内核写死，能力包按启用集合装
 *
 * 上半段是**平台内核**（ADR-0002 四层边界表第一行）：不可关闭，因此就该是
 * 一串写死的调用，加条件只会让人以为它们可以被关掉。
 *
 * 下半段是**可选能力**：注册与否由 `CapabilityRegistry` 的解析结果决定。
 * 这就是 feature gate 在主进程侧的全部含义 —— 没有第二处「其实也注册了但
 * 加了个 if」的地方。未启用的能力，它的 `activate()` 一次都不会被调用，
 * 因此 `registeredChannels()` 里也不会出现它的通道。
 *
 * 顺序有一处不能换：pi-ipc 先注册 —— sessions-ipc 的 rename / export 要经
 * pi-ipc 持有的 client 索引取当前 runtime，虽然那是运行期才解引用的，但把
 * 「谁持有 client」这件事在注册顺序上也表达一次，日后读代码少绕一圈。
 */
import { assembleCapabilities, capabilityRegistry } from "./capability/capability-catalog.js";
import { registerCapabilityIpc } from "./capability/capability-ipc.js";
import { registerDiagnosticsIpc } from "./diagnostics/diagnostics-ipc.js";
import { registerMiscIpc } from "./misc-ipc.js";
import { registerPiIpc } from "./pi/pi-ipc.js";
import { registerPiResourcesIpc } from "./pi-resources/pi-resources-ipc.js";
import { registerProvidersIpc, registerUsageIpc } from "./providers/providers-ipc.js";
import { registerSessionsIpc } from "./sessions/sessions-ipc.js";
import { registerUpdateIpc } from "./update/update-ipc.js";

export function registerAllIpc(): void {
  // ---- 平台内核：恒注册
  registerPiIpc();
  registerPiResourcesIpc();
  registerSessionsIpc();
  registerMiscIpc();
  registerProvidersIpc();
  registerUsageIpc();
  registerUpdateIpc();
  registerDiagnosticsIpc();
  registerCapabilityIpc();

  // ---- 可选能力：只装启用的那些
  //
  // 装配必须在这里、在任何 activate 之前完成：`capability-state` 的默认值是
  // 「未装配 = 全部视为启用」（那个默认值是给单测用的），生产路径上必须由
  // 这一行把它换成真实集合。
  const resolution = assembleCapabilities();
  for (const id of resolution.enabled) {
    capabilityRegistry.get(id)?.activate?.();
  }
}
