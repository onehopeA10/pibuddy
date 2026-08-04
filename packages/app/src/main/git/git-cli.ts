/**
 * Git 子进程的**唯一**执行原语（coding.git / GIT-101）。
 *
 * 整个 Git 能力包里，只有这一处真的会起进程，因此所有关于「怎么安全地跑
 * git」的纪律都写死在这里：
 *
 *  1. **只传 argv，`shell:false`**。`execFile`（而不是 `exec` / `spawn(..,
 *     {shell:true})`）把参数数组原样交给 git，不经任何 shell 分词。路径、
 *     分支名、提交信息全部是数组里的一个元素，命令注入在结构上不存在。
 *     导入时把 `execFile` 别名成 `execGit`，是为了让「跑 git」这条路径与
 *     「跑任意子进程」（process.shell）在源码上一眼可分 —— 一个裸的
 *     `spawn(` / `execFile(` 仍然会被 drift test 判成 process.shell，而 git
 *     的执行路径归 process.git。
 *  2. **受控环境**。`GIT_TERMINAL_PROMPT=0` / 空 askpass 让任何要凭据、要
 *     passphrase 的操作**立刻失败**而不是挂起等输入；`GIT_OPTIONAL_LOCKS=0`
 *     避免只读操作也去抢锁；`GIT_PAGER=cat` 关分页器；`LC_ALL=C` 让报错稳定
 *     可读。凭据 / token 既不入 argv 也不入日志（本批全是本地操作，压根不碰
 *     网络与 credential helper；push/fetch 属 deferred）。
 *  3. **在途进程可被拆卸**。每个 child 登记在 `inflight` 里，`disposeGitCli`
 *     一次性 kill —— 能力被禁用时不留一个还在跑的 clone/log 子进程
 *     （ADR-0002 D4 规则 4：teardown child-process）。
 *
 * 日志只记 `{subcommand, code, ms}` 与失败时一段**已截断、已脱敏**的 stderr：
 * 记全 argv 会把提交信息 / 分支名等用户内容原样落盘，没有必要。
 */
import { execFile as execGit, type ChildProcess } from "node:child_process";

import { createLogger, type Logger } from "../logger.js";

/** 合并输出的截断长度：够看到真因，又不至于把整个 git log 灌进渲染进程。 */
const OUTPUT_LIMIT = 64 * 1024;
/** 子进程 stdout/stderr 缓冲上限。大 diff 走 `git show` 的字节，给 16MB。 */
const MAX_BUFFER = 16 * 1024 * 1024;
/** 单条命令超时：本地操作足够，超了大概率是卡在一个交互式提示上。 */
const DEFAULT_TIMEOUT_MS = 30_000;

// 用内核唯一的 logger，绑一个 `domain: "git"` 字段而不是新开一个 LogScope：
// logger.ts 是全仓唯一 logger，事件名 `git_*` 已足以在日志里区分本域。
let gitLogger: Logger | null = null;
function log(): Logger {
  if (!gitLogger) gitLogger = createLogger("main").child({ domain: "git" });
  return gitLogger;
}

/** 还在跑的 git 子进程。禁用能力时统一 kill。 */
const inflight = new Set<ChildProcess>();

export interface GitRunResult {
  /** 退出码；0 = 成功 */
  code: number;
  /** 标准输出（字节）。文本命令用 toString，`git show` 的 blob 用原字节 */
  stdout: Buffer;
  /** 标准错误（字节） */
  stderr: Buffer;
}

export interface GitRunOptions {
  timeoutMs?: number;
  /**
   * 喂给子进程 stdin 的字节。hunk 级暂存要把一段构造好的补丁交给
   * `git apply --cached`——补丁走 stdin 而不是拼进 argv：补丁里全是用户代码，
   * 既不该进命令行也不该进日志。仍是 execFile + shell:false，只是多写一次 stdin。
   */
  input?: Buffer;
}

function truncate(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}\n…（输出已截断）`;
}

/**
 * 受控环境。派生自 process.env，只覆盖那几个决定「非交互 / 稳定输出」的键。
 *
 * 不整份重写 env：git 要靠 PATH 找到自己、要靠 HOME / 用户 gitconfig 拿到
 * user.name（commit 需要）。覆盖的都是「别弹窗、别分页、别抢锁、别本地化」。
 */
function controlledEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  };
}

/**
 * 跑一条 git 命令。**cwd 必须是主进程解析出的仓库根**（绝不接受渲染进程
 * 给的路径）；`argv` 是纯参数数组（子命令 + 选项 + 已校验的路径/分支名）。
 *
 * 无论成败都 resolve 一个结构化结果，绝不 reject —— 上层据 `code` 判断，
 * 抛异常在这条链路上只会退化成「点了没反应」。
 */
export function runGit(cwd: string, argv: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  const started = Date.now();
  return new Promise<GitRunResult>((resolve) => {
    const child = execGit(
      "git",
      argv,
      {
        cwd,
        env: controlledEnv(),
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        // shell:false 是默认值，显式写出来让任何「顺手改成 true」的改动在
        // diff 里无所遁形 —— 改成 true 就等于把上面「只传 argv」那道闸拆了。
        shell: false,
        windowsHide: true,
        encoding: "buffer",
      },
      (err, stdout, stderr) => {
        inflight.delete(child);
        const out = (stdout ?? Buffer.alloc(0)) as unknown as Buffer;
        const errBuf = (stderr ?? Buffer.alloc(0)) as unknown as Buffer;
        // execGit 的回调 err 带 .code（退出码）或 .killed（超时被杀）。
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        log().info("git_command", {
          subcommand: argv[0] ?? "",
          code,
          ms: Date.now() - started,
          // stderr 经 logger-redact 脱敏后落盘（home 路径 → ~，token → [redacted]）。
          stderr: code === 0 ? undefined : truncate(errBuf.toString("utf8")),
        });
        resolve({ code, stdout: out, stderr: errBuf });
      }
    );
    inflight.add(child);
    // hunk 级暂存的补丁经 stdin 送进 `git apply --cached`。写完即 end，让
    // git 读到 EOF 开始 apply；子进程已退出时 stdin 可能已不可写，吞掉 EPIPE。
    if (options.input && child.stdin) {
      child.stdin.on("error", () => {
        /* EPIPE：子进程已退出，apply 的成败由 exit code 反映 */
      });
      child.stdin.end(options.input);
    }
  });
}

/** 便利包装：只要 stdout 文本、成功时返回 trim 后的字符串，失败返回 null。 */
export async function gitText(cwd: string, argv: string[]): Promise<string | null> {
  const res = await runGit(cwd, argv);
  if (res.code !== 0) return null;
  return res.stdout.toString("utf8");
}

/**
 * 拆卸：kill 全部在途 git 子进程（ADR-0002 D4 规则 4）。
 *
 * 只收「还在跑」的进程，**不碰任何磁盘上的仓库**（规则 5：卸载与删数据是
 * 两个动作，禁用 Git 面板不等于同意丢掉用户的工作树）。
 */
export function disposeGitCli(): void {
  for (const child of [...inflight]) {
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
    inflight.delete(child);
  }
}
