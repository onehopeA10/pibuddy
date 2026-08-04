import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Git 补完整（coding.git v2）的判据。**大量用真 git 子进程跑真仓库**——v2 的核心
 * 不变量（危险操作要二次确认、worktree remove 前查脏、hunk 只暂存一段、push 真的把
 * 提交送到远端）没法靠打桩证明，只有让 runGit 真的起 git、再跳出去问磁盘上的 repo
 * 才作数。
 *
 * 三组可证伪的重点：
 *
 *  1. **危险操作的二次确认是真门槛**（任务点名，参照 SEC-003 allow-once）。注入
 *     「恒拒绝」的确认器 → reset --hard 后 HEAD **没动**；注入「恒允许」→ HEAD
 *     **动了**。把确认这道闸删掉，恒拒绝那条立刻红。
 *  2. **worktree remove 前的脏检查是真门槛**（任务点名）。脏 worktree 的
 *     force=false 被拒、clean 的被删——两者成对，证明拒绝是因为脏、不是一律拒。
 *  3. **hunk 级 stage 只暂存一段**：改两处、diff-hunks 得两段、stage 第 0 段后
 *     该文件同时出现在已暂存与未暂存两侧（部分暂存），且 index 里只含第 0 段的改动。
 *
 * 另加：新通道全部经第五道闸（process.git）的权限互斥、ref/remote 输入校验。
 */

const h = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => h.userData, isPackaged: false, getVersion: () => "0.0.0" },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  shell: { trashItem: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { CHANNELS } from "@pibuddy/contract";
import * as permStore from "../src/main/permission/permission-store.js";
import { __setWorkspaceDataDir, registerWorkspace } from "../src/main/workspace-registry.js";
import { getStatus } from "../src/main/git/git-repo.js";
import { assertSafeRef, assertSafeRemoteName } from "../src/main/git/git-repo.js";
import { resetHard, setDangerConfirmer, resetDangerConfirmer } from "../src/main/git/git-danger.js";
import { stashSave, stashList, stashPop } from "../src/main/git/git-stash.js";
import { log, show } from "../src/main/git/git-history.js";
import { push, fetch } from "../src/main/git/git-network.js";
import { diffHunks, stageHunk } from "../src/main/git/git-hunk.js";
import {
  worktreeCreate,
  worktreeList,
  worktreeRemove,
} from "../src/main/git/git-worktree.js";

const GIT_ID = "coding.git";
const GIT_PERM = "process.git";

/** 在 dir 里跑一条 git（测试脚手架，不是被测代码）。 */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

let tmpRoot: string;
let repoDir: string;
let workspaceId: string;

/** 建一个带两个提交、一个 5 行文件的临时 repo，注册成工作区。 */
function seedRepo(): void {
  repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  git(repoDir, "init", "-q", "-b", "main");
  git(repoDir, "config", "user.email", "t@example.com");
  git(repoDir, "config", "user.name", "Tester");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "l1\nl2\nl3\nl4\nl5\n");
  git(repoDir, "add", "a.txt");
  git(repoDir, "commit", "-q", "-m", "init commit");
  fs.writeFileSync(path.join(repoDir, "b.txt"), "hello\n");
  git(repoDir, "add", "b.txt");
  git(repoDir, "commit", "-q", "-m", "second commit");
  workspaceId = registerWorkspace(repoDir).workspaceId;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gitv2-"));
  h.userData = fs.mkdtempSync(path.join(tmpRoot, "userData-"));
  __setWorkspaceDataDir(h.userData);
  permStore.__resetPermissionStore();
  resetDangerConfirmer();
  seedRepo();
});

afterEach(() => {
  __setWorkspaceDataDir(null);
  resetDangerConfirmer();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* worktree 里可能有句柄没释放，尽力删 */
  }
});

describe("危险操作的二次确认是真门槛（reset --hard，SEC-003 allow-once 语义）", () => {
  it("确认器拒绝 → HEAD 不动；确认器允许 → HEAD 移动", async () => {
    const headBefore = git(repoDir, "rev-parse", "HEAD").trim();

    // 恒拒绝：reset --hard 必须不发生。
    setDangerConfirmer({ confirm: async () => false });
    const denied = await resetHard(workspaceId, "HEAD~1");
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain("已取消");
    expect(git(repoDir, "rev-parse", "HEAD").trim()).toBe(headBefore); // ← HEAD 没动

    // 恒允许：这一次真的 reset。
    setDangerConfirmer({ confirm: async () => true });
    const ok = await resetHard(workspaceId, "HEAD~1");
    expect(ok.ok).toBe(true);
    const headAfter = git(repoDir, "rev-parse", "HEAD").trim();
    expect(headAfter).not.toBe(headBefore); // ← 这次动了
    expect(headAfter).toBe(git(repoDir, "rev-parse", "HEAD~0").trim());
  });

  it("确认器收到的范围里带精确的 HEAD 与目标 ref（不是一句空泛提示）", async () => {
    const seen: { scope: string; operation: string }[] = [];
    setDangerConfirmer({
      confirm: async (req) => {
        seen.push({ scope: req.scope, operation: req.operation });
        return false;
      },
    });
    await resetHard(workspaceId, "HEAD~1");
    expect(seen).toHaveLength(1);
    expect(seen[0].operation).toContain("reset --hard");
    expect(seen[0].scope).toContain("HEAD~1"); // 精确范围含目标 ref
  });
});

describe("worktree remove 前的脏检查是真门槛", () => {
  async function makeWorktree(name: string): Promise<string> {
    const created = await worktreeCreate(workspaceId, name, `wt-${name}`, true);
    expect(created.ok).toBe(true);
    const list = await worktreeList(workspaceId);
    const entry = list.worktrees.find((w) => w.name === name);
    expect(entry).toBeDefined();
    return entry!.id;
  }

  it("clean worktree：force=false 直接删掉（证明拒绝不是一律拒）", async () => {
    const id = await makeWorktree("clean");
    const res = await worktreeRemove(workspaceId, id, false);
    expect(res.ok).toBe(true);
    const after = await worktreeList(workspaceId);
    expect(after.worktrees.some((w) => w.name === "clean")).toBe(false);
  });

  it("dirty worktree：force=false 被拒，force=true 才删", async () => {
    const id = await makeWorktree("dirty");
    const list = await worktreeList(workspaceId);
    // 找到脏 worktree 的落盘位置（主进程放在 userData/git-worktrees 下），弄脏它。
    const base = path.join(h.userData, "git-worktrees", workspaceId, "dirty");
    fs.writeFileSync(path.join(base, "untracked.txt"), "dirty\n"); // 未跟踪 → 脏

    const refused = await worktreeRemove(workspaceId, id, false);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("拒绝移除");
    // 仍在册（没被删）。
    expect((await worktreeList(workspaceId)).worktrees.some((w) => w.name === "dirty")).toBe(true);

    const forced = await worktreeRemove(workspaceId, id, true);
    expect(forced.ok).toBe(true);
    expect((await worktreeList(workspaceId)).worktrees.some((w) => w.name === "dirty")).toBe(false);
    void list;
  });
});

describe("hunk 级 stage：只暂存被选中的那一段", () => {
  it("改两处 → 两个 hunk → stage 第 0 段后仅它进 index，文件同时在已/未暂存两侧", async () => {
    // 用一个够长、改动分处两端的文件，保证 -U3 上下文不把两处合成一个 hunk。
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    fs.writeFileSync(path.join(repoDir, "c.txt"), lines);
    git(repoDir, "add", "c.txt");
    git(repoDir, "commit", "-q", "-m", "add c");

    const modified = lines.replace("line2\n", "LINE2\n").replace("line38\n", "LINE38\n");
    fs.writeFileSync(path.join(repoDir, "c.txt"), modified);

    const hunks = await diffHunks(workspaceId, "c.txt", false);
    expect(hunks.degraded).toBeNull();
    expect(hunks.hunks.length).toBe(2); // 两处分离的改动 = 两个 hunk

    const staged = await stageHunk(workspaceId, "c.txt", 0);
    expect(staged.ok).toBe(true);

    // index 里只应有第 0 段（LINE2），不含第 1 段（LINE38）。
    const cached = git(repoDir, "diff", "--cached");
    expect(cached).toContain("LINE2");
    expect(cached).not.toContain("LINE38");

    // 工作树↔index 仍有未暂存的第 1 段。
    const unstaged = git(repoDir, "diff");
    expect(unstaged).toContain("LINE38");

    // 逐文件状态：c.txt 同时有已暂存（x）与未暂存（y）改动。
    const status = await getStatus(workspaceId);
    const c = status.entries.find((e) => e.relativePath === "c.txt");
    expect(c).toBeDefined();
    expect(c!.x).not.toBe(" "); // 已暂存侧有改动
    expect(c!.y).not.toBe(" "); // 未暂存侧仍有改动
  });
});

describe("stash / history 在真仓库上的往返", () => {
  it("stash save → 工作树干净；list 有一条；pop → 改动回来", async () => {
    fs.writeFileSync(path.join(repoDir, "a.txt"), "l1\nCHANGED\nl3\nl4\nl5\n");
    const saved = await stashSave(workspaceId, "wip", false);
    expect(saved.ok).toBe(true);
    expect(git(repoDir, "status", "--porcelain").trim()).toBe(""); // 干净

    const list = await stashList(workspaceId);
    expect(list.entries.length).toBe(1);
    expect(list.entries[0].index).toBe(0);
    expect(list.entries[0].branch).toBe("main");

    const popped = await stashPop(workspaceId, 0);
    expect(popped.ok).toBe(true);
    expect(git(repoDir, "status", "--porcelain")).toContain("a.txt"); // 改动回来了
  });

  it("log 返回两条提交、subject 正确；show HEAD 列出改动文件", async () => {
    const res = await log(workspaceId, null, 50, 0);
    expect(res.commits.length).toBe(2);
    expect(res.commits[0].subject).toBe("second commit");
    expect(res.commits[1].subject).toBe("init commit");
    expect(res.commits[0].shortHash.length).toBeGreaterThan(0);

    const shown = await show(workspaceId, "HEAD");
    expect(shown.found).toBe(true);
    expect(shown.subject).toBe("second commit");
    expect(shown.files.some((f) => f.relativePath === "b.txt")).toBe(true);
  });

  it("log 限定单文件时只回该文件的历史", async () => {
    const res = await log(workspaceId, "b.txt", 50, 0);
    expect(res.commits.length).toBe(1);
    expect(res.commits[0].subject).toBe("second commit");
  });
});

describe("网络：对本地 bare remote 推送 / 抓取（不需要真凭据）", () => {
  it("push 把提交送进 bare repo，fetch 再抓回来", async () => {
    const bare = fs.mkdtempSync(path.join(tmpRoot, "bare-"));
    git(bare, "init", "-q", "--bare");
    git(repoDir, "remote", "add", "origin", bare);

    const pushed = await push(workspaceId, "origin", "main", true);
    expect(pushed.ok).toBe(true);
    // bare repo 里真的有了 main 分支（跳出被测代码，直接问 bare）。
    expect(git(bare, "rev-parse", "main").trim()).toBe(git(repoDir, "rev-parse", "main").trim());

    const fetched = await fetch(workspaceId, "origin");
    expect(fetched.ok).toBe(true);
  });
});

describe("新通道全部经第五道闸（process.git），且危险/网络/worktree 一条不漏", () => {
  const sample = [
    CHANNELS.gitFetch,
    CHANNELS.gitPush,
    CHANNELS.gitForcePush,
    CHANNELS.gitResetHard,
    CHANNELS.gitBranchDelete,
    CHANNELS.gitStashSave,
    CHANNELS.gitLog,
    CHANNELS.gitWorktreeCreate,
    CHANNELS.gitWorktreeRemove,
    CHANNELS.gitDiffHunks,
    CHANNELS.gitStageHunk,
  ];

  it("未授权 → 全被挡；对照：需求表外的 settings:get 放行", () => {
    for (const ch of sample) {
      expect(() => permStore.gateForChannel(ch, {})).toThrow(/IPC_PERMISSION_DENIED/);
    }
    expect(() => permStore.gateForChannel(CHANNELS.settingsGet, {})).not.toThrow();
  });

  it("allow-session 后全放行；撤销后又全拒", async () => {
    await permStore.decidePermission({
      capabilityId: GIT_ID,
      permission: GIT_PERM,
      resource: null,
      disposition: "allow-session",
      workspaceId: null,
    });
    for (const ch of sample) expect(() => permStore.gateForChannel(ch, {})).not.toThrow();

    permStore.revokePermission({
      capabilityId: GIT_ID,
      permission: GIT_PERM,
      resource: null,
      scope: "session",
      workspaceId: null,
    });
    for (const ch of sample) expect(() => permStore.gateForChannel(ch, {})).toThrow(/IPC_PERMISSION_DENIED/);
  });
});

describe("输入校验：ref / remote 白名单挡选项注入", () => {
  it("assertSafeRef 接受 HEAD~1 / origin/main / hash，拒 -x / a..b / --foo", () => {
    for (const good of ["HEAD~1", "origin/main", "abc1234", "v1.2.0", "HEAD^"]) {
      expect(() => assertSafeRef(good)).not.toThrow();
    }
    for (const bad of ["-x", "--force", "a..b", "-D", ""]) {
      expect(() => assertSafeRef(bad)).toThrow(/GIT_REF_REJECTED/);
    }
  });

  it("assertSafeRemoteName 接受 origin，拒以 - 开头与含斜杠", () => {
    expect(() => assertSafeRemoteName("origin")).not.toThrow();
    expect(() => assertSafeRemoteName("my-remote.1")).not.toThrow();
    for (const bad of ["--upload-pack=x", "-o", "a/b", ""]) {
      expect(() => assertSafeRemoteName(bad)).toThrow(/GIT_REMOTE_NAME_REJECTED/);
    }
  });
});
