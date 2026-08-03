import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * FS-102 变更集的关键路径 —— 全都围绕**同一件事**：不能用一份过期的内容
 * 盖掉用户刚写的东西。
 *
 *   1. 接受之前重算 hash，与登记时的 before 不符就一个字节都不写；
 *   2. 同一条变更接受两次只应用一次；
 *   3. 拒绝不产生任何磁盘写；
 *   4. 接受之后备份存在且等于应用前的原文件；
 *   5. before 快照缺失的条目禁止一键接受，批量路径要显式列出被跳过的。
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
type Apply = typeof import("./apply.js");

const opened: { store: Store | null } = { store: null };

async function freshModules(): Promise<{ store: Store; apply: Apply }> {
  vi.resetModules();
  const registry = await import("../workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
  workspaceId = registry.registerWorkspace(workspaceDir).workspaceId;
  const store = await import("./changeset-store.js");
  store.__setChangesetDataDir(userDataDir);
  const apply = await import("./apply.js");
  opened.store = store;
  return { store, apply };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-cs-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "note.txt"), "one\ntwo\n", "utf8");
});

afterEach(() => {
  opened.store?.__setChangesetDataDir(null);
  opened.store = null;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const buf = (v: string | Uint8Array): Buffer =>
  typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);

/** 登记一条「把 note.txt 改成 next」的待审阅变更。 */
async function stage(
  store: Store,
  next: string | Uint8Array,
  before: string | Uint8Array | null = "one\ntwo\n",
  relativePath = "note.txt"
) {
  return store.changesetStore().record({
    workspaceId,
    sessionId: "s1",
    turnId: "t1",
    toolCallId: `tc-${Math.random()}`,
    toolName: "write_file",
    kind: "write",
    relativePath,
    beforeBytes: before === null ? null : buf(before),
    afterBytes: buf(next),
  });
}

describe("接受一条变更", () => {
  it("磁盘还是 before 时正常应用，并留下等于原文件的备份", async () => {
    const { store, apply } = await freshModules();
    const record = await stage(store, "one\ntwo\nthree\n");
    const original = fs.readFileSync(path.join(workspaceDir, "note.txt"));

    const result = await apply.acceptChange(record.id);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, "note.txt"), "utf8")).toBe("one\ntwo\nthree\n");

    const backup = await apply.backupBytesOf(record.id);
    expect(backup).not.toBeNull();
    expect(backup!.equals(original)).toBe(true);
  });

  it("文件在审阅期间被外部改过：返回 conflict，磁盘字节一个都不动", async () => {
    const { store, apply } = await freshModules();
    const record = await stage(store, "one\ntwo\nthree\n");

    // 用户在别的编辑器里改了同一个文件
    fs.writeFileSync(path.join(workspaceDir, "note.txt"), "用户自己的改动\n", "utf8");
    const bytesBefore = fs.readFileSync(path.join(workspaceDir, "note.txt"));

    const result = await apply.acceptChange(record.id);
    expect(result.conflict).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.current?.preview).toContain("用户自己的改动");
    expect(fs.readFileSync(path.join(workspaceDir, "note.txt")).equals(bytesBefore)).toBe(true);
  });

  it("同一条变更第二次接受直接短路成 alreadyApplied", async () => {
    const { store, apply } = await freshModules();
    const record = await stage(store, "one\ntwo\nthree\n");
    expect((await apply.acceptChange(record.id)).ok).toBe(true);

    const second = await apply.acceptChange(record.id);
    expect(second.alreadyApplied).toBe(true);
    // 第二次不能再写一遍（备份也不该被覆盖成「已应用后的内容」）
    const backup = await apply.backupBytesOf(record.id);
    expect(backup!.toString("utf8")).toBe("one\ntwo\n");
  });

  it("只接受勾选的 hunk 时，未勾选的段保持 before", async () => {
    const { store, apply } = await freshModules();
    fs.writeFileSync(path.join(workspaceDir, "note.txt"), "a\nb\nc\n", "utf8");
    const record = await store.changesetStore().record({
      workspaceId,
      sessionId: "s1",
      turnId: "t1",
      toolCallId: "tc-hunk",
      toolName: "edit_file",
      kind: "edit",
      relativePath: "note.txt",
      beforeBytes: buf("a\nb\nc\n"),
      afterBytes: buf("A\nb\nC\n"),
    });
    const diff = store.diffOf(store.changesetStore().get(record.id)!);
    expect(diff.hunks.length).toBeGreaterThanOrEqual(2);

    // 只接受第一段
    const result = await apply.acceptChange(record.id, [diff.hunks[0].index]);
    expect(result.ok).toBe(true);
    const text = fs.readFileSync(path.join(workspaceDir, "note.txt"), "utf8");
    expect(text).toContain("A");
    expect(text).toContain("c");
    expect(text).not.toContain("C");
  });
});

describe("拒绝一条变更", () => {
  it("拒绝之后目标文件的 mtime 与内容都没变（不产生任何磁盘写）", async () => {
    const { store, apply } = await freshModules();
    const record = await stage(store, "one\ntwo\nthree\n");

    const file = path.join(workspaceDir, "note.txt");
    const before = { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs };

    const result = apply.rejectChange(record.id);
    expect(result.ok).toBe(true);

    const after = { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs };
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtime).toBe(before.mtime);
    expect(store.changesetStore().get(record.id)?.status).toBe("rejected");
  });
});

describe("unverified 变更", () => {
  it("单条接受返回 requiresManualReview 且不写磁盘", async () => {
    const { store, apply } = await freshModules();
    // before 抓不到 → status = unverified
    const record = await stage(store, "来历不明的内容\n", null);
    expect(record.status).toBe("unverified");

    const file = path.join(workspaceDir, "note.txt");
    const bytesBefore = fs.readFileSync(file);

    const result = await apply.acceptChange(record.id);
    expect(result.requiresManualReview).toBe(true);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(file).equals(bytesBefore)).toBe(true);
  });

  it("批量接受硬跳过 unverified 并在返回值里列出来", async () => {
    const { store, apply } = await freshModules();
    const good = await stage(store, "one\ntwo\nthree\n");
    const bad = await stage(store, "来历不明的内容\n", null);

    const result = await apply.acceptBatch([good.id, bad.id]);
    expect(result.applied).toEqual([good.id]);
    // 静默跳过和静默接受一样糟：被跳过的必须能被 UI 点名
    expect(result.skippedUnverified).toEqual([bad.id]);
  });
});

/**
 * 一份**真实的**二进制内容：PNG magic + NUL + 若干非法 UTF-8 序列。
 *
 * 纯 ASCII 在这里测不出任何东西 —— 它经 utf8 解码再编码是无损的，坏代码
 * 照样全绿。必须是解码时会掉进 U+FFFD 的字节。
 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const binaryFixture = (seed: number): Buffer =>
  Buffer.from([
    ...PNG_MAGIC,
    0x00, 0x00, 0x00, 0x0d, // NUL：逐行 diff 的经典二进制标记
    0xff, 0xfe, // UTF-8 里永不合法的起始字节
    0xc3, 0x28, // 两字节序列被非续接字节截断
    0xed, 0xa0, 0x80, // UTF-16 代理区码点，UTF-8 编码里非法
    0xf0, 0x9f, 0x92, // 四字节序列缺最后一个续接字节
    seed, 0x80, 0x00, 0xfe,
  ]);

const BIN = "assets/logo.png";

describe("二进制变更的字节保真", () => {
  const fileOf = () => path.join(workspaceDir, BIN);

  it("[夹具自检] 这份内容经一次 utf8 往返确实会失真", () => {
    const bytes = binaryFixture(0xa5);
    const roundTripped = Buffer.from(bytes.toString("utf8"), "utf8");
    // 这条断言守住整个 describe 的有效性：夹具一旦退化成 ASCII，
    // 下面每条测试都会变成恒真，而 CI 上看不出任何异样。
    expect(roundTripped.equals(bytes)).toBe(false);
  });

  /** 布置「工具已经把二进制文件改掉了」的现场，返回登记好的变更。 */
  async function stageBinary(store: Store) {
    const original = binaryFixture(0xa5);
    const after = binaryFixture(0x5c);
    fs.mkdirSync(path.dirname(fileOf()), { recursive: true });
    // 工具落盘之后磁盘上是 after，快照里是 original
    fs.writeFileSync(fileOf(), after);
    const record = await stage(store, after, original, BIN);
    return { record, original, after };
  }

  it("登记时还原磁盘 —— 写回去的是逐字节的原文件", async () => {
    const { store } = await freshModules();
    const { original } = await stageBinary(store);
    // 这一步是损坏的真正源头：用户还没打开审阅面板，文件就已经被改坏了
    expect(fs.readFileSync(fileOf()).equals(original)).toBe(true);
  });

  it("入库的 before / after 都是原字节，不经字符串", async () => {
    const { store } = await freshModules();
    const { record, original, after } = await stageBinary(store);
    const reloaded = store.changesetStore().get(record.id)!;
    expect(reloaded.beforeBytes!.equals(original)).toBe(true);
    expect(reloaded.afterBytes!.equals(after)).toBe(true);
  });

  it("拒绝之后磁盘仍是逐字节的原文件", async () => {
    const { store, apply } = await freshModules();
    const { record, original } = await stageBinary(store);

    expect(apply.rejectChange(record.id).ok).toBe(true);
    expect(fs.readFileSync(fileOf()).equals(original)).toBe(true);
  });

  it("接受把 after 的原字节写下去，备份是 before 的原字节", async () => {
    const { store, apply } = await freshModules();
    const { record, original, after } = await stageBinary(store);

    const result = await apply.acceptChange(record.id);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(fileOf()).equals(after)).toBe(true);
    // 一份被转码过的备份等于没有备份：撤销会还原出一个打不开的文件
    expect((await apply.backupBytesOf(record.id))!.equals(original)).toBe(true);
  });

  it("标记为 binary，diff 降级为摘要而不是硬渲染", async () => {
    const { store } = await freshModules();
    const { record } = await stageBinary(store);
    const reloaded = store.changesetStore().get(record.id)!;

    expect(reloaded.binary).toBe(true);
    const diff = store.diffOf(reloaded);
    expect(diff.hunks).toEqual([]);
    expect(diff.degraded).toBe("二进制文件");
  });

  it("二进制条目拒绝逐 hunk 接受，且一个字节都不写", async () => {
    const { store, apply } = await freshModules();
    const { record, original } = await stageBinary(store);

    // diff 是空的，照旧往下走会拼出一份只剩 before 的内容写下去
    const result = await apply.acceptChange(record.id, [0]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("二进制");
    expect(fs.readFileSync(fileOf()).equals(original)).toBe(true);
  });
});
