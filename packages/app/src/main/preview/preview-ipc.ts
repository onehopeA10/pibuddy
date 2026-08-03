/**
 * 安全预览的 IPC handler（ART-101）——**恰 3 条通道**。
 *
 * 跨进程边界上只有两种目标表达：attachment token（CT-17）或
 * workspaceId + relativePath（CT-18）。没有第三种，尤其没有绝对路径 ——
 * 于是「预览 C:\Users\…\auth.json」这个意图在结构上就说不出来。
 *
 * 收容判定一律走 TASK-007 的 `resolveInWorkspace`：那是全计划唯一的
 * 收容原语，本文件一行都不重新实现它。两个需要定位文件的 handler 各自
 * 显式调用一次，而不是共用一个隐藏在下面的辅助函数 —— 校验写在入口上
 * 才看得见，藏起来的校验迟早会有一个新 handler 忘了走。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 */
import {
  CHANNELS,
  previewCloseRequestSchema,
  previewTargetSchema,
  type InvokeChannel,
  type PreviewHandle,
  type PreviewResult,
  type PreviewTarget,
} from "@pibuddy/contract";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { resolveAttachment } from "../attachment-registry.js";
import { registerHandler } from "../ipc-guard.js";
import { resolveInWorkspace } from "../workspace-registry.js";
import { convert } from "./convert-host.js";
import { SUGGESTION } from "./convert-worker.js";
import { closePreviewWindow, openPreviewWindow } from "./preview-window.js";

/** 本域注册的全部通道。单测据它断言逐一出现在 ipc-guard 的注册表里。 */
export const PREVIEW_CHANNELS: InvokeChannel[] = [
  CHANNELS.previewOpen,
  CHANNELS.previewConvert,
  CHANNELS.previewClose,
];

/** 目标定位失败时的统一结果。分类照样给，界面照样有话说。 */
function refused(sourceName: string): PreviewResult {
  return {
    kind: "text",
    code: "unsupported",
    text: "",
    suggestion: SUGGESTION.unsupported,
    notices: [],
    tables: [],
    dataUrl: null,
    sourceName,
    sizeBytes: 0,
    elapsedMs: 0,
  };
}

/** 把 ConvertOutcome 摊平成一个总是可渲染的 PreviewResult。 */
function flatten(
  outcome: Awaited<ReturnType<typeof convert>>,
  sourceName: string
): PreviewResult {
  if (outcome.ok) return outcome.result;
  return {
    kind: "text",
    code: outcome.code,
    text: "",
    // 宿主给了更具体的那句话（比如「这个文件里有 300 个工作表」）就用它，
    // 否则回落到按 code 分类的默认文案。
    suggestion: outcome.suggestion ?? (outcome.code === "ok" ? "" : SUGGESTION[outcome.code]),
    notices: [],
    tables: [],
    dataUrl: null,
    sourceName,
    sizeBytes: 0,
    elapsedMs: 0,
  };
}

/** 两种目标表达都不给 = 说不清要看什么，直接拒。 */
function assertAddressable(target: PreviewTarget): void {
  const byToken = typeof target.token === "string" && target.token.length > 0;
  const byPath =
    typeof target.workspaceId === "string" &&
    target.workspaceId.length > 0 &&
    typeof target.relativePath === "string" &&
    target.relativePath.length > 0;
  if (!byToken && !byPath) throw new Error("PREVIEW_TARGET_REQUIRED");
}

export function registerPreviewIpc(): void {
  // ------------------------------------------------------------ open

  registerHandler<PreviewTarget, PreviewHandle>(
    CHANNELS.previewOpen,
    previewTargetSchema,
    async (target) => {
      assertAddressable(target);

      let inputPath: string;
      if (target.token) {
        // token 路径：兑付时 attachment-registry 会重做过期、能力、收容
        // 与存在性校验（它内部同样用 assertContained，与收容原语同判据）。
        const record = await resolveAttachment(target.token, { capability: "read" });
        inputPath = record.canonicalPath;
      } else {
        const resolved = await resolveInWorkspace(
          target.workspaceId as string,
          target.relativePath as string,
          { requireFile: true }
        );
        inputPath = resolved.realPath;
      }

      const sourceName = path.basename(inputPath);
      const outcome = await convert({ inputPath, sourceName });
      const result = flatten(outcome, sourceName);
      const previewId = randomUUID();
      // 窗口照开：转换失败时窗口里显示的是 SUGGESTION 里那句话，
      // 而不是一片空白 —— 「打开之后什么都没有」是最难排查的失败形态。
      openPreviewWindow({ previewId, title: sourceName, result });
      return { previewId, result };
    }
  );

  // --------------------------------------------------------- convert

  registerHandler<PreviewTarget, PreviewResult>(
    CHANNELS.previewConvert,
    previewTargetSchema,
    async (target) => {
      assertAddressable(target);

      let inputPath: string;
      if (target.token) {
        const record = await resolveAttachment(target.token, { capability: "read" });
        inputPath = record.canonicalPath;
      } else {
        const resolved = await resolveInWorkspace(
          target.workspaceId as string,
          target.relativePath as string,
          { requireFile: true }
        );
        inputPath = resolved.realPath;
      }

      const sourceName = path.basename(inputPath);
      try {
        return flatten(await convert({ inputPath, sourceName }), sourceName);
      } catch {
        return refused(sourceName);
      }
    }
  );

  // ----------------------------------------------------------- close
  //
  // 入参是 preview:open 返回的不透明 previewId，不是路径 —— 这个
  // handler 因此没有可收容的东西，也不该假装有。

  registerHandler<{ previewId: string }, void>(
    CHANNELS.previewClose,
    previewCloseRequestSchema,
    (payload) => {
      closePreviewWindow(payload.previewId);
    }
  );
}
