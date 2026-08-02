/**
 * 错误分类：七类各一个**真实**的 electron-updater 错误样本。
 *
 * 样本不是编出来的字符串 —— 每一条都来自 electron-updater / node 在对应
 * 故障下实际抛出的报文。分类错了的直接后果是用户被引向错误的自救动作：
 * 磁盘满被告知「检查网络」，然后重试一百次都失败。
 */
import { describe, expect, it } from "vitest";

import { classifyUpdaterError, describeUpdateError, mapUpdaterError } from "./update-errors.js";
import type { UpdateErrorCode } from "@pibuddy/contract";

const SAMPLES: Array<{ code: UpdateErrorCode; label: string; err: unknown }> = [
  {
    code: "network",
    label: "断网",
    err: new Error("net::ERR_INTERNET_DISCONNECTED"),
  },
  {
    code: "disk",
    label: "磁盘满",
    err: Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    }),
  },
  {
    code: "permission",
    label: "无写权限",
    err: Object.assign(
      new Error("EACCES: permission denied, open 'C:\\Users\\x\\AppData\\Local\\pibuddy-updater\\pending\\PiBuddy-Setup.exe'"),
      { code: "EACCES" }
    ),
  },
  {
    code: "signature",
    label: "sha512 不符",
    err: new Error(
      "sha512 checksum mismatch, expected 8fD1c…, got 21aB9… (file PiBuddy-Setup-2.0.0.exe)"
    ),
  },
  {
    code: "metadata",
    label: "feed 元数据坏了",
    err: new Error("ERR_UPDATER_INVALID_UPDATE_INFO: Cannot parse update info"),
  },
  {
    code: "unsupported",
    label: "未打包",
    err: new Error(
      "Skip checkForUpdates because application is not packed and dev update config is not forced"
    ),
  },
  {
    code: "unknown",
    label: "无法归类",
    err: new Error("something completely unexpected happened"),
  },
];

describe("mapUpdaterError 的七类映射", () => {
  for (const { code, label, err } of SAMPLES) {
    it(`${label} → ${code}`, () => {
      expect(classifyUpdaterError(err)).toBe(code);
      const info = mapUpdaterError(err);
      expect(info.code).toBe(code);
      expect(info.message.length).toBeGreaterThan(0);
      expect(typeof info.retryable).toBe("boolean");
    });
  }

  it("七个样本的分类两两不同（分类真的是互斥的，不是全落 unknown）", () => {
    const codes = SAMPLES.map((s) => classifyUpdaterError(s.err));
    expect(new Set(codes).size).toBe(7);
  });

  it("签名 / 元数据 / 不支持三类不给重试按钮", () => {
    for (const code of ["signature", "metadata", "unsupported"] as const) {
      expect(describeUpdateError(code).retryable).toBe(false);
    }
  });

  it("网络 / 磁盘 / 权限三类可以重试", () => {
    for (const code of ["network", "disk", "permission"] as const) {
      expect(describeUpdateError(code).retryable).toBe(true);
    }
  });
});

describe("switch 的 default 分支", () => {
  it("拿到一个不认识的码时返回 'unknown'，而不是 undefined", () => {
    // 跨进程 / 跨版本传来的码在运行时不受编译期联合类型约束。
    // 返回 undefined 会让界面渲染出一条既没文案也没重试按钮的空错误。
    const info = describeUpdateError("something-else" as UpdateErrorCode);
    expect(info).toBeDefined();
    expect(info.code).toBe("unknown");
    expect(info.message.length).toBeGreaterThan(0);
  });

  it("null / undefined / 非 Error 也不会炸", () => {
    expect(mapUpdaterError(null).code).toBe("unknown");
    expect(mapUpdaterError(undefined).code).toBe("unknown");
    expect(mapUpdaterError({ weird: true }).code).toBe("unknown");
  });
});
