/**
 * FastAnalyzer：约 80% 请求不需要额外 Analyzer LLM。
 *
 * 本期只做规则。通用知识（「HTTP 429 / Python GIL 是什么」）必须 mode=none，
 * 不查长期记忆。
 */
import type { TaskAnalysis } from "@pibuddy/contract";

import { isPureGreeting } from "../../lib/pure-greeting.js";

const EXPLICIT_MEMORY_RE =
  /记住|记得|还记得|我之前|我说过|按我的习惯|适合我|长期偏好|你记得/;
const CONTINUATION_RE = /继续|接着|还是那个|照之前|按原来的|上一个|刚才那个|再来/;
const PATTERN_RE =
  /总是|经常|通常|规律|趋势|反复|最近几次|最近三次|最近几|为什么老是|综合过去|过去半年|最常纠结|纠结什么/;
const EPISODIC_RE = /上次|之前那|我之前|我说过/;
const PROJECT_RE =
  /这个(项目|repo|仓库)|本仓库|本项目|当前项目|我们的项目|这个 repo|这个仓库|workspace|package\.json|怎么 build|如何构建|node 版本|Node 版本/i;
const PROJECT_TASK_RE = /包管理器|修复|调试|部署|构建|编译|跑测试|写.{0,4}(?:查询|SQL)|\b(?:deploy|build|debug)\b/i;
const HISTORY_TASK_RE = /报告|任务|方案|代码|部署|构建|测试|项目|\b(?:docker|repo|deploy|build)\b/i;
const DEFINITIONAL_RE = /什么是|是什么|是啥|什么意思|what is|what's|explain\s+(what|why)/i;
const PERSONAL_RE = /我喜欢|我的偏好|默认用|包管理器/;

export function isExplicitMemoryReference(message: string): boolean {
  return EXPLICIT_MEMORY_RE.test(message);
}

export function isGenericKnowledge(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  if (isExplicitMemoryReference(t)) return false;
  if (PROJECT_RE.test(t)) return false;
  if (CONTINUATION_RE.test(t) || PATTERN_RE.test(t)) return false;
  return DEFINITIONAL_RE.test(t);
}

export function fastAnalyze(message: string, opts?: { hasActiveProject?: boolean }): TaskAnalysis {
  if (isPureGreeting(message)) {
    return {
      intent: "conversation",
      memorySignal: "none",
      historyNeed: "none",
      currentStateNeed: "none",
      scopes: { user: false, project: false, agent: false, organization: false },
      logicalKinds: [],
      entities: [],
      temporalExpressions: [],
      ambiguity: 0,
      genericKnowledge: false,
    };
  }

  const genericKnowledge = isGenericKnowledge(message);
  const explicit = isExplicitMemoryReference(message);
  const continuation = CONTINUATION_RE.test(message);
  // 工作区存在只表示资源可用，不表示当前问题需要项目背景。
  const projectish = !genericKnowledge && (
    PROJECT_RE.test(message) || Boolean(opts?.hasActiveProject && PROJECT_TASK_RE.test(message))
  );
  const personal = PERSONAL_RE.test(message) || explicit;
  const organization = /我们(?:的)?(?:团队|公司|组织)|本公司|本团队/.test(message);
  const calendar = !genericKnowledge && /会议|日程|calendar/i.test(message);
  const historyTask = HISTORY_TASK_RE.test(message);
  const pattern = PATTERN_RE.test(message) && (projectish || personal || /我|我们/.test(message));
  const episodic = EPISODIC_RE.test(message) && (historyTask || personal);
  const memoryRelevant = projectish || personal || organization || calendar || pattern ||
    ((continuation || episodic) && historyTask);

  let historyNeed: TaskAnalysis["historyNeed"] = "none";
  if (pattern) historyNeed = "pattern";
  else if (continuation) historyNeed = "continuation";
  else if (explicit || episodic) historyNeed = "episodic";

  let intent: TaskAnalysis["intent"] = "conversation";
  if (genericKnowledge) intent = "knowledge";
  else if (projectish) intent = "coding";
  else if (personal) intent = "personal";

  return {
    intent,
    memorySignal: explicit ? "explicit" : !genericKnowledge && memoryRelevant ? "implicit" : "none",
    historyNeed,
    currentStateNeed: /现在|当前|live|实际|今天|会议|日程/.test(message)
      ? "required"
      : projectish
        ? "preferred"
        : "none",
    scopes: {
      user: personal || explicit,
      project: Boolean(projectish && !genericKnowledge),
      agent: false,
      organization,
    },
    logicalKinds: personal ? ["preference", "constraint"] : projectish ? ["procedure", "fact", "constraint"] : [],
    entities: [],
    temporalExpressions: [],
    ambiguity: genericKnowledge || explicit || projectish ? 0.1 : 0.4,
    genericKnowledge,
  };
}
