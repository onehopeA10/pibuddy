/**
 * `window.piBuddy.preview` —— 安全预览（ART-101）。
 *
 * 目标只有两种表达方式，**都不是绝对路径**：
 *   - `token`：attachment-registry 签发的一次性能力凭证（30 分钟滑动
 *     过期）。全计划统一称谓恒为 `token`，不存在任何别的标识字段名。
 *   - `workspaceId` + `relativePath`：工作区内的文件，main 侧经
 *     resolveInWorkspace 收容。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod）——
 * 从主入口做值导入会把 140KB 的 zod 打进一个开着 sandbox 的安全边界，
 * 或者更糟，让整个 preload 静默失败、window.piBuddy 变成 undefined。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { PreviewHandle, PreviewResult, PreviewTarget } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const preview = {
  /** 打开一个沙箱预览窗口，同时返回首次转换结果。 */
  open: (target: PreviewTarget) => invoke<PreviewHandle>(CHANNELS.previewOpen, target),

  /** 只转换、不开窗（用于内嵌在主界面里的预览面板）。 */
  convert: (target: PreviewTarget) => invoke<PreviewResult>(CHANNELS.previewConvert, target),

  /** 关掉一个预览窗口。previewId 来自 open 的返回值。 */
  close: (previewId: string) => invoke<void>(CHANNELS.previewClose, { previewId }),
};
