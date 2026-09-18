import { describe, expect, it } from "vitest";

import { APPROVAL_MODES } from "@contract";
import {
  APPROVAL_MODE_OPTIONS,
  approvalModeDescription,
  approvalModeLabel,
} from "./approval-mode";

describe("审批模式文案", () => {
  it("四个模式都有短标签和一句说明，顺序与契约枚举一致", () => {
    expect(APPROVAL_MODE_OPTIONS.map((o) => o.value)).toEqual([...APPROVAL_MODES]);
    for (const option of APPROVAL_MODE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it("读不到模式时给占位，不假装已经选中了某个档", () => {
    expect(approvalModeLabel(undefined)).toBe("权限");
    expect(approvalModeDescription(undefined)).toBe("当前读不到审批模式");
    expect(approvalModeLabel("default")).toBe("默认权限");
  });
});
