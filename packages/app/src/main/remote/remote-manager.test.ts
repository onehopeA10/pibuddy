import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-remote-mgr-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0.0.0", isPackaged: false },
}));

const start = vi.fn(async function start(this: { bindScope: string; listening: boolean }, scope: string) {
  this.bindScope = scope;
  this.listening = true;
});
const stop = vi.fn(async function stop(this: { listening: boolean }) {
  this.listening = false;
});

vi.mock("./remote-server.js", () => ({
  RemoteServer: class RemoteServer {
    bindScope = "loopback";
    listening = false;
    start = start;
    stop = stop;
    isListening() {
      return this.listening;
    }
    address() {
      return this.listening ? "127.0.0.1" : null;
    }
    port() {
      return this.listening ? 8787 : null;
    }
    wsHub() {
      return { hasDevice: () => false };
    }
    dropDevice() {}
  },
}));

const { __setRemoteDataDir } = await import("./device-registry.js");
const { applyCapabilityResolution, __resetCapabilityState } = await import(
  "../capability/capability-state.js"
);
const { REMOTE_CAPABILITY_ID } = await import("@pibuddy/contract");
const mgr = await import("./remote-manager.js");

beforeEach(() => {
  start.mockClear();
  stop.mockClear();
  __setRemoteDataDir(userData);
  applyCapabilityResolution([REMOTE_CAPABILITY_ID]);
});

afterEach(async () => {
  await mgr.disposeRemoteResources();
  __resetCapabilityState();
  __setRemoteDataDir(null);
});

describe("remote-manager assembly", () => {
  it("setEnabled(true) 以 bindScope 调用 start，且不真 listen", async () => {
    const state = await mgr.setEnabled(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("loopback");
    expect(state.enabled).toBe(true);
    expect(state.listening).toBe(true);
    expect(state.port).toBe(8787);
  });

  it("describe 在未启动时 listening=false", () => {
    const state = mgr.describe();
    expect(state.listening).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
