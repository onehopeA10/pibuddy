/**
 * `window.piBuddy.shell` —— 用系统默认程序打开 / 在文件管理器里定位。
 *
 * 入参只有能力凭证：没有任何一条通道接受路径字符串，因此渲染进程无法
 * 诱导主进程去打开一个它自己挑的文件。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { AttachmentRef } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

/** 只用来把 AttachmentRef 的 token 字段类型钉在契约上。 */
type Token = AttachmentRef["token"];

export const shell = {
  open: (token: Token) => invoke<string>(CHANNELS.shellOpenPath, { token }),
  showInFolder: (token: Token) => invoke<void>(CHANNELS.shellShowInFolder, { token }),
};
