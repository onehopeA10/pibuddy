import { describe, expect, it } from "vitest";

import { formatDuration } from "./duration";

describe("formatDuration · 紧凑时长", () => {
  it("秒 / 分秒 / 时分三档", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(152_000)).toBe("2m32s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(3_780_000)).toBe("1h03m");
  });

  it("负数与 NaN 按 0 处理", () => {
    expect(formatDuration(-3_000)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});
