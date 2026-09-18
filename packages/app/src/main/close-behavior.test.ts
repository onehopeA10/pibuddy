import { describe, expect, it, vi } from "vitest";
import {
  choiceFromDialogResponse,
  closeDialogPrompt,
  decideClose,
  persistedCloseAction,
  promptCloseChoice,
} from "./close-behavior.js";

describe("decideClose", () => {
  it("正在退出时放行，不再弹窗", () => {
    expect(decideClose({ quitting: true, action: "ask" })).toBe("allow-quit");
    expect(decideClose({ quitting: true, action: "tray" })).toBe("allow-quit");
  });

  it("记住托盘则直接隐藏，记住退出则放行", () => {
    expect(decideClose({ quitting: false, action: "tray" })).toBe("hide-tray");
    expect(decideClose({ quitting: false, action: "quit" })).toBe("allow-quit");
  });

  it("没选过或 ask 就询问", () => {
    expect(decideClose({ quitting: false, action: undefined })).toBe("ask");
    expect(decideClose({ quitting: false, action: "ask" })).toBe("ask");
  });
});

describe("记住选择", () => {
  it("只有勾选且不是取消才落盘", () => {
    expect(persistedCloseAction(true, "tray")).toBe("tray");
    expect(persistedCloseAction(true, "quit")).toBe("quit");
    expect(persistedCloseAction(true, "cancel")).toBeNull();
    expect(persistedCloseAction(false, "tray")).toBeNull();
  });

  it("对话框按钮顺序：托盘 / 退出 / 取消", () => {
    expect(choiceFromDialogResponse(0)).toBe("tray");
    expect(choiceFromDialogResponse(1)).toBe("quit");
    expect(choiceFromDialogResponse(2)).toBe("cancel");
    expect(choiceFromDialogResponse(99)).toBe("cancel");
    expect(closeDialogPrompt().buttons).toEqual(["缩小到托盘", "退出", "取消"]);
  });

  it("勾选记住后把选择写回设置", async () => {
    const saveCloseAction = vi.fn();
    const choice = await promptCloseChoice(
      {
        showMessageBox: async () => ({ response: 0, checkboxChecked: true }),
        saveCloseAction,
      },
      {}
    );
    expect(choice).toBe("tray");
    expect(saveCloseAction).toHaveBeenCalledWith("tray");
  });
});
