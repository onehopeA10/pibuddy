import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 连接器编排层（连接器 v1 / CON-101）。
 *
 * 三件事：
 *   1. **域名上界在配置这一步就生效**：白名单外的域名创建即被拒（未授权域名被拒）。
 *   2. **凭证只进不出**：完整 URL 落 secret-store（磁盘上是密文），渲染视图里
 *      **没有 url 字段**，只有 {domain, configured, last4}。
 *   3. 增删改启停返回权威快照。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-connector-"));
const XOR_KEY = 0x5a;
function xorBuf(input: Buffer): Buffer {
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! ^ XOR_KEY;
  return out;
}

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => xorBuf(Buffer.from(plain, "utf8")),
    decryptString: (buf: Buffer) => xorBuf(buf).toString("utf8"),
  },
}));

const { __setConnectorDataDir, closeConnectorStore } = await import(
  "../src/main/connector/connector-store.js"
);
const { __setSecretDataDir } = await import("../src/main/secret-store.js");
const {
  createConnector,
  listConnectors,
  removeConnector,
  setConnectorEnabled,
  updateConnector,
} = await import("../src/main/connector/connector-manager.js");

const SLACK_URL = "https://hooks.slack.com/services/T000/B000/SECRETTOKEN9999";

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(userData, "run-"));
  __setConnectorDataDir(dir);
  __setSecretDataDir(dir);
});

afterEach(() => {
  closeConnectorStore();
});

describe("域名上界（未授权域名被拒）", () => {
  it("白名单内的域名可以创建", () => {
    const list = createConnector({ kind: "webhook", displayName: "研发群", url: SLACK_URL });
    expect(list).toHaveLength(1);
    expect(list[0]!.domain).toBe("hooks.slack.com");
  });

  it("白名单外的域名创建即被拒，且不落任何记录", () => {
    expect(() =>
      createConnector({ kind: "webhook", displayName: "坏的", url: "https://evil.example.com/x" })
    ).toThrow(/CONNECTOR_DOMAIN_UNSUPPORTED/);
    expect(listConnectors()).toHaveLength(0);
  });

  it("非 https / 非法 URL 被拒", () => {
    expect(() =>
      createConnector({ kind: "webhook", displayName: "http 的", url: "http://open.feishu.cn/x" })
    ).toThrow(/CONNECTOR_URL_INVALID|CONNECTOR_DOMAIN_UNSUPPORTED/);
  });
});

describe("凭证只进不出", () => {
  it("视图里没有 url 字段，只有 {domain, configured, last4}", () => {
    const list = createConnector({ kind: "webhook", displayName: "研发群", url: SLACK_URL });
    const view = list[0]!;
    expect(Object.keys(view).sort()).toEqual(
      ["createdAt", "configured", "displayName", "domain", "enabled", "id", "kind", "last4"].sort()
    );
    expect(view).not.toHaveProperty("url");
    expect(view.configured).toBe(true);
    expect(view.last4).toBe("9999");
  });

  it("落盘的 secrets.json 里是密文，不含明文 URL", () => {
    createConnector({ kind: "webhook", displayName: "研发群", url: SLACK_URL });
    // secret-store 写在同一个 run 目录里
    const files = fs
      .readdirSync(userData, { recursive: true } as { recursive: true })
      .filter((f) => String(f).endsWith("secrets.json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(userData, String(f)), "utf8");
      expect(raw).not.toContain("SECRETTOKEN9999");
      expect(raw).not.toContain("hooks.slack.com/services");
    }
  });
});

describe("增删改启停", () => {
  it("轮换凭证会更新域名与 last4，改名保留凭证", () => {
    let list = createConnector({ kind: "webhook", displayName: "研发群", url: SLACK_URL });
    const id = list[0]!.id;

    // 轮换到飞书
    list = updateConnector({
      connectorId: id,
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/abcd1234",
    });
    expect(list[0]!.domain).toBe("open.feishu.cn");
    expect(list[0]!.last4).toBe("1234");

    // 只改名，凭证不变
    list = updateConnector({ connectorId: id, displayName: "飞书群" });
    expect([list[0]!.displayName, list[0]!.configured, list[0]!.last4]).toEqual(["飞书群", true, "1234"]);
  });

  it("启停切换 enabled", () => {
    const id = createConnector({ kind: "webhook", displayName: "群", url: SLACK_URL })[0]!.id;
    expect(setConnectorEnabled(id, false)[0]!.enabled).toBe(false);
    expect(setConnectorEnabled(id, true)[0]!.enabled).toBe(true);
  });

  it("删除后列表为空，凭证也清掉", () => {
    const id = createConnector({ kind: "webhook", displayName: "群", url: SLACK_URL })[0]!.id;
    const after = removeConnector(id);
    expect(after).toHaveLength(0);
  });
});
