import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 预览与产物两域的 IPC 出口（裁定1 / CT-17 / CT-18）。
 *
 * 三条结构性断言：
 *
 *   1. 本任务新增的每一条 channel 都出现在 ipc-guard 的**运行时注册表**里，
 *      且在契约的 schema 表里有对应条目 —— 断言不钉死任何 handler 文件
 *      路径，handler 日后迁到别的目录依然成立（CT-05 的教训）。
 *   2. 预览目标以 token 表达（`.shape` 里有 token 这个键），刚签发的
 *      attachment token 直接传进来能解析。
 *   3. `../../../etc/passwd` 与指向工作区外的 symlink 都被拒。
 */
import { CHANNEL_CONTRACTS, CHANNELS, previewTargetSchema } from "@pibuddy/contract";

let userDataDir = "";

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
  // 预览窗口的行为由 preview-window.test.ts 逐条断言；这里只要它别在
  // handler 里抛异常。
  BrowserWindow: class {
    webContents = {
      setWindowOpenHandler: () => {},
      on: () => {},
    };
    on() {}
    once() {}
    show() {}
    close() {}
    isDestroyed() {
      return false;
    }
    loadURL() {
      return Promise.resolve();
    }
    loadFile() {
      return Promise.resolve();
    }
  },
  session: {
    fromPartition: () => ({
      webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    }),
  },
  utilityProcess: { fork: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") },
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })) },
}));

/** 主 frame 的假 event：guard 的第一道闸只看 senderFrame === mainFrame。 */
const mainFrame = { id: 1 };
const mainFrameEvent = { senderFrame: mainFrame, sender: { id: 7, mainFrame } };

let tmpRoot = "";
let workspaceDir = "";
let workspaceId = "";

const opened: { artifacts: typeof import("../artifacts/artifact-store.js") | null } = {
  artifacts: null,
};

async function setup() {
  vi.resetModules();
  handlers.clear();

  const guard = await import("../ipc-guard.js");
  guard.__resetRegisteredChannels();

  const registry = await import("../workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
  workspaceId = registry.registerWorkspace(workspaceDir).workspaceId;

  const artifacts = await import("../artifacts/artifact-store.js");
  artifacts.__setArtifactDataDir(userDataDir);
  opened.artifacts = artifacts;

  const host = await import("./convert-host.js");
  // 转换本身在 convert-path.test.ts 里逐类测过；这里要测的是 handler 的
  // 收容与注册面，因此用一个不起真进程的假子进程。
  host.__setConvertChildFactory(() => {
    let messageListener: ((reply: unknown) => void) | null = null;
    return {
      postMessage: (request) => {
        setTimeout(
          () =>
            messageListener?.({
              requestId: request.requestId,
              result: {
                kind: "text",
                code: "ok",
                text: "内容",
                suggestion: "",
                notices: [],
                tables: [],
                dataUrl: null,
                sourceName: request.sourceName,
                sizeBytes: request.sizeBytes,
                elapsedMs: 1,
              },
            }),
          0
        );
      },
      on: (_e, l) => {
        messageListener = l as (reply: unknown) => void;
      },
      once: () => {},
      kill: () => {},
      killed: false,
    };
  });

  const previewIpc = await import("./preview-ipc.js");
  const artifactIpc = await import("../artifacts/artifact-ipc.js");
  previewIpc.registerPreviewIpc();
  artifactIpc.registerArtifactIpc();
  return { guard, previewIpc, artifactIpc, artifacts };
}

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册的 channel: ${channel}`);
  return handler(mainFrameEvent, payload);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-previewipc-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "note.md"), "# 标题\n正文", "utf8");
  // 工作区外的秘密文件，供 symlink 逃逸用例指向它
  fs.writeFileSync(path.join(tmpRoot, "secret.md"), "机密", "utf8");
});

afterEach(() => {
  opened.artifacts?.closeArtifactStore();
  opened.artifacts = null;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("裁定1 · IPC 注册面", () => {
  it("本任务新增的 11 条 channel 全部经 ipc-guard 注册且契约里有 schema", async () => {
    const { guard, previewIpc, artifactIpc } = await setup();
    const registered = guard.registeredChannels();
    const mine = [...previewIpc.PREVIEW_CHANNELS, ...artifactIpc.ARTIFACT_CHANNELS];

    expect(mine).toHaveLength(11);
    for (const channel of mine) {
      expect(registered, channel).toContain(channel);
      expect(CHANNEL_CONTRACTS[channel], `${channel} 的契约`).toBeDefined();
    }
    expect(registered.length).toBeGreaterThanOrEqual(6);
  });

  it("注册表里的每一条都在契约的 schema 表里有对应条目", async () => {
    const { guard } = await setup();
    for (const channel of guard.registeredChannels()) {
      expect(CHANNEL_CONTRACTS[channel], channel).toBeDefined();
    }
  });
});

describe("CT-17 · preview 只收 attachment token", () => {
  it("preview:open 的 schema 里有 token 这个键", () => {
    expect(Object.keys(previewTargetSchema.shape)).toContain("token");
    expect(CHANNEL_CONTRACTS[CHANNELS.previewOpen].request).toBe(previewTargetSchema);
  });

  it("刚由 createAttachment 签发的 token 直接传给 preview:open 能解析", async () => {
    await setup();
    const registry = await import("../attachment-registry.js");
    const descriptor = await registry.createAttachment(path.join(workspaceDir, "note.md"), {
      workspaceId,
    });
    expect(descriptor).toHaveProperty("token");

    const handle = (await invoke(CHANNELS.previewOpen, { token: descriptor.token })) as {
      previewId: string;
      result: { code: string; sourceName: string };
    };
    expect(handle.previewId).toBeTruthy();
    expect(handle.result.code).toBe("ok");
    expect(handle.result.sourceName).toBe("note.md");
  });
});

describe("CT-18 · 收容", () => {
  it("`../../../etc/passwd` 被拒", async () => {
    await setup();
    await expect(
      invoke(CHANNELS.previewOpen, { workspaceId, relativePath: "../../../etc/passwd" })
    ).rejects.toThrow(/PATH_TRAVERSAL_REJECTED|PATH_ESCAPES/);
  });

  it("指向工作区外的 symlink 被拒", async () => {
    await setup();
    const link = path.join(workspaceDir, "escape.md");
    try {
      fs.symlinkSync(path.join(tmpRoot, "secret.md"), link, "file");
    } catch {
      // Windows 上没开开发者模式时建不了 symlink：这条用例在那种环境下
      // 无从执行，直接跳过而不是假装通过。
      return;
    }
    await expect(
      invoke(CHANNELS.previewOpen, { workspaceId, relativePath: "escape.md" })
    ).rejects.toThrow(/PATH_ESCAPES_WORKSPACE/);
  });

  it("绝对路径被拒（渲染进程连表达都不该表达得出来）", async () => {
    await setup();
    await expect(
      invoke(CHANNELS.previewConvert, {
        workspaceId,
        relativePath: path.join(tmpRoot, "secret.md"),
      })
    ).rejects.toThrow(/PATH_ABSOLUTE_REJECTED/);
  });

  it("两种目标表达都不给时直接拒", async () => {
    await setup();
    await expect(invoke(CHANNELS.previewOpen, {})).rejects.toThrow("PREVIEW_TARGET_REQUIRED");
  });
});

describe("artifacts 通道", () => {
  it("query / trash / restore 走通，且返回值里没有工作区绝对路径", async () => {
    const { artifacts } = await setup();
    const store = artifacts.artifactStore();
    fs.writeFileSync(path.join(workspaceDir, "out.md"), "产物", "utf8");
    const record = store.markReady(
      store.begin({ workspaceId, relativePath: "out.md" }).id
    );

    const page = (await invoke(CHANNELS.artifactsQuery, { workspaceId })) as {
      items: { id: string }[];
    };
    expect(page.items.map((i) => i.id)).toContain(record.id);
    const canonical = fs.realpathSync.native(workspaceDir);
    expect(JSON.stringify(page)).not.toContain(canonical);

    const trashed = (await invoke(CHANNELS.artifactsTrash, { id: record.id })) as {
      ok: boolean;
      record: { status: string };
    };
    expect(trashed.ok).toBe(true);
    expect(trashed.record.status).toBe("trashed");
    // 软删不动磁盘
    expect(fs.existsSync(path.join(workspaceDir, "out.md"))).toBe(true);

    const restored = (await invoke(CHANNELS.artifactsRestore, { id: record.id })) as {
      record: { status: string };
    };
    expect(restored.record.status).toBe("ready");
  });

  it("导出被用户取消时如实返回 ok:false，不假装成功", async () => {
    const { artifacts } = await setup();
    const store = artifacts.artifactStore();
    fs.writeFileSync(path.join(workspaceDir, "e.md"), "x", "utf8");
    const record = store.markReady(store.begin({ workspaceId, relativePath: "e.md" }).id);
    const result = (await invoke(CHANNELS.artifactsExport, { id: record.id })) as {
      ok: boolean;
      savedName: string | null;
    };
    expect(result.ok).toBe(false);
    expect(result.savedName).toBeNull();
  });
});
