import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * SEC-003：workspace 身份稳定性与路径收容。
 *
 * 关键路径断言（不做穷举矩阵）：
 *   1. workspaceId = sha256(canonical realpath) —— 跨「重启」必须稳定
 *   2. 六类恶意输入全部被拒
 *   3. relativePath 为空串（root 自身）放行 —— 全计划唯一口径（CT-18）
 *
 * electron 打桩：app.getPath("userData") 指向临时目录。
 */
let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() },
}));

let tmpRoot = "";
let workspaceDir = "";

/**
 * 每个用例拿一份全新的模块实例 —— 注册表在模块作用域里持有内存缓存，
 * 重新 import 正是「应用重启」在单测里最忠实的模拟。
 */
async function freshRegistry(): Promise<typeof import("../src/main/workspace-registry.js")> {
  vi.resetModules();
  return import("../src/main/workspace-registry.js");
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-ws-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "note.txt"), "hello", "utf8");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("workspaceId 由 canonical realpath 派生且跨重启稳定（裁定3）", () => {
  it("同一个目录两次注册得到同一个 id，重启后仍然相同", async () => {
    const first = await freshRegistry();
    const id1 = first.registerWorkspace(workspaceDir).workspaceId;
    // 同一进程内重复注册
    expect(first.registerWorkspace(workspaceDir).workspaceId).toBe(id1);

    // 销毁模块实例并重新 import = 应用重启
    const second = await freshRegistry();
    const id2 = second.registerWorkspace(workspaceDir).workspaceId;
    expect(id2).toBe(id1);

    // 落盘的记录与内存里的一致
    const store = JSON.parse(
      fs.readFileSync(path.join(userDataDir, "workspaces.json"), "utf8")
    ) as Record<string, { root: string }>;
    expect(Object.keys(store)).toContain(id2);
    expect(store[id2].root).toBe(fs.realpathSync.native(workspaceDir));
  });

  it("重启后即便不再调用 registerWorkspace，也能凭旧 id 解出 root", async () => {
    const first = await freshRegistry();
    const id = first.registerWorkspace(workspaceDir).workspaceId;

    const second = await freshRegistry();
    expect(second.requireWorkspaceRoot(id)).toBe(fs.realpathSync.native(workspaceDir));
  });

  it("落盘 key 被改绑到另一个 root 时拒绝载入", async () => {
    const first = await freshRegistry();
    const id = first.registerWorkspace(workspaceDir).workspaceId;
    const other = path.join(tmpRoot, "other-work");
    fs.mkdirSync(other);
    fs.writeFileSync(
      path.join(userDataDir, "workspaces.json"),
      JSON.stringify({
        [id]: { root: fs.realpathSync.native(other), registeredAt: 1 },
      }),
      "utf8"
    );

    const second = await freshRegistry();
    expect(() => second.requireWorkspaceRoot(id)).toThrow(/WORKSPACE_UNKNOWN/);
  });

  it("两个不同目录得到不同的 id", async () => {
    const reg = await freshRegistry();
    const other = path.join(tmpRoot, "work2");
    fs.mkdirSync(other);
    expect(reg.registerWorkspace(workspaceDir).workspaceId).not.toBe(
      reg.registerWorkspace(other).workspaceId
    );
  });

  it("未注册的 workspaceId 一律抛错，不静默回落到某个默认目录", async () => {
    const reg = await freshRegistry();
    expect(() => reg.requireWorkspaceRoot("deadbeef")).toThrow(/WORKSPACE_UNKNOWN/);
  });
});

describe("resolveInWorkspace：六类恶意输入全部被拒", () => {
  it("1. 绝对路径", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    await expect(
      reg.resolveInWorkspace(id, "C:/Windows/System32/drivers/etc/hosts")
    ).rejects.toThrow(/PATH_ABSOLUTE_REJECTED/);
    await expect(reg.resolveInWorkspace(id, "/etc/passwd")).rejects.toThrow(
      /PATH_ABSOLUTE_REJECTED/
    );
  });

  it("2. ../../../etc/passwd", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    await expect(reg.resolveInWorkspace(id, "../../../etc/passwd")).rejects.toThrow(
      /PATH_TRAVERSAL_REJECTED/
    );
    await expect(reg.resolveInWorkspace(id, "sub\\..\\..\\outside.txt")).rejects.toThrow(
      /PATH_TRAVERSAL_REJECTED/
    );
  });

  it("3. 指向 workspace 外目标的 symlink", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    const secret = path.join(tmpRoot, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET", "utf8");
    const link = path.join(workspaceDir, "innocent.txt");
    try {
      fs.symlinkSync(secret, link, "file");
    } catch {
      // Windows 上没开开发者模式就建不了符号链接；此时跳过而不是假装通过
      return;
    }
    // 名字完全正常、也确实躺在 workspace 里，但 realpath 之后落在外面
    await expect(reg.resolveInWorkspace(id, "innocent.txt")).rejects.toThrow(
      /PATH_ESCAPES_WORKSPACE/
    );
  });

  it("4. 兄弟目录名恰好以 root 开头 —— 字符串前缀判定会误放行", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    // <tmp>/work 与 <tmp>/work-evil："work-evil".startsWith("work") 为真
    const evil = `${workspaceDir}-evil`;
    fs.mkdirSync(evil);
    fs.writeFileSync(path.join(evil, "loot.txt"), "x", "utf8");
    const root = reg.requireWorkspaceRoot(id);
    expect(`${root}-evil`.startsWith(root)).toBe(true);
    await expect(reg.assertContained(root, path.join(evil, "loot.txt"))).rejects.toThrow(
      /PATH_ESCAPES_ROOT/
    );
  });

  it("5. 目录被当成文件用时（requireFile）被拒", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    fs.mkdirSync(path.join(workspaceDir, "sub"));
    await expect(
      reg.resolveInWorkspace(id, "sub", { requireFile: true })
    ).rejects.toThrow(/PATH_NOT_A_FILE/);
  });

  it("6. 不存在的目标被拒（realpath 失败）", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    await expect(reg.resolveInWorkspace(id, "nope.txt")).rejects.toThrow();
  });
});

describe("放行语义（CT-18 · 全计划唯一口径）", () => {
  it("relativePath 为空串即 workspace root 自身 —— 返回成功而非拒绝", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    const resolved = await reg.resolveInWorkspace(id, "");
    expect(resolved.relativePath).toBe("");
    expect(resolved.isDirectory).toBe(true);
    expect(resolved.realPath).toBe(fs.realpathSync.native(workspaceDir));
  });

  it("workspace 内的普通文件放行，并带回 size 与类型", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    const resolved = await reg.resolveInWorkspace(id, "note.txt", { requireFile: true });
    expect(resolved.isFile).toBe(true);
    expect(resolved.size).toBe(5);
    expect(resolved.relativePath).toBe("note.txt");
  });

  it("子目录里的文件放行", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    fs.mkdirSync(path.join(workspaceDir, "sub"));
    fs.writeFileSync(path.join(workspaceDir, "sub", "a.txt"), "ok", "utf8");
    const resolved = await reg.resolveInWorkspace(id, "sub/a.txt", { requireFile: true });
    expect(resolved.isFile).toBe(true);
  });
});

/**
 * TASK-015 追加：FS-101 让「解析工作区里的一条路径」变成一个每次列目录、
 * 每次保存都要走的高频动作，因此这几条边界必须在同一个 spec 里钉住 ——
 * 收容原语全计划只有 resolveInWorkspace 一个实现（CT-18），它的判定漂了，
 * 文件树、编辑器、搜索、变更集会一起漂。
 */
describe("CT-18 追加：junction 与含中文空格的合法路径", () => {
  it("Windows junction 指向工作区外时被拒（realpath 会穿透 junction）", async () => {
    if (process.platform !== "win32") return;
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;

    const outside = path.join(tmpRoot, "outside-dir");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "loot.txt"), "x", "utf8");

    const junction = path.join(workspaceDir, "linked");
    try {
      fs.symlinkSync(outside, junction, "junction");
    } catch {
      // 建不了 junction 就跳过，而不是假装通过
      return;
    }
    await expect(reg.resolveInWorkspace(id, "linked/loot.txt")).rejects.toThrow(
      /PATH_ESCAPES_WORKSPACE/
    );
  });

  it("路径里含中文与空格的合法文件照常放行", async () => {
    const reg = await freshRegistry();
    const id = reg.registerWorkspace(workspaceDir).workspaceId;
    const dir = path.join(workspaceDir, "我的 文档");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "读我 说明.txt"), "ok", "utf8");

    const resolved = await reg.resolveInWorkspace(id, "我的 文档/读我 说明.txt", {
      requireFile: true,
    });
    expect(resolved.isFile).toBe(true);
    expect(resolved.relativePath.split("\\").join("/")).toBe("我的 文档/读我 说明.txt");
  });
});
