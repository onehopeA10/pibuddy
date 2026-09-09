/**
 * pi 包的安装 / 卸载（TASK-012 / EXT-102）。
 *
 * 这是整个资源中心唯一一处真的会起进程的地方，所以三道闸全部在这里：
 *
 *  1. **子命令白名单**。渲染进程递过来的东西永远不是命令行，只能是
 *     `install` / `remove` 二选一 —— 参数化而不是拼字符串。
 *  2. **spec 注入校验**。`;`、`&&`、`|`、反引号、`$(`、换行、`&` 一律拒绝，
 *     且前缀必须落在 packages.md 认可的几类里。这一层就算 execFile 已经
 *     shell:false 也不能省：spec 会被写进 settings.json 再被别的工具读，
 *     多一道纯输入校验换来的是「坏值根本进不了磁盘」。
 *  3. **execFile（shell:false）**。绝不用 exec，也绝不用 `spawn(..., {shell:true})`。
 *     这两者会把 argv 交给 shell 重新分词，上面两道闸就全白做了。
 *
 * 还有一条与安全无关但同样致命的纪律：**project 作用域必须先受信**。
 * 未受信时写 `.pi/settings.json` 等于替用户接受了一个他还没同意加载的项目
 * 配置 —— 而且下次启动 pi 会照着它去装包。
 */
import { execFile, type ChildProcess } from "node:child_process";

import { piPackageSpecIssue, type PiPackageCommandResult } from "@pibuddy/contract";

/** 允许经 IPC 触发的 pi 子命令。加成员前先想清楚它会不会写磁盘。 */
export const ALLOWED_SUBCOMMANDS = ["install", "remove"] as const;

export type AllowedSubcommand = (typeof ALLOWED_SUBCOMMANDS)[number];

/** 合并输出的截断长度。够看到真因，又不至于把一整个 npm 日志灌进渲染进程。 */
const OUTPUT_LIMIT = 8000;

const DEFAULT_TIMEOUT_MS = 120_000;
const activePackageCommands = new Set<ChildProcess>();

/** 应用退出时回收仍在运行的 pi/npm/git 包管理进程。 */
export function disposePackageCommands(): void {
  for (const child of activePackageCommands) {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
  activePackageCommands.clear();
}

/**
 * 校验包规格。不合格直接抛 `PKG_SPEC_REJECTED: ...`。
 *
 * 规则定义在 contract：IPC schema、权限资源解析与 execFile 前最后一道校验
 * 必须是同一口径，不能出现「批准的是 A 语法，执行的是 B 语法」。
 */
export function assertSafeSpec(spec: string): void {
  const issue = piPackageSpecIssue(spec);
  if (issue !== null) throw new Error(`PKG_SPEC_REJECTED: ${issue}`);
}

function truncate(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n…（输出已截断）`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 跑一条 pi 包命令。
 *
 * 无论成败都返回结构化结果，绝不向上抛：这条链路的终点是一个弹窗，抛异常
 * 只会变成「什么都没发生」。
 */
export async function runPackageCommand(args: {
  subcommand: "install" | "remove";
  spec: string;
  cwd: string;
  scope: "user" | "project";
  trusted: boolean;
  npmCommand?: string[];
  piCommand: { command: string; prefixArgs?: string[]; env?: NodeJS.ProcessEnv };
  timeoutMs?: number;
}): Promise<PiPackageCommandResult> {
  if (!(ALLOWED_SUBCOMMANDS as readonly string[]).includes(args.subcommand)) {
    return { ok: false, output: "", reason: "subcommand-not-allowed" };
  }

  try {
    assertSafeSpec(args.spec);
  } catch (err) {
    return { ok: false, output: describeError(err), reason: "injection" };
  }

  if (args.scope === "project" && !args.trusted) {
    return {
      ok: false,
      output: "项目尚未受信，不能写入项目设置（.pi/settings.json）。请先信任这个项目再安装。",
      reason: "not-trusted",
    };
  }

  const argv = [...(args.piCommand.prefixArgs ?? []), args.subcommand, args.spec];
  // `-l` 让 pi 写项目设置而不是用户设置（packages.md「Install and Manage」）。
  if (args.scope === "project") argv.push("-l");

  const env: NodeJS.ProcessEnv = { ...(args.piCommand.env ?? process.env) };
  if (args.npmCommand && args.npmCommand.length > 0) {
    // 只作为诊断信息透传；真正生效的 npmCommand 由 pi 从 settings.json 读。
    env.PIBUDDY_NPM_COMMAND = args.npmCommand.join(" ");
  }

  return await new Promise<PiPackageCommandResult>((resolve) => {
    let child: ChildProcess | undefined;
    child = execFile(
      args.piCommand.command,
      argv,
      {
        cwd: args.cwd,
        env,
        timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        // shell:false 是默认值，显式写出来是为了让任何「顺手改成 true」的
        // 改动在 diff 里无所遁形。
        shell: false,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (child) activePackageCommands.delete(child);
        const output = truncate(`${stdout ?? ""}${stderr ?? ""}`);
        if (err) {
          const detail = output.length > 0 ? output : describeError(err);
          resolve({ ok: false, output: truncate(detail), reason: "exec-failed" });
          return;
        }
        resolve({ ok: true, output });
      }
    );
    // 单测中的同步 callback mock 会在赋值前完成；真实 execFile 总会返回 child。
    if (child) activePackageCommands.add(child);
  });
}
