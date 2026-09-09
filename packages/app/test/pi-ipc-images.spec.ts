import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_TOTAL_ATTACHMENT_BYTES,
  MAX_PROMPT_TOTAL_IMAGE_BYTES,
} from "@pibuddy/contract";
import {
  appendPromptAttachmentManifest,
  resolvePromptAttachments,
  shouldRevokeAttachmentsAfterSessionChange,
  validateInlineImages,
} from "../src/main/pi/pi-ipc.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF = Buffer.from("GIF89a");
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const BMP = Buffer.from([0x42, 0x4d, 0, 0]);

function inline(buffer: Buffer, mimeType = "image/png") {
  return { type: "image" as const, data: buffer.toString("base64"), mimeType };
}

function sizedPng(bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes);
  PNG.copy(buffer);
  return buffer;
}

describe("pi IPC inline image validation", () => {
  it("accepts PNG/JPEG/GIF/WebP/BMP magic bytes when declared MIME matches", () => {
    const images = [
      inline(PNG),
      inline(JPEG, "image/jpeg"),
      inline(GIF, "image/gif"),
      inline(WEBP, "image/webp"),
      inline(BMP, "image/bmp"),
    ];
    expect(validateInlineImages(images)).toEqual(images);
  });

  it("rejects invalid magic bytes and declared MIME mismatches", () => {
    expect(() => validateInlineImages([inline(Buffer.from("not an image"))])).toThrow(
      /PI_IMAGE_MAGIC_INVALID/
    );
    expect(() => validateInlineImages([inline(JPEG, "image/png")])).toThrow(
      /PI_IMAGE_MIME_MISMATCH/
    );
  });

  it("rejects malformed base64 before forwarding", () => {
    expect(() =>
      validateInlineImages([{ type: "image", data: "%%%=", mimeType: "image/png" }])
    ).toThrow(/PI_IMAGE_BASE64_INVALID/);
  });

  it("rejects non-canonical base64 (trailing bits set) even when it decodes", () => {
    // "QQ==" 与 "QR==" 都解码成同一个字节 0x41，但后者最后一块的尾随位非零，
    // 不是该字节序列的规范 base64 写法 —— 必须拒收，防止同一负载多重表示。
    expect(() =>
      validateInlineImages([{ type: "image", data: "QR==", mimeType: "image/png" }])
    ).toThrow(/PI_IMAGE_BASE64_INVALID/);
  });

  it("enforces decoded per-image and total image byte limits", () => {
    expect(() => validateInlineImages([inline(sizedPng(MAX_PROMPT_IMAGE_BYTES + 1))])).toThrow(
      /PI_IMAGE_TOO_LARGE/
    );

    const halfPlusOne = Math.floor(MAX_PROMPT_TOTAL_IMAGE_BYTES / 2) + 1;
    expect(() =>
      validateInlineImages([inline(sizedPng(halfPlusOne)), inline(sizedPng(halfPlusOne))])
    ).toThrow(/PI_IMAGE_TOTAL_TOO_LARGE/);
  });
});

describe("pi prompt attachment validation", () => {
  function snapshot(size: number, token = "token") {
    return {
      token,
      sourceLabel: `${token}.txt`,
      sourceName: `${token}.txt`,
      relativePath: `${token}.txt`,
      mimeType: "text/plain",
      size,
      sha256: "abc",
      snapshotPath: `/app-temp/${token}/${token}.txt`,
    };
  }

  it("starts resolution for the complete token set before rejecting one invalid token", async () => {
    const resolve = vi.fn(async (token: string) => {
      if (token === "bad") throw new Error("ATTACHMENT_TOKEN_INVALID");
      return snapshot(1, token);
    });

    await expect(resolvePromptAttachments(["bad", "good"], resolve)).rejects.toThrow(
      /ATTACHMENT_TOKEN_INVALID/
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenNthCalledWith(1, "bad");
    expect(resolve).toHaveBeenNthCalledWith(2, "good");
  });

  it("enforces per-file and aggregate attachment bytes after resolution", async () => {
    await expect(
      resolvePromptAttachments(["large"], async () =>
        snapshot(MAX_PROMPT_ATTACHMENT_BYTES + 1, "large")
      )
    ).rejects.toThrow(/PI_ATTACHMENT_TOO_LARGE/);

    const halfPlusOne = Math.floor(MAX_PROMPT_TOTAL_ATTACHMENT_BYTES / 2) + 1;
    await expect(
      resolvePromptAttachments(["a", "b"], async (token) => snapshot(halfPlusOne, token))
    ).rejects.toThrow(/PI_ATTACHMENT_TOTAL_TOO_LARGE/);
  });

  it("computes aggregate limits from stable snapshot sizes", async () => {
    const sizes = new Map([
      ["a", Math.floor(MAX_PROMPT_TOTAL_ATTACHMENT_BYTES / 2)],
      ["b", Math.floor(MAX_PROMPT_TOTAL_ATTACHMENT_BYTES / 2)],
    ]);
    const resolved = await resolvePromptAttachments(["a", "b"], async (token) =>
      snapshot(sizes.get(token)!, token)
    );
    expect(resolved.map((item) => item.size)).toEqual([...sizes.values()]);
  });

  it("manifest labels the original relative name but sends only the app snapshot path", () => {
    const originalWorkspacePath = "C:\\Users\\alice\\secret-workspace\\reports\\q1.txt";
    const item = snapshot(12, "q1");
    item.sourceLabel = "reports/q1.txt";
    item.snapshotPath = "C:\\Temp\\pibuddy-prompt-attachments\\token\\q1.txt";

    const message = appendPromptAttachmentManifest("summarize", [item]);
    expect(message).toContain("reports/q1.txt");
    expect(message).toContain(item.snapshotPath);
    expect(message).not.toContain(originalWorkspacePath);
    expect(message).not.toContain("secret-workspace");
  });
});

describe("session attachment revocation semantics", () => {
  it("does not revoke on extension veto and revokes only on an effective success", () => {
    expect(
      shouldRevokeAttachmentsAfterSessionChange({ success: true, data: { cancelled: true } })
    ).toBe(false);
    expect(
      shouldRevokeAttachmentsAfterSessionChange({ success: true, data: { cancelled: false } })
    ).toBe(true);
    expect(shouldRevokeAttachmentsAfterSessionChange({ success: true })).toBe(true);
    expect(shouldRevokeAttachmentsAfterSessionChange({ success: false })).toBe(false);
  });
});
