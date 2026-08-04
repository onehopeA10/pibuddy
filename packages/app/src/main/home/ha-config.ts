/**
 * HA 端点配置的落盘（home.assistant / 智能家居 Phase B）。
 *
 * ## 分区与生命周期（ADR-0002 D4 规则 3 / 规则 5）
 *
 * 配置按 capabilityId 分区：host/port 住在 `userData/home-assistant/config.json`，
 * 文件内再按 workspaceId 分键——不同工作区可以指向不同的 HA 实例（家里与
 * 工作室各一台是预期用法）。**停用能力不删这份文件**（规则 5）。
 *
 * ## token 不在这份文件里
 *
 * long-lived access token 归 secret-store（safeStorage 加密、只进不出），槽位
 * 按 workspaceId 派生。这份 JSON 里只有 host/port——它们本来就要显示在设置面
 * 与授权确认框上，不敏感；token 的明文只在主进程组 Authorization 头的那一刻
 * 出现，没有任何 IPC 通道能取回它。
 *
 * ## host/port 落盘前的形态校验
 *
 * saveHaConfig 复用契约的 parseLocalEndpointResource：能落盘的 host:port 与
 * 能被授权的 host:port 是同一个形态集合，两边不可能各认一套。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { parseLocalEndpointResource } from "@pibuddy/contract";

import { writeJsonAtomic } from "../fs-atomic.js";
import { describeSecret, loadSecret, saveSecret } from "../secret-store.js";

const HOME_DATA_DIR = "home-assistant";
const CONFIG_FILENAME = "config.json";

export interface HaEndpointConfig {
  /** 小写化后的 host（IPv4 点分或主机名） */
  host: string;
  /** 1-65535 */
  port: number;
  /** 主进程写入时间戳（Unix ms） */
  updatedAt: number;
}

interface ConfigFile {
  version: number;
  /** workspaceId → 端点配置 */
  workspaces: Record<string, HaEndpointConfig>;
}

/** 测试注入用的数据目录；生产环境恒为 null，走 app.getPath("userData")。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把配置落盘目录指向临时目录。 */
export function __setHomeConfigDataDir(dir: string | null): void {
  dataDirOverride = dir;
}

function configPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, HOME_DATA_DIR, CONFIG_FILENAME);
}

function readFileOrEmpty(): ConfigFile {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const candidate = raw as Partial<ConfigFile>;
      if (candidate.workspaces && typeof candidate.workspaces === "object") {
        const workspaces: Record<string, HaEndpointConfig> = {};
        for (const [wsId, value] of Object.entries(candidate.workspaces)) {
          const entry = value as Partial<HaEndpointConfig>;
          // 被手改坏的条目按「未配置」处理，不让一条坏记录拖垮整个文件。
          if (typeof entry?.host !== "string" || typeof entry?.port !== "number") continue;
          if (parseLocalEndpointResource(`${entry.host}:${entry.port}`) === null) continue;
          workspaces[wsId] = {
            host: entry.host,
            port: entry.port,
            updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
          };
        }
        return { version: candidate.version ?? 1, workspaces };
      }
    }
  } catch {
    /* 文件不存在 / 被改坏：当成空表，下一次保存会重建 */
  }
  return { version: 1, workspaces: {} };
}

/** 读某工作区的端点配置；未配置返回 null。 */
export function loadHaConfig(workspaceId: string): HaEndpointConfig | null {
  return readFileOrEmpty().workspaces[workspaceId] ?? null;
}

/**
 * 写某工作区的端点配置。host 小写化；形态非法直接抛错（中文），不静默修正。
 */
export function saveHaConfig(workspaceId: string, host: string, port: number): HaEndpointConfig {
  const parsed = parseLocalEndpointResource(`${host.trim()}:${port}`);
  if (parsed === null) {
    throw new Error("HA_CONFIG_INVALID: 地址必须是 host:port 形态（IPv4 或主机名 + 1-65535 端口）");
  }
  const file = readFileOrEmpty();
  const entry: HaEndpointConfig = { host: parsed.host, port: parsed.port, updatedAt: Date.now() };
  file.workspaces[workspaceId] = entry;
  writeJsonAtomic(configPath(), file);
  return entry;
}

// ---------------------------------------------------------------- token

/** secret-store 槽位：按 workspaceId 分区（与配置同一分区键）。 */
function tokenSlot(workspaceId: string): string {
  return `home.assistant.token:${workspaceId}`;
}

/** 保存 token（空串 = 清除）。加密不可用时 secret-store 抛错，绝不明文落盘。 */
export function saveHaToken(workspaceId: string, token: string): void {
  saveSecret(tokenSlot(workspaceId), token);
}

/** token 的渲染侧视图：配没配 + 尾四位。 */
export function describeHaToken(workspaceId: string): { configured: boolean; last4: string } {
  return describeSecret(tokenSlot(workspaceId));
}

/** 取回明文。**只允许主进程内部调用**（组 Authorization 头 / WS auth 序列）。 */
export function loadHaToken(workspaceId: string): string | null {
  return loadSecret(tokenSlot(workspaceId));
}
