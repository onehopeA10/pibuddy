import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * SEC-003 / 裁定2：附件能力凭证。
 *
 * 关键路径断言：
 *   1. TTL 30 分钟**滑动**过期：29 分钟访问一次、50 分钟再访问仍成功；
 *      静置 31 分钟失败（判据是「距最后一次使用」，不是「距签发」）
 *   2. revokeAll / revokeAllForSession 后既有凭证一律失效
 *   3. 扩展名为 .png 但首字节是 PE 头（MZ）的文件被 magic bytes 拒掉
 *   4. 超过 MAX_IMAGE_BYTES 的文件被拒
 */
let userDataDir = "";
const openPath = vi.fn(async () => "");
const showItemInFolder = vi.fn();

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { openPath, showItemInFolder },
}));

let tmpRoot = "";
let workspaceDir = "";

type Registry = typeof import("../src/main/attachment-registry.js");
type WsRegistry = typeof import("../src/main/workspace-registry.js");

async function freshModules(): Promise<{ reg: Registry; ws: WsRegistry }> {
  vi.resetModules();
  const ws = await import("../src/main/workspace-registry.js");
  const reg = await import("../src/main/attachment-registry.js");
  return { reg, ws };
}

/** 写一个字节上合法的最小 PNG（只需要头部通过嗅探）。 */
function writePng(filePath: string, padding = 0): void {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(filePath, Buffer.concat([head, Buffer.alloc(padding)]));
}

beforeEach(() => {
  openPath.mockClear();
  showItemInFolder.mockClear();
  // realpath 归一化：GitHub 的 windows runner 上 `os.tmpdir()` 返回 8.3 短路径
  // （`C:\Users\RUNNER~1\AppData\Local\Temp`），而 attachment-registry 内部对
  // 每个文件都做 `fsp.realpath`，拿到的是长路径（`…\runneradmin\…`）。两者
  // 逐字符不等，于是 `toHaveBeenCalledWith(fs.realpathSync(file))` 与
  // `resolve()` 里那条「realpath 与签发时记的不一致」的自检双双失败 ——
  // 本机绿、CI 红，且报错内容完全看不出是路径形态问题。
  // 在源头把根目录折成 realpath，两侧就永远是同一种形态。
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-att-")));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("TTL 30 分钟滑动过期（裁定2）", () => {
  it("常量就是 1800000ms", async () => {
    const { reg } = await freshModules();
    expect(reg.ATTACHMENT_TTL_MS).toBe(1800000);
  });

  it("第 29 分钟访问一次、第 50 分钟再访问 —— 两次都成功", async () => {
    const { reg } = await freshModules();
    const file = path.join(workspaceDir, "a.png");
    writePng(file);

    const t0 = 1_000_000_000;
    const { token } = await reg.issue(file, { now: t0 });

    const at29 = t0 + 29 * 60_000;
    await expect(reg.resolveAttachment(token, { now: at29 })).resolves.toBeTruthy();

    // 距签发已 50 分钟（> TTL），但距上一次访问只有 21 分钟 → 仍然有效
    const at50 = t0 + 50 * 60_000;
    await expect(reg.resolveAttachment(token, { now: at50 })).resolves.toBeTruthy();
  });

  it("签发后静置 31 分钟 → 失效", async () => {
    const { reg } = await freshModules();
    const file = path.join(workspaceDir, "a.png");
    writePng(file);

    const t0 = 1_000_000_000;
    const { token } = await reg.issue(file, { now: t0 });
    await expect(reg.resolveAttachment(token, { now: t0 + 31 * 60_000 })).rejects.toThrow(
      /ATTACHMENT_TOKEN_(EXPIRED|INVALID)/
    );
  });
});

describe("撤销", () => {
  it("revokeAll() 后既有 token 一律 resolve 失败", async () => {
    const { reg } = await freshModules();
    const f1 = path.join(workspaceDir, "a.png");
    const f2 = path.join(workspaceDir, "b.png");
    writePng(f1);
    writePng(f2);
    const t1 = (await reg.issue(f1)).token;
    const t2 = (await reg.issue(f2)).token;
    expect(reg.outstandingCount()).toBe(2);

    expect(reg.revokeAll()).toBe(2);
    expect(reg.outstandingCount()).toBe(0);
    await expect(reg.resolveAttachment(t1)).rejects.toThrow(/ATTACHMENT_TOKEN_INVALID/);
    await expect(reg.resolveAttachment(t2)).rejects.toThrow(/ATTACHMENT_TOKEN_INVALID/);
  });

  it("revokeAllForSession 只撤销该会话的凭证", async () => {
    const { reg } = await freshModules();
    const f1 = path.join(workspaceDir, "a.png");
    const f2 = path.join(workspaceDir, "b.png");
    writePng(f1);
    writePng(f2);
    const mine = (await reg.issue(f1, { sessionId: "s1" })).token;
    const other = (await reg.issue(f2, { sessionId: "s2" })).token;

    expect(reg.revokeAllForSession("s1")).toBe(1);
    await expect(reg.resolveAttachment(mine)).rejects.toThrow(/ATTACHMENT_TOKEN_INVALID/);
    await expect(reg.resolveAttachment(other)).resolves.toBeTruthy();
  });
});

describe("magic bytes 嗅探", () => {
  it("扩展名 .png 但首字节是 MZ 的 PE 文件被拒", async () => {
    const { reg } = await freshModules();
    const fake = path.join(workspaceDir, "payload.png");
    // 'M' 'Z' —— Windows PE 可执行文件头
    fs.writeFileSync(fake, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]));

    const { token } = await reg.issue(fake);
    // 扩展名查表会放行（kind 判定为 image），字节不会
    await expect(reg.readImage(token)).rejects.toThrow(/ATTACHMENT_NOT_AN_IMAGE/);
  });

  it("真 PNG 通过，且返回的 mimeType 取自字节而非扩展名", async () => {
    const { reg } = await freshModules();
    // 故意起一个 .jpg 的名字，内容却是 PNG
    const file = path.join(workspaceDir, "mislabeled.jpg");
    writePng(file, 16);
    const { token } = await reg.issue(file);
    const image = await reg.readImage(token);
    expect(image.mimeType).toBe("image/png");
    expect(image.data.length).toBeGreaterThan(0);
  });

  it("sniffImageMime 认得五种格式，认不得别的", async () => {
    const { reg } = await freshModules();
    expect(reg.sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png"
    );
    expect(reg.sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(reg.sniffImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(
      "image/gif"
    );
    expect(reg.sniffImageMime(Buffer.from([0x42, 0x4d, 0x00, 0x00]))).toBe("image/bmp");
    expect(
      reg.sniffImageMime(
        Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])
      )
    ).toBe("image/webp");
    expect(reg.sniffImageMime(Buffer.from([0x4d, 0x5a]))).toBe(null);
  });
});

describe("大小与收容", () => {
  it("超过 MAX_IMAGE_BYTES 的文件被拒", async () => {
    const { reg } = await freshModules();
    const big = path.join(workspaceDir, "big.png");
    writePng(big, reg.MAX_IMAGE_BYTES + 1);
    const { token } = await reg.issue(big);
    await expect(reg.readImage(token)).rejects.toThrow(/ATTACHMENT_TOO_LARGE/);
  });

  it("绑定 workspace 的凭证：签发时就拒掉 workspace 之外的文件", async () => {
    const { reg, ws } = await freshModules();
    const id = ws.registerWorkspace(workspaceDir).workspaceId;
    const outside = path.join(tmpRoot, "outside.png");
    writePng(outside);
    await expect(reg.issue(outside, { workspaceId: id })).rejects.toThrow(
      /PATH_ESCAPES_ROOT/
    );
  });

  it("openAttachment / revealAttachment 只接受凭证，且是唯一触达 shell 的路径", async () => {
    const { reg } = await freshModules();
    const file = path.join(workspaceDir, "a.png");
    writePng(file);
    const { token } = await reg.issue(file);

    // 期望值必须用 realpathSync.native —— 实现走的就是 native 版。
    // 词法版在 Windows 上不展开 8.3 短名，于是同一个文件算出两个字符串，
    // 在短名路径的机器上这条断言必红（CI runner 正是这种路径）。
    const canonical = fs.realpathSync.native(file);

    await reg.openAttachment(token);
    expect(openPath).toHaveBeenCalledWith(canonical);

    await reg.revealAttachment(token);
    expect(showItemInFolder).toHaveBeenCalledWith(canonical);

    await expect(reg.openAttachment("not-a-token")).rejects.toThrow(
      /ATTACHMENT_TOKEN_INVALID/
    );
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it("能力被限定时，越权兑付被拒", async () => {
    const { reg } = await freshModules();
    const file = path.join(workspaceDir, "a.png");
    writePng(file);
    const { token } = await reg.issue(file, { capabilities: ["read"] });
    await expect(reg.openAttachment(token)).rejects.toThrow(
      /ATTACHMENT_CAPABILITY_DENIED/
    );
  });
});

describe("结构化附件引用（裁定2 · FS-101）", () => {
  it("createAttachment 恰好返回八个字段，标识字段名是 token", async () => {
    const { reg, ws } = await freshModules();
    ws.__setWorkspaceDataDir(userDataDir);
    const workspaceId = ws.registerWorkspace(workspaceDir).workspaceId;
    const file = path.join(workspaceDir, "doc.md");
    fs.writeFileSync(file, "# hi" + String.fromCharCode(10), "utf8");

    const result = await reg.createAttachment(file, { workspaceId });
    expect(Object.keys(result).sort()).toEqual(
      [
        "capability",
        "expiresAt",
        "mimeType",
        "relativePath",
        "sha256",
        "sizeBytes",
        "sourceName",
        "token",
      ].sort()
    );
    // 标识恒为 token —— 全计划统一称谓，没有 id，也没有 attachmentId
    expect(typeof result.token).toBe("string");
    expect(result.relativePath).toBe("doc.md");
    expect(result.mimeType).toBe("text/markdown");
    expect(result.capability).toBe("read");
    // 结构化引用里没有任何字段承载绝对路径
    expect(JSON.stringify(result)).not.toContain(ws.requireWorkspaceRoot(workspaceId));
  });

  it("capability='read' 的凭证用于写请求时被拒，'read-write' 放行", async () => {
    const { reg, ws } = await freshModules();
    ws.__setWorkspaceDataDir(userDataDir);
    const workspaceId = ws.registerWorkspace(workspaceDir).workspaceId;
    const file = path.join(workspaceDir, "doc.md");
    fs.writeFileSync(file, "# hi" + String.fromCharCode(10), "utf8");

    const readOnly = await reg.createAttachment(file, { workspaceId });
    // 只签发不校验的能力字段等于没有能力控制，而且不会有任何报错
    await expect(
      reg.resolveAttachment(readOnly.token, { access: "read-write" })
    ).rejects.toThrow(/ATTACHMENT_ACCESS_DENIED/);
    // 读请求照常放行
    await expect(reg.resolveAttachment(readOnly.token)).resolves.toBeTruthy();

    const writable = await reg.createAttachment(file, {
      workspaceId,
      access: "read-write",
    });
    await expect(
      reg.resolveAttachment(writable.token, { access: "read-write" })
    ).resolves.toBeTruthy();
  });

  it("刚签发的 token 可直接被后续 handler 解析（CT-17：预览与附件同一句柄）", async () => {
    const { reg, ws } = await freshModules();
    ws.__setWorkspaceDataDir(userDataDir);
    const workspaceId = ws.registerWorkspace(workspaceDir).workspaceId;
    const file = path.join(workspaceDir, "doc.md");
    fs.writeFileSync(file, "# hi" + String.fromCharCode(10), "utf8");

    const descriptor = await reg.createAttachment(file, { workspaceId });
    const record = await reg.resolveAttachment(descriptor.token, { capability: "open" });
    expect(record.token).toBe(descriptor.token);
    expect(record.sha256).toBe(descriptor.sha256);
  });
});
