import { describe, expect, it } from "vitest";
import {
  assignRecordsToItems,
  assistantKeyForToolCall,
  latestAssistantKey,
  linksFromRecords,
  mergeArtifactLinks,
  pendingChangeIdFrom,
  resolveRecordFrom,
} from "./chat-artifacts";
import type { ArtifactRecord } from "@contract";

const RECORD: ArtifactRecord = {
  id: "a-1",
  logicalKey: "notes.md",
  name: "notes.md",
  kind: "document",
  sourceSessionId: "s1",
  sourceTurnId: "t1",
  sourceToolCallId: "call-9",
  workspaceId: "w1",
  version: 1,
  sha256: "x",
  createdAt: 1,
  updatedAt: 2,
  previewPath: null,
  exportPath: "notes.md",
  status: "ready",
  deletedAt: null,
  sizeBytes: 4,
};

describe("linksFromRecords", () => {
  it("按 toolCallId 只收对应产物，失败的不要", () => {
    const failed = { ...RECORD, id: "a-2", sourceToolCallId: "call-9", status: "failed" as const };
    const other = { ...RECORD, id: "a-3", sourceToolCallId: "call-8" };
    expect(linksFromRecords([RECORD, failed, other], "call-9")).toEqual([
      { artifactId: "a-1", version: 1, name: "notes.md" },
    ]);
  });

  it("能力未启用导致空列表时不编造链接", () => {
    expect(linksFromRecords([], "call-9")).toEqual([]);
  });
});

describe("mergeArtifactLinks / latestAssistantKey", () => {
  it("同 id+version 不重复挂", () => {
    const link = { artifactId: "a-1", version: 1, name: "notes.md" };
    expect(mergeArtifactLinks([link], [link, { ...link, version: 2 }])).toEqual([
      link,
      { artifactId: "a-1", version: 2, name: "notes.md" },
    ]);
  });

  it("挂到最近一条 assistant；没有则 live-assistant", () => {
    const items = [
      { key: 1, message: { role: "user" } },
      { key: 2, message: { role: "assistant" } },
      { key: 3, message: { role: "user" } },
    ];
    expect(latestAssistantKey(items, true)).toBe(2);
    expect(latestAssistantKey([], true)).toBe("live-assistant");
  });

  it("按 toolCall 挂到发出它的那条 assistant，不堆到最后一条", () => {
    const items = [
      {
        key: 2,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-9", name: "write" }],
        },
      },
      {
        key: 4,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "后来又说了一句" }],
        },
      },
    ];
    expect(assistantKeyForToolCall(items, "call-9", false)).toBe(2);
    const assigned = assignRecordsToItems([RECORD], items);
    expect(assigned).toEqual([
      { key: 2, links: [{ artifactId: "a-1", version: 1, name: "notes.md" }] },
    ]);
  });
});

describe("resolveRecordFrom / pendingChangeIdFrom", () => {
  it("按 artifactId 锚定后再取指定 version", () => {
    const v2 = { ...RECORD, id: "a-2", version: 2, sha256: "y" };
    expect(resolveRecordFrom([RECORD, v2], "a-2", 1)?.id).toBe("a-1");
    expect(resolveRecordFrom([], "a-1", 1)).toBeNull();
  });

  it("pending 变更优先对 toolCallId，其次相对路径", () => {
    expect(
      pendingChangeIdFrom({ "tool:call-9": "cs-1", "path:notes.md": "cs-2" }, RECORD)
    ).toBe("cs-1");
    expect(pendingChangeIdFrom({ "path:notes.md": "cs-2" }, RECORD)).toBe("cs-2");
    expect(pendingChangeIdFrom({}, RECORD)).toBeNull();
  });
});
