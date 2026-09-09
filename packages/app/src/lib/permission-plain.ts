/**
 * 权限申请说人话：能力名和权限 ID 不摊给普通人。
 * 未知 ID 仍原样返回，避免把没登记的权限藏起来。
 */

const CAPABILITY_WORDS: Record<string, string> = {
  "common.workspace-files": "工作区文件",
  "common.workspace-review": "改动审阅",
  "common.preview": "预览",
  "common.artifacts": "产物",
  "common.memory": "记忆",
  "common.mcp": "外部工具（MCP）",
  "common.tasks": "定时任务",
  "common.child-agent": "子助手",
  "common.workflow": "工作流",
  "common.office-skills": "办公技能",
  "coding.git": "Git",
  "coding.terminal": "终端",
  "connector.webhook": "Webhook",
  "connector.feishu": "飞书",
  "connector.slack": "Slack",
  "connector.telegram": "Telegram",
  "connector.remote": "远程访问",
  "home.assistant": "智能家居",
};

const PERMISSION_WORDS: Record<string, string> = {
  "workspace.read": "读这个文件夹里的文件",
  "workspace.write": "改这个文件夹里的文件",
  "process.git": "使用 Git",
  "process.shell": "在这台电脑上运行命令",
  "network.local": "访问家里的设备",
  "tasks.manage": "管理定时任务",
  "mcp.manage": "管理外部工具",
};

export function humanCapability(id: string): string {
  return CAPABILITY_WORDS[id] ?? id;
}

export function humanPermission(id: string): string {
  return PERMISSION_WORDS[id] ?? id;
}
