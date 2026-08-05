import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工具结果归档护栏的端到端（tool-archive）。
 *
 * 起**真 bridge**（named pipe + 一次性 token）+ 真归档落盘 + 真恢复读取工具，
 * 走完整链：
 *
 *   工具执行 → 超阈值 → 完整原文落归档（文件旁路，体量远超 256KB 传输上界）
 *   → 回包只剩一个带 ref 的占位符 → 模型经 read_archived_result 分页读回
 *   → 拼起来与原文逐字相同。
 *
 * 对拍：
 *   ① 归档失败（归档根不可写）→ 保留原文 + 计一次 archiveFailures（降级回
 *      旧行为，不丢任何东西）；
 *   ② **读归档不会触发新一轮归档**——恢复读取的响应严格有界（按估算 token
 *      二分）。拆掉 archive-read.ts 里的二分，本组的「每一页回包都不是占位符」
 *      会变红。
 *   ③ 读回的前四校验（workspace → kind → size → sha256）任一不符即拒，
 *      **绝不静默返回错内容**。
 *
 * 诚实边界：bridge 的执行面在本测里注入，生产的 cwd → workspaceId 解析
 * （home-ipc.workspaceIdOfCwd，多一道「必须是已注册工作区」）不在此覆盖——
 * 与 home-assistant-e2e / home-automation-e2e 对 bridge 执行面的注入口径一致。
 * 归档隔离用的是同一个派生（realpath → workspaceIdFor），本测覆盖到它。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-archive-e2e-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  dialog: { showMessageBox: vi.fn() },
}));

const { HomeToolBridge, registerBridgeTool } = await import("../src/main/home/tool-bridge.js");
const { __setToolArchiveDir, archiveScopeForCwd } = await import(
  "../src/main/tool-archive/archive-store.js"
);
const { readArchivedToolResult } = await import("../src/main/tool-archive/archive-read.js");
const { isArchivedToolResultPlaceholder, serializeToolResult } = await import(
  "../src/main/tool-archive/result-guard.js"
);
const { __resetToolArchiveCounters, toolArchiveCounters } = await import(
  "../src/main/tool-archive/bridge-guard.js"
);
const { HOME_TOOL_READ_ARCHIVE } = await import("@pibuddy/contract");

/** 归档根（与生产同构：<userData>/tool-archive/<workspaceId>/<artifactId>）。 */
const archiveRoot = path.join(userData, "tool-archive");
/** pi 子进程的 cwd —— 归档隔离域就是从它派生的。 */
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-archive-ws-"));
/** 另一个工作区，用来对拍隔离。 */
const otherWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-archive-ws2-"));

let bridge: InstanceType<typeof HomeToolBridge>;
let pipePath: string;
/** 注入的执行面：测试逐例设定这次工具调用返回什么。 */
let nextResult: unknown = null;

function bridgeCall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("bridge 调用超时"));
    }, 10000);
    // setEncoding 而不是逐 chunk 的 chunk.toString("utf8")：一个 3 字节的
    // 汉字会被 TCP 切在两个 chunk 之间，逐 chunk 解码会把它变成两个 U+FFFD。
    // fail-open 回的是完整原文（可能几百 KB），这条路上真的会撞见。
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 调一次「会返回大结果」的工具。 */
function callTool(
  tool: string,
  args: unknown = {},
  cwd: string = workspaceDir
): Promise<Record<string, unknown>> {
  return bridgeCall({ id: Math.random(), token: bridge.__token(), tool, args, cwd });
}

/**
 * 一个远超 256KB 传输上界的中文结果。
 *
 * 它证明的是：归档走**文件旁路**，体量不受那道传输闸约束；而回包里只剩
 * 一个几百字节的占位符——256KB 从「截断点」变成「永远不会被触及的安全网」。
 */
function chineseResult(count: number): unknown {
  return {
    total: count,
    entities: Array.from({ length: count }, (_, i) => ({
      id: `light.living_room_${i}`,
      name: `客厅主灯${i}号`,
      area: "客厅",
      description: "位于客厅顶部的主照明设备，支持色温与亮度调节，归属客厅区域，当前处于开启状态",
    })),
  };
}

const hugeChineseResult = (): unknown => chineseResult(1400);
/** 同样超阈值、但小到能在几页里读完——分页往返用它，跑得快。 */
const mediumChineseResult = (): unknown => chineseResult(40);

const smallResult = { total: 1, entities: ["light.living_room | 客厅灯 | on | 客厅"] };

function archiveFilesOf(workspaceDirPath: string): string[] {
  const dir = path.join(archiveRoot, archiveScopeForCwd(workspaceDirPath)!);
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

beforeAll(async () => {
  __setToolArchiveDir(userData);
  bridge = new HomeToolBridge(async () => nextResult);
  // 恢复读取工具挂进跨包注册表（生产在 home-ipc 的 registerHomeIpc 里做同一件事）。
  registerBridgeTool(HOME_TOOL_READ_ARCHIVE, async (_tool, args, cwd) =>
    readArchivedToolResult(archiveScopeForCwd(cwd)!, args)
  );
  pipePath = await bridge.start();
});

afterAll(async () => {
  registerBridgeTool(HOME_TOOL_READ_ARCHIVE, null);
  await bridge.stop();
  __setToolArchiveDir(null);
});

beforeEach(() => {
  __setToolArchiveDir(userData);
  __resetToolArchiveCounters();
});

describe("回包路径：超阈值就归档，未超就原样回", () => {
  it("小结果原样回包，磁盘上一条归档都不产生", async () => {
    nextResult = smallResult;
    const res = await callTool("home.assistant.list_entities");
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(smallResult);
    expect(isArchivedToolResultPlaceholder(res.result)).toBe(false);
    expect(toolArchiveCounters()).toEqual({});
  });

  it("超 256KB 的大中文结果：归档里是完整原文，回包只剩几百字节的占位符", async () => {
    const original = hugeChineseResult();
    const serialized = serializeToolResult(original);
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(256 * 1024);

    nextResult = original;
    const res = await callTool("home.assistant.list_entities");
    expect(res.ok).toBe(true);
    expect(isArchivedToolResultPlaceholder(res.result)).toBe(true);

    const placeholder = res.result as Record<string, unknown>;
    // 回包本身必须小到不值一提——这就是整道护栏的目的。
    expect(JSON.stringify(placeholder).length).toBeLessThan(1200);
    expect(placeholder.originalBytes).toBe(Buffer.byteLength(serialized, "utf8"));

    // 不变式 1：归档里躺着的就是完整原文。
    const files = archiveFilesOf(workspaceDir);
    expect(files).toEqual([placeholder.artifactId]);
    const record = JSON.parse(
      fs.readFileSync(
        path.join(archiveRoot, archiveScopeForCwd(workspaceDir)!, String(placeholder.artifactId)),
        "utf8"
      )
    ) as { serializedResult: string; kind: string; workspaceId: string };
    expect(record.serializedResult).toBe(serialized);
    expect(record.kind).toBe("pibuddy.tool_result_archive");
    expect(record.workspaceId).toBe(archiveScopeForCwd(workspaceDir));

    // 可观测：字段只在 >0 时出现，archiveFailures 缺席即「没降级」。
    const counters = toolArchiveCounters();
    expect(counters.archivedResults).toBe(1);
    expect(counters.estimatedTokensSaved).toBeGreaterThan(0);
    expect(counters.archiveFailures).toBeUndefined();
    expect("archiveFailures" in counters).toBe(false);
  });
});

describe("恢复读取：分页读回 = 原文逐字相同，且读归档不会触发新一轮归档", () => {
  let ref: string;
  let serialized: string;

  beforeEach(async () => {
    const original = mediumChineseResult();
    serialized = serializeToolResult(original);
    nextResult = original;
    const res = await callTool("home.assistant.list_entities");
    ref = String((res.result as Record<string, unknown>).ref);
    __resetToolArchiveCounters();
  });

  it("按 nextOffset 逐页读完，拼起来与原文逐字相同", async () => {
    let offset: number | null = 0;
    let assembled = "";
    let pages = 0;
    while (offset !== null) {
      const res: Record<string, unknown> = await callTool(HOME_TOOL_READ_ARCHIVE, { ref, offset });
      expect(res.ok).toBe(true);
      const page = res.result as {
        ok: boolean;
        content: string;
        nextOffset: number | null;
        totalChars: number;
        toolName: string;
      };
      expect(page.ok).toBe(true);
      expect(page.toolName).toBe("home.assistant.list_entities");
      expect(page.totalChars).toBe(serialized.length);
      assembled += page.content;
      offset = page.nextOffset;
      pages += 1;
      expect(pages).toBeLessThan(2000);
    }
    expect(assembled).toBe(serialized);
    expect(pages).toBeGreaterThan(1);
  });

  it("对拍②：每一页的回包都不是占位符，读取全程零新增归档", async () => {
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null && pages < 2000) {
      const res: Record<string, unknown> = await callTool(HOME_TOOL_READ_ARCHIVE, { ref, offset });
      // 拆掉 archive-read.ts 里的 token 二分，这一行立刻变红：整份归档一次
      // 吐回 → 回包超阈值 → 又被归档 → 模型再去读那份归档，死循环。
      expect(isArchivedToolResultPlaceholder(res.result)).toBe(false);
      offset = (res.result as { nextOffset: number | null }).nextOffset;
      pages += 1;
    }
    expect(toolArchiveCounters()).toEqual({});
  });

  it("limit 是请求上界而不是保证：中文页会被 token 上限收窄", async () => {
    const res = await callTool(HOME_TOOL_READ_ARCHIVE, { ref, offset: 0, limit: 6000 });
    const page = res.result as { limit: number; content: string };
    expect(page.limit).toBeLessThan(6000);
    expect(page.limit).toBe(page.content.length);
    expect(page.limit).toBeGreaterThan(0);
  });
});

describe("对拍③：读回的前四校验，任一不符即拒，绝不静默返回错内容", () => {
  let ref: string;
  let artifactId: string;

  beforeEach(async () => {
    nextResult = hugeChineseResult();
    const res = await callTool("home.assistant.list_entities");
    const placeholder = res.result as Record<string, unknown>;
    ref = String(placeholder.ref);
    artifactId = String(placeholder.artifactId);
  });

  async function readWith(badRef: string, cwd = workspaceDir): Promise<Record<string, unknown>> {
    const res = await callTool(HOME_TOOL_READ_ARCHIVE, { ref: badRef }, cwd);
    return res.result as Record<string, unknown>;
  }

  it("workspace 隔离：换一个工作区读同一个 artifactId → 读不到", async () => {
    const out = await readWith(ref, otherWorkspaceDir);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not_found");
  });

  it("workspace 隔离：把归档文件搬进别的工作区目录 → workspace_mismatch", async () => {
    const otherDir = path.join(archiveRoot, archiveScopeForCwd(otherWorkspaceDir)!);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.copyFileSync(
      path.join(archiveRoot, archiveScopeForCwd(workspaceDir)!, artifactId),
      path.join(otherDir, artifactId)
    );
    const out = await readWith(ref, otherWorkspaceDir);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("workspace_mismatch");
    fs.rmSync(path.join(otherDir, artifactId));
  });

  it("size：bytes 对不上 → size_mismatch", async () => {
    const bad = ref.replace(/bytes=\d+/, "bytes=123");
    const out = await readWith(bad);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("size_mismatch");
  });

  it("sha256：hash 对不上 → source_mismatch", async () => {
    const bad = ref.replace(/sha256=[a-f0-9]{64}/, `sha256=${"b".repeat(64)}`);
    const out = await readWith(bad);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("source_mismatch");
  });

  it("内容被改坏（长度不变）→ corrupt，而不是把改坏的内容喂回去", async () => {
    const file = path.join(archiveRoot, archiveScopeForCwd(workspaceDir)!, artifactId);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { serializedResult: string };
    record.serializedResult = `X${record.serializedResult.slice(1)}`;
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    const out = await readWith(ref);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("corrupt");
  });

  it("artifactId 里的路径穿越写不出来 → not_allowed", async () => {
    const bad = ref.replace(artifactId, encodeURIComponent("../../evil.json"));
    const out = await readWith(bad);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not_allowed");
  });

  it("ref 形态不对 → invalid_ref；入参形态不对 → invalid_args", async () => {
    expect((await readWith("file:///etc/passwd")).reason).toBe("invalid_ref");
    const res = await callTool(HOME_TOOL_READ_ARCHIVE, { ref: 42 });
    expect((res.result as Record<string, unknown>).reason).toBe("invalid_args");
  });
});

describe("对拍①：归档失败 → 保留原文 + 计一次 archiveFailures（降级回旧行为）", () => {
  it("归档根写不进去时，回包仍是完整原文，一个字都没丢", async () => {
    // 把归档根指到一个**文件**上：mkdir 必然失败 → 写归档抛错 → fail-open。
    const blocker = path.join(userData, "blocker-file");
    fs.writeFileSync(blocker, "not a directory", "utf8");
    __setToolArchiveDir(blocker);

    const original = hugeChineseResult();
    nextResult = original;
    const res = await callTool("home.assistant.list_entities");

    expect(res.ok).toBe(true);
    // 两条一起断言：原文还在 **且** 占位符不存在（soft：对拍时两条都要红）。
    expect.soft(res.result).toEqual(original);
    expect.soft(isArchivedToolResultPlaceholder(res.result)).toBe(false);

    const counters = toolArchiveCounters();
    expect(counters.archiveFailures).toBe(1);
    expect(counters.archivedResults).toBeUndefined();
    expect(counters.estimatedTokensSaved).toBeUndefined();
  });

  it("cwd 解析不出工作区时同样 fail-open，且不影响这次工具调用成功", async () => {
    nextResult = hugeChineseResult();
    const res = await callTool(
      "home.assistant.list_entities",
      {},
      path.join(workspaceDir, "不存在的子目录")
    );
    expect(res.ok).toBe(true);
    expect(isArchivedToolResultPlaceholder(res.result)).toBe(false);
    expect(toolArchiveCounters().archiveFailures).toBe(1);
  });
});
