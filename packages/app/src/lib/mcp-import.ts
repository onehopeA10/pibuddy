/**
 * 粘贴导入 MCP 配置。接受 Claude / Cursor 常见的 mcpServers 包，
 * 也接受包里面那一层裸 map。只解析，不写盘。
 */

export interface ImportedMcpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  oauth: boolean;
}

export interface McpImportResult {
  servers: ImportedMcpServer[];
  skipped: string[];
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function parseOne(name: string, raw: unknown): ImportedMcpServer | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `「${name}」不是一份服务器配置`;
  }
  const row = raw as Record<string, unknown>;
  const command = typeof row.command === "string" ? row.command.trim() : "";
  const url = typeof row.url === "string" ? row.url.trim() : "";
  if (command) {
    return {
      name,
      transport: "stdio",
      command,
      args: asStringArray(row.args),
      env: asStringRecord(row.env),
      oauth: false,
    };
  }
  if (url) {
    return {
      name,
      transport: "http",
      args: [],
      env: {},
      url,
      oauth: row.oauth === true,
    };
  }
  return `「${name}」既没有启动命令也没有网址`;
}

export function parseMcpImport(text: string): McpImportResult {
  const trimmed = text.trim();
  const servers: ImportedMcpServer[] = [];
  const skipped: string[] = [];
  if (!trimmed) return { servers, skipped };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { servers, skipped: ["这段不是合法 JSON"] };
  }

  let map: unknown = parsed;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.mcpServers && typeof obj.mcpServers === "object") map = obj.mcpServers;
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { servers, skipped: ["找不到 mcpServers"] };
  }

  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    const item = parseOne(name.trim() || "unnamed", raw);
    if (typeof item === "string") skipped.push(item);
    else servers.push(item);
  }
  return { servers, skipped };
}
