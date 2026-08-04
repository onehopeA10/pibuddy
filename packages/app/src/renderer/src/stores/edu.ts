/**
 * 学习面板的渲染侧状态（edu.kids / REQ-0001 R3）。
 *
 * ## 这个 store 只做三件事
 *
 * 档案的读写缓存、错题本的只读快照、以及「一键出卷」的指令拼装。第三件
 * 刻意不发 IPC：出题在 pi 回路内（agent 调 edu.kids.math_worksheet 工具），
 * 面板能做的只是把一条组好的中文指令**填进输入框**——用户看得到、改得了、
 * 发不发由他决定。面板绕过会话直接出题会绕开「家长陪同对话」这个产品定位。
 */
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { EduKidsProfile, EduMistakeEntry, EduSubjectId } from "@contract";

/** 出卷参数（渲染侧表单 → 中文指令，不是 IPC 形参）。 */
export interface WorksheetRequest {
  operation: "add" | "sub" | "mul" | "div" | "mix";
  count: number;
  difficulty: "basic" | "challenge";
}

export const SUBJECT_LABELS: Record<EduSubjectId, string> = {
  english: "英语",
  math: "数学",
  chinese: "语文",
  science: "科学",
};

const OPERATION_LABELS: Record<WorksheetRequest["operation"], string> = {
  add: "加法",
  sub: "减法",
  mul: "乘法",
  div: "除法",
  mix: "加减乘除混合",
};

export const useEduStore = defineStore("edu", () => {
  const profile = shallowRef<EduKidsProfile | null>(null);
  /** profileGet 是否已回来过一次（区分「没档案」与「还没查」） */
  const profileLoaded = ref(false);
  const mistakes = shallowRef<EduMistakeEntry[]>([]);
  const mistakesExists = ref(false);
  const mistakesTotal = ref(0);
  const mistakesSkipped = ref(0);
  const busy = ref(false);
  const lastError = ref("");

  async function refresh(workspaceId: string): Promise<void> {
    busy.value = true;
    try {
      const [profileResult, mistakeResult] = await Promise.all([
        window.piBuddy.edu.profileGet(workspaceId),
        window.piBuddy.edu.mistakeList(workspaceId),
      ]);
      profile.value = profileResult.profile;
      profileLoaded.value = true;
      mistakes.value = mistakeResult.entries;
      mistakesExists.value = mistakeResult.exists;
      mistakesTotal.value = mistakeResult.total;
      mistakesSkipped.value = mistakeResult.skipped;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      busy.value = false;
    }
  }

  async function saveProfile(
    workspaceId: string,
    childName: string,
    grade: number,
    subjects: EduSubjectId[]
  ): Promise<boolean> {
    busy.value = true;
    try {
      const result = await window.piBuddy.edu.profileSet(workspaceId, childName, grade, subjects);
      profile.value = result.profile;
      profileLoaded.value = true;
      lastError.value = "";
      return true;
    } catch (err) {
      lastError.value = (err as Error).message;
      return false;
    } finally {
      busy.value = false;
    }
  }

  /** 称呼：有档案用档案里的名字，没有就叫「孩子」。 */
  function childLabel(): string {
    const name = profile.value?.childName.trim();
    return name ? name : "孩子";
  }

  /** 数学练习卷：组给 agent 的指令（经 edu-worksheet 技能 → math_worksheet 工具）。 */
  function buildWorksheetPrompt(request: WorksheetRequest): string {
    const grade = profile.value?.grade ?? 3;
    return (
      `请使用 edu-worksheet 技能给${childLabel()}出一份数学练习卷：` +
      `${grade} 年级，${OPERATION_LABELS[request.operation]}，共 ${request.count} 题，` +
      `难度${request.difficulty === "challenge" ? "挑战" : "基础"}。` +
      `题目和标准答案必须来自 edu.kids.math_worksheet 工具，排版成可打印的 markdown（答案页分离），` +
      `保存到 edu-kids/worksheets/ 目录。`
    );
  }

  /** 错题复习卷：组给 agent 的指令（经 edu-mistake-book 技能）。 */
  function buildReviewPrompt(): string {
    return (
      `请使用 edu-mistake-book 技能：读取 edu-kids/mistakes.jsonl，按知识点聚类分析${childLabel()}` +
      `最薄弱的知识点，然后生成一份针对性复习卷（可打印 markdown，答案页分离），` +
      `保存到 edu-kids/reviews/ 目录。`
    );
  }

  return {
    profile,
    profileLoaded,
    mistakes,
    mistakesExists,
    mistakesTotal,
    mistakesSkipped,
    busy,
    lastError,
    refresh,
    saveProfile,
    buildWorksheetPrompt,
    buildReviewPrompt,
  };
});
