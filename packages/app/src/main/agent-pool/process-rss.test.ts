import { describe, expect, it } from "vitest";

import { parsePsOutput, parseTasklistCsv, readProcessRssMb } from "./process-rss.js";

describe("process-rss：按 pid 读 RSS", () => {
  it("tasklist CSV：只挑要的 pid，内存列剥掉千分位与单位后按 KB 换算", () => {
    const text = [
      '"System Idle Process","0","Services","0","8 K"',
      '"electron.exe","12345","Console","1","345,678 K"',
      '"electron.exe","999","Console","1","1,048,576 K"',
      '"node.exe","777","Console","1","2.048 K"',
      "",
    ].join("\r\n");
    const rss = parseTasklistCsv(text, new Set([12345, 999, 777]));
    expect(rss.get(12345)).toBe(338);
    expect(rss.get(999)).toBe(1024);
    // 区域设置用「.」做千分位也只取数字
    expect(rss.get(777)).toBe(2);
    expect(rss.has(0)).toBe(false);
  });

  it("ps 输出：pid + rss(KB) 两列", () => {
    const rss = parsePsOutput("  4242 524288\n 17 1024\n");
    expect(rss.get(4242)).toBe(512);
    expect(rss.get(17)).toBe(1);
  });

  it("空 pid 列表不 spawn，直接空表", async () => {
    expect((await readProcessRssMb([])).size).toBe(0);
    expect((await readProcessRssMb([0, -1, Number.NaN])).size).toBe(0);
  });

  it("真读当前进程：RSS 为正数（各平台路径都跑一遍）", async () => {
    const rss = await readProcessRssMb([process.pid]);
    const mb = rss.get(process.pid);
    expect(mb).toBeDefined();
    expect(mb!).toBeGreaterThan(0);
  }, 20_000);
});
