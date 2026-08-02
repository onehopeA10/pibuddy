/**
 * `~/.pi/agent/models.json` 的合并式读写（PROV-101）。
 *
 * 这个文件里的断言来自一次**真实事故**：真机验证时一条
 * `providers:remove('openai')` 把本机 models.json 里那个 provider 连同 baseUrl
 * 与内联 apiKey 一起删掉了，当时没有任何退路（auth.json 有备份，这份没有）。
 * 因此这里钉死两件事：
 *
 *   1. 任何一次写入之前都留下一份可校验的备份；
 *   2. 合并写入 —— 用户手写的其它条目（Ollama / vLLM 本地端点）一个都不丢。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderCustomRequest } from "@pibuddy/contract";

vi.mock("electron", () => ({ app: { getPath: () => userDataDir } }));

let tmpRoot = "";
let homeDir = "";
let userDataDir = "";

type AuthStore = typeof import("./auth-store.js");
type ModelsStore = typeof import("./models-store.js");
type Guard = typeof import("../net/outbound-guard.js");

async function freshModules(): Promise<{
  models: ModelsStore;
  auth: AuthStore;
  guard: Guard;
}> {
  vi.resetModules();
  const auth = await import("./auth-store.js");
  auth.__setAuthStoreDirs({ home: homeDir, userData: userDataDir });
  auth.__setProviderLogger({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    filePath: () => "",
    logFiles: () => [],
  } as never);
  const models = await import("./models-store.js");
  models.__setModelsStoreHome(homeDir);
  const guard = await import("../net/outbound-guard.js");
  // 默认让所有主机名解析到一个公网地址，否则每个用例都要真查 DNS
  guard.__setOutboundDeps({ lookup: async () => [{ address: "203.0.113.7", family: 4 }] });
  return { models, auth, guard };
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 写一份「用户手写过」的 models.json：两个本地端点 + 一个中转。 */
function seedModelsFile(models: ModelsStore): void {
  const file = models.modelsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            compat: { supportsDeveloperRole: false },
            models: [{ id: "local-a" }, { id: "local-b" }],
          },
          relay: {
            baseUrl: "https://relay.example.com/v1",
            apiKey: "sk-relay-1234",
            api: "openai-completions",
            models: [{ id: "relay-model", name: "Relay", input: ["text", "image"] }],
          },
        },
        // 用户手写的顶层字段，我们不认识但必须原样保留
        someFutureKey: { keepMe: true },
      },
      null,
      2
    )
  );
}

function customRequest(over: Partial<ProviderCustomRequest> = {}): ProviderCustomRequest {
  return {
    id: "my-endpoint",
    name: "我的中转",
    baseUrl: "https://api.example.com/v1",
    models: [],
    ...over,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pibuddy-models-"));
  homeDir = path.join(tmpRoot, "home");
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterEach(async () => {
  const guard = await import("../net/outbound-guard.js");
  guard.__setOutboundDeps({ lookup: null, fetch: null });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("[写前备份] 每一次写入都留下可校验的退路", () => {
  it("removeCustomProvider 之前先备份，备份字节与删除前的原文件相同", async () => {
    const { models, auth } = await freshModules();
    seedModelsFile(models);
    const before = sha256(models.modelsFilePath());

    models.removeCustomProvider("relay");

    const backups = fs
      .readdirSync(auth.backupDir())
      .filter((f) => f.startsWith("models."));
    expect(backups).toHaveLength(1);
    const backupPath = path.join(auth.backupDir(), backups[0]);
    expect(sha256(backupPath)).toBe(before);

    // 删除确实生效了（否则「备份和原文件一样」是平凡成立的）
    expect(models.listCustomProviders().relay).toBeUndefined();
    // 被删掉的那条可以从备份里逐字段找回来
    const recovered = JSON.parse(fs.readFileSync(backupPath, "utf8")) as {
      providers: Record<string, { baseUrl: string; apiKey: string }>;
    };
    expect(recovered.providers.relay.baseUrl).toBe("https://relay.example.com/v1");
    expect(recovered.providers.relay.apiKey).toBe("sk-relay-1234");
  });

  it("upsertCustomProvider 之前同样备份", async () => {
    const { models, auth } = await freshModules();
    seedModelsFile(models);
    const before = sha256(models.modelsFilePath());

    await models.upsertCustomProvider(customRequest());

    const backups = fs.readdirSync(auth.backupDir()).filter((f) => f.startsWith("models."));
    expect(backups).toHaveLength(1);
    expect(sha256(path.join(auth.backupDir(), backups[0]))).toBe(before);
  });

  it("原文件不存在时不备份，也不报错（第一次添加自定义端点）", async () => {
    const { models } = await freshModules();
    await expect(models.upsertCustomProvider(customRequest())).resolves.toBeTruthy();
    expect(models.listCustomProviders()["my-endpoint"]).toBeTruthy();
  });
});

describe("[合并写入] 用户手写的条目一个都不丢", () => {
  it("新增一个端点后，两个既有端点连同它们的自定义字段逐项保留", async () => {
    const { models } = await freshModules();
    seedModelsFile(models);
    const original = JSON.parse(fs.readFileSync(models.modelsFilePath(), "utf8")) as {
      providers: Record<string, unknown>;
    };

    await models.upsertCustomProvider(customRequest());

    const after = JSON.parse(fs.readFileSync(models.modelsFilePath(), "utf8")) as {
      providers: Record<string, unknown>;
      someFutureKey: unknown;
    };
    expect(after.providers.ollama).toEqual(original.providers.ollama);
    expect(after.providers.relay).toEqual(original.providers.relay);
    // 我们不认识的顶层字段也不许丢
    expect(after.someFutureKey).toEqual({ keepMe: true });
    expect(Object.keys(after.providers).sort()).toEqual([
      "my-endpoint",
      "ollama",
      "relay",
    ]);
  });

  it("覆盖已有端点时保留它自己的 apiKey 与 compat", async () => {
    const { models } = await freshModules();
    seedModelsFile(models);

    await models.upsertCustomProvider(
      customRequest({ id: "ollama", name: "本地 Ollama", baseUrl: "https://ollama.example.com/v1" })
    );

    const entry = models.listCustomProviders().ollama;
    expect(entry.apiKey).toBe("ollama");
    expect(entry.compat).toEqual({ supportsDeveloperRole: false });
    expect(entry.baseUrl).toBe("https://ollama.example.com/v1");
  });

  it("删除不存在的 provider 是 no-op，不动文件也不备份", async () => {
    const { models, auth } = await freshModules();
    seedModelsFile(models);
    const before = sha256(models.modelsFilePath());

    models.removeCustomProvider("never-existed");

    expect(sha256(models.modelsFilePath())).toBe(before);
    expect(fs.existsSync(auth.backupDir())).toBe(false);
  });

  it("文件被改坏时 readModelsFile 返回 {} 而不是抛", async () => {
    const { models } = await freshModules();
    const file = models.modelsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json at all");
    expect(models.readModelsFile()).toEqual({});
    expect(models.listCustomProviders()).toEqual({});
  });
});

describe("[落盘前校验] 地址不合格时一个字节都不写", () => {
  it("非 https 的地址被拒，且 models.json 完全没变", async () => {
    const { models } = await freshModules();
    seedModelsFile(models);
    const before = sha256(models.modelsFilePath());

    await expect(
      models.upsertCustomProvider(customRequest({ baseUrl: "http://api.example.com/v1" }))
    ).rejects.toThrow(/OUTBOUND_BLOCKED/);

    expect(sha256(models.modelsFilePath())).toBe(before);
    expect(models.listCustomProviders()["my-endpoint"]).toBeUndefined();
  });

  it("api 字段被钉成 openai-completions", async () => {
    const { models } = await freshModules();
    await models.upsertCustomProvider(customRequest());
    expect(models.listCustomProviders()["my-endpoint"].api).toBe(
      models.CUSTOM_PROVIDER_API
    );
  });

  it("新端点的 apiKey 是占位值而不是真密钥（真密钥归 auth.json）", async () => {
    const { models } = await freshModules();
    await models.upsertCustomProvider(customRequest());
    expect(models.listCustomProviders()["my-endpoint"].apiKey).toBe(
      models.CUSTOM_PROVIDER_PLACEHOLDER_KEY
    );
  });
});

describe("discoverModels", () => {
  it("发现到的模型写回文件，且保留已有条目上手写的能力字段", async () => {
    const { models, guard } = await freshModules();
    seedModelsFile(models);
    guard.__setOutboundDeps({
      fetch: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        body: null,
        text: async () =>
          JSON.stringify({ data: [{ id: "relay-model" }, { id: "brand-new-model" }] }),
      })) as never,
    });

    const found = await models.discoverModels("relay", "sk-relay-1234");

    expect(found.map((m) => m.id)).toEqual(["relay-model", "brand-new-model"]);
    // 已有条目上手写的 input 能力不该被一次发现抹掉
    expect(found[0].input).toEqual(["text", "image"]);
    expect(found[0].name).toBe("Relay");
    // 新发现的模型只有 id
    expect(found[1].input).toBeUndefined();

    const persisted = models.listCustomProviders().relay.models ?? [];
    expect(persisted.map((m) => m.id)).toEqual(["relay-model", "brand-new-model"]);
  });

  it("端点返回非 OpenAI 形状时报 DISCOVER_FAILED，不写坏文件", async () => {
    const { models, guard } = await freshModules();
    seedModelsFile(models);
    const before = sha256(models.modelsFilePath());
    guard.__setOutboundDeps({
      fetch: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        body: null,
        text: async () => "<html>not json</html>",
      })) as never,
    });

    await expect(models.discoverModels("relay")).rejects.toThrow(/DISCOVER_FAILED/);
    expect(sha256(models.modelsFilePath())).toBe(before);
  });

  it("provider 不存在时抛 PROVIDER_NOT_FOUND", async () => {
    const { models } = await freshModules();
    await expect(models.discoverModels("nope")).rejects.toThrow(/PROVIDER_NOT_FOUND/);
  });
});
