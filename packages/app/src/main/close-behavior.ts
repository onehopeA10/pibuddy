/**
 * 关闭窗口：问一次、收到托盘、还是退出。
 *
 * 决策本身不碰 Electron：点 X 的拦截、托盘菜单、原生对话框都在 index /
 * app-tray 里接线。这里只回答「这一次 close 该怎么走」和「勾了记住之后写什么」。
 */
export type CloseAction = "ask" | "tray" | "quit";
export type CloseDecision = "allow-quit" | "hide-tray" | "ask";
export type CloseChoice = "tray" | "quit" | "cancel";

export const CLOSE_DIALOG_BUTTONS = {
  tray: 0,
  quit: 1,
  cancel: 2,
} as const;

export function decideClose(opts: {
  quitting: boolean;
  action: CloseAction | undefined;
}): CloseDecision {
  if (opts.quitting) return "allow-quit";
  const action = opts.action ?? "ask";
  if (action === "quit") return "allow-quit";
  if (action === "tray") return "hide-tray";
  return "ask";
}

export function choiceFromDialogResponse(response: number): CloseChoice {
  if (response === CLOSE_DIALOG_BUTTONS.tray) return "tray";
  if (response === CLOSE_DIALOG_BUTTONS.quit) return "quit";
  return "cancel";
}

/** 勾了「记住这次选择」才落盘；取消不写。 */
export function persistedCloseAction(remember: boolean, choice: CloseChoice): CloseAction | null {
  if (!remember || choice === "cancel") return null;
  return choice;
}

export interface CloseDialogPrompt {
  type: "question";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  checkboxLabel: string;
  noLink: boolean;
}

export function closeDialogPrompt(): CloseDialogPrompt {
  return {
    type: "question",
    title: "关闭窗口",
    message: "关闭窗口时要做什么？",
    detail: "缩小到托盘后，后台会话还会继续跑；退出会结束应用。",
    buttons: ["缩小到托盘", "退出", "取消"],
    defaultId: CLOSE_DIALOG_BUTTONS.tray,
    cancelId: CLOSE_DIALOG_BUTTONS.cancel,
    checkboxLabel: "记住这次选择",
    noLink: true,
  };
}

export interface CloseDialogDeps {
  showMessageBox: (
    win: unknown,
    opts: CloseDialogPrompt
  ) => Promise<{ response: number; checkboxChecked: boolean }>;
  saveCloseAction: (action: CloseAction) => void;
}

export async function promptCloseChoice(deps: CloseDialogDeps, win: unknown): Promise<CloseChoice> {
  const { response, checkboxChecked } = await deps.showMessageBox(win, closeDialogPrompt());
  const choice = choiceFromDialogResponse(response);
  const remembered = persistedCloseAction(checkboxChecked, choice);
  if (remembered) deps.saveCloseAction(remembered);
  return choice;
}
