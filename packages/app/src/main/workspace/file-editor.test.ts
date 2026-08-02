import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * FS-101 编辑器的关键路径：编码/换行探测，以及 mtime + content hash 的
 * 冲突判定。
 *
 * 不做穷举矩阵 —— 只钉三件真会让用户丢东西的事：
 *   1. 内容变了必须拦（拦下时磁盘字节一个都不能动）；
 *   2. 只有 mtime 变了不能拦（误报会训练用户闭眼点覆盖）；
 *   3. 写失败要分类报（权限 / 磁盘满各有各的处置方式）。
 */
let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn(), trashItem: vi.fn(async () => {}) },
}));

let tmpRoot = "";
let workspaceDir = "";
let workspaceId = "";

type Editor = typeof import("./file-editor.js");
type Registry = typeof import("../workspace-registry.js");

async function freshModules(): Promise<{ editor: Editor; registry: Registry }> {
  vi.resetModules();
  const registry = await import("../workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
  workspaceId = registry.registerWorkspace(workspaceDir).workspaceId;
  const editor = await import("./file-editor.js");
  return { editor, registry };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-editor-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("编码与换行探测", () => {
  it("BOM / 无 BOM UTF-8 / GBK 三种样本各自判对", async () => {
    const { editor } = await freshModules();
    const utf8 = Buffer.from("你好 hello", "utf8");
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
    // GBK 的「你好」：C4 E3 BA C3，不是合法的 UTF-8 序列
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);

    expect(editor.detectEncoding(bom)).toBe("utf8-bom");
    expect(editor.detectEncoding(utf8)).toBe("utf8");
    expect(editor.detectEncoding(gbk)).toBe("gbk");
  });

  it("CRLF 文件保存之后落盘仍然是 CRLF（不存在裸 LF 行尾）", async () => {
    const { editor } = await freshModules();
    const file = path.join(workspaceDir, "crlf.txt");
    fs.writeFileSync(file, "a\r\nb\r\nc\r\n", "utf8");

    const read = await editor.readFile({ workspaceId, relativePath: "crlf.txt" });
    expect(read.newline).toBe("crlf");
    // 交给编辑器的内容是归一成 LF 的
    expect(read.content).toBe("a\nb\nc\n");

    const saved = await editor.saveFile({
      workspaceId,
      relativePath: "crlf.txt",
      content: `${read.content}d\n`,
      baseMtimeMs: read.mtimeMs,
      baseSha256: read.sha256,
    });
    expect(saved.ok).toBe(true);

    const onDisk = fs.readFileSync(file, "utf8");
    expect(
      onDisk
        .split("\n")
        .slice(0, -1)
        .every((line) => line.endsWith("\r"))
    ).toBe(true);
  });
});

describe("保存冲突：唯一判据是内容 hash", () => {
  it("base 全部匹配时写入成功", async () => {
    const { editor } = await freshModules();
    const file = path.join(workspaceDir, "note.txt");
    fs.writeFileSync(file, "one\n", "utf8");
    const read = await editor.readFile({ workspaceId, relativePath: "note.txt" });

    const saved = await editor.saveFile({
      workspaceId,
      relativePath: "note.txt",
      content: "two\n",
      baseMtimeMs: read.mtimeMs,
      baseSha256: read.sha256,
    });
    expect(saved.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("two\n");
  });

  it("只有 mtime 变了、内容 hash 没变时照常写入（不误报）", async () => {
    const { editor } = await freshModules();
    const file = path.join(workspaceDir, "note.txt");
    fs.writeFileSync(file, "one\n", "utf8");
    const read = await editor.readFile({ workspaceId, relativePath: "note.txt" });

    // 原样重写一遍：mtime 变了，字节没变
    fs.writeFileSync(file, "one\n", "utf8");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(file, future, future);

    const saved = await editor.saveFile({
      workspaceId,
      relativePath: "note.txt",
      content: "two\n",
      baseMtimeMs: read.mtimeMs,
      baseSha256: read.sha256,
    });
    expect(saved.ok).toBe(true);
    expect(saved.conflict).toBeUndefined();
  });

  it("内容 hash 变了：返回 conflict 且目标文件字节一个都没动", async () => {
    const { editor } = await freshModules();
    const file = path.join(workspaceDir, "note.txt");
    fs.writeFileSync(file, "one\n", "utf8");
    const read = await editor.readFile({ workspaceId, relativePath: "note.txt" });

    // 外部编辑器改了同一个文件
    fs.writeFileSync(file, "外部改动\n", "utf8");
    const bytesBefore = fs.readFileSync(file);

    const saved = await editor.saveFile({
      workspaceId,
      relativePath: "note.txt",
      content: "我的改动\n",
      baseMtimeMs: read.mtimeMs,
      baseSha256: read.sha256,
    });
    expect(saved.conflict).toBe(true);
    expect(saved.ok).toBe(false);
    expect(saved.current?.preview).toContain("外部改动");
    expect(fs.readFileSync(file).equals(bytesBefore)).toBe(true);
  });

  it("用户点「覆盖」之后才真的写盘", async () => {
    const { editor } = await freshModules();
    const file = path.join(workspaceDir, "note.txt");
    fs.writeFileSync(file, "one\n", "utf8");
    const read = await editor.readFile({ workspaceId, relativePath: "note.txt" });
    fs.writeFileSync(file, "外部改动\n", "utf8");

    const saved = await editor.saveFile({
      workspaceId,
      relativePath: "note.txt",
      content: "我的改动\n",
      baseMtimeMs: read.mtimeMs,
      baseSha256: read.sha256,
      overwrite: true,
    });
    expect(saved.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("我的改动\n");
  });
});

describe("写失败的分类", () => {
  it("权限不足返回 errorCode='permission'，不抛未捕获异常", async () => {
    const { editor } = await freshModules();
    const file = path.join(workspaceDir, "ro.txt");
    fs.writeFileSync(file, "one\n", "utf8");
    const read = await editor.readFile({ workspaceId, relativePath: "ro.txt" });

    editor.__setFileWriter(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    try {
      const saved = await editor.saveFile({
        workspaceId,
        relativePath: "ro.txt",
        content: "two\n",
        baseMtimeMs: read.mtimeMs,
        baseSha256: read.sha256,
      });
      expect(saved.ok).toBe(false);
      expect(saved.errorCode).toBe("permission");
    } finally {
      editor.__setFileWriter(null);
    }
  });

  it("磁盘满（ENOSPC）返回 errorCode='disk'", async () => {
    const { editor } = await freshModules();
    const file = path.join(workspaceDir, "full.txt");
    fs.writeFileSync(file, "one\n", "utf8");
    const read = await editor.readFile({ workspaceId, relativePath: "full.txt" });

    editor.__setFileWriter(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    try {
      const saved = await editor.saveFile({
        workspaceId,
        relativePath: "full.txt",
        content: "two\n",
        baseMtimeMs: read.mtimeMs,
        baseSha256: read.sha256,
      });
      expect(saved.ok).toBe(false);
      expect(saved.errorCode).toBe("disk");
      // 报错要说人话，不能把 errno 原样甩给用户
      expect(saved.message).toContain("磁盘空间不足");
    } finally {
      editor.__setFileWriter(null);
    }
  });
});
