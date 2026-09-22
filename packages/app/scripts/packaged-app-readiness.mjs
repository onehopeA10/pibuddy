/** 只接受本次子进程在 stderr 报告的 Chromium browser endpoint。 */
export function childCdpEndpoint(stderr) {
  const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    if (url.hostname !== "127.0.0.1" || !/^\d+$/.test(url.port) ||
        Number(url.port) < 1 || Number(url.port) > 65535 ||
        !/^\/devtools\/browser\/[a-f0-9-]{36}$/i.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

export async function waitForChildCdp(child, logs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "子进程尚未报告 CDP endpoint";
  while (Date.now() < deadline) {
    if (logs.spawnError) throw logs.spawnError;
    if (child.exitCode !== null || child.signalCode) throw new Error("进程在 CDP 就绪前退出");
    const endpoint = childCdpEndpoint(logs.stderr);
    if (endpoint) {
      try {
        const res = await fetch(`http://127.0.0.1:${endpoint.port}/json/version`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now()))),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const version = await res.json();
        if (version.webSocketDebuggerUrl === endpoint.href) return { version, port: Number(endpoint.port) };
        lastState = "CDP browser 身份与本次子进程不一致";
      } catch (error) {
        lastState = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(100, deadline - Date.now()))));
  }
  throw new Error(`等待本次进程 CDP 超时：${lastState}`);
}

function inspectAppReadiness() {
  const root = document.getElementById("app");
  const packagedPage = location.protocol === "file:" && location.pathname.endsWith("/renderer/index.html");
  const mounted = Boolean(root?.hasAttribute("data-v-app") && root.childElementCount > 0);
  const preload = typeof window.piBuddy?.pi?.prompt === "function";
  return {
    ready: packagedPage && document.readyState === "complete" && mounted && preload,
    url: location.href,
    documentState: document.readyState,
    mounted,
    preload,
  };
}

export const APP_READINESS_EXPRESSION = `(${inspectAppReadiness.toString()})()`;

export function probePage(debuggerUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(debuggerUrl);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("CDP 页面检查超时")), timeoutMs);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: APP_READINESS_EXPRESSION, returnByValue: true },
      }));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      try {
        const response = JSON.parse(String(event.data));
        if (response.id !== 1) return;
        if (response.error || response.result?.exceptionDetails) {
          throw new Error(`CDP 页面检查失败：${JSON.stringify(response.error ?? response.result.exceptionDetails)}`);
        }
        const value = response.result?.result?.value;
        if (!value || typeof value.ready !== "boolean") throw new Error("CDP 未返回页面就绪状态");
        finish(null, value);
      } catch (error) {
        finish(error);
      }
    });
    socket.addEventListener("error", () => finish(new Error("CDP 页面连接失败")), { once: true });
    socket.addEventListener("close", () => finish(new Error("CDP 页面连接提前关闭")), { once: true });
  });
}

export async function waitForApp(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "没有应用页面";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`进程在页面就绪前退出，code=${child.exitCode}, signal=${child.signalCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now()))),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = await res.json();
      const pages = Array.isArray(targets) ? targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl) : [];
      for (const page of pages) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const state = await probePage(page.webSocketDebuggerUrl, Math.min(3000, remaining));
        if (state.ready && child.exitCode === null && !child.signalCode) return state;
        lastState = JSON.stringify(state);
      }
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(400, deadline - Date.now()))));
  }
  throw new Error(`等待应用页面就绪超时：${lastState}`);
}
