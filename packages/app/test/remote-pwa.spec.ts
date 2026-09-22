// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_JS } from "../src/main/remote/pwa-assets/pwa-content.js";

const SNAPSHOT = {
  sequence: 1,
  sessions: [
    { sessionId: "session-a", workspaceId: "workspace-1", runState: "running", unread: false },
    { sessionId: "session-b", workspaceId: "workspace-1", runState: "running", unread: false },
  ],
  inbox: [],
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    FakeWebSocket.instances.push(this);
  }

  emitSnapshot(snapshot = SNAPSHOT): void {
    this.onmessage?.({ data: JSON.stringify({ type: "pool", snapshot }) });
  }

  close(): void {}
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mountApp(
  promptResponse: () => Promise<Response> = async () => jsonResponse(200, { ok: true, reason: "ok" })
): Promise<ReturnType<typeof vi.fn>> {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/pool") return Promise.resolve(jsonResponse(200, SNAPSHOT));
    if (url === "/api/prompt") return promptResponse();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeWebSocket);

  window.eval(APP_JS);
  await vi.waitFor(() => expect(document.querySelector("textarea[data-session]")).not.toBeNull());
  return fetchMock;
}

function composer(): HTMLTextAreaElement {
  return document.querySelector("textarea[data-session]") as HTMLTextAreaElement;
}

function setDraft(text: string): void {
  const textarea = composer();
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickSession(sessionId: string): void {
  const target = [...document.querySelectorAll<HTMLElement>(".sess .id")].find(
    (element) => element.textContent === sessionId
  );
  expect(target).toBeDefined();
  target!.click();
}

function clickSend(): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button.primary")].find(
    (element) => element.textContent === "发送"
  );
  expect(button).toBeDefined();
  button!.click();
}

beforeEach(() => {
  document.body.innerHTML =
    "<header><span id='conn' class='dot off'></span><button id='unpair'></button></header><main id='app'></main>";
  localStorage.clear();
  localStorage.setItem("pibuddy.remote.token", "synthetic-token");
  localStorage.setItem("pibuddy.remote.scopes", JSON.stringify(["prompt.send"]));
  FakeWebSocket.instances = [];
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("remote PWA composer state", () => {
  it("keeps unsent text, focus, and selection when the same snapshot renders again", async () => {
    await mountApp();
    const before = composer();
    setDraft("unsent draft");
    before.focus();
    before.setSelectionRange(2, 7);

    FakeWebSocket.instances[0].emitSnapshot();

    const after = composer();
    expect(after).not.toBe(before);
    expect(after.value).toBe("unsent draft");
    expect(document.activeElement).toBe(after);
    expect([after.selectionStart, after.selectionEnd]).toEqual([2, 7]);
  });

  it("keeps an independent draft for each target session", async () => {
    await mountApp();
    setDraft("draft for a");

    clickSession("session-b");
    expect(composer().value).toBe("");
    setDraft("draft for b");

    clickSession("session-a");
    expect(composer().value).toBe("draft for a");
    clickSession("session-b");
    expect(composer().value).toBe("draft for b");
  });

  it.each([
    [502, { ok: false, reason: "session unavailable" }],
    [200, { ok: false, reason: "not delivered" }],
  ])("keeps the draft when prompt response is HTTP %s with a failed body", async (status, body) => {
    await mountApp(async () => jsonResponse(status, body));
    setDraft("keep this prompt");

    clickSend();

    await vi.waitFor(() => expect(document.body.textContent).toContain("发送失败"));
    expect(composer().value).toBe("keep this prompt");
  });

  it("does not clear newer text when an in-flight send succeeds after refresh", async () => {
    const pending = deferred<Response>();
    await mountApp(() => pending.promise);
    setDraft("submitted text");
    clickSend();

    FakeWebSocket.instances[0].emitSnapshot();
    setDraft("new text while sending");
    pending.resolve(jsonResponse(200, { ok: true, reason: "ok" }));

    await vi.waitFor(() => expect(composer().value).toBe("new text while sending"));
  });

  it("keeps a same-text ABA draft edited while the prior send is in flight", async () => {
    const pending = deferred<Response>();
    await mountApp(() => pending.promise);
    setDraft("same text");
    clickSend();

    setDraft("");
    setDraft("same text");
    pending.resolve(jsonResponse(200, { ok: true, reason: "ok" }));

    await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("button.primary")].find(
        (element) => element.textContent === "发送"
      );
      expect(button?.disabled).toBe(false);
    });
    expect(composer().value).toBe("same text");
  });

  it("does not clear the new target draft when another session send resolves", async () => {
    const pending = deferred<Response>();
    await mountApp(() => pending.promise);
    setDraft("submitted to a");
    clickSend();

    clickSession("session-b");
    setDraft("new draft for b");
    pending.resolve(jsonResponse(200, { ok: true, reason: "ok" }));

    await vi.waitFor(() => expect(composer().value).toBe("new draft for b"));
    expect(composer().getAttribute("data-session")).toBe("session-b");
  });
});
