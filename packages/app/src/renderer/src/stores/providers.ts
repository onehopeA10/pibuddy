/**
 * Provider 中心 / 用量页的渲染侧状态（PROV-101）。
 *
 * 这个 store 里**不存在任何密钥字段**。用户敲进输入框的明文只在 `saveKey()`
 * 这一次调用的参数里活一瞬间，之后由主进程写进 `~/.pi/agent/auth.json`；
 * 回来的 `ProviderView` 只有 `{configured, last4}`。
 *
 * 同样地，这里**没有一个模型名**：`models` 全部来自主进程转发的
 * `get_available_models`。硬编码名单的后果见 model-capability.ts 的头注释。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  ProviderCustomRequest,
  ProviderTestResult,
  ProviderView,
  UsageQuery,
  UsageRow,
  UsageSessionRow,
} from "@contract";
import { localDayOf, summarizeUsage } from "../usage-summary";

/** 一次「测试连接」的界面态。`pending` 期间按钮转圈且不可重复点。 */
export interface TestState {
  pending: boolean;
  result: ProviderTestResult | null;
}

export const useProvidersStore = defineStore("providers", () => {
  const providers = ref<ProviderView[]>([]);
  /** auth.json 的 0600 是否真的生效。false 时界面显示平台能力提示 */
  const permissionEnforced = ref(true);
  const loading = ref(false);
  const lastError = ref("");
  const panelOpen = ref(false);
  const usagePanelOpen = ref(false);

  /** providerId → 该 provider 最近一次连通性测试 */
  const tests = ref<Record<string, TestState>>({});

  const usageRows = ref<UsageRow[]>([]);
  const usageFilter = ref<UsageQuery>({});
  /** 按 (sessionId, day) 的会话明细（R5.2），跟随 usageFilter。 */
  const usageSessionRows = ref<UsageSessionRow[]>([]);
  /** 不带日期过滤的全量按日行 —— 「今日 / 近 7 日 / 累计」从它算。 */
  const usageAllRows = ref<UsageRow[]>([]);

  /** 至少配好了一个可用凭据 —— 首启向导据它判断「能不能发第一条消息」。 */
  const hasAnyConfigured = computed(() => providers.value.some((p) => p.configured));

  function adopt(result: { providers: ProviderView[]; permissionEnforced: boolean }): void {
    providers.value = result.providers;
    permissionEnforced.value = result.permissionEnforced;
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    lastError.value = "";
    try {
      adopt(await window.piBuddy.providers.list());
    } catch (err) {
      // 不静默：拉不到列表时界面必须说明原因，而不是显示一个空列表
      // 冒充「你还没配过任何账号」。
      lastError.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  /** key 为空串 = 删除这条凭据。明文只在这一次调用里存在于渲染进程。 */
  async function saveKey(providerId: string, key: string): Promise<boolean> {
    lastError.value = "";
    try {
      adopt(await window.piBuddy.providers.saveKey(providerId, key));
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  async function remove(providerId: string): Promise<void> {
    lastError.value = "";
    try {
      adopt(await window.piBuddy.providers.remove(providerId));
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
    }
  }

  /** 添加一个自定义 OpenAI 兼容端点。地址不合格时主进程抛，原样展示。 */
  async function addCustom(input: ProviderCustomRequest): Promise<boolean> {
    lastError.value = "";
    try {
      adopt(await window.piBuddy.providers.addCustom(input));
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /**
   * 测试连通性。主进程侧**永不 reject**，失败信息在返回值里；
   * 这里的 catch 兜的是 IPC 本身出问题（被限流 / 窗口正在关闭）。
   */
  async function test(providerId: string): Promise<ProviderTestResult> {
    tests.value = { ...tests.value, [providerId]: { pending: true, result: null } };
    let result: ProviderTestResult;
    try {
      result = await window.piBuddy.providers.test(providerId);
    } catch (err) {
      result = {
        ok: false,
        latencyMs: 0,
        errorCode: "unknown",
        redactedMessage: err instanceof Error ? err.message : String(err),
      };
    }
    tests.value = { ...tests.value, [providerId]: { pending: false, result } };
    return result;
  }

  async function discoverModels(providerId: string): Promise<boolean> {
    lastError.value = "";
    try {
      adopt(await window.piBuddy.providers.discoverModels(providerId));
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  async function refreshUsage(filter: UsageQuery = usageFilter.value): Promise<void> {
    usageFilter.value = filter;
    try {
      // 汇总档（今日 / 近 7 日 / 累计）刻意不吃日期筛选：用户框选了上个月
      // 也不该让「今日」变成 0。workspace 维度跟随筛选（分区铁律）。
      const allFilter: UsageQuery = filter.workspaceId
        ? { workspaceId: filter.workspaceId }
        : {};
      [usageRows.value, usageSessionRows.value, usageAllRows.value] = await Promise.all([
        window.piBuddy.providers.usage.query(filter),
        window.piBuddy.providers.usage.sessions(filter),
        window.piBuddy.providers.usage.query(allFilter),
      ]);
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
    }
  }

  /** 导出返回的是**文本**，落盘位置由用户在浏览器下载对话框里决定。 */
  async function exportUsage(format: "csv" | "json"): Promise<void> {
    const result = await window.piBuddy.providers.usage.export({
      ...usageFilter.value,
      format,
    });
    const blob = new Blob([result.content], {
      type: format === "csv" ? "text/csv;charset=utf-8" : "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 按日期汇总的总花费，用量页顶部显示一个数。 */
  const totalCost = computed(() =>
    usageRows.value.reduce((sum, row) => sum + row.cost, 0)
  );
  const totalFailures = computed(() =>
    usageRows.value.reduce((sum, row) => sum + row.failures, 0)
  );

  /** 今日 / 近 7 日 / 累计（R5.2），从不带日期过滤的全量行汇总。 */
  const usageSummary = computed(() => summarizeUsage(usageAllRows.value, localDayOf()));

  return {
    providers,
    permissionEnforced,
    loading,
    lastError,
    panelOpen,
    usagePanelOpen,
    tests,
    usageRows,
    usageFilter,
    usageSessionRows,
    usageSummary,
    hasAnyConfigured,
    totalCost,
    totalFailures,
    refresh,
    saveKey,
    remove,
    addCustom,
    test,
    discoverModels,
    refreshUsage,
    exportUsage,
  };
});
