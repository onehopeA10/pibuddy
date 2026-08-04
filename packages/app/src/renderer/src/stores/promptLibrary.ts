/**
 * 提示词库的渲染侧状态（common.prompt-library / REQ-0001 R1）。
 *
 * 渲染进程只持有主进程下发的整库快照；分组 / 搜索 / 收藏置顶都是对快照的
 * 纯计算，不再发第二条通道。「一键填入输入框」= 对 app store 的
 * `editorText` 赋一次值 —— 与语音转写落字走的是同一条现成路径
 * （InputBar 的 n-input 双向绑定它），没有为此发明新机制。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import {
  PROMPT_CATEGORY_LABELS,
  type PromptCategory,
  type PromptEntry,
} from "@contract";
import { useAppStore } from "./app";

/** 面板里的分组展示顺序：五个预置分类在前，用户自建垫底。 */
const CATEGORY_ORDER: readonly PromptCategory[] = [
  "email",
  "data",
  "summary",
  "translate",
  "report",
  "custom",
];

export const usePromptLibraryStore = defineStore("promptLibrary", () => {
  const entries = shallowRef<PromptEntry[]>([]);
  const errors = shallowRef<string[]>([]);
  const loading = ref(false);
  const panelOpen = ref(false);
  const lastError = ref("");

  const query = ref("");
  /** 是否显示被隐藏的预置项（用于「恢复显示」）。 */
  const showHidden = ref(false);
  /** 只看收藏。 */
  const favoritesOnly = ref(false);

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      const result = await window.piBuddy.promptLibrary.list();
      entries.value = result.entries;
      errors.value = result.errors;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** 动作公共外壳：主进程每个动作都回权威快照，直接接住。 */
  async function apply(
    action: () => Promise<{ entries: PromptEntry[]; errors: string[] }>
  ): Promise<boolean> {
    try {
      const result = await action();
      entries.value = result.entries;
      errors.value = result.errors;
      lastError.value = "";
      return true;
    } catch (err) {
      lastError.value = (err as Error).message;
      return false;
    }
  }

  const filtered = computed<PromptEntry[]>(() => {
    const q = query.value.trim().toLowerCase();
    return entries.value.filter((e) => {
      if (e.hidden && !showHidden.value) return false;
      if (favoritesOnly.value && !e.favorite) return false;
      if (!q) return true;
      return (
        e.title.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q)
      );
    });
  });

  /** 按分类分组（收藏的排每组最前），空组不出现。 */
  const grouped = computed<{ category: PromptCategory; label: string; items: PromptEntry[] }[]>(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        label: PROMPT_CATEGORY_LABELS[category],
        items: filtered.value
          .filter((e) => e.category === category)
          .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title)),
      })).filter((group) => group.items.length > 0)
  );

  const hiddenCount = computed(() => entries.value.filter((e) => e.hidden).length);

  /**
   * 一键把模板正文填入聊天输入框（R1.3 / R1.4 的后半句）。
   *
   * 输入框已有内容时**追加**而不是覆盖 —— 覆盖会把用户正打到一半的话
   * 无声抹掉，而那正是最难察觉的一类丢失。
   */
  function fillComposer(entry: PromptEntry): void {
    const app = useAppStore();
    app.editorText = app.editorText.trim()
      ? `${app.editorText.trimEnd()}\n\n${entry.content}`
      : entry.content;
    panelOpen.value = false;
  }

  function create(input: {
    title: string;
    description: string;
    category: PromptCategory;
    content: string;
  }): Promise<boolean> {
    return apply(() => window.piBuddy.promptLibrary.create(input));
  }

  function update(input: {
    id: string;
    title?: string;
    description?: string;
    category?: PromptCategory;
    content?: string;
  }): Promise<boolean> {
    return apply(() => window.piBuddy.promptLibrary.update(input));
  }

  function remove(id: string): Promise<boolean> {
    return apply(() => window.piBuddy.promptLibrary.delete(id));
  }

  function setFavorite(id: string, favorite: boolean): Promise<boolean> {
    return apply(() => window.piBuddy.promptLibrary.setFavorite(id, favorite));
  }

  function setHidden(id: string, hidden: boolean): Promise<boolean> {
    return apply(() => window.piBuddy.promptLibrary.setHidden(id, hidden));
  }

  return {
    entries,
    errors,
    loading,
    panelOpen,
    lastError,
    query,
    showHidden,
    favoritesOnly,
    filtered,
    grouped,
    hiddenCount,
    refresh,
    fillComposer,
    create,
    update,
    remove,
    setFavorite,
    setHidden,
  };
});
