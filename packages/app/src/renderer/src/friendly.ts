// 工具调用 → 普通用户能看懂的文案

export interface ToolLabel {
  icon: string;
  title: string;
  detail: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function describeTool(name: string, args: Record<string, unknown>): ToolLabel {
  const path = str(args.path) || str(args.file_path) || str(args.filePath);
  switch (name) {
    case "read":
      return { icon: "📄", title: "查看文件", detail: path };
    case "write":
      return { icon: "✏️", title: "写入文件", detail: path };
    case "edit":
    case "multi-edit":
      return { icon: "🛠️", title: "修改文件", detail: path };
    case "bash":
      return { icon: "⚡", title: "执行操作", detail: str(args.command).slice(0, 120) };
    case "grep":
    case "rg":
      return { icon: "🔍", title: "搜索内容", detail: str(args.pattern) };
    case "glob":
    case "find":
    case "ls":
    case "list":
      return { icon: "🗂️", title: "浏览文件", detail: path || str(args.pattern) };
    default:
      return { icon: "🧩", title: `使用工具 ${name}`, detail: "" };
  }
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function formatCost(cost: number): string {
  if (!cost) return "$0";
  return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}
