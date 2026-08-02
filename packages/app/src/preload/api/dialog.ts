/**
 * `window.piBuddy.dialog` —— 需要真实用户手势的系统对话框，外加当前工作区。
 *
 * 工作目录只能从这里来：`chooseFolder()` 打的是系统目录选择框，绝对路径由
 * 主进程自己写进设置，渲染进程收到的只有 `{workspaceId, displayPath}`。
 * `displayPath` 是**单向下发**的展示字段，任何 IPC 入参都不接受它。
 *
 * `currentWorkspace()` 与 chooseFolder 同属「工作区从哪来」这一件事，因此
 * 归在同一个命名空间下，而不是另开一个只有一个方法的 workspace 命名空间。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { AttachmentRef, WorkspaceRef } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const dialog = {
  /** 已选的工作目录；未选返回 null。 */
  currentWorkspace: () => invoke<WorkspaceRef | null>(CHANNELS.workspaceCurrent),
  chooseFolder: () => invoke<WorkspaceRef | null>(CHANNELS.dialogChooseFolder),
  /** 系统文件对话框；返回的是能力凭证，不是路径。 */
  chooseFiles: () => invoke<AttachmentRef[]>(CHANNELS.dialogChooseFiles),
};
