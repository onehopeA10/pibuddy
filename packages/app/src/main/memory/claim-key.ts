/**
 * Claim 身份：同 subject+predicate 才进同一组 Authority。
 * 未命中启发式时用 envelope id，避免多条无关 fact 被 logicalKind 压成一条。
 */
export function inferClaim(content: string, fallbackKind: string): { subject: string; predicate: string } {
  const text = content.replace(/\s+/g, " ").trim().toLowerCase();
  if (/pnpm|yarn|npm|包管理/.test(text)) return { subject: "package_manager", predicate: "default" };
  if (/node(?:\.js)?|nodejs/.test(text) && /版本|>=|v\d+/.test(text)) return { subject: "node", predicate: "version" };
  if (/postgres|mysql|数据库/.test(text)) return { subject: "database", predicate: "engine" };
  if (/会议|日程|calendar/.test(text)) return { subject: "calendar", predicate: "today" };
  return { subject: fallbackKind, predicate: "stated" };
}

export function claimIdentity(env: {
  id: string;
  logicalKind: string;
  claimSubject?: string | null;
  claimPredicate?: string | null;
  content: string;
}): string {
  const inferred = inferClaim(env.content, env.logicalKind);
  const subject =
    env.claimSubject && env.claimSubject !== env.logicalKind
      ? env.claimSubject
      : inferred.subject !== env.logicalKind
        ? inferred.subject
        : env.id;
  const predicate =
    env.claimPredicate && env.claimPredicate !== "stated" ? env.claimPredicate : inferred.predicate;
  return `${subject}::${predicate}`;
}
