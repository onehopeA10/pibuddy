/**
 * 连接器凭证的存取（连接器 v1 / CON-101）。
 *
 * ## 凭证 = 完整 webhook URL
 *
 * 自定义机器人 incoming webhook 的密令写在 URL 路径里（`.../hook/<token>`），
 * 因此整条 URL 就是这个连接器的凭证。它经 secret-store（safeStorage 加密、
 * 只进不出）保管，槽位名按 `connector.<id>` 命名空间隔离——一个连接器一把。
 *
 * ## 为什么这层薄封装值得单独存在
 *
 * 它把「连接器凭证的槽位怎么算」这件事收成唯一一处。散落在 manager / outbound
 * 各写一遍 `connector.${id}` 的话，改命名规则要改好几处，漏一处就成了一把
 * 取不回来的孤儿密钥。
 *
 * ## 不进日志
 *
 * 本模块只搬运密文与 `{configured, last4}`，从不把明文 URL 交给任何 logger。
 * loadUrl 的返回值只在 `connector-outbound.ts` 里直接喂给 safeFetch，且那里
 * 的错误一律经出站守卫脱敏（不含 URL）。
 */
import { describeSecret, loadSecret, saveSecret } from "../secret-store.js";
import type { SecretDescriptor } from "@pibuddy/contract";

/** 某连接器的凭证槽位名。 */
function slotOf(connectorId: string): string {
  return `connector.${connectorId}`;
}

/** 保存 / 轮换一个连接器的完整 webhook URL。返回 {configured, last4}，无明文。 */
export function saveConnectorUrl(connectorId: string, url: string): SecretDescriptor {
  return saveSecret(slotOf(connectorId), url);
}

/** 清除一个连接器的凭证（删除连接器时调用）。 */
export function clearConnectorUrl(connectorId: string): void {
  saveSecret(slotOf(connectorId), "");
}

/** 取回完整 URL（**仅供主进程出站时使用**）；未配置 / 解不开返回 null。 */
export function loadConnectorUrl(connectorId: string): string | null {
  return loadSecret(slotOf(connectorId));
}

/** 渲染进程唯一能看到的凭证形态：配没配 + 尾四位。 */
export function describeConnectorUrl(connectorId: string): SecretDescriptor {
  return describeSecret(slotOf(connectorId));
}
