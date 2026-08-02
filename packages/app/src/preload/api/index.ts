/**
 * `window.piBuddy` 的聚合对象 —— **接口面的唯一定义**。
 *
 * 分层的理由是结构性的：所有方法挤在一个 index.ts 里、类型再在 index.d.ts
 * 里手抄一遍时，「新增一个命名空间」必然同时改这两个文件，于是 M3-M5 的
 * 七个任务全部串行卡在同一处冲突上，而且手抄的签名一定会和实现漂移。
 *
 * 现在的规则只有两条：
 *   1. 新增命名空间 = 新增 `api/<ns>.ts` + 在下面加一行；
 *   2. `index.d.ts` 用 `typeof api` 推导，永远不会和实现对不上。
 *
 * 七个键的划分按「渲染进程要做的事」而不是「主进程怎么实现」：
 *   pi        pi 运行时的一切（动作 + 生命周期 + 事件 + 扩展 UI）
 *   sessions  会话中心（列表 / 搜索 / 整理 / 草稿 / 导出 / 向前翻页）
 *   settings  设置与密钥
 *   dialog    需要真实用户手势的系统对话框（选文件夹 / 选文件）+ 当前工作区
 *   file      附件能力凭证的进出口
 *   shell     用系统程序打开 / 定位（入参只有凭证）
 *   stt       语音转写
 *   update    应用自更新（状态快照 + 九个动作 + 事件订阅）
 */
import { pi } from "./pi.js";
import { piResources } from "./piResources.js";
import { sessions } from "./sessions.js";
import { settings } from "./settings.js";
import { dialog } from "./dialog.js";
import { file } from "./file.js";
import { shell } from "./shell.js";
import { stt } from "./stt.js";
import { update } from "./update.js";
import { diagnostics } from "./diagnostics.js";

export const api = {
  pi,
  piResources,
  sessions,
  settings,
  dialog,
  file,
  shell,
  stt,
  update,
  diagnostics,
};

export type PiBuddyApi = typeof api;
