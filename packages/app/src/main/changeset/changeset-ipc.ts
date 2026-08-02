/**
 * Agent 变更集的 IPC handler（FS-102）——**恰 4 条通道**。
 *
 * 四条都以不透明的 changeset id 为入参：写什么内容、写到哪个文件全部由
 * 主进程按 id 查出来。渲染进程在结构上表达不出「把这段内容写到那个路径」，
 * 因此「变更审阅」这个界面本身不会变成一条通用写文件旁路。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 */
import {
  CHANNELS,
  changesetBatchRequestSchema,
  changesetIdRequestSchema,
  changesetQueryRequestSchema,
  type ChangesetQueryResult,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { acceptBatch, acceptChange, rejectChange } from "./apply.js";
import { changesetStore, diffOf, toChangesetEntry } from "./changeset-store.js";

/** 本域注册的全部通道。单测据它断言注册面。 */
export const CHANGESET_CHANNELS: InvokeChannel[] = [
  CHANNELS.changesetQuery,
  CHANNELS.changesetAccept,
  CHANNELS.changesetReject,
  CHANNELS.changesetAcceptBatch,
];

export function registerChangesetIpc(): void {
  registerHandler(
    CHANNELS.changesetQuery,
    changesetQueryRequestSchema,
    (payload): ChangesetQueryResult => {
      const records = changesetStore().list(payload);
      return {
        entries: records.map(toChangesetEntry),
        // diff 与条目一起下发：分两次取的话，列表已经渲染出来而 diff 还在
        // 路上，用户会看到一排「正在加载差异」然后其中几条永远转圈。
        diffs: records.map(diffOf),
      };
    }
  );

  registerHandler(CHANNELS.changesetAccept, changesetIdRequestSchema, (payload) =>
    acceptChange(payload.id, payload.hunkIndexes)
  );

  registerHandler(CHANNELS.changesetReject, changesetIdRequestSchema, (payload) =>
    rejectChange(payload.id)
  );

  registerHandler(CHANNELS.changesetAcceptBatch, changesetBatchRequestSchema, (payload) =>
    acceptBatch(payload.ids)
  );
}
