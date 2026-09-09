/**
 * 产物库与预览的渲染侧状态（ART-101 / ART-102）。
 *
 * 这里从头到尾**没有任何绝对路径字段** —— 主进程不下发它们，因此
 * 「顺手缓存一下真实位置」在这里连类型都写不出来。
 *
 * ## 为什么预览结果要按 key 缓存
 *
 * 一次 Office 转换是几百毫秒到几秒。用户在文件树里上下点的时候，
 * 不缓存的表现是每点一次都白屏几百毫秒 —— 而缓存的代价只是一个
 * Map，转换结果本身是不可变的。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type {
  ArtifactComparison,
  ArtifactRecord,
  ArtifactStatus,
  PreviewResult,
} from "@contract";

/** 预览目标：token、产物 id，或 workspaceId + relativePath。 */
export interface PreviewRequest {
  token?: string;
  workspaceId?: string;
  relativePath?: string;
  artifactId?: string;
}

function keyOf(target: PreviewRequest): string {
  if (target.artifactId) return `artifact:${target.artifactId}`;
  return target.token ?? `${target.workspaceId ?? ""}#${target.relativePath ?? ""}`;
}

export const useArtifactsStore = defineStore("artifacts", () => {
  // -------------------------------------------------------------- 产物库

  const items = shallowRef<ArtifactRecord[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const query = ref("");
  const statusFilter = ref<ArtifactStatus | "">("");
  const showTrash = ref(false);
  const panelOpen = ref(false);
  const lastError = ref("");

  /** 版本比较面板里选中的两条。第二次点同一条会取消选中。 */
  const compareLeft = ref<string>("");
  const compareRight = ref<string>("");
  const comparison = shallowRef<ArtifactComparison | null>(null);

  async function refresh(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    loading.value = true;
    try {
      const page = await window.piBuddy.artifacts.query({
        workspaceId,
        query: query.value || undefined,
        status: statusFilter.value || undefined,
        trashed: showTrash.value,
        latestOnly: !showTrash.value,
        limit: 500,
      });
      items.value = page.items;
      total.value = page.total;
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** 单条动作的公共外壳：失败时把原因留下来，不静默吞掉。 */
  async function mutate(
    workspaceId: string,
    action: () => Promise<{ ok: boolean; message?: string }>
  ): Promise<boolean> {
    try {
      const result = await action();
      if (!result.ok) {
        lastError.value = result.message ?? "操作没有成功";
        return false;
      }
      await refresh(workspaceId);
      return true;
    } catch (err) {
      lastError.value = (err as Error).message;
      return false;
    }
  }

  const rename = (workspaceId: string, id: string, name: string) =>
    mutate(workspaceId, () => window.piBuddy.artifacts.rename(id, name));
  const duplicate = (workspaceId: string, id: string) =>
    mutate(workspaceId, () => window.piBuddy.artifacts.duplicate(id));
  const trash = (workspaceId: string, id: string) =>
    mutate(workspaceId, () => window.piBuddy.artifacts.trash(id));
  const restore = (workspaceId: string, id: string) =>
    mutate(workspaceId, () => window.piBuddy.artifacts.restore(id));

  async function exportOne(id: string): Promise<string> {
    try {
      const result = await window.piBuddy.artifacts.export(id);
      if (!result.ok) {
        lastError.value = result.message ?? "导出没有成功";
        return "";
      }
      return result.savedName ?? "";
    } catch (err) {
      lastError.value = (err as Error).message;
      return "";
    }
  }

  const showInFolder = (id: string) => window.piBuddy.artifacts.showInFolder(id);

  function toggleCompare(id: string): void {
    if (compareLeft.value === id) {
      compareLeft.value = "";
      comparison.value = null;
      return;
    }
    if (compareRight.value === id) {
      compareRight.value = "";
      comparison.value = null;
      return;
    }
    if (!compareLeft.value) compareLeft.value = id;
    else compareRight.value = id;
  }

  async function runCompare(): Promise<void> {
    if (!compareLeft.value || !compareRight.value) return;
    try {
      comparison.value = await window.piBuddy.artifacts.compare(
        compareLeft.value,
        compareRight.value
      );
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  const canCompare = computed(() => compareLeft.value !== "" && compareRight.value !== "");

  // ---------------------------------------------------------------- 预览

  const previewCache = new Map<string, PreviewResult>();
  const current = shallowRef<PreviewResult | null>(null);
  const previewing = ref(false);
  const previewTarget = ref("");
  /**
   * 正在预览的文件（相对工作区）。
   *
   * 与 previewTarget 分开是因为后者是缓存键（token 与路径两种形态揉在
   * 一个字符串里），拿它去 split('#') 反推路径是个一眼看不懂、改一下就
   * 断的写法 —— 而它断掉的表现是预览区永远空着。
   */
  const previewRelativePath = ref("");
  /** 按产物版本预览时记下 id，刷新不能退化成只按路径读当前文件。 */
  const previewArtifactId = ref("");

  /**
   * 转换并显示。**失败时同样把结果设进 current** —— 那里带着
   * `suggestion`，界面显示的正是那句话；把失败路径留成 null 的表现是
   * 「点了没反应」，那比报错难查得多。
   */
  async function preview(target: PreviewRequest): Promise<PreviewResult | null> {
    const key = keyOf(target);
    previewTarget.value = key;
    previewRelativePath.value = target.relativePath ?? "";
    previewArtifactId.value = target.artifactId ?? "";
    const cached = previewCache.get(key);
    if (cached) {
      current.value = cached;
      return cached;
    }
    previewing.value = true;
    try {
      const result = await window.piBuddy.preview.convert(target);
      previewCache.set(key, result);
      current.value = result;
      return result;
    } catch (err) {
      lastError.value = (err as Error).message;
      current.value = null;
      return null;
    } finally {
      previewing.value = false;
    }
  }

  /** 在独立的沙箱窗口里打开（大文档看着舒服些）。 */
  async function openInWindow(target: PreviewRequest): Promise<string> {
    try {
      const handle = await window.piBuddy.preview.open(target);
      current.value = handle.result;
      return handle.previewId;
    } catch (err) {
      lastError.value = (err as Error).message;
      return "";
    }
  }

  function clearPreview(): void {
    current.value = null;
    previewTarget.value = "";
    previewRelativePath.value = "";
    previewArtifactId.value = "";
  }

  return {
    items,
    total,
    loading,
    query,
    statusFilter,
    showTrash,
    panelOpen,
    lastError,
    compareLeft,
    compareRight,
    comparison,
    canCompare,
    refresh,
    rename,
    duplicate,
    trash,
    restore,
    exportOne,
    showInFolder,
    toggleCompare,
    runCompare,
    current,
    previewing,
    previewTarget,
    previewRelativePath,
    previewArtifactId,
    preview,
    openInWindow,
    clearPreview,
  };
});
