/**
 * 读一组子进程的常驻内存（RSS，MB）。
 *
 * Node 没有「按 pid 读别的进程内存」的内置 API，这里按平台各走一条最便宜的路：
 *   - Linux：直接读 `/proc/<pid>/status` 的 VmRSS，零 spawn；
 *   - macOS：一次 `ps -o pid=,rss= -p a,b,c`；
 *   - Windows：每个 pid 一条 `tasklist /FI "PID eq N"` 并行跑。实测（Win11，
 *     ~530 个进程）：列全表 3.5–4.5 s，PowerShell `Get-Process` 1.7–2.3 s，
 *     单 pid 过滤 0.6–1 s 且并行不叠加；wmic 在 Win11 已移除。tasklist 的多个
 *     `/FI` 是 AND 关系，一次问不了多个 pid，只能各问各的。
 *
 * 只量 pi 进程自己（不含它派生的 shell / 工具子进程）：目标是看 V8 堆有没有
 * 一路涨，工具子进程是瞬时的、由 pi 自己收。任一 pid 读不到就缺席（不给 0，
 * 0 会把上一次的估算覆盖掉）；整体失败返回空表，调用方保留旧值。
 *
 * 不依赖第三方（pidusage 之类）：一个 15 秒一次的采样不值得为它进一个原生依赖。
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * 单次外部命令的时间上限：超时按失败处理，绝不让下一拍排队等它。
 * 取采样周期（15 s）的三分之二：机器很忙时 tasklist 会拖到数秒，正常值的
 * 几倍还够用；再长就说明这一拍已经没有参考价值。
 */
const SAMPLE_TIMEOUT_MS = 10_000;

export type RssReader = (pids: number[]) => Promise<Map<number, number>>;

function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done(() => reject(new Error(`${command} 采样超时（${SAMPLE_TIMEOUT_MS}ms）`)));
    }, SAMPLE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", (err) => done(() => reject(err)));
    child.on("close", () => done(() => resolve(out)));
  });
}

const kbToMb = (kb: number): number => Math.round(kb / 1024);

async function readLinux(pids: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const text = await readFile(`/proc/${pid}/status`, "utf8");
        const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
        if (m) result.set(pid, kbToMb(Number(m[1])));
      } catch {
        /* 进程已退出或无权限：缺席 */
      }
    })
  );
  return result;
}

/** 解析 `ps -o pid=,rss=` 输出（rss 单位 KB）。 */
export function parsePsOutput(text: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) result.set(Number(m[1]), kbToMb(Number(m[2])));
  }
  return result;
}

async function readPs(pids: number[]): Promise<Map<number, number>> {
  const out = await runCapture("ps", ["-o", "pid=,rss=", "-p", pids.join(",")]);
  return parsePsOutput(out);
}

/**
 * 解析 `tasklist /FO CSV /NH` 输出。
 *
 * 每行形如 `"electron.exe","12345","Console","1","345,678 K"`。内存列的千分位
 * 与单位随系统区域设置变化（中文系统同样是 `K`，但分隔符可能不同），因此只
 * 提取数字：tasklist 的内存列恒以 KB 计。pid 不在 wanted 里的行忽略——
 * `/FI` 没命中时 tasklist 输出的是一行提示文字而不是 CSV，同样被跳过。
 */
export function parseTasklistCsv(text: string, wanted: ReadonlySet<number>): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('"')) continue;
    const cols = line
      .slice(1, line.endsWith('"') ? -1 : undefined)
      .split('","');
    if (cols.length < 5) continue;
    const pid = Number(cols[1]);
    if (!Number.isFinite(pid) || !wanted.has(pid)) continue;
    const digits = cols[cols.length - 1].replace(/\D/g, "");
    if (!digits) continue;
    result.set(pid, kbToMb(Number(digits)));
  }
  return result;
}

async function readWindows(pids: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const out = await runCapture("tasklist", ["/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`]);
        const one = parseTasklistCsv(out, new Set([pid]));
        const mb = one.get(pid);
        if (mb !== undefined) result.set(pid, mb);
      } catch {
        /* 单个 pid 读失败：缺席，其它 pid 照常 */
      }
    })
  );
  return result;
}

/** 按当前平台读 RSS。空 pid 列表直接返回空表，不 spawn。 */
export const readProcessRssMb: RssReader = async (pids) => {
  const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (unique.length === 0) return new Map();
  if (process.platform === "linux") return readLinux(unique);
  if (process.platform === "win32") return readWindows(unique);
  return readPs(unique);
};
