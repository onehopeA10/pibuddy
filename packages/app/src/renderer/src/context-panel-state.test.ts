import { describe, expect, it } from "vitest";

import {
  isContextPanelMode,
  readContextPanelMode,
  writeContextPanelMode,
} from "./context-panel-state";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("context-panel-state · 任务上下文面板状态持久化", () => {
  it("从未选过 → null，交给调用方做首次引导", () => {
    expect(readContextPanelMode(memoryStorage())).toBeNull();
    expect(readContextPanelMode(null)).toBeNull();
  });

  it("写什么读什么，三态都能往返", () => {
    for (const mode of ["closed", "expanded", "collapsed"] as const) {
      const storage = memoryStorage();
      writeContextPanelMode(mode, storage);
      expect(readContextPanelMode(storage)).toBe(mode);
    }
  });

  it("存储里的脏值不当作选择", () => {
    expect(readContextPanelMode(memoryStorage({ "pibuddy.contextPanel": "open" }))).toBeNull();
    expect(isContextPanelMode("expanded")).toBe(true);
    expect(isContextPanelMode("")).toBe(false);
    expect(isContextPanelMode(undefined)).toBe(false);
  });

  it("存储抛错时读回 null、写不抛", () => {
    const broken = {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readContextPanelMode(broken)).toBeNull();
    expect(() => writeContextPanelMode("expanded", broken)).not.toThrow();
  });
});
