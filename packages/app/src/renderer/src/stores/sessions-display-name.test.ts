import { describe, expect, it } from "vitest";
import { sessionDisplayName } from "./sessions";

describe("sessionDisplayName", () => {
  it("优先使用去除首尾空白后的显式名称", () => {
    expect(sessionDisplayName({ name: "  项目计划  ", preview: "帮我写一份计划" })).toBe("项目计划");
  });

  it("使用首条用户消息的前 5 个字符", () => {
    expect(sessionDisplayName({ name: undefined, preview: "帮我分析这份报告" })).toBe("帮我分析这");
  });

  it("命名前折叠连续空白", () => {
    expect(sessionDisplayName({ name: " ", preview: "你好\n  请 分析" })).toBe("你好 请 ");
  });

  it("按 Unicode 字符截取，不截断 emoji", () => {
    expect(sessionDisplayName({ name: undefined, preview: "你好😀世界继续" })).toBe("你好😀世界");
  });

  it("没有名称和消息时显示未命名任务", () => {
    expect(sessionDisplayName({ name: undefined, preview: "   " })).toBe("未命名任务");
  });
});
