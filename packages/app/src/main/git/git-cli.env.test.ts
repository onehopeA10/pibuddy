import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveGitInstallRoot, withGitUnixToolsOnPath } from "./git-cli.js";

describe("Git Windows PATH：补上 usr\\bin\\sh", () => {
  it("从 Git\\cmd 反推安装根（本机有 Git 时）", () => {
    const root = resolveGitInstallRoot(process.env.PATH ?? process.env.Path ?? "");
    if (!root) return;
    expect(root.toLowerCase()).toMatch(/git$/);
  });

  it("PATH 只有 Git\\cmd 时把 usr\\bin 接到最前", () => {
    const root = resolveGitInstallRoot(process.env.PATH ?? "") ?? "C:\\Program Files\\Git";
    const cmd = path.join(root, "cmd");
    const usrBin = path.join(root, "usr", "bin");
    const next = withGitUnixToolsOnPath({ PATH: cmd });
    const first = (next.PATH ?? "").split(path.delimiter)[0];
    expect(first.toLowerCase()).toBe(usrBin.toLowerCase());
  });

  it("已经有 usr\\bin 时不重复插入", () => {
    const root = resolveGitInstallRoot(process.env.PATH ?? "") ?? "C:\\Program Files\\Git";
    const usrBin = path.join(root, "usr", "bin");
    const mingw = path.join(root, "mingw64", "bin");
    const original = [usrBin, mingw, path.join(root, "cmd")].join(path.delimiter);
    const next = withGitUnixToolsOnPath({ PATH: original });
    expect(next.PATH).toBe(original);
  });
});
