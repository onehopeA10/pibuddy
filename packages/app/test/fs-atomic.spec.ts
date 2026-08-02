import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeJsonAtomic } from "../src/main/fs-atomic.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-atomic-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("正常写入后目标文件是完整 JSON，且不残留 .tmp", () => {
    const dir = tmpDir();
    const file = path.join(dir, "nested", "settings.json");

    writeJsonAtomic(file, { workspace: "D:/work", modelId: "m1" });

    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      workspace: "D:/work",
      modelId: "m1",
    });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("rename 之前抛异常时原文件字节未变，且 .tmp 被清理", () => {
    const dir = tmpDir();
    const file = path.join(dir, "settings.json");
    const original = '{"workspace":"OLD"}\n';
    fs.writeFileSync(file, original, "utf8");
    const before = fs.readFileSync(file);

    const boom = new Error("simulated crash before rename");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw boom;
    });

    expect(() => writeJsonAtomic(file, { workspace: "NEW" })).toThrow(boom);

    // 原文件逐字节未变
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    // 半截产物不得留在磁盘上
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});
