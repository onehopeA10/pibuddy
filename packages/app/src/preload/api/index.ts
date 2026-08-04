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
 *   workspace 工作区文件服务（树 / 搜索 / 读写 / 变更集），只认相对路径
 *   preview   安全预览（沙箱窗口 + 受限转换进程）
 *   artifacts 产物库（版本链 / 回收站 / 导出 / 版本比较）
 *   capabilities 能力包与 Profile（描述 / 换 Profile / 单个开关）
 */
import { pi } from "./pi.js";
import { piResources } from "./piResources.js";
import { providers } from "./providers.js";
import { sessions } from "./sessions.js";
import { settings } from "./settings.js";
import { dialog } from "./dialog.js";
import { file } from "./file.js";
import { shell } from "./shell.js";
import { stt } from "./stt.js";
import { update } from "./update.js";
import { diagnostics } from "./diagnostics.js";
import { workspace } from "./workspace.js";
import { preview } from "./preview.js";
import { artifacts } from "./artifacts.js";
import { capabilities } from "./capabilities.js";
import { permission } from "./permission.js";
import { mcp } from "./mcp.js";
import { memory } from "./memory.js";
import { agentPool } from "./agentPool.js";
import { childAgent } from "./childAgent.js";
import { git } from "./git.js";
import { terminal } from "./terminal.js";
import { tasks } from "./tasks.js";
import { connector } from "./connector.js";
import { workflow } from "./workflow.js";
import { remote } from "./remote.js";
import { promptLibrary } from "./promptLibrary.js";
import { officeSkills } from "./officeSkills.js";
import { homeAdvisor } from "./homeAdvisor.js";
import { edu } from "./edu.js";
import { home } from "./home.js";
import { dashboard } from "./dashboard.js";

export const api = {
  pi,
  piResources,
  /** Provider 与模型中心、用量统计（PROV-101）。只进不出：有 saveKey，没有 getKey */
  providers,
  sessions,
  settings,
  dialog,
  file,
  shell,
  stt,
  update,
  diagnostics,
  /** 工作区文件服务与 Agent 变更集（FS-101 / FS-102）。出入参一律相对路径 */
  workspace,
  /** 安全预览（ART-101）。目标只能是 attachment token 或工作区相对路径 */
  preview,
  /** 产物库（ART-102）。入参一律不透明 artifactId，没有路径字段 */
  artifacts,
  /** 能力包与 Profile（ADR-0002）。只能在已封口的表上勾选，没有注册入口 */
  capabilities,
  /** 能力权限决策（ADR-0002 D3 / SEC-003）。决策在主进程，没有直接执行入口 */
  permission,
  /** 长期记忆（MEM-101）。用户显式保存 + 相关注入；没有「注入任意文本」入口 */
  memory,
  /** MCP 服务器管理（common.mcp）。启停 / 测试收不透明 id，spawn 只在主进程 */
  mcp,
  /** 后台会话池（AGT-101）。观测与调度，入参只有不透明 sessionId / 资源上界 */
  agentPool,
  /** 子 Agent 编排（common.child-agent）。父子拓扑 / 结构化消息 / cancel 传播 */
  childAgent,
  /** Git 编码能力包（coding.git）。九个意图，无 argv 入口，每条通道要 process.git */
  git,
  /** 终端能力包（coding.terminal）。node-pty 开 shell，无 cwd/argv 入口，每条通道要 process.shell */
  terminal,
  /** 持久定时任务（common.tasks）。调度 headless，触发的是已落盘任务里冻结的配置 */
  tasks,
  /** Webhook 连接器（connector.webhook）。凭证只进不出，出站逐域名经权限授权 + safeFetch */
  connector,
  /** 可视化工作流（common.workflow）。DAG 画布 / 运行 / 历史 / 导入导出，Agent 节点走后台池触发 */
  workflow,
  /** 远程访问管理面（connector.remote）。开关 / 配对 / 撤销 / 授危险 scope，token 只进不出 */
  remote,
  /** 预置办公提示词库（common.prompt-library）。六个意图，无路径 / 文件名入口 */
  promptLibrary,
  /** 预置办公技能包（common.office-skills）。只读清单 + 物化状态，无执行 / 物化入口 */
  officeSkills,
  /** 家居场景建议包（home.advisor）。只读清单 + 物化状态，无执行 / 控制入口 */
  homeAdvisor,
  /** 儿童教育能力包（edu.kids）。档案与错题本三条窄通道，无路径与出题入口 */
  edu,
  /** 智能家居基座（home.assistant）。端点配置/测试/只读快照，token 只进不出，无控制入口 */
  home,
  /** 家居监控面板（home.dashboard）。消费者信令 + 只读快照 + 增量订阅，无控制入口 */
  dashboard,
};

export type PiBuddyApi = typeof api;
