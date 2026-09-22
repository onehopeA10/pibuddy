import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readEntriesBefore, __lastReadBytes } from "./session-history.js";

/**
 * CRITICAL-1：向更早翻页的关键路径断言。
 *
 *   1. 连续反向翻页到头，所有页拼起来与整文件逐行解析的 id 序列完全相等
 *   2. 单次调用读取的字节数远小于文件总字节数（证明不是整文件读入）
 *   3. beforeOffset 落在行中间时不抛 JSON.parse 异常，半行被丢弃且计数为 1
 *   4. 两次调用之间文件被追加 → stale=true；调用方重试后拿到完整结果
 *
 * 这条路**不经 pi RPC**：rpc.md:696 的 get_entries 只返回 strictly after 的
 * 条目，全协议没有 before / limit，反向分页在协议层不存在。
 */

const LINES = 1000;
/** 每行填充到 ~700 字节：文件约 700KB，一次 64KB 的块读取只占 ~9%。 */
const PAD = "字".repeat(220);

let tmpRoot = "";
let file = "";

/** entry 的 id —— 契约里的 entry 是 loose 对象，取值口径收在这里。 */
function idOf(entry: unknown): string {
  return String((entry as { id?: unknown } | undefined)?.id);
}

function line(i: number, text = PAD): string {
  return `${JSON.stringify({
    type: "message",
    id: `e${String(i).padStart(4, "0")}`,
    parentId: i === 0 ? null : `e${String(i - 1).padStart(4, "0")}`,
    message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
  })}\n`;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pibuddy-hist-"));
  file = path.join(tmpRoot, "session.jsonl");
  let text = "";
  for (let i = 0; i < LINES; i++) text += line(i);
  await writeFile(file, text, "utf8");
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function fileSize(): Promise<number> {
  return (await readFile(file)).length;
}

/** 整文件逐行解析出的 id 序列 —— 反向分页的正确性基准。 */
async function expectedIds(): Promise<string[]> {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { id: string }).id);
}

describe("反向分页的顺序与完整性", () => {
  it("从文件末尾以 limit=60 连续翻到头，拼接结果与整文件解析完全相等", async () => {
    const size = await fileSize();
    let before: number | null = size;
    const pages: string[][] = [];
    let guard = 0;

    while (before !== null) {
      const page: Awaited<ReturnType<typeof readEntriesBefore>> = await readEntriesBefore({
        sourcePath: file,
        beforeOffset: before,
        limit: 60,
      });
      expect(page.entries.length).toBeLessThanOrEqual(60);
      pages.push(page.entries.map((e) => idOf(e)));
      before = page.nextBeforeOffset;
      if (++guard > 100) throw new Error("翻页没有收敛");
    }

    // pages 是「由新到旧」的页序列，页内本身是正序 → 反转页序即得全序
    const ids = pages.reverse().flat();
    expect(ids).toEqual(await expectedIds());
  });

  it("单次调用读取的字节数 < 文件总字节数的 20%", async () => {
    const size = await fileSize();
    await readEntriesBefore({ sourcePath: file, beforeOffset: size, limit: 60 });
    expect(__lastReadBytes()).toBeGreaterThan(0);
    expect(__lastReadBytes()).toBeLessThan(size * 0.2);
  });

  it("跨多个 64KB 块的长行在 limit=7 时仍完整返回且可继续翻页", async () => {
    const longText = "x".repeat(3 * 64 * 1024 + 17);
    const content = Array.from({ length: 12 }, (_, i) =>
      line(i, i === 8 ? longText : `short-${i}`)
    ).join("");
    await writeFile(file, content, "utf8");

    const page = await readEntriesBefore({
      sourcePath: file,
      beforeOffset: Buffer.byteLength(content),
      limit: 7,
    });
    expect(page.entries.map(idOf)).toEqual([
      "e0005",
      "e0006",
      "e0007",
      "e0008",
      "e0009",
      "e0010",
      "e0011",
    ]);
    expect(page.nextBeforeOffset).toBe(
      Buffer.byteLength(Array.from({ length: 5 }, (_, i) => line(i, `short-${i}`)).join(""))
    );
    expect(page.skippedPartial).toBe(0);

    const earlier = await readEntriesBefore({
      sourcePath: file,
      beforeOffset: page.nextBeforeOffset!,
      limit: 7,
    });
    expect(earlier.entries.map(idOf)).toEqual(["e0000", "e0001", "e0002", "e0003", "e0004"]);
    expect(earlier.nextBeforeOffset).toBeNull();
  });
});

describe("半行边界与一致性", () => {
  it("坏行只丢该行，仍占用 limit 的物理行窗口并推进偏移", async () => {
    const firstLine = line(0, "first");
    const content = `${firstLine}{broken json}\n${line(2, "third")}${line(3, "fourth")}`;
    await writeFile(file, content, "utf8");

    const page = await readEntriesBefore({
      sourcePath: file,
      beforeOffset: Buffer.byteLength(content),
      limit: 3,
    });
    expect(page.entries.map(idOf)).toEqual(["e0002", "e0003"]);
    expect(page.nextBeforeOffset).toBe(Buffer.byteLength(firstLine));
    expect(page.skippedPartial).toBe(0);

    const earlier = await readEntriesBefore({
      sourcePath: file,
      beforeOffset: page.nextBeforeOffset!,
      limit: 3,
    });
    expect(earlier.entries.map(idOf)).toEqual(["e0000"]);
    expect(earlier.nextBeforeOffset).toBeNull();
  });

  it("beforeOffset 落在行中间时不抛异常，半行被丢弃且 skippedPartial === 1", async () => {
    const size = await fileSize();
    // 最后一行的中间：整行约 700 字节，往回 300 字节必然落在行内
    const page = await readEntriesBefore({
      sourcePath: file,
      beforeOffset: size - 300,
      limit: 5,
    });
    expect(page.skippedPartial).toBe(1);
    expect(page.entries.length).toBe(5);
    // 被截断的是最后一行，因此本页最后一条必须是倒数第二行
    expect(idOf(page.entries.at(-1))).toBe("e0998");
  });

  it("落在行首（上一页的 nextBeforeOffset）时 skippedPartial === 0", async () => {
    const size = await fileSize();
    const first = await readEntriesBefore({ sourcePath: file, beforeOffset: size, limit: 10 });
    const second = await readEntriesBefore({
      sourcePath: file,
      beforeOffset: first.nextBeforeOffset!,
      limit: 10,
    });
    expect(second.skippedPartial).toBe(0);
    expect(idOf(second.entries.at(-1))).toBe("e0989");
  });

  it("两次调用之间文件被追加 → stale=true；重试后结果完整且不含半行", async () => {
    const size = await fileSize();
    const stamp = { mtimeMs: 0, sizeBytes: size };
    // 先拿到真实 mtime
    const probe = await readEntriesBefore({ sourcePath: file, beforeOffset: size, limit: 3 });
    expect(probe.stale).toBe(false);

    await appendFile(file, line(1000), "utf8");

    const stale = await readEntriesBefore({
      sourcePath: file,
      beforeOffset: size,
      limit: 3,
      expect: stamp,
    });
    expect(stale.stale).toBe(true);
    expect(stale.entries).toEqual([]);

    // 调用方「先 syncWorkspace」的等价物：拿到新的 size 后重试一次
    const fresh = await fileSize();
    const retry = await readEntriesBefore({ sourcePath: file, beforeOffset: fresh, limit: 3 });
    expect(retry.stale).toBe(false);
    expect(retry.skippedPartial).toBe(0);
    expect(idOf(retry.entries.at(-1))).toBe("e1000");
  });
});
