import { describe, expect, it } from "vitest";
import { formatCost, formatTokenCount } from "./friendly";

describe("费用与 token 格式化", () => {
  it("保留零成本与小额成本口径", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.001)).toBe("<$0.01");
  });

  it("token 数量使用紧凑但可读的单位", () => {
    expect(formatTokenCount(0)).toBe("0 tokens");
    expect(formatTokenCount(999)).toBe("999 tokens");
    expect(formatTokenCount(26269)).toBe("26k tokens");
    expect(formatTokenCount(1_250_000)).toBe("1.3m tokens");
  });
});
