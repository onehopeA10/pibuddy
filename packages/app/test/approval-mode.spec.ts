import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseApprovalStatus } from "@pibuddy/contract";
import {
  APPROVAL_RELOAD_COMMAND,
  APPROVAL_SETTINGS_RELATIVE_PATH,
  approvalModeFromStatuses,
  approvalSettingsPath,
  writeApprovalMode,
} from "../src/main/pi/approval-mode.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-approval-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("parseApprovalStatus", () => {
  it("YOLO 对应 bypassPermissions，APPROVAL <mode> 对应枚举", () => {
    expect(parseApprovalStatus("YOLO")).toBe("bypassPermissions");
    expect(parseApprovalStatus("  YOLO  ")).toBe("bypassPermissions");
    expect(parseApprovalStatus("APPROVAL default")).toBe("default");
    expect(parseApprovalStatus("APPROVAL acceptEdits")).toBe("acceptEdits");
    expect(parseApprovalStatus("APPROVAL dontAsk")).toBe("dontAsk");
  });

  it("空、未知、plan 这种扩展不暴露的字都读不出", () => {
    expect(parseApprovalStatus(undefined)).toBeUndefined();
    expect(parseApprovalStatus("")).toBeUndefined();
    expect(parseApprovalStatus("APPROVAL plan")).toBeUndefined();
    expect(parseApprovalStatus("AUTO")).toBeUndefined();
  });
});

describe("approvalModeFromStatuses", () => {
  it("没有 approval-mode 这条状态 = 扩展不在场", () => {
    expect(approvalModeFromStatuses([])).toBeNull();
    expect(approvalModeFromStatuses([{ key: "other", text: "YOLO" }])).toBeNull();
  });

  it("在场时按文本解析", () => {
    expect(approvalModeFromStatuses([{ key: "approval-mode", text: "YOLO" }])).toBe(
      "bypassPermissions"
    );
    expect(approvalModeFromStatuses([{ key: "approval-mode", text: "" }])).toBeUndefined();
  });
});

describe("writeApprovalMode", () => {
  it("文件不存在时新建，只写 permissions.defaultMode", () => {
    const root = tmpDir();
    const file = writeApprovalMode(root, "default");
    expect(file).toBe(approvalSettingsPath(root));
    expect(path.relative(root, file)).toBe(APPROVAL_SETTINGS_RELATIVE_PATH);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      permissions: { defaultMode: "default" },
    });
  });

  it("已有 allow / deny 时只改 defaultMode，其余原样留下", () => {
    const root = tmpDir();
    const file = approvalSettingsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ theme: "dark", permissions: { allow: ["Bash"], deny: ["Web"] } }, null, 2)
    );
    writeApprovalMode(root, "acceptEdits");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      theme: "dark",
      permissions: { allow: ["Bash"], deny: ["Web"], defaultMode: "acceptEdits" },
    });
  });

  it("顶层不是对象时拒绝覆盖", () => {
    const root = tmpDir();
    const file = approvalSettingsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "[]\n");
    expect(() => writeApprovalMode(root, "default")).toThrow(/顶层不是对象/);
    expect(fs.readFileSync(file, "utf8")).toBe("[]\n");
  });

  it("reload 命令必须仍以 / 开头，否则 pi 会当普通提示词发出去", () => {
    expect(APPROVAL_RELOAD_COMMAND.startsWith("/")).toBe(true);
    expect(APPROVAL_RELOAD_COMMAND).toBe("/permissions reload");
  });
});
