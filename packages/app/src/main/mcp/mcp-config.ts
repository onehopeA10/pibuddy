/**
 * MCP 服务器配置的读写（能力包 common.mcp）。
 *
 * ## 落盘位置与格式
 *
 * pi 本身没有 MCP 概念（settings.md / extensions.md 与 dist 都查过，没有
 * `mcpServers` 键），因此这里采用 MCP 生态的事实标准形状，落在与 pi 资源
 * 同层的两个文件：
 *   - user：    `~/.pi/agent/mcp.json`
 *   - project： `<workspace>/.pi/mcp.json`
 *
 * 文件形如：
 * ```json
 * { "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "remote":     { "type": "http", "url": "https://mcp.example.com", "headers": {} }
 * } }
 * ```
 *
 * ## 纪律
 *
 *  - **绝不抛异常**：读失败 / JSON 坏了折成一句中文放进 errors，扫描是旁路。
 *  - **写前先读再合并**：这两个文件用户可能手动编辑过，整文件覆盖会抹掉
 *    用户自己加的服务器与我们不认识的字段。
 *  - **env / header 的值只出现在磁盘与 main**：下发给渲染进程的 descriptor
 *    经 `toDescriptor` 脱敏，只留键名。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MCP_HTTP_TEST_NOT_IMPLEMENTED_NOTE,
  mcpExecutionFingerprintMaterial,
  mcpRunResource,
  type McpScope,
  type McpServerDescriptor,
  type McpServerInput,
  type McpTransport,
} from "@pibuddy/contract";

import { writeJsonAtomic } from "../fs-atomic.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";

/** 一台服务器在 main 侧的完整（含明文）配置。 */
export interface ResolvedMcpServer {
  id: string;
  scope: McpScope;
  source: string;
  config: McpServerInput;
  executionFingerprint: string | null;
  runPermissionResource: string | null;
  diagnostics: string[];
}

export interface McpPermissionTarget {
  workspaceId: string;
  scope: McpScope;
  name: string;
  resource: string | null;
}

const permissionTargetSnapshots = new Map<string, ReadonlyMap<string, McpPermissionTarget>>();
const resolutionGeneration = new Map<string, number>();

export function lookupMcpPermissionTarget(
  workspaceId: string,
  id: string
): McpPermissionTarget | undefined {
  return permissionTargetSnapshots.get(workspaceId)?.get(id);
}

export function lookupMcpPermissionTargetByRef(
  workspaceId: string,
  scope: McpScope,
  name: string
): McpPermissionTarget | undefined {
  const snap = permissionTargetSnapshots.get(workspaceId);
  if (!snap) return undefined;
  for (const target of snap.values()) {
    if (target.scope === scope && target.name === name) return target;
  }
  return undefined;
}

export function __resetMcpPermissionTargets(): void {
  permissionTargetSnapshots.clear();
  resolutionGeneration.clear();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 指纹覆盖真正交给 spawn 的 command / args / env，env 明文永不离开 main。 */
export function mcpExecutionFingerprint(config: McpServerInput): string {
  return sha256(mcpExecutionFingerprintMaterial(config));
}

function descriptorFingerprintMaterial(config: McpServerInput): string {
  if (config.transport === "stdio") return mcpExecutionFingerprintMaterial(config);
  return JSON.stringify({
    url: config.url ?? "",
    headers: Object.fromEntries(
      Object.entries(config.headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    ),
    oauth: config.oauth,
  });
}

/** 配置一变 id 就变；旧列表里的 id 因此无法命中新配置并触发 spawn。 */
export function mcpServerId(
  workspaceId: string,
  scope: McpScope,
  config: McpServerInput
): string {
  return sha256(
    `${workspaceId}\u0000${scope}\u0000${config.name}\u0000${descriptorFingerprintMaterial(config)}`
  ).slice(0, 16);
}

function configFile(scope: McpScope, workspaceRoot: string, homeDir: string): string {
  return scope === "user"
    ? path.join(homeDir, ".pi", "agent", "mcp.json")
    : path.join(workspaceRoot, ".pi", "mcp.json");
}

/** 判定一条原始条目的传输方式。有 url 或 type 属 http 系即 http，否则 stdio。 */
function transportOf(entry: Record<string, unknown>): McpTransport {
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  const transport = typeof entry.transport === "string" ? entry.transport.toLowerCase() : "";
  if (["http", "sse", "streamable-http", "streamablehttp"].includes(type)) return "http";
  if (["http", "sse", "streamable-http", "streamablehttp"].includes(transport)) return "http";
  if (typeof entry.url === "string" && entry.url.length > 0) return "http";
  return "stdio";
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** 把一条原始 JSON 条目折成规整的输入配置，附带诊断。 */
function normalizeEntry(name: string, raw: unknown): { config: McpServerInput; diagnostics: string[] } {
  const entry = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const transport = transportOf(entry);
  const diagnostics: string[] = [];

  const config: McpServerInput = {
    name,
    transport,
    command: typeof entry.command === "string" ? entry.command : undefined,
    args: stringArray(entry.args),
    env: stringRecord(entry.env),
    url: typeof entry.url === "string" ? entry.url : undefined,
    headers: stringRecord(entry.headers),
    oauth:
      entry.oauth === true ||
      (entry.auth && typeof entry.auth === "object" ? true : false) ||
      false,
  };

  if (transport === "stdio" && !config.command) {
    diagnostics.push("stdio 服务器缺少 command，无法启动或测试");
  }
  if (transport === "http") {
    if (!config.url) diagnostics.push("http 服务器缺少 url");
    diagnostics.push(MCP_HTTP_TEST_NOT_IMPLEMENTED_NOTE);
  }
  return { config, diagnostics };
}

/** 读一个作用域的配置文件。文件不存在返回空表；解析失败记一条 error。 */
async function readScope(
  workspaceId: string,
  scope: McpScope,
  file: string,
  errors: string[]
): Promise<ResolvedMcpServer[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(`读取失败：${file}（${describeError(err)}）`);
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    errors.push(`JSON 解析失败：${file}（${describeError(err)}）`);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push(`内容不是 JSON 对象，已跳过：${file}`);
    return [];
  }

  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];

  const out: ResolvedMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const { config, diagnostics } = normalizeEntry(name, raw);
    const id = mcpServerId(workspaceId, scope, config);
    const executionFingerprint =
      config.transport === "stdio" ? mcpExecutionFingerprint(config) : null;
    const runPermissionResource =
      executionFingerprint === null
        ? null
        : mcpRunResource(workspaceId, scope, name, executionFingerprint);
    out.push({
      id,
      scope,
      source: file,
      config,
      executionFingerprint,
      runPermissionResource,
      diagnostics,
    });
  }
  return out;
}

/** 枚举一个工作目录能看到的全部 MCP 服务器（user + project）。 */
export async function resolveServers(
  workspaceId: string,
  homeDir: string = os.homedir()
): Promise<{ servers: ResolvedMcpServer[]; errors: string[] }> {
  const root = requireWorkspaceRoot(workspaceId);
  const errors: string[] = [];
  const generation = (resolutionGeneration.get(workspaceId) ?? 0) + 1;
  resolutionGeneration.set(workspaceId, generation);
  const user = await readScope(workspaceId, "user", configFile("user", root, homeDir), errors);
  const project = await readScope(
    workspaceId,
    "project",
    configFile("project", root, homeDir),
    errors
  );
  const servers = [...user, ...project];
  if (resolutionGeneration.get(workspaceId) === generation) {
    const next = new Map<string, McpPermissionTarget>();
    for (const server of servers) {
      next.set(server.id, {
        workspaceId,
        scope: server.scope,
        name: server.config.name,
        resource: server.runPermissionResource,
      });
    }
    permissionTargetSnapshots.set(workspaceId, next);
  }
  return { servers, errors };
}

/** 按 id 找一台服务器（含明文配置，供 main 侧 spawn 用）。 */
export async function findServer(
  workspaceId: string,
  id: string,
  homeDir: string = os.homedir()
): Promise<ResolvedMcpServer | undefined> {
  const { servers } = await resolveServers(workspaceId, homeDir);
  return servers.find((s) => s.id === id);
}

/** 脱敏：env / header 只留键名，值不下发。 */
export function toDescriptor(server: ResolvedMcpServer, running: boolean): McpServerDescriptor {
  const { config } = server;
  return {
    id: server.id,
    name: config.name,
    scope: server.scope,
    transport: config.transport,
    source: server.source,
    command: config.command,
    args: config.args,
    envKeys: Object.keys(config.env),
    url: config.url,
    headerKeys: Object.keys(config.headers),
    oauthRequired: config.oauth,
    running,
    runPermissionResource: server.runPermissionResource,
    diagnostics: server.diagnostics,
  };
}

const configMutationTails = new Map<string, Promise<void>>();

/** 同一配置文件的 read-modify-write 串行化，避免并发 save/remove 丢更新。 */
async function withConfigMutation<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = configMutationTails.get(file) ?? Promise.resolve();
  let release!: () => void;
  const marker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => marker);
  configMutationTails.set(file, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (configMutationTails.get(file) === tail) configMutationTails.delete(file);
  }
}

/**
 * 写入 / 更新一台服务器（按 name upsert）。写前先读再合并。
 *
 * env / header 里值为空串的键当作「删除该键」，让编辑框能清空一个环境变量。
 */
export async function saveServer(
  workspaceId: string,
  scope: McpScope,
  config: McpServerInput,
  homeDir: string = os.homedir()
): Promise<void> {
  const root = requireWorkspaceRoot(workspaceId);
  const file = configFile(scope, root, homeDir);

  await withConfigMutation(file, async () => {
    let doc: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {
      /* 文件不存在 / 坏了：从空文档起，下面 writeJsonAtomic 会建目录并写出 */
    }

    const servers =
      doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
        ? { ...(doc.mcpServers as Record<string, unknown>) }
        : {};

    const entry: Record<string, unknown> = { type: config.transport };
    if (config.transport === "stdio") {
      entry.command = config.command ?? "";
      if (config.args.length > 0) entry.args = config.args;
      if (Object.keys(config.env).length > 0) entry.env = pruneEmpty(config.env);
    } else {
      entry.url = config.url ?? "";
      if (Object.keys(config.headers).length > 0) entry.headers = pruneEmpty(config.headers);
    }
    if (config.oauth) entry.oauth = true;
    servers[config.name] = entry;

    await ensureDir(path.dirname(file));
    writeJsonAtomic(file, { ...doc, mcpServers: servers });
  });
}

/** 删除一台服务器。写前先读再合并；服务器不存在时静默成功（幂等）。 */
export async function removeServer(
  workspaceId: string,
  scope: McpScope,
  name: string,
  homeDir: string = os.homedir()
): Promise<void> {
  const root = requireWorkspaceRoot(workspaceId);
  const file = configFile(scope, root, homeDir);

  await withConfigMutation(file, async () => {
    let doc: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      doc = parsed as Record<string, unknown>;
    } catch {
      return; // 文件不存在：没什么可删的
    }
    if (!doc.mcpServers || typeof doc.mcpServers !== "object" || Array.isArray(doc.mcpServers)) {
      return;
    }

    const servers = { ...(doc.mcpServers as Record<string, unknown>) };
    if (!(name in servers)) return;
    delete servers[name];
    writeJsonAtomic(file, { ...doc, mcpServers: servers });
  });
}

function pruneEmpty(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v !== "") out[k] = v;
  }
  return out;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
