/**
 * 项目列表（workspace:list 的数据面）：listWorkspaces / touchWorkspace。
 *
 * 钉住三件事：注册 ≠ 打开（lastOpenedAt 只由 touch 推进）；排序以最近打开
 * 优先、从未打开的按注册时间倒序；目录被删后重新载入即从列表消失。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
}));

let registry: typeof import("./workspace-registry.js");
let userDataDir = "";
let dirA = "";
let dirB = "";

beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-ws-list-"));
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-ws-a-"));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-ws-b-"));
  registry = await import("./workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
});

afterEach(() => {
  registry.__setWorkspaceDataDir(null);
  for (const d of [userDataDir, dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
});

describe("listWorkspaces / touchWorkspace", () => {
  it("注册不算打开；touch 之后最近打开的排最前", () => {
    const a = registry.registerWorkspace(dirA);
    const b = registry.registerWorkspace(dirB);
    expect(a.lastOpenedAt).toBe(0);

    // 都没打开过：按注册时间倒序（B 后注册，排前）
    let ids = registry.listWorkspaces().map((r) => r.workspaceId);
    expect(ids.indexOf(b.workspaceId)).toBeLessThan(ids.indexOf(a.workspaceId));

    registry.touchWorkspace(a.workspaceId);
    ids = registry.listWorkspaces().map((r) => r.workspaceId);
    expect(ids[0]).toBe(a.workspaceId);
    expect(registry.lookupWorkspace(a.workspaceId)!.lastOpenedAt).toBeGreaterThan(0);
  });

  it("lastOpenedAt 跨重启保留；目录已删的条目重新载入后不再出现", () => {
    const a = registry.registerWorkspace(dirA);
    const b = registry.registerWorkspace(dirB);
    registry.touchWorkspace(a.workspaceId);
    const stamp = registry.lookupWorkspace(a.workspaceId)!.lastOpenedAt;

    fs.rmSync(dirB, { recursive: true, force: true });
    // 清缓存 = 模拟重启后首次载入
    registry.__setWorkspaceDataDir(userDataDir);

    const list = registry.listWorkspaces();
    expect(list.map((r) => r.workspaceId)).toEqual([a.workspaceId]);
    expect(list[0].lastOpenedAt).toBe(stamp);
    expect(registry.lookupWorkspace(b.workspaceId)).toBeNull();
  });

  it("touch 未注册的 id 是空操作", () => {
    expect(() => registry.touchWorkspace("nope")).not.toThrow();
    expect(registry.listWorkspaces()).toEqual([]);
  });
});
