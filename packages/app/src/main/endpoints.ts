/**
 * 出站端点注册表（SEC-004）。
 *
 * 渲染进程提交一个地址，主进程校验通过后签发一个不透明的 `endpointId`；
 * 此后所有请求只认这个 id。这样「往哪发」这个决定权就永久留在了主进程侧：
 * 渲染进程即便被完全攻陷，也只能在**已经过校验的端点集合**里挑一个，而
 * 不能现编一个 `https://169.254.169.254/v1` 出来。
 *
 * 校验发生在**保存之前**，因此被拒的地址一个字节都不会落盘（TASK-008 的
 * 人工回归项 d 就是查这个）。
 */
import { app } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./fs-atomic.js";
import { assertPublicAddress, normalizeEndpointUrl } from "./net/outbound-guard.js";

export type EndpointKind = "stt" | "provider";

export interface EndpointRecord {
  endpointId: string;
  kind: EndpointKind;
  /** 已规范化的 https 地址（无用户名密码、host 已折过） */
  baseUrl: string;
  model: string;
  registeredAt: number;
}

/** 渲染进程可见的部分：id 与展示名，没有别的。 */
export interface EndpointView {
  endpointId: string;
  label: string;
}

const STORE_FILE = "endpoints.json";

let dataDirOverride: string | null = null;

/** 仅供单测：把 endpoints.json 指向临时目录。 */
export function __setEndpointDataDir(dir: string | null): void {
  dataDirOverride = dir;
  cache = null;
}

function storePath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, STORE_FILE);
}

let cache: Map<string, EndpointRecord> | null = null;

function load(): Map<string, EndpointRecord> {
  if (cache) return cache;
  const map = new Map<string, EndpointRecord>();
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    if (Array.isArray(raw)) {
      for (const item of raw as EndpointRecord[]) {
        if (item && typeof item.endpointId === "string") map.set(item.endpointId, item);
      }
    }
  } catch {
    /* 没有文件 / 读不动：空表 */
  }
  cache = map;
  return map;
}

function persist(map: Map<string, EndpointRecord>): void {
  writeJsonAtomic(storePath(), [...map.values()]);
}

/** id 由 (kind, baseUrl) 派生：同一个端点重复保存不会长出第二条记录。 */
function deriveId(kind: EndpointKind, baseUrl: string): string {
  return createHash("sha256").update(`${kind}|${baseUrl}`).digest("hex").slice(0, 16);
}

/**
 * 校验并登记一个端点。**先校验，再落盘。**
 *
 * 抛出的错误直接来自 outbound-guard（OUTBOUND_BLOCKED / OUTBOUND_DNS_FAILED），
 * 界面把它原样展示即可：这两条消息本身就是给人看的。
 */
export async function registerEndpoint(input: {
  kind: EndpointKind;
  baseUrl: string;
  model?: string;
}): Promise<EndpointRecord> {
  // 自定义模型接口经常是 http 明文中转；语音转写仍只收 https。
  const baseUrl = normalizeEndpointUrl(input.baseUrl, {
    allowHttp: input.kind === "provider",
  });
  await assertPublicAddress(new URL(baseUrl).hostname);

  const endpointId = deriveId(input.kind, baseUrl);
  const map = load();
  const record: EndpointRecord = {
    endpointId,
    kind: input.kind,
    baseUrl,
    model: input.model?.trim() || "whisper-1",
    registeredAt: map.get(endpointId)?.registeredAt ?? Date.now(),
  };
  map.set(endpointId, record);
  persist(map);
  return record;
}

/** 按 id 取端点。取不到就抛 —— 渲染进程给的 id 一律当作不可信。 */
export function requireEndpoint(endpointId: string): EndpointRecord {
  const record = load().get(endpointId);
  if (!record) throw new Error("ENDPOINT_NOT_FOUND: 端点不存在，请到「设置」里重新保存");
  return record;
}

export function describeEndpoint(record: EndpointRecord): EndpointView {
  return { endpointId: record.endpointId, label: new URL(record.baseUrl).host };
}

export function listEndpoints(kind?: EndpointKind): EndpointView[] {
  return [...load().values()]
    .filter((r) => (kind ? r.kind === kind : true))
    .map(describeEndpoint);
}
