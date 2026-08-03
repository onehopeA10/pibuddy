import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * tool-watch 的快照必须是**字节**。
 *
 * 这里是整条损坏链路的源头：start 时用 utf8 读一份 PNG，非法序列在那一行
 * 就变成了 U+FFFD，原字节再也取不回来；end 时 record() 又拿这份坏掉的
 * before 把磁盘「还原」一遍 —— 于是用户还没看见审阅面板，文件已经打不开了，
 * 而且接受、拒绝都救不回来。
 *
 * 测试走完整的 start → 工具落盘 → end，断言磁盘与入库内容都是逐字节的原样。
 */
let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: {
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => {}),
  },
}));

let tmpRoot = "";
let workspaceDir = "";
let workspaceId = "";

type Store = typeof import("./changeset-store.js");
type Watch = typeof import("./tool-watch.js");
type Artifacts = typeof import("../artifacts/artifact-store.js");

const opened: { store: Store | null; artifacts: Artifacts | null } = {
  store: null,
  artifacts: null,
};

async function freshModules(): Promise<{ store: Store; watch: Watch }> {
  vi.resetModules();
  const registry = await import("../workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
  workspaceId = registry.registerWorkspace(workspaceDir).workspaceId;
  const store = await import("./changeset-store.js");
  store.__setChangesetDataDir(userDataDir);
  // tool-watch 顺带往产物库插 generating（ART-102），它会开一个 sqlite 句柄。
  // 不关掉的话 Windows 上 afterEach 的 rmSync 会 EPERM —— 那不是被测行为，
  // 但也不该用 try/catch 盖住：拿到句柄按正常入口关掉。
  const artifacts = await import("../artifacts/artifact-store.js");
  artifacts.__setArtifactDataDir(userDataDir);
  const watch = await import("./tool-watch.js");
  watch.__resetToolWatch();
  opened.store = store;
  opened.artifacts = artifacts;
  return { store, watch };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-tw-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  opened.store?.__setChangesetDataDir(null);
  opened.artifacts?.__setArtifactDataDir(null);
  opened.store = null;
  opened.artifacts = null;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 含 NUL 与多种非法 UTF-8 序列的真实二进制内容。 */
const binaryFixture = (seed: number): Buffer =>
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
    0x00, 0x00, 0x00, 0x0d, // NUL
    0xff, 0xfe, // 永不合法的起始字节
    0xc3, 0x28, // 截断的两字节序列
    0xed, 0xa0, 0x80, // 代理区码点
    seed, 0x80, 0x00, 0xfe,
  ]);

const REL = "assets/logo.png";

const ctx = () => ({ workspaceId, sessionId: "s1", turnId: "t1" });

describe("工具改到二进制文件", () => {
  it("[夹具自检] 这份内容经一次 utf8 往返确实会失真", () => {
    const bytes = binaryFixture(0xa5);
    expect(Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)).toBe(false);
  });

  it("快照与还原全程走字节：磁盘回到原样，入库的 before/after 也是原字节", async () => {
    const { store, watch } = await freshModules();
    const file = path.join(workspaceDir, REL);
    const original = binaryFixture(0xa5);
    const after = binaryFixture(0x5c);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, original);

    // 1. 工具开始 —— 此刻抓 before 快照
    await watch.observeToolEvent(
      {
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "write_file",
        args: { path: REL },
      },
      ctx()
    );

    // 2. 工具真的落盘了
    fs.writeFileSync(file, after);

    // 3. 工具结束 —— 登记并把磁盘还原成 before
    await watch.observeToolEvent(
      {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "write_file",
        result: { content: [] } as never,
        isError: false,
      },
      ctx()
    );

    // 还原下去的必须是原字节，不是一份被 U+FFFD 吃过的替身
    expect(fs.readFileSync(file).equals(original)).toBe(true);

    const records = store.changesetStore().list({ workspaceId });
    expect(records).toHaveLength(1);
    expect(records[0].relativePath).toBe(REL);
    expect(records[0].beforeBytes!.equals(original)).toBe(true);
    expect(records[0].afterBytes!.equals(after)).toBe(true);
    expect(records[0].binary).toBe(true);
    expect(records[0].status).toBe("pending");
  });

  it("字节相同就不登记 —— 判等不能塌缩到同一串替换字符", async () => {
    const { store, watch } = await freshModules();
    const file = path.join(workspaceDir, REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, binaryFixture(0xa5));

    await watch.observeToolEvent(
      {
        type: "tool_execution_start",
        toolCallId: "tc-2",
        toolName: "write_file",
        args: { path: REL },
      },
      ctx()
    );
    // 工具跑了但什么也没改
    await watch.observeToolEvent(
      {
        type: "tool_execution_end",
        toolCallId: "tc-2",
        toolName: "write_file",
        result: { content: [] } as never,
        isError: false,
      },
      ctx()
    );

    expect(store.changesetStore().list({ workspaceId })).toHaveLength(0);
  });
});
