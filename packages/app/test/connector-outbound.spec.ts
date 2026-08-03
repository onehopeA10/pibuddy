import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 连接器出站的可证伪判据（连接器 v1 / CON-101）。
 *
 * 三件事各自做**对拍**（临时拆掉机制、确认结果翻转），因为「断言函数被调用」
 * 挡不住恒真：
 *
 *   1. **经引擎授权**：同一次推送，无授权**必被拒**（errorCode=permission）、
 *      有授权**必放行**。用**真实的 CapabilityPermissionEngine**（纯逻辑、不碰
 *      electron）跑，授权前后翻转——拆掉 authorizeNetwork 那一关，无授权也能发。
 *   2. **域名上界**：声明白名单之外的域名，即便给了授权也被拒（errorCode=domain）。
 *   3. **SSRF 守卫 + 凭证不泄漏**：出站只走真实 safeFetch。域名解析到内网 → 被挡
 *      （ssrf）；解析到公网 → 放行。底层 fetch 抛出的、带完整 URL 的错误经 safeFetch
 *      脱敏后，凭证不出现在返回值里。
 */

// connector-outbound 不 import electron（连接器记录是 type-only 引入），因此本
// 文件无需给 electron 打桩——需要打桩才能跑的判据最后都会变成没人跑的判据。
import {
  CONNECTOR_CAPABILITY_ID,
  CONNECTOR_NETWORK_PERMISSIONS,
  type CapabilityGrant,
} from "@pibuddy/contract";
import { CapabilityPermissionEngine } from "../src/main/permission/permission-engine.js";
import {
  __setOutboundDeps,
  type SafeFetchResult,
} from "../src/main/net/outbound-guard.js";
import {
  sendThroughConnector,
  type ConnectorOutboundDeps,
} from "../src/main/connector/connector-outbound.js";
import type { ConnectorRecord } from "../src/main/connector/connector-store.js";

const SLACK: ConnectorRecord = {
  id: "c1",
  kind: "webhook",
  displayName: "研发群",
  domain: "hooks.slack.com",
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const SLACK_URL = "https://hooks.slack.com/services/T000/B000/SECRETTOKEN0000";

function jsonOk(): SafeFetchResult {
  return { status: 200, ok: true, bodyText: "{}" };
}

afterEach(() => {
  __setOutboundDeps({ lookup: null, fetch: null });
});

describe("经引擎授权（对拍：无授权必拒 / 有授权必放行）", () => {
  /** 真实引擎：manifest 声明了全部 network:<domain> 上界，workspace 授权表可变。 */
  function makeEngine(grants: CapabilityGrant[]): CapabilityPermissionEngine {
    const engine = new CapabilityPermissionEngine({
      declaredPermissions: (id) =>
        id === CONNECTOR_CAPABILITY_ID ? new Set(CONNECTOR_NETWORK_PERMISSIONS) : new Set(),
      workspaceGrants: () => grants,
    });
    return engine;
  }

  function depsWith(engine: CapabilityPermissionEngine, sentSpy: () => SafeFetchResult): ConnectorOutboundDeps {
    return {
      authorizeNetwork: (domain, workspaceId) =>
        engine.evaluate({
          capabilityId: CONNECTOR_CAPABILITY_ID,
          permission: `network:${domain}`,
          resource: null,
          workspaceId,
        }).allowed,
      loadUrl: () => SLACK_URL,
      fetch: async () => sentSpy(),
    };
  }

  it("无授权 → 被拒，且底层 fetch 一次都没被调用", async () => {
    const engine = makeEngine([]); // 空授权表
    const fetchSpy = vi.fn(jsonOk);
    const res = await sendThroughConnector(SLACK, "ws1", "hi", depsWith(engine, fetchSpy));
    expect([res.ok, res.errorCode]).toEqual([false, "permission"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("对拍：补上 workspace 授权后，同一次推送放行且真的发了出去", async () => {
    const grant: CapabilityGrant = {
      capabilityId: CONNECTOR_CAPABILITY_ID,
      permission: "network:hooks.slack.com",
      resource: null,
      grantedAt: 0,
    };
    const engine = makeEngine([grant]);
    const fetchSpy = vi.fn(jsonOk);
    const res = await sendThroughConnector(SLACK, "ws1", "hi", depsWith(engine, fetchSpy));
    expect([res.ok, res.errorCode]).toEqual([true, "ok"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("上界对拍：授权表里给了一个 manifest 未声明的域名，仍拒（越不过 manifest）", async () => {
    // 即便伪造一条 network:evil.example.com 的授权，isDeclared 也会把它挡在上界外。
    const bogus: CapabilityGrant = {
      capabilityId: CONNECTOR_CAPABILITY_ID,
      permission: "network:evil.example.com",
      resource: null,
      grantedAt: 0,
    };
    const engine = makeEngine([bogus]);
    const evil: ConnectorRecord = { ...SLACK, domain: "evil.example.com" };
    const res = await sendThroughConnector(
      evil,
      "ws1",
      "hi",
      {
        authorizeNetwork: (domain, workspaceId) =>
          engine.evaluate({
            capabilityId: CONNECTOR_CAPABILITY_ID,
            permission: `network:${domain}`,
            resource: null,
            workspaceId,
          }).allowed,
        loadUrl: () => "https://evil.example.com/hook/x",
        fetch: async () => jsonOk(),
      }
    );
    // 域名不在白名单，连授权都不问就被 domain 关拦下。
    expect([res.ok, res.errorCode]).toEqual([false, "domain"]);
  });
});

describe("域名上界（未授权域名被拒）", () => {
  it("配置了一个白名单外的域名 → domain 拒，即便授权恒真", async () => {
    const evil: ConnectorRecord = { ...SLACK, domain: "evil.example.com" };
    const res = await sendThroughConnector(evil, "ws1", "hi", {
      authorizeNetwork: () => true, // 授权恒真也不行
      loadUrl: () => "https://evil.example.com/hook/x",
      fetch: async () => jsonOk(),
    });
    expect([res.ok, res.errorCode]).toEqual([false, "domain"]);
  });
});

describe("SSRF 守卫 + 凭证不泄漏（真实 safeFetch）", () => {
  const authorized: ConnectorOutboundDeps = {
    authorizeNetwork: () => true,
    loadUrl: () => SLACK_URL,
    // 不注入 fetch：走真实 safeFetch，SSRF 判定在它内部
  };

  it("域名解析到内网 → 被出站守卫挡下（ssrf）", async () => {
    __setOutboundDeps({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    const res = await sendThroughConnector(SLACK, "ws1", "hi", authorized);
    expect([res.ok, res.errorCode]).toEqual([false, "ssrf"]);
  });

  it("对拍：同样的调用，域名解析到公网 → 放行（放行还是拦截只由地址决定）", async () => {
    let sawUrl = "";
    __setOutboundDeps({
      lookup: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (url) => {
        sawUrl = url;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const res = await sendThroughConnector(SLACK, "ws1", "hi", authorized);
    expect([res.ok, res.errorCode]).toEqual([true, "ok"]);
    // safeFetch 拿到的确实是含密令的完整 URL（凭证只在出站原语内部）
    expect(sawUrl).toContain("SECRETTOKEN");
  });

  it("底层 fetch 抛出带完整 URL 的错误 → 经 safeFetch 脱敏，凭证不出现在返回值里", async () => {
    __setOutboundDeps({
      lookup: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async () => {
        throw new Error(`fetch failed ${SLACK_URL}`);
      },
    });
    const res = await sendThroughConnector(SLACK, "ws1", "hi", authorized);
    expect(res.ok).toBe(false);
    expect(res.redactedMessage).not.toContain("SECRETTOKEN");
    expect(res.redactedMessage).not.toContain("hooks.slack.com/services");
  });
});
