/**
 * `window.piBuddy.file` —— 附件的能力凭证进出口。
 *
 * 渲染进程从头到尾只持有 `token`（30 分钟滑动过期，只能换取签发时那一个
 * canonical 文件）。拖拽进来的文件在**这里**就被换成凭证：
 * `webUtils.getPathForFile` 在 preload 内部调用，绝对路径不进渲染进程的
 * JS 作用域 —— 收敛前它是直接把路径 return 给渲染进程的。
 */
import { webUtils } from "electron";
import { CHANNELS } from "@pibuddy/contract/channels";
import type { AttachmentRef, ReadImageResult } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const file = {
  /** 拖拽进来的文件 → 能力凭证。路径只在 preload→main 的 stage 步出现。 */
  fromDrop: async (dropped: File) => {
    const droppedPath = webUtils.getPathForFile(dropped);
    const staged = await invoke<{ nonce: string }>(CHANNELS.fileStageDropped, { droppedPath });
    return invoke<AttachmentRef>(CHANNELS.fileAttachDropped, { nonce: staged.nonce });
  },
  readImage: (token: string) => invoke<ReadImageResult>(CHANNELS.fileReadAttachment, { token }),
  /** 换会话 / 关窗口时作废全部已签发凭证。 */
  revokeAll: () => invoke<void>(CHANNELS.attachmentRevokeAll),
};
