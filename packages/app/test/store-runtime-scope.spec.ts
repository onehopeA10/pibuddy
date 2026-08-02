import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../src/renderer/src/stores/app.js";

describe("runtimeScope 代理", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("started/streaming 读写仍然生效，且落在 runtimeScope 上", () => {
    const s = useAppStore();
    expect(s.started).toBe(false);
    expect(s.streaming).toBe(false);
    s.started = true;
    s.streaming = true;
    expect(s.runtimeScope[""].started).toBe(true);
    expect(s.runtimeScope[""].streaming).toBe(true);
    expect(s.started).toBe(true);
    s.streaming = false;
    expect(s.streaming).toBe(false);
    expect(s.currentSessionId).toBe("");
  });
});
