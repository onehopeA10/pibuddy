/**
 * 本地用量聚合（PROV-101）。
 *
 * 两条断言是这个文件存在的主要理由，都对应「不报错但结果是错的」那一类：
 *
 *   1. **增量不出负数** —— pi 侧压缩后会重置会话统计，本次 total 因此可能
 *      小于上一次。直接做差会写进一个负数，表现是「这个月比上周花得还少」。
 *   2. **CSV 注入** —— workspace 显示名是用户可控的文件夹名，以 `=` 开头的
 *      单元格被 Excel 当成公式求值。导出文件一打开就执行命令是典型静默风险。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageRecordRequest } from "@pibuddy/contract";

vi.mock("electron", () => ({ app: { getPath: () => userDataDir } }));

let tmpRoot = "";
let userDataDir = "";

type Mod = typeof import("./usage-store.js");

/** 本用例开出来的全部连接。afterEach 统一关闭 —— Windows 上 SQLite 的
 *  -wal / -shm 只要还被句柄占着，rmSync 就会以 EPERM 失败，而那种失败会把
 *  一个通过的用例报成红的。 */
let openStores: { close(): void }[] = [];

async function freshStore(): Promise<{ mod: Mod; store: InstanceType<Mod["UsageStore"]> }> {
  vi.resetModules();
  const mod = await import("./usage-store.js");
  mod.__setUsageDataDir(userDataDir);
  const store = new mod.UsageStore(path.join(userDataDir, "usage.db"));
  openStores.push(store);
  return { mod, store };
}

function record(over: Partial<UsageRecordRequest> = {}): UsageRecordRequest {
  return {
    sessionId: "s1",
    workspaceId: "ws-a",
    provider: "anthropic",
    modelId: "some-model",
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...over,
  };
}

/** 固定到某一天的时间戳（本地时区）。 */
function at(day: string): number {
  return new Date(`${day}T12:00:00`).getTime();
}

beforeEach(() => {
  openStores = [];
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pibuddy-usage-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterEach(() => {
  for (const store of openStores) store.close();
  openStores = [];
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不该把用例报成红的；系统自己会回收 */
  }
});

describe("按 (day, workspace, provider, model) 聚合", () => {
  it("同一天同一模型的多次上报累加到一行", async () => {
    const { store } = await freshStore();
    store.record(record({ inputTokens: 100, outputTokens: 20, cost: 0.01 }), at("2026-08-01"));
    store.record(record({ inputTokens: 300, outputTokens: 60, cost: 0.05 }), at("2026-08-01"));

    const rows = store.query();
    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(300);
    expect(rows[0].outputTokens).toBe(60);
    expect(rows[0].cost).toBeCloseTo(0.05, 6);
    expect(rows[0].day).toBe("2026-08-01");
    store.close();
  });

  it("不同模型 / 不同 workspace / 不同日期各成一行", async () => {
    const { store } = await freshStore();
    store.record(record({ inputTokens: 10, cost: 0.001 }), at("2026-08-01"));
    store.record(
      record({ sessionId: "s2", modelId: "other-model", inputTokens: 10, cost: 0.002 }),
      at("2026-08-01")
    );
    store.record(
      record({ sessionId: "s3", workspaceId: "ws-b", inputTokens: 10, cost: 0.003 }),
      at("2026-08-01")
    );
    store.record(record({ sessionId: "s4", inputTokens: 10, cost: 0.004 }), at("2026-08-02"));
    expect(store.query()).toHaveLength(4);
    store.close();
  });

  it("按日期区间与 workspace 过滤", async () => {
    const { store } = await freshStore();
    store.record(record({ sessionId: "a", inputTokens: 1 }), at("2026-07-30"));
    store.record(record({ sessionId: "b", inputTokens: 1 }), at("2026-08-01"));
    store.record(
      record({ sessionId: "c", workspaceId: "ws-b", inputTokens: 1 }),
      at("2026-08-01")
    );

    expect(store.query({ fromDay: "2026-08-01" })).toHaveLength(2);
    expect(store.query({ toDay: "2026-07-31" })).toHaveLength(1);
    expect(store.query({ workspaceId: "ws-a" })).toHaveLength(2);
    expect(store.query({ fromDay: "2026-08-01", workspaceId: "ws-b" })).toHaveLength(1);
    store.close();
  });

  it("失败次数累加，context 取最新值而不是累加", async () => {
    const { store } = await freshStore();
    store.record(record({ contextTokens: 5000, failed: true }), at("2026-08-01"));
    store.record(
      record({ inputTokens: 10, contextTokens: 8000, failed: true }),
      at("2026-08-01")
    );
    const row = store.query()[0];
    expect(row.failures).toBe(2);
    // context 是「当前占用」，累加会得到一个没有意义的数
    expect(row.contextTokens).toBe(8000);
    store.close();
  });
});

describe("增量不出负数（pi 压缩后重置统计）", () => {
  it("本次 total 小于 last_seen_total 时写入增量为 0 而非负数", async () => {
    const { store } = await freshStore();
    // 第一次：累计 1000
    store.record(record({ inputTokens: 1000, outputTokens: 200, cost: 1 }), at("2026-08-01"));
    // pi 压缩后统计归零，第二次上报的累计值反而变小了
    const delta = store.record(
      record({ inputTokens: 120, outputTokens: 30, cost: 0.1 }),
      at("2026-08-01")
    );

    expect(delta.inputDelta).toBe(0);
    expect(delta.outputDelta).toBe(0);
    expect(delta.costDelta).toBe(0);

    const row = store.query()[0];
    expect(row.inputTokens).toBe(1000);
    expect(row.cost).toBeCloseTo(1, 6);
    store.close();
  });

  it("全表没有一行负数", async () => {
    const { store } = await freshStore();
    for (const total of [500, 100, 900, 50, 1200]) {
      store.record(
        record({ inputTokens: total, outputTokens: total / 2, cost: total / 1000 }),
        at("2026-08-01")
      );
    }
    const negatives = store
      .query()
      .filter((r) => r.inputTokens < 0 || r.outputTokens < 0 || r.cost < 0);
    expect(negatives).toHaveLength(0);
    store.close();
  });

  it("重置后继续增长，增量按新基线计算", async () => {
    const { store } = await freshStore();
    store.record(record({ inputTokens: 1000, cost: 1 }), at("2026-08-01"));
    store.record(record({ inputTokens: 100, cost: 0.1 }), at("2026-08-01")); // 重置
    store.record(record({ inputTokens: 250, cost: 0.3 }), at("2026-08-01")); // 新基线上 +150
    expect(store.query()[0].inputTokens).toBe(1150);
    store.close();
  });
});

describe("按 (sessionId, day) 的会话明细（R5.2）", () => {
  /** 真实形状的 get_session_stats 快照（tokens.input/output + cost 的口径）。 */
  const SNAPSHOT = { inputTokens: 22319, outputTokens: 512, cost: 0.1117 };

  it("同一会话同一天多轮上报，明细累加成一行", async () => {
    const { store } = await freshStore();
    store.record(record({ inputTokens: 1000, outputTokens: 100, cost: 0.01 }), at("2026-08-01"));
    store.record(record({ inputTokens: 3000, outputTokens: 400, cost: 0.05 }), at("2026-08-01"));

    const rows = store.querySessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("s1");
    expect(rows[0].day).toBe("2026-08-01");
    expect(rows[0].inputTokens).toBe(3000);
    expect(rows[0].outputTokens).toBe(400);
    expect(rows[0].cost).toBeCloseTo(0.05, 6);
    store.close();
  });

  it("[双源去重] 前台与池后台上报同一份累计快照，只计一次", async () => {
    const { store } = await freshStore();
    // 前台（渲染进程经 usage:record）先结账
    store.record(record(SNAPSHOT), at("2026-08-01"));
    // 池后台对同一 sessionId 用同一份 get_session_stats 再结一次账
    store.record(record(SNAPSHOT), at("2026-08-01"));

    const sessions = store.querySessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].inputTokens).toBe(22319); // 不是 44638
    expect(sessions[0].outputTokens).toBe(512);
    expect(sessions[0].cost).toBeCloseTo(0.1117, 6);
    // 日汇总同样只计一次
    expect(store.query()[0].inputTokens).toBe(22319);
    store.close();
  });

  it("[跨日] 跨过午夜的长会话按天各成一行，每行只记当天增量", async () => {
    const { store } = await freshStore();
    store.record(record({ inputTokens: 1000, outputTokens: 100, cost: 0.1 }), at("2026-08-01"));
    // 次日继续：累计 1500 → 当天增量 500
    store.record(record({ inputTokens: 1500, outputTokens: 130, cost: 0.16 }), at("2026-08-02"));

    const rows = store.querySessions(); // day DESC
    expect(rows).toHaveLength(2);
    expect(rows[0].day).toBe("2026-08-02");
    expect(rows[0].inputTokens).toBe(500);
    expect(rows[0].outputTokens).toBe(30);
    expect(rows[0].cost).toBeCloseTo(0.06, 6);
    expect(rows[1].day).toBe("2026-08-01");
    expect(rows[1].inputTokens).toBe(1000);
    store.close();
  });

  it("[分区] 按 workspaceId 过滤，各文件夹的账互不可见", async () => {
    const { store } = await freshStore();
    store.record(record({ inputTokens: 10, cost: 0.001 }), at("2026-08-01"));
    store.record(
      record({ sessionId: "s2", workspaceId: "ws-b", inputTokens: 20, cost: 0.002 }),
      at("2026-08-01")
    );

    expect(store.querySessions({ workspaceId: "ws-a" }).map((r) => r.sessionId)).toEqual(["s1"]);
    expect(store.querySessions({ workspaceId: "ws-b" }).map((r) => r.sessionId)).toEqual(["s2"]);
    expect(store.querySessions()).toHaveLength(2);
    store.close();
  });

  it("重复快照（增量全零且无失败）不为当天凭空造一行明细", async () => {
    const { store } = await freshStore();
    store.record(record(SNAPSHOT), at("2026-08-01"));
    // 次日重复上报同一份累计快照（例如双源都结了账但会话没有新活动）
    store.record(record(SNAPSHOT), at("2026-08-02"));

    const rows = store.querySessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("2026-08-01");
    store.close();
  });

  it("失败轮记入 failure_count，token 增量为零也如实落一行", async () => {
    const { store } = await freshStore();
    store.record(record({ failed: true }), at("2026-08-01"));
    const rows = store.querySessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].failures).toBe(1);
    expect(rows[0].inputTokens).toBe(0);
    store.close();
  });
});

describe("CSV 导出", () => {
  it("首行是约定好的表头，一个字都不能改（用户的导入脚本认它）", async () => {
    const { mod, store } = await freshStore();
    const csv = store.exportCsv();
    expect(csv.split("\n")[0]).toBe(
      "date,workspace,provider,model,input_tokens,output_tokens,cost,failures"
    );
    expect(csv.split("\n")[0]).toBe(mod.USAGE_CSV_HEADER);
    store.close();
  });

  it("[CSV 注入] `=cmd|…` 形态的 workspace 名以 `'=` 开头导出", async () => {
    const { store } = await freshStore();
    store.record(record({ inputTokens: 10, cost: 0.5 }), at("2026-08-01"));
    const evil = `=cmd|' /C calc'!A0`;
    const csv = store.exportCsv({}, { "ws-a": evil });

    const dataLine = csv.split("\n")[1];
    // 第 2 列就是 workspace。它必须以 '= 开头 —— 前导单引号让 Excel 把整格
    // 当成文本，而不是一条待求值的公式。
    const workspaceField = dataLine.split(",")[1];
    expect(workspaceField.startsWith("'=")).toBe(true);
    expect(workspaceField).toBe(`'${evil}`);
    // 整行里不存在一个「裸的」等号开头字段
    expect(dataLine).not.toContain(",=cmd");
    store.close();
  });

  it("四种公式前缀都被转义", async () => {
    const { mod } = await freshStore();
    for (const prefix of ["=", "+", "-", "@"]) {
      expect(mod.csvCell(`${prefix}danger`)).toBe(`'${prefix}danger`);
    }
    // 普通值不加引号也不加撇号
    expect(mod.csvCell("正常文件夹")).toBe("正常文件夹");
    expect(mod.csvCell(42)).toBe("42");
    // 含逗号的值按 RFC 4180 包引号
    expect(mod.csvCell("a,b")).toBe('"a,b"');
    // 内部双引号翻倍
    expect(mod.csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("exportJson 带 schemaVersion 与 rows", async () => {
    const { mod, store } = await freshStore();
    store.record(record({ inputTokens: 10, cost: 0.5 }), at("2026-08-01"));
    const parsed = JSON.parse(store.exportJson({}, { "ws-a": "我的项目" })) as {
      schemaVersion: number;
      rows: { workspace: string }[];
    };
    expect(parsed.schemaVersion).toBe(mod.USAGE_SCHEMA_VERSION);
    expect(parsed.rows[0].workspace).toBe("我的项目");
    store.close();
  });
});
