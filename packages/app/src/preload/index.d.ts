/**
 * 渲染进程可见的 `window.piBuddy` 类型。
 *
 * **不再逐字段手抄签名**：类型直接从 `./api` 的聚合对象 `typeof api` 推导，
 * 因此实现与类型在结构上不可能漂移 —— 收敛前这里手写着一份 150 行的接口
 * 声明，每加一个方法都要在两处各写一遍，而漏写的那一处只会在运行时暴露。
 *
 * **接口面的有限性由类型层兜底**：`api/` 下不出现任何裸的通道名、绝对路径、
 * 任意 URL 或环境变量形参。工作目录一律以不透明的 `workspaceId` 表达，会话
 * 一律以不透明的 `sessionId` 表达，文件一律以短期能力凭证 `token` 表达。
 * 任何想绕过 capability 的改动，都会先在某个 api/<ns>.ts 里表现为
 * 「多了一个裸字符串路径形参」。
 */
import type { PiBuddyApi } from "./api/index.js";
import type {
  AppSettings,
  AttachmentRef,
  DraftRecord,
  PiStartParams,
  ReadImageResult,
  SecretDescriptor,
  SecretKind,
  SessionHistoryPage,
  SessionQuery,
  SessionRow,
  SessionStatus,
  SttTranscribeRequest,
  SttTranscribeResult,
  WorkspaceRef,
} from "@contract";

export type {
  AppSettings,
  AttachmentRef,
  DraftRecord,
  PiBuddyApi,
  PiStartParams,
  ReadImageResult,
  SecretDescriptor,
  SecretKind,
  SessionHistoryPage,
  SessionQuery,
  SessionRow,
  SessionStatus,
  SttTranscribeRequest,
  SttTranscribeResult,
  WorkspaceRef,
};

// 这两个从 api/ 原样透出：定义与实现同处一个文件，不可能漂移。
export type { PiStartResult } from "./api/pi.js";
export type { RendererSettingsPatch } from "./api/settings.js";

declare global {
  interface Window {
    piBuddy: PiBuddyApi;
  }
}
