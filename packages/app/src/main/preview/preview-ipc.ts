/**
 * 安全预览的 IPC handler（ART-101）——**恰 3 条通道**。
 *
 * 跨进程边界上只有 token（CT-17）、workspaceId + relativePath（CT-18）
 * 或 artifactId（按记录 sha256 核对版本）。没有绝对路径 —— 于是
 * 「预览 C:\Users\…\auth.json」这个意图在结构上就说不出来。
 *
 * 收容判定一律走 TASK-007 的 `resolveInWorkspace`：那是全计划唯一的
 * 收容原语。artifactId 路径先查产物记录再收容，避免把当前文件当成旧版。
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
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveAttachment } from "../attachment-registry.js";
import { artifactStore } from "../artifacts/artifact-store.js";
import { registerHandler } from "../ipc-guard.js";
import { resolveInWorkspace } from "../workspace-registry.js";
import { convert } from "./convert-host.js";
import { SUGGESTION } from "./convert-worker.js";
import { closeAllPreviewWindows, closePreviewWindow, openPreviewWindow } from "./preview-window.js";

/** 历史版本磁盘对不上时给用户的那句话。不能把当前文件当成旧版打开。 */
export const ARTIFACT_VERSION_UNAVAILABLE =
  "这一版的内容已经不在磁盘上了。当前文件是更新后的版本，不能当成旧版打开。";

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

/** 三种目标表达都不给 = 说不清要看什么，直接拒。 */
function assertAddressable(target: PreviewTarget): void {
  const byToken = typeof target.token === "string" && target.token.length > 0;
  const byArtifact = typeof target.artifactId === "string" && target.artifactId.length > 0;
  const byPath =
    typeof target.workspaceId === "string" &&
    target.workspaceId.length > 0 &&
    typeof target.relativePath === "string" &&
    target.relativePath.length > 0;
  if (!byToken && !byArtifact && !byPath) throw new Error("PREVIEW_TARGET_REQUIRED");
}

type LocatedSource =
  | { ok: true; inputPath: string; sourceName: string }
  | { ok: false; result: PreviewResult };

function versionUnavailable(sourceName: string): PreviewResult {
  return {
    kind: "text",
    code: "unsupported",
    text: "",
    suggestion: ARTIFACT_VERSION_UNAVAILABLE,
    notices: [],
    tables: [],
    dataUrl: null,
    sourceName,
    sizeBytes: 0,
    elapsedMs: 0,
  };
}

async function locatePreviewSource(target: PreviewTarget): Promise<LocatedSource> {
  if (target.token) {
    const record = await resolveAttachment(target.token, { capability: "read" });
    return { ok: true, inputPath: record.canonicalPath, sourceName: path.basename(record.canonicalPath) };
  }

  if (target.artifactId) {
    const record = artifactStore().get(target.artifactId);
    if (!record) throw new Error(`ARTIFACT_UNKNOWN: ${target.artifactId}`);
    if (target.workspaceId && target.workspaceId !== record.workspaceId) {
      throw new Error("ARTIFACT_WORKSPACE_MISMATCH");
    }
    const resolved = await resolveInWorkspace(record.workspaceId, record.exportPath, {
      requireFile: true,
    });
    if (record.sha256) {
      const actual = createHash("sha256").update(fs.readFileSync(resolved.realPath)).digest("hex");
      if (actual !== record.sha256) {
        return { ok: false, result: versionUnavailable(record.name || path.basename(record.exportPath)) };
      }
    }
    return {
      ok: true,
      inputPath: resolved.realPath,
      sourceName: record.name || path.basename(resolved.realPath),
    };
  }

  const resolved = await resolveInWorkspace(
    target.workspaceId as string,
    target.relativePath as string,
    { requireFile: true }
  );
  return {
    ok: true,
    inputPath: resolved.realPath,
    sourceName: path.basename(resolved.realPath),
  };
}

export function registerPreviewIpc(): void {
  // ------------------------------------------------------------ open

  registerHandler<PreviewTarget, PreviewHandle>(
    CHANNELS.previewOpen,
    previewTargetSchema,
    async (target) => {
      assertAddressable(target);
      const located = await locatePreviewSource(target);
      if (!located.ok) {
        const previewId = randomUUID();
        openPreviewWindow({ previewId, title: located.result.sourceName, result: located.result });
        return { previewId, result: located.result };
      }
      const { inputPath, sourceName } = located;
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
      const located = await locatePreviewSource(target);
      if (!located.ok) return located.result;
      try {
        return flatten(await convert({ inputPath: located.inputPath, sourceName: located.sourceName }), located.sourceName);
      } catch {
        return refused(located.sourceName);
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

/**
 * 拆卸本能力的运行期资源（ADR-0002 D4 规则 4）。
 *
 * 预览窗口是独立的 BrowserWindow：不收的话，禁用之后用户看到的是「设置里
 * 说已关闭，桌面上那个预览窗口还开着」。转换缓存目录**不动** —— 那是磁盘
 * 上的产物，删它属于「卸载」而不是「禁用」（规则 5）。
 */
export function disposePreviewResources(): void {
  closeAllPreviewWindows();
}
