/**
 * 孩子档案的落盘（edu.kids / REQ-0001 R3）。
 *
 * ## 分区与生命周期（ADR-0002 D4 规则 3 / 规则 5）
 *
 * 数据按 capabilityId 分区：档案住在 `userData/edu-kids/profiles.json`，
 * 文件内再按 workspaceId 分键——同一台机器上不同工作区各自一份档案
 * （家里两个孩子各用一个工作文件夹是这个包的预期用法）。
 *
 * **停用能力不删这份文件**（规则 5：卸载与删数据是两个动作）：用户关掉
 * edu.kids 再打开，档案还在。这与「pi 资源经账本收回」是两回事——资源是
 * 我们物化的可再生副本，档案是用户输入的数据。
 *
 * ## 为什么不塞进 settings.json
 *
 * 与 capability-prefs 同一组理由：塞进去就自动落进 `settings:set` 的可写
 * 集合，且档案的键（workspaceId）是随使用增长的集合，不适合有穷举校验的
 * schema。独立文件的先例是 capability-prefs.json / update-prefs.json。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import type { EduKidsProfile, EduProfileSetRequest, EduSubjectId } from "@pibuddy/contract";
import { EDU_SUBJECTS } from "@pibuddy/contract";

import { writeJsonAtomic } from "../fs-atomic.js";

const EDU_DATA_DIR = "edu-kids";
const PROFILES_FILENAME = "profiles.json";

interface ProfileFile {
  version: number;
  /** workspaceId → 档案 */
  workspaces: Record<string, EduKidsProfile>;
}

/** 测试注入用的数据目录；生产环境恒为 null，走 app.getPath("userData")。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把档案落盘目录指向临时目录。 */
export function __setEduDataDir(dir: string | null): void {
  dataDirOverride = dir;
}

function profilesPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, EDU_DATA_DIR, PROFILES_FILENAME);
}

/** 一条档案的形状校验（读盘侧的宽进：坏条目丢弃，不让整个文件失效）。 */
function sanitizeProfile(value: unknown): EduKidsProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<EduKidsProfile>;
  if (typeof raw.grade !== "number" || !Number.isInteger(raw.grade)) return null;
  if (raw.grade < 1 || raw.grade > 6) return null;
  const subjects = Array.isArray(raw.subjects)
    ? raw.subjects.filter((s): s is EduSubjectId =>
        (EDU_SUBJECTS as readonly string[]).includes(s as string)
      )
    : [];
  return {
    childName: typeof raw.childName === "string" ? raw.childName.slice(0, 30) : "",
    grade: raw.grade,
    subjects,
    updatedAt:
      typeof raw.updatedAt === "number" && raw.updatedAt >= 0 ? Math.floor(raw.updatedAt) : 0,
  };
}

function loadFile(): ProfileFile {
  try {
    const raw = JSON.parse(fs.readFileSync(profilesPath(), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const workspaces: Record<string, EduKidsProfile> = {};
      const entries = (raw as Partial<ProfileFile>).workspaces ?? {};
      for (const [workspaceId, value] of Object.entries(entries)) {
        const profile = sanitizeProfile(value);
        if (profile !== null) workspaces[workspaceId] = profile;
      }
      return { version: 1, workspaces };
    }
  } catch {
    // 文件不存在 / 被手改坏：当空档案。写入路径会原子重建整个文件。
  }
  return { version: 1, workspaces: {} };
}

/** 读某工作区的档案；没有为 null（新工作区没有档案不是错误）。 */
export function loadEduProfile(workspaceId: string): EduKidsProfile | null {
  return loadFile().workspaces[workspaceId] ?? null;
}

/** 整份替换某工作区的档案，盖 updatedAt，返回写入后的档案。 */
export function saveEduProfile(request: EduProfileSetRequest): EduKidsProfile {
  const file = loadFile();
  const profile: EduKidsProfile = {
    childName: request.childName,
    grade: request.grade,
    // 去重（zod 只限长度，不限重复）：同一科目声明两遍没有第二种语义
    subjects: [...new Set(request.subjects)],
    updatedAt: Date.now(),
  };
  file.workspaces[request.workspaceId] = profile;
  writeJsonAtomic(profilesPath(), file);
  return profile;
}
