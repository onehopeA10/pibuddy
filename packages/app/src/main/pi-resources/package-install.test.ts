/**
 * 包命令三道闸的回归线（TASK-012）。
 *
 * 最要紧的一条是最后那个：**未受信的 project 安装不能真的起进程**。
 * 只断言返回值 ok=false 是不够的 —— 「先跑完再报错」和「压根没跑」在返回值
 * 上长得一模一样，而前者已经把包装进磁盘了。所以这里 mock 掉 child_process
 * 并直接数 execFile 的调用次数。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiPackageCommandResult } from "@pibuddy/contract";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

import { ALLOWED_SUBCOMMANDS, assertSafeSpec, runPackageCommand } from "./package-install.js";

const execFileMock = vi.mocked(execFile);

const BASE = {
  spec: "npm:@foo/bar@1.0.0",
  cwd: "/tmp/ws",
  piCommand: { command: "pi" },
} as const;

beforeEach(() => {
  execFileMock.mockReset();
});

describe("ALLOWED_SUBCOMMANDS", () => {
  it("只有 install 与 remove 两个成员", () => {
    expect([...ALLOWED_SUBCOMMANDS]).toEqual(["install", "remove"]);
  });
});

describe("assertSafeSpec", () => {
  const injections: [string, string][] = [
    ["分号", "npm:foo; rm -rf /"],
    ["逻辑与", "npm:foo && rm -rf /"],
    ["管道符", "npm:foo | tee /etc/passwd"],
    ["反引号", "npm:foo`whoami`"],
  ];

  for (const [label, spec] of injections) {
    it(`拒绝含${label}的包规格`, () => {
      expect(() => assertSafeSpec(spec)).toThrow(/^PKG_SPEC_REJECTED/);
    });
  }

  it("拒绝前缀不在白名单内的包规格", () => {
    expect(() => assertSafeSpec("foo/bar")).toThrow(/^PKG_SPEC_REJECTED/);
  });

  it("接受 npm / git / https / ssh / 绝对路径 / 相对路径", () => {
    for (const spec of [
      "npm:@foo/bar@1.0.0",
      "git:github.com/user/repo@v1",
      "https://github.com/user/repo",
      "ssh://git@github.com/user/repo",
      "/abs/path/to/pkg",
      "./rel/path/to/pkg",
    ]) {
      expect(() => assertSafeSpec(spec)).not.toThrow();
    }
  });
});

describe("runPackageCommand", () => {
  const injections: [string, string][] = [
    ["分号", "npm:foo; rm -rf /"],
    ["逻辑与", "npm:foo && rm -rf /"],
    ["管道符", "npm:foo | tee /etc/passwd"],
    ["反引号", "npm:foo`whoami`"],
  ];

  for (const [label, spec] of injections) {
    it(`含${label}的包规格被拒，reason=injection 且没有起进程`, async () => {
      const result = await runPackageCommand({
        ...BASE,
        spec,
        subcommand: "install",
        scope: "user",
        trusted: true,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("injection");
      expect(execFileMock).toHaveBeenCalledTimes(0);
    });
  }

  it("白名单外的子命令被拒", async () => {
    const result = await runPackageCommand({
      ...BASE,
      // 故意绕过类型：真正的攻击面是运行时传进来的字符串。
      subcommand: "update" as "install",
      scope: "user",
      trusted: true,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("subcommand-not-allowed");
    expect(execFileMock).toHaveBeenCalledTimes(0);
  });

  it("project 作用域未受信时被拒，且 execFile 一次都没被调用", async () => {
    const result = await runPackageCommand({
      ...BASE,
      subcommand: "install",
      scope: "project",
      trusted: false,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-trusted");
    expect(result.output).toContain("尚未受信");
    expect(execFileMock).toHaveBeenCalledTimes(0);
  });

  it("合法入参走 execFile，argv 是参数化的且 shell 为 false", async () => {
    execFileMock.mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, "已安装\n", "");
      return undefined;
    }) as unknown as typeof execFile);

    const result = await runPackageCommand({
      ...BASE,
      subcommand: "install",
      scope: "project",
      trusted: true,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("已安装");
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const [file, argv, options] = execFileMock.mock.calls[0] as unknown as [
      string,
      string[],
      { shell?: boolean },
    ];
    expect(file).toBe("pi");
    // 包规格是独立的一个 argv 成员，永远不与子命令拼成一个字符串。
    expect(argv).toEqual(["install", "npm:@foo/bar@1.0.0", "-l"]);
    expect(options.shell).toBe(false);
  });

  it("命令失败时返回 exec-failed 并保留输出", async () => {
    execFileMock.mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(new Error("exit 1"), "", "找不到这个包\n");
      return undefined;
    }) as unknown as typeof execFile);

    const result = await runPackageCommand({
      ...BASE,
      subcommand: "remove",
      scope: "user",
      trusted: true,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("exec-failed");
    expect(result.output).toContain("找不到这个包");
  });
});

/**
 * 返回值形状与契约一致 —— 渲染进程按 `PiPackageCommandResult` 解读它，
 * 两边对不上时用户会看到一个「成功」的失败。
 */
describe("返回值契约", () => {
  it("被拒的调用同样给出 ok / output / reason 三个字段", async () => {
    const result: PiPackageCommandResult = await runPackageCommand({
      subcommand: "install",
      spec: "npm:pkg; rm -rf /",
      cwd: process.cwd(),
      scope: "user",
      trusted: true,
      piCommand: { command: process.execPath },
    });
    expect(result.ok).toBe(false);
    expect(typeof result.output).toBe("string");
    expect(result.reason).toBe("injection");
  });
});
