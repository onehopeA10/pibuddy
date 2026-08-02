// @vitest-environment happy-dom
/**
 * 首次启动向导（UX-101）。
 *
 * 三条断言各自对应一种会让用户直接放弃的行为：
 *
 *   1. **可中断恢复** —— 每完成一步立刻写 `settings.onboardingStep`；模拟
 *      在第 4 步重启后，store 重新加载时 step === 4 而不是 0。
 *   2. **完成判据是 completedAt 而不是 step** —— 用 step 冒充完成状态的话，
 *      用户在第 3 步退出后重进会直接落到主界面，那时候连模型都还没有。
 *   3. **测试连接的失败文案带 HTTP 状态码或 errno** —— 「连接失败」四个字
 *      对排查毫无帮助，用 401 与 ENOTFOUND 两个注入错误分别断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import type { ProviderTestResult } from "@contract";

vi.mock("naive-ui", () => ({
  NAlert: { template: `<div class="alert"><slot /></div>` },
  NButton: {
    inheritAttrs: false,
    props: ["disabled"],
    template: `<button v-bind="$attrs" :disabled="disabled"><slot /></button>`,
  },
  NCheckbox: {
    props: ["checked"],
    emits: ["update:checked"],
    template: `<label><input type="checkbox" :checked="checked" /><slot /></label>`,
  },
  NInput: {
    inheritAttrs: false,
    props: ["value"],
    emits: ["update:value"],
    template: `<input v-bind="$attrs" :value="value" />`,
  },
  NRadio: { template: `<label><slot /></label>` },
  NRadioGroup: { template: `<div><slot /></div>` },
  NSpace: { template: `<div><slot /></div>` },
  NSteps: { template: `<div class="steps"><slot /></div>` },
  NStep: { template: `<div class="step" />` },
  NTag: { template: `<span class="tag"><slot /></span>` },
}));

import OnboardingWizard from "./OnboardingWizard.vue";
import { useAppStore } from "../stores/app";
import { useProvidersStore } from "../stores/providers";

/** 主进程侧设置的替身 —— 保存后再读得到，才能验证「重启后恢复」。 */
let persisted: Record<string, unknown>;
let testResult: ProviderTestResult;

function installBridge(): void {
  (window as unknown as { piBuddy: unknown }).piBuddy = {
    settings: {
      get: vi.fn(async () => ({ ...persisted })),
      set: vi.fn(async (patch: Record<string, unknown>) => {
        persisted = { ...persisted, ...patch };
        return { ...persisted };
      }),
    },
    providers: {
      list: vi.fn(async () => ({
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            authKind: "api_key",
            configured: false,
            last4: "",
            custom: false,
            models: [],
            permissionEnforced: true,
          },
        ],
        permissionEnforced: true,
      })),
      saveKey: vi.fn(async () => ({
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            authKind: "api_key",
            configured: true,
            last4: "1234",
            custom: false,
            models: [],
            permissionEnforced: true,
          },
        ],
        permissionEnforced: true,
      })),
      test: vi.fn(async () => testResult),
    },
    piResources: { trust: { describe: vi.fn(async () => null), decide: vi.fn() } },
    pi: {},
    sessions: { saveDraft: vi.fn(async () => true), getDraft: vi.fn(async () => null) },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  persisted = {
    schemaVersion: 2,
    piRuntimeMode: "bundled",
    sttApiKeyConfigured: false,
    sttApiKeyLast4: "",
    crashDumpConsent: "unset",
    workspaceDefaults: {},
    onboardingStep: 0,
    notificationsEnabled: true,
    voiceEnabled: false,
  };
  testResult = { ok: true, latencyMs: 42 };
  installBridge();
});

describe("[向导可中断恢复]", () => {
  it("每完成一步立刻写 onboardingStep", async () => {
    const app = useAppStore();
    app.settings = { ...app.settings, ...persisted } as never;
    const wrapper = mount(OnboardingWizard);
    await nextTick();

    await (wrapper.vm as unknown as { gotoStep: (n: number) => Promise<void> }).gotoStep(1);
    expect(persisted.onboardingStep).toBe(1);
    await (wrapper.vm as unknown as { gotoStep: (n: number) => Promise<void> }).gotoStep(4);
    expect(persisted.onboardingStep).toBe(4);
  });

  it("第 4 步后模拟重启：重新加载 store，state.step === 4 而不是 0", async () => {
    // 第一次挂载，走到第 4 步
    const app = useAppStore();
    app.settings = { ...app.settings, ...persisted } as never;
    const first = mount(OnboardingWizard);
    await nextTick();
    await (first.vm as unknown as { gotoStep: (n: number) => Promise<void> }).gotoStep(4);
    first.unmount();

    // 「重启」：全新 pinia，从持久化的设置重新加载
    setActivePinia(createPinia());
    const reloaded = useAppStore();
    reloaded.settings = (await window.piBuddy.settings.get()) as never;
    const second = mount(OnboardingWizard);
    await nextTick();

    expect((second.vm as unknown as { step: number }).step).toBe(4);
    expect(second.find('[data-testid="onboarding-wizard"]').attributes("data-step")).toBe("4");
  });

  it("onboardingCompletedAt 只在最后一步完成后写入", async () => {
    const app = useAppStore();
    app.settings = { ...app.settings, ...persisted } as never;
    const wrapper = mount(OnboardingWizard);
    await nextTick();

    // 走遍前五步，一次都不该写 completedAt
    for (const step of [1, 2, 3, 4]) {
      await (wrapper.vm as unknown as { gotoStep: (n: number) => Promise<void> }).gotoStep(step);
      expect(persisted.onboardingCompletedAt).toBeUndefined();
    }

    await (wrapper.vm as unknown as { finish: () => Promise<void> }).finish();
    expect(persisted.onboardingCompletedAt).toBeTypeOf("number");
  });
});

describe("[测试连接] 失败文案必须带状态码或 errno", () => {
  it("注入 401 → 文案含 '401'", async () => {
    testResult = {
      ok: false,
      latencyMs: 12,
      errorCode: "auth",
      redactedMessage: "HTTP 401 · invalid api key",
    };
    const app = useAppStore();
    app.settings = { ...app.settings, ...persisted } as never;
    const wrapper = mount(OnboardingWizard);
    await nextTick();

    await (wrapper.vm as unknown as { saveKeyAndTest: () => Promise<void> }).saveKeyAndTest();
    await nextTick();

    expect((wrapper.vm as unknown as { testText: string }).testText).toContain("401");
  });

  it("注入 ENOTFOUND → 文案含 'ENOTFOUND'", async () => {
    testResult = {
      ok: false,
      latencyMs: 5000,
      errorCode: "network",
      redactedMessage: "getaddrinfo ENOTFOUND api.example.com",
    };
    const app = useAppStore();
    app.settings = { ...app.settings, ...persisted } as never;
    const wrapper = mount(OnboardingWizard);
    await nextTick();

    await (wrapper.vm as unknown as { saveKeyAndTest: () => Promise<void> }).saveKeyAndTest();
    await nextTick();

    expect((wrapper.vm as unknown as { testText: string }).testText).toContain("ENOTFOUND");
  });

  it("成功时文案含「成功」", async () => {
    testResult = { ok: true, latencyMs: 42 };
    const app = useAppStore();
    app.settings = { ...app.settings, ...persisted } as never;
    const wrapper = mount(OnboardingWizard);
    await nextTick();

    await (wrapper.vm as unknown as { saveKeyAndTest: () => Promise<void> }).saveKeyAndTest();
    await nextTick();

    expect((wrapper.vm as unknown as { testText: string }).testText).toContain("成功");
  });
});

describe("推进闸门", () => {
  it("没选工作文件夹时第 1 步不能往下走，并说明原因", async () => {
    const app = useAppStore();
    app.settings = { ...app.settings, ...persisted } as never;
    app.workspaceId = "";
    const wrapper = mount(OnboardingWizard);
    await (wrapper.vm as unknown as { gotoStep: (n: number) => Promise<void> }).gotoStep(1);
    await nextTick();

    expect((wrapper.vm as unknown as { canAdvance: boolean }).canAdvance).toBe(false);
    expect(wrapper.find('[data-testid="onboarding-block-reason"]').text()).toContain(
      "工作文件夹"
    );
  });

  it("一个账号都没配时第 3 步不能往下走", async () => {
    const app = useAppStore();
    app.settings = { ...app.settings, ...persisted } as never;
    const providers = useProvidersStore();
    await providers.refresh();
    const wrapper = mount(OnboardingWizard);
    await (wrapper.vm as unknown as { gotoStep: (n: number) => Promise<void> }).gotoStep(3);
    await nextTick();

    expect(providers.hasAnyConfigured).toBe(false);
    expect((wrapper.vm as unknown as { canAdvance: boolean }).canAdvance).toBe(false);
  });
});

describe("无障碍基线", () => {
  it("向导是带 aria-labelledby 的 dialog", async () => {
    const app = useAppStore();
    app.settings = { ...app.settings, ...persisted } as never;
    const wrapper = mount(OnboardingWizard);
    const root = wrapper.find('[data-testid="onboarding-wizard"]');
    expect(root.attributes("role")).toBe("dialog");
    expect(root.attributes("aria-modal")).toBe("true");
    expect(root.attributes("aria-labelledby")).toBe("wizard-title");
    expect(wrapper.find("#wizard-title").exists()).toBe(true);
  });
});
