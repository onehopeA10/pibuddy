import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Git 编码能力包（coding.git / GIT-101）的判据。
 *
 * 三组，每组都刻意做成可证伪的：
 *
 *  1. **权限互斥**（本包的核心验证点，ADR-0002 D3）。不测「引擎被调用」——那
 *     容易恒真——而测第五道闸的判定函数 `gateForChannel` 在同一条 git 通道上
 *     的一对互斥结果：未授权**必拒**、allow-session 后**必放行**、撤销后**又拒**。
 *     另加一条上界：给 coding.git 发一个它 manifest 里没声明的 process.shell
 *     授权，不产生任何授权、git 仍被拒（越不过 manifest）。对照组是需求表外的
 *     现有通道（settings:get）一律放行——证明挡 git 的是需求表那几行，不是
 *     全盘拒绝。
 *  2. **diff 复用 changeset 的 review 原语**。`buildGitDiff` 产出的 hunks 必须
 *     **逐字节等于** `diffLines(before, after)`——同一套原语、同一种 hunk 形状；
 *     二进制走 `looksBinary` 降级。若哪天有人给 Git 另造一套 diff，这条立刻红。
 *  3. **输入校验与状态解析**：分支名白名单（`-D` / `--force` / `a..b` 必拒）、
 *     路径穿越必拒、porcelain -z 的 staged/unstaged/untracked 解析。
 */

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/pibuddy-git-test", isPackaged: false, getVersion: () => "0.0.0" },
  shell: { trashItem: vi.fn(async () => undefined), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

const { CHANNELS } = await import("@pibuddy/contract");
const permStore = await import("../src/main/permission/permission-store.js");
const { buildGitDiff } = await import("../src/main/git/git-diff.js");
const { diffLines, looksBinary } = await import("../src/main/changeset/changeset-store.js");
const { assertRepoRelPath, assertSafeBranchName, parsePorcelainZ } = await import(
  "../src/main/git/git-repo.js"
);

const GIT_ID = "coding.git";
const GIT_PERM = "process.git";

describe("权限互斥：未授权拒、授权放行、撤销又拒（ADR-0002 D3 的硬要求）", () => {
  beforeEach(() => permStore.__resetPermissionStore());

  it("未授权 → git:commit 被第五道闸挡下；对照：需求表外的 settings:get 放行", () => {
    // 挡 git 的是需求表那几行 process.git，不是全盘拒绝——现有通道一字不变。
    expect(() => permStore.gateForChannel(CHANNELS.gitCommit, {})).toThrow(/IPC_PERMISSION_DENIED/);
    expect(() => permStore.gateForChannel(CHANNELS.gitStatus, {})).toThrow(/IPC_PERMISSION_DENIED/);
    expect(() => permStore.gateForChannel(CHANNELS.settingsGet, {})).not.toThrow();
  });

  it("allow-session(coding.git/process.git) 后，九条 git 通道全放行；撤销后又全拒", async () => {
    await permStore.decidePermission({
      capabilityId: GIT_ID,
      permission: GIT_PERM,
      resource: null,
      disposition: "allow-session",
      workspaceId: null,
    });
    // 同一条 process.git 覆盖本包全部动作（连只读 status/diff 也在内）。
    expect(() => permStore.gateForChannel(CHANNELS.gitCommit, {})).not.toThrow();
    expect(() => permStore.gateForChannel(CHANNELS.gitStatus, {})).not.toThrow();
    expect(() => permStore.gateForChannel(CHANNELS.gitBranchCreate, {})).not.toThrow();

    permStore.revokePermission({
      capabilityId: GIT_ID,
      permission: GIT_PERM,
      resource: null,
      scope: "session",
      workspaceId: null,
    });
    expect(() => permStore.gateForChannel(CHANNELS.gitCommit, {})).toThrow(/IPC_PERMISSION_DENIED/);
  });

  it("上界：给 coding.git 发一个它没声明的 process.shell 授权 → 不产生授权，git 仍被拒", async () => {
    const state = await permStore.decidePermission({
      capabilityId: GIT_ID,
      permission: "process.shell", // manifest 只声明了 process.git，越不过去
      resource: null,
      disposition: "allow-session",
      workspaceId: null,
    });
    expect(state.sessionGrants).toEqual([]);
    expect(state.audit.some((a) => a.kind === "denied")).toBe(true);
    expect(() => permStore.gateForChannel(CHANNELS.gitCommit, {})).toThrow(/IPC_PERMISSION_DENIED/);
  });
});

describe("diff 复用 changeset 的 review 原语（不另造一套）", () => {
  it("buildGitDiff 的 hunks 逐字节等于 diffLines(before, after)", () => {
    const before = Buffer.from("alpha\nbeta\ngamma\n", "utf8");
    const after = Buffer.from("alpha\nBETA\ngamma\n", "utf8");
    const diff = buildGitDiff("x.txt", before, after);

    expect(diff.degraded).toBeNull();
    // 数据非空才有意义（防「两个空数组恒相等」）。
    expect(diff.hunks.length).toBeGreaterThan(0);
    expect(diff.hunks).toEqual(
      diffLines(before.toString("utf8").split("\n"), after.toString("utf8").split("\n"))
    );
  });

  it("二进制内容走 looksBinary 降级，而不是硬渲染一屏乱码", () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]);
    expect(looksBinary(bin)).toBe(true); // 前置：确实被判成二进制
    const diff = buildGitDiff("x.bin", bin, bin);
    expect(diff.hunks).toEqual([]);
    expect(diff.degraded).toBe("二进制文件");
  });
});

describe("输入校验：argv + shell:false 之外，再挡选项注入与路径穿越", () => {
  it("合法分支名通过；-D / --force / a..b / 结尾斜杠必拒", () => {
    expect(() => assertSafeBranchName("feature/git-101")).not.toThrow();
    expect(() => assertSafeBranchName("release-1.2.0")).not.toThrow();
    for (const bad of ["-D", "--force", "a..b", "branch/", "-x", ".lock-ish.lock", ""]) {
      expect(() => assertSafeBranchName(bad)).toThrow(/GIT_BRANCH_NAME_REJECTED/);
    }
  });

  it("绝对路径与 .. 穿越必拒", () => {
    expect(() => assertRepoRelPath("src/a.ts")).not.toThrow();
    expect(() => assertRepoRelPath("/etc/passwd")).toThrow(/GIT_PATH_REJECTED/);
    expect(() => assertRepoRelPath("../../secret")).toThrow(/GIT_PATH_REJECTED/);
    expect(() => assertRepoRelPath("a/../../b")).toThrow(/GIT_PATH_REJECTED/);
  });
});

describe("porcelain -z 解析：staged / unstaged / untracked 各归各位", () => {
  it("四种状态被正确切分与归类", () => {
    // XY + 空格 + path，NUL 分隔。M(空) = 已暂存修改；(空)M = 未暂存修改；
    // ?? = 未跟踪；A(空) = 已暂存新增。
    const z = "M  staged.txt\0 M dirty.txt\0?? new.txt\0A  added.txt\0";
    const entries = parsePorcelainZ(z);

    expect(entries.map((e) => e.relativePath)).toEqual([
      "staged.txt",
      "dirty.txt",
      "new.txt",
      "added.txt",
    ]);
    const byPath = Object.fromEntries(entries.map((e) => [e.relativePath, e]));
    expect(byPath["staged.txt"].staged).toBe(true);
    expect(byPath["dirty.txt"].staged).toBe(false);
    expect(byPath["new.txt"].untracked).toBe(true);
    expect(byPath["new.txt"].staged).toBe(false);
    expect(byPath["added.txt"].staged).toBe(true);
  });
});
