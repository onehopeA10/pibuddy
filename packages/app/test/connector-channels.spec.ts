import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 三个真实渠道适配器的可证伪判据（connector.feishu / slack / telegram）。
 *
 * 沿用 connector-outbound.spec 的手法——每件事都做**对拍**（临时翻转条件、确认结果
 * 跟着翻转），因为「断言函数被调用」挡不住恒真：
 *
 *   1. **消息体按平台文档拼**：真的把 body 抓下来，比对飞书 msg_type/content、
 *      Slack/Telegram 的 {text}——拼错就红。
 *   2. **响应判读看业务状态**：飞书 code≠0 / Telegram ok:false 即便 HTTP 200 也判失败；
 *      对拍 code:0 / ok:true 才算送达。
 *   3. **域名上界按适配器隔离（未授权域名被拒）**：飞书连接器配了 Slack 的 host，
 *      即便授权恒真也被 domain 关拒——跨平台发送越不过各自那一条白名单。
 *   4. **经引擎授权（对拍）**：用**真实** CapabilityPermissionEngine，飞书连接器无
 *      workspace 授权必拒（fetch 一次没调）、有授权必放行。
 *   5. **SSRF 守卫（对拍）**：Telegram 出站走真实 safeFetch，域名解析到内网被挡（ssrf）、
 *      解析到公网放行——放行 / 拦截只由地址决定。
 *   6. **入站防回环 / 去重（对拍）**：三平台各按自己的字段识别「我们自己发的」
 *      （飞书 sender_type、Slack bot_id、Telegram from.is_bot）→ 交给守卫判 loop；
 *      对拍换成真人消息则被接受。同一 messageId 再来一次判 duplicate。
 */
import {
  FEISHU_CAPABILITY_ID,
  TELEGRAM_CAPABILITY_ID,
  type CapabilityGrant,
  type SafeFetchResult,
} from "@pibuddy/contract";
import { CapabilityPermissionEngine } from "../src/main/permission/permission-engine.js";
import { __setOutboundDeps } from "../src/main/net/outbound-guard.js";
import {
  sendThroughConnector,
  type ConnectorOutboundDeps,
} from "../src/main/connector/connector-outbound.js";
import type { ConnectorRecord } from "../src/main/connector/connector-store.js";
import {
  feishuAdapter,
  slackAdapter,
  telegramAdapter,
} from "../src/main/connector/adapters/index.js";
import { IngestGuard, type InboundMessage } from "../src/main/connector/connector-ingest.js";

// ------------------------------------------------------------ 固定装置

function record(kind: ConnectorRecord["kind"], domain: string): ConnectorRecord {
  return { id: "c1", kind, displayName: "群", domain, enabled: true, createdAt: 0, updatedAt: 0 };
}

const FEISHU = record("feishu", "open.feishu.cn");
const FEISHU_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/SECRETHOOKTOKEN";
const TELEGRAM = record("telegram", "api.telegram.org");
const TELEGRAM_URL = "https://api.telegram.org/botSECRET:TOKEN/sendMessage?chat_id=42";

function jsonResult(bodyText: string): SafeFetchResult {
  return { status: 200, ok: true, bodyText };
}

afterEach(() => {
  __setOutboundDeps({ lookup: null, fetch: null });
});

// ------------------------------------------------------------ 1. 消息体按平台文档拼

describe("出站消息体按平台文档拼（真的把 body 抓下来比对）", () => {
  async function captureBody(rec: ConnectorRecord, url: string): Promise<unknown> {
    let sent: unknown = null;
    const deps: ConnectorOutboundDeps = {
      authorizeNetwork: () => true,
      loadUrl: () => url,
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body ?? "null"));
        return jsonResult('{"code":0,"ok":true}');
      },
    };
    await sendThroughConnector(rec, "ws1", "hi", deps);
    return sent;
  }

  it("飞书 = {msg_type:'text', content:{text}}", async () => {
    expect(await captureBody(FEISHU, FEISHU_URL)).toEqual({
      msg_type: "text",
      content: { text: "hi" },
    });
  });

  it("Telegram = {text}（chat_id 随凭证 URL，不进 body）", async () => {
    expect(await captureBody(TELEGRAM, TELEGRAM_URL)).toEqual({ text: "hi" });
  });

  it("Slack = {text}", () => {
    expect(slackAdapter.formatBody("hi")).toEqual({ text: "hi" });
  });
});

// ------------------------------------------------------------ 2. 响应判读看业务状态

describe("响应判读：HTTP 200 不等于业务成功（对拍）", () => {
  it("飞书 code≠0 → 失败；对拍 code:0 → 成功", () => {
    expect(feishuAdapter.checkResponse(jsonResult('{"code":19001,"msg":"invalid"}')).ok).toBe(false);
    expect(feishuAdapter.checkResponse(jsonResult('{"code":0,"msg":"success"}')).ok).toBe(true);
  });

  it("Telegram ok:false → 失败；对拍 ok:true → 成功", () => {
    expect(telegramAdapter.checkResponse(jsonResult('{"ok":false,"description":"chat not found"}')).ok).toBe(false);
    expect(telegramAdapter.checkResponse(jsonResult('{"ok":true,"result":{}}')).ok).toBe(true);
  });

  it("飞书出站：上游回 code≠0 时整次推送判失败（即便 HTTP 200）", async () => {
    const deps: ConnectorOutboundDeps = {
      authorizeNetwork: () => true,
      loadUrl: () => FEISHU_URL,
      fetch: async () => jsonResult('{"code":9499,"msg":"bot forbidden"}'),
    };
    const res = await sendThroughConnector(FEISHU, "ws1", "hi", deps);
    expect([res.ok, res.errorCode]).toEqual([false, "network"]);
  });
});

// ------------------------------------------------------------ 3. 域名上界按适配器隔离

describe("域名上界按适配器隔离（未授权域名被拒）", () => {
  it("飞书连接器配了 Slack 的 host → domain 拒，即便授权恒真", async () => {
    const crossed = record("feishu", "hooks.slack.com");
    const res = await sendThroughConnector(crossed, "ws1", "hi", {
      authorizeNetwork: () => true, // 授权恒真也不行
      loadUrl: () => "https://hooks.slack.com/services/x",
      fetch: async () => jsonResult("{}"),
    });
    expect([res.ok, res.errorCode]).toEqual([false, "domain"]);
  });
});

// ------------------------------------------------------------ 4. 经引擎授权（对拍）

describe("飞书出站经引擎授权（对拍：无授权必拒 / 有授权必放行）", () => {
  function engineWith(grants: CapabilityGrant[]): CapabilityPermissionEngine {
    return new CapabilityPermissionEngine({
      declaredPermissions: (id) =>
        id === FEISHU_CAPABILITY_ID ? new Set(["network:open.feishu.cn"]) : new Set(),
      workspaceGrants: () => grants,
    });
  }
  function deps(engine: CapabilityPermissionEngine, spy: () => SafeFetchResult): ConnectorOutboundDeps {
    return {
      authorizeNetwork: (domain, workspaceId) =>
        engine.evaluate({
          capabilityId: FEISHU_CAPABILITY_ID,
          permission: `network:${domain}`,
          resource: null,
          workspaceId,
        }).allowed,
      loadUrl: () => FEISHU_URL,
      fetch: async () => spy(),
    };
  }

  it("无授权 → permission，底层 fetch 一次没被调用", async () => {
    const spy = vi.fn(() => jsonResult('{"code":0}'));
    const res = await sendThroughConnector(FEISHU, "ws1", "hi", deps(engineWith([]), spy));
    expect([res.ok, res.errorCode]).toEqual([false, "permission"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("对拍：补上 network:open.feishu.cn 授权后，同一次推送放行且真的发了", async () => {
    const grant: CapabilityGrant = {
      capabilityId: FEISHU_CAPABILITY_ID,
      permission: "network:open.feishu.cn",
      resource: null,
      grantedAt: 0,
    };
    const spy = vi.fn(() => jsonResult('{"code":0}'));
    const res = await sendThroughConnector(FEISHU, "ws1", "hi", deps(engineWith([grant]), spy));
    expect([res.ok, res.errorCode]).toEqual([true, "ok"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("上界对拍：伪造一条 network:api.telegram.org 授权也越不过飞书 manifest", async () => {
    // 授权表里给的是 Telegram 的域名，但飞书能力没声明它 → isDeclared 挡在上界外。
    const bogus: CapabilityGrant = {
      capabilityId: FEISHU_CAPABILITY_ID,
      permission: "network:api.telegram.org",
      resource: null,
      grantedAt: 0,
    };
    const res = await sendThroughConnector(FEISHU, "ws1", "hi", deps(engineWith([bogus]), () => jsonResult('{"code":0}')));
    expect([res.ok, res.errorCode]).toEqual([false, "permission"]);
  });
});

// ------------------------------------------------------------ 5. SSRF 守卫（对拍）

describe("Telegram 出站 SSRF 守卫（真实 safeFetch，对拍）", () => {
  const authorized: ConnectorOutboundDeps = {
    authorizeNetwork: () => true,
    loadUrl: () => TELEGRAM_URL,
  };

  it("域名解析到内网 → 被出站守卫挡下（ssrf）", async () => {
    __setOutboundDeps({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    const res = await sendThroughConnector(TELEGRAM, "ws1", "hi", authorized);
    expect([res.ok, res.errorCode]).toEqual([false, "ssrf"]);
  });

  it("对拍：解析到公网 → 放行（且 safeFetch 拿到的是含密令的完整 URL）", async () => {
    let sawUrl = "";
    __setOutboundDeps({
      lookup: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (url) => {
        sawUrl = url;
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const res = await sendThroughConnector(TELEGRAM, "ws1", "hi", authorized);
    expect([res.ok, res.errorCode]).toEqual([true, "ok"]);
    expect(sawUrl).toContain("SECRET:TOKEN");
  });

  it("凭证不泄漏：底层错误带完整 URL，经 safeFetch 脱敏后不出现在返回值", async () => {
    __setOutboundDeps({
      lookup: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async () => {
        throw new Error(`fetch failed ${TELEGRAM_URL}`);
      },
    });
    const res = await sendThroughConnector(TELEGRAM, "ws1", "hi", authorized);
    expect(res.ok).toBe(false);
    expect(res.redactedMessage).not.toContain("SECRET:TOKEN");
  });
});

// ------------------------------------------------------------ 6. 入站解析：防回环 / 去重 / 握手

describe("入站解析：url_verification 握手", () => {
  it("飞书 url_verification → challenge", () => {
    const p = feishuAdapter.parseInbound({ type: "url_verification", challenge: "fs-abc" });
    expect(p).toEqual({ type: "challenge", challenge: "fs-abc" });
  });
  it("Slack url_verification → challenge", () => {
    const p = slackAdapter.parseInbound({ type: "url_verification", challenge: "sl-xyz" });
    expect(p).toEqual({ type: "challenge", challenge: "sl-xyz" });
  });
});

describe("入站防回环（对拍：机器人自己的消息判 loop / 真人消息被接受）", () => {
  const guard = () => new IngestGuard();
  function feed(parse: ReturnType<typeof feishuAdapter.parseInbound>): InboundMessage {
    if (parse.type !== "message") throw new Error("expected message");
    return {
      connectorId: "c1",
      messageId: parse.messageId,
      workspaceId: "ws1",
      fromSelf: parse.fromSelf,
      text: parse.text,
      attachmentCount: parse.attachmentCount,
      attachmentBytes: parse.attachmentBytes,
      at: 1000,
    };
  }

  it("飞书：sender_type 非 user（机器人）→ fromSelf → loop；对拍：user → 接受", () => {
    const content = JSON.stringify({ text: "hi" });
    const bot = feishuAdapter.parseInbound({
      event: { sender: { sender_type: "app" }, message: { message_id: "om_1", content } },
    });
    const human = feishuAdapter.parseInbound({
      event: { sender: { sender_type: "user" }, message: { message_id: "om_2", content } },
    });
    expect(guard().accept(feed(bot)).reason).toBe("loop");
    expect(guard().accept(feed(human)).accepted).toBe(true);
  });

  it("Slack：带 bot_id → loop；对拍：无 bot_id → 接受", () => {
    const bot = slackAdapter.parseInbound({
      type: "event_callback",
      event: { type: "message", text: "hi", ts: "1", bot_id: "B1" },
    });
    const human = slackAdapter.parseInbound({
      type: "event_callback",
      event: { type: "message", text: "hi", ts: "2", client_msg_id: "u2" },
    });
    expect(guard().accept(feed(bot)).reason).toBe("loop");
    expect(guard().accept(feed(human)).accepted).toBe(true);
  });

  it("Telegram：from.is_bot → loop；对拍：真人 → 接受", () => {
    const bot = telegramAdapter.parseInbound({
      update_id: 1,
      message: { message_id: 1, from: { is_bot: true }, text: "hi" },
    });
    const human = telegramAdapter.parseInbound({
      update_id: 2,
      message: { message_id: 2, from: { is_bot: false }, text: "hi" },
    });
    expect(guard().accept(feed(bot)).reason).toBe("loop");
    expect(guard().accept(feed(human)).accepted).toBe(true);
  });

  it("去重：同一 update_id 再投一次 → duplicate", () => {
    const g = guard();
    const first = telegramAdapter.parseInbound({
      update_id: 7,
      message: { message_id: 7, from: { is_bot: false }, text: "hi" },
    });
    expect(g.accept(feed(first)).accepted).toBe(true);
    expect(g.accept(feed(first)).reason).toBe("duplicate");
  });
});
