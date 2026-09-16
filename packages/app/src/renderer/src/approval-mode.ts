/**
 * 审批模式在界面上的文案。模式枚举与状态文本解析在 @contract/approval-mode，
 * 这里只负责「给用户看什么字」。
 */
import { APPROVAL_MODES, type ApprovalMode } from "@contract";

export interface ApprovalModeOption {
  value: ApprovalMode;
  /** 下拉里的短标签。 */
  label: string;
  /** 悬停 / 选中时的一句说明。 */
  description: string;
}

const LABELS: Record<ApprovalMode, Pick<ApprovalModeOption, "label" | "description">> = {
  default: {
    label: "默认权限",
    description: "读文件直接做；改文件、跑命令先问你",
  },
  acceptEdits: {
    label: "放行改文件",
    description: "改文件直接做；跑命令仍然先问你",
  },
  dontAsk: {
    label: "只做已批准的",
    description: "不问你，没预先批准的一律拒绝",
  },
  bypassPermissions: {
    label: "全部放行",
    description: "所有工具直接执行，不再询问（YOLO）",
  },
};

export const APPROVAL_MODE_OPTIONS: readonly ApprovalModeOption[] = APPROVAL_MODES.map((value) => ({
  value,
  ...LABELS[value],
}));

export function approvalModeLabel(mode: ApprovalMode | undefined): string {
  return mode ? LABELS[mode].label : "权限";
}

export function approvalModeDescription(mode: ApprovalMode | undefined): string {
  return mode ? LABELS[mode].description : "当前读不到审批模式";
}
