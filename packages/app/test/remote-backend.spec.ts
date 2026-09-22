import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliver: vi.fn<(sessionId: string, text: string) => boolean>(),
}));

vi.mock("../src/main/agent-pool/pool.js", () => ({
  agentPool: () => ({
    snapshot: vi.fn(),
    stopSession: vi.fn(),
    resolveInbox: vi.fn(),
    sessionGrantPolicy: vi.fn(),
  }),
  poolRuntimeHost: () => ({ deliver: mocks.deliver }),
}));

vi.mock("../src/main/sessions/session-history.js", () => ({
  readEntriesBefore: vi.fn(),
}));

vi.mock("../src/main/sessions/session-index.js", () => ({
  sessionIndex: () => ({ bySessionId: vi.fn() }),
}));

vi.mock("../src/main/permission/permission-store.js", () => ({
  decidePermission: vi.fn(),
  describePermissions: vi.fn(),
}));

const { productionBackend } = await import("../src/main/remote/remote-backend.js");

describe("productionBackend prompt delivery", () => {
  beforeEach(() => {
    mocks.deliver.mockReset();
  });

  it("returns ok only when the sanctioned pool entry reports delivery", () => {
    mocks.deliver.mockReturnValueOnce(true);
    const backend = productionBackend();

    expect(backend.sendPrompt("session-1", "hello")).toEqual({ ok: true, reason: "ok" });
    expect(mocks.deliver).toHaveBeenCalledWith("session-1", "hello");
  });

  it("returns an explicit failure when deliver returns false", () => {
    mocks.deliver.mockReturnValueOnce(false);
    const backend = productionBackend();

    expect(backend.sendPrompt("stopped-session", "hello")).toEqual({
      ok: false,
      reason: "session unavailable",
    });
  });
});
