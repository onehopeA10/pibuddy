/**
 * Pi 运行时来源的授权流程（SEC-005）。
 *
 * ## 这个文件存在的理由
 *
 * `piExternalCommand` 是全仓唯一一个「用户可配置、且最终会成为 spawn 的
 * argv[0]」的值。收敛前它是 `settings:set` 的一个普通字段：渲染进程发一次
 * `{piRuntimeMode:"external", piExternalCommand:"C:\\Windows\\System32\\calc.exe"}`
 * 就能让主进程在下一次启动时执行任意本机程序 —— 这条路绕开了 TASK-007 把
 * `pi:command` 拆成 15 条窄通道所建立的全部约束，而那次收敛的整个理由就是
 * 「渲染进程不得表达任意命令执行」。
 *
 * 现在的判据有两条，缺一条都不成立：
 *
 *   1. **路径不再由渲染进程提供** —— `settings:set-pi-runtime` 的入参只有
 *      一个 mode 枚举。可执行文件由主进程弹原生文件选择框，用户当面挑。
 *      与 `dialog:choose-folder` 同一口径（工作目录也只能经真实用户手势）。
 *   2. **落盘前必须有一次展示完整路径的确认** —— 文件选择框本身可能被一段
 *      诱导性文案带偏，因此再要一次「你即将允许 PiBuddy 执行 <绝对路径>」
 *      的确认。这一步的对话框由主进程创建，渲染进程既伪造不了也绕不开。
 *
 * 切回 bundled 是**降权**，不需要确认：给一个正在被攻击的用户多一道弹窗，
 * 拦不住任何攻击，只会让「恢复到安全状态」这件事变难。
 *
 * ## 为什么逻辑与 electron 分离
 *
 * 判定本身（取消了要不要落盘、落盘落的是哪一个字符串）是这条修复的全部
 * 内容，而它一旦和 `dialog.showOpenDialog` 写在一起就只能靠真机点击来验证。
 * 依赖以参数注入，misc-ipc.ts 只负责把真的 electron 对话框接上来。
 */
import type { AppSettings } from "@pibuddy/contract";

export interface PiRuntimeApprovalDeps {
  /**
   * 弹原生文件选择框，返回用户选中的绝对路径；用户取消返回 null。
   * 渲染进程在这条路径上没有任何输入。
   */
  pickExecutable(): Promise<string | null>;
  /**
   * 把用户挑中的文件解析成**真正会被 spawn 的**可执行文件绝对路径。
   * 不存在 / 不是文件时抛错（由 pi-launcher 的同一份解析实现负责）。
   */
  resolveCommand(picked: string): string;
  /** 展示完整路径并要求用户明确确认；返回是否确认。默认按钮必须是「取消」。 */
  confirm(resolvedPath: string): Promise<boolean>;
  /** 落盘。只有在确认之后才允许被调用。 */
  persist(patch: Partial<AppSettings>): AppSettings;
  /** 当前设置；用户取消时原样返回，向界面表明「一个字节都没改」。 */
  current(): AppSettings;
}

export interface PiRuntimeApplyOutcome {
  applied: boolean;
  settings: AppSettings;
}

/**
 * 应用一次运行时来源选择。
 *
 * external 路径上任何一步的取消都必须让 `persist` **一次都不被调用** ——
 * 「先写下去，失败再改回来」的写法会在中途崩溃时留下一个用户从没同意过的
 * 外部命令。
 */
export async function applyPiRuntimeChoice(
  mode: "bundled" | "external",
  deps: PiRuntimeApprovalDeps
): Promise<PiRuntimeApplyOutcome> {
  if (mode === "bundled") {
    // 降权：不弹确认，也不保留上一次的 external 命令 —— 留着它，下次误点
    // 「外部」就会在没有任何确认的情况下重新指向那个旧路径。
    return {
      applied: true,
      settings: deps.persist({ piRuntimeMode: "bundled", piExternalCommand: "" }),
    };
  }

  const picked = await deps.pickExecutable();
  if (picked === null) return { applied: false, settings: deps.current() };

  // 解析放在确认**之前**：确认框上必须写的是真正会被执行的那个文件，
  // 而不是用户点中的那个名字（两者在 Windows 的 .cmd/.exe 补全下可以不同）。
  const resolved = deps.resolveCommand(picked);

  const confirmed = await deps.confirm(resolved);
  if (!confirmed) return { applied: false, settings: deps.current() };

  return {
    applied: true,
    settings: deps.persist({ piRuntimeMode: "external", piExternalCommand: resolved }),
  };
}
