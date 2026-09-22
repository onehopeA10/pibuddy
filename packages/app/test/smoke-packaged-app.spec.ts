import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_READINESS_EXPRESSION, childCdpEndpoint, probePage, waitForApp, waitForChildCdp } from "../scripts/packaged-app-readiness.mjs";

function readiness({ url = "file:///app/out/renderer/index.html", mounted = true, preload = true, documentState = "complete", empty = false } = {}) {
  const window = new Window({ url });
  window.document.body.innerHTML = `<div id="app" ${mounted ? "data-v-app" : ""}>${empty ? "" : "<main>欢迎使用 PiBuddy</main>"}</div>`;
  Object.defineProperty(window.document, "readyState", { value: documentState });
  return runInNewContext(APP_READINESS_EXPRESSION, {
    document: window.document,
    location: window.location,
    window: { piBuddy: preload ? { pi: { prompt() {} } } : undefined },
  });
}

class TestSocket extends EventTarget {
  static instances: TestSocket[] = [];
  static responses: unknown[] = [];
  closed = false;
  sent = "";
  constructor() {
    super();
    TestSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(data: string) {
    this.sent = data;
    const response = TestSocket.responses.shift();
    if (response !== undefined) {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(response) })));
    }
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

function useCdp(responses: unknown[]) {
  TestSocket.instances = [];
  TestSocket.responses = responses;
  vi.stubGlobal("WebSocket", TestSocket);
}

const reply = (value: unknown) => ({ id: 1, result: { result: { type: "object", value } } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("打包冒烟的实际页面判据", () => {
  it("允许已挂载向导页，不需要配置模型或伪造首启状态", () => {
    expect(readiness()).toMatchObject({ ready: true, mounted: true, preload: true });
  });

  it.each([
    { url: "about:blank" },
    { url: "chrome-error://chromewebdata/" },
    { url: "http://localhost/renderer/index.html" },
    { mounted: false },
    { empty: true },
    { preload: false },
    { documentState: "loading" },
  ])("窗口存在但应用未就绪时拒绝：%j", (state) => {
    expect(readiness(state).ready).toBe(false);
  });
});

describe("CDP 只绑定本次子进程", () => {
  const endpoint = "ws://127.0.0.1:45678/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";
  const child = { exitCode: null, signalCode: null };

  it("没有子进程 endpoint 时不探测可能属于旧实例的端口", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ webSocketDebuggerUrl: endpoint }) });
    vi.stubGlobal("fetch", fetch);
    const pending = expect(waitForChildCdp(child, { stderr: "" }, 100)).rejects.toThrow(/尚未报告/);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("相同端口返回旧 browser UUID 时不能通过", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ webSocketDebuggerUrl: endpoint.replace("01234567", "fedcba98") }) }));
    const pending = expect(waitForChildCdp(child, { stderr: `DevTools listening on ${endpoint}\n` }, 100)).rejects.toThrow(/身份.*不一致/);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
  });

  it("仅接受子进程报告并经 version 核对的 loopback endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ webSocketDebuggerUrl: endpoint }) });
    vi.stubGlobal("fetch", fetch);
    await expect(waitForChildCdp(child, { stderr: `DevTools listening on ${endpoint}\r\n` }, 100)).resolves.toMatchObject({ port: 45678 });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:45678/json/version", expect.anything());
    expect(childCdpEndpoint(`DevTools listening on ${endpoint.replace("127.0.0.1", "example.com")}`)).toBeNull();
    expect(childCdpEndpoint(`DevTools listening on ${endpoint.replace("/devtools/browser/", "/devtools/page/")}`)).toBeNull();
  });

  it("spawn 失败或进程退出都不能借旧实例通过", async () => {
    await expect(waitForChildCdp(child, { stderr: "", spawnError: new Error("EACCES") }, 100)).rejects.toThrow("EACCES");
    await expect(waitForChildCdp({ exitCode: 1 }, { stderr: `DevTools listening on ${endpoint}` }, 100)).rejects.toThrow(/退出/);
  });
});

describe("CDP 就绪探测", () => {
  it("执行实际就绪表达式，取回值后关闭连接", async () => {
    useCdp([reply(readiness())]);
    await expect(probePage("ws://synthetic", 1000)).resolves.toMatchObject({ ready: true });
    expect(JSON.parse(TestSocket.instances[0].sent)).toEqual({
      id: 1, method: "Runtime.evaluate", params: { expression: APP_READINESS_EXPRESSION, returnByValue: true },
    });
    expect(TestSocket.instances[0].closed).toBe(true);
  });

  it.each([
    { id: 1, error: { message: "context destroyed" } },
    { id: 1, result: { exceptionDetails: { text: "ReferenceError" } } },
    { id: 1, result: { result: {} } },
  ])("协议或页面错误不能当作成功：%j", async (response) => {
    useCdp([response]);
    await expect(probePage("ws://synthetic", 1000)).rejects.toThrow();
    expect(TestSocket.instances[0].closed).toBe(true);
  });

  it("页面持续空白会超时失败，即使 CDP 一直有 page 目标", async () => {
    vi.useFakeTimers();
    useCdp([reply(readiness({ mounted: false }))]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://synthetic" }] }));
    const result = expect(waitForApp(9222, 100, { exitCode: null, signalCode: null })).rejects.toThrow(/等待应用页面就绪超时/);
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });

  it("等待页面从空白变为已挂载，而不是在首个 page 出现时通过", async () => {
    vi.useFakeTimers();
    useCdp([reply(readiness({ mounted: false })), reply(readiness())]);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://synthetic" }] });
    vi.stubGlobal("fetch", fetch);
    const result = waitForApp(9222, 1000, { exitCode: null, signalCode: null });
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toMatchObject({ ready: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("页面无响应时有界失败并释放连接", async () => {
    vi.useFakeTimers();
    useCdp([]);
    const result = expect(probePage("ws://synthetic", 100)).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(TestSocket.instances[0].closed).toBe(true);
  });
});
