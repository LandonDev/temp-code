import type { HarnessEnvironmentStatus } from "@server/shared/contract-harness";
import { HARNESS_SET_LABELS } from "@shared/harnessSets";
import { timeAgo } from "../lib/format";

/**
 * A host's harness sync on Settings → Hosts, as separate facts: the files
 * and when, or never, or the last error. The row's title says "Harness
 * config" and the host's header says whether it is connected; each set's
 * count is the facts' tooltip (`setsText`).
 */
export function harnessParts(env: HarnessEnvironmentStatus, now = Date.now()): string[] {
  if (env.running) return ["Syncing…"];
  if (env.error) return env.syncedAt ? [env.error, `last synced ${ago(env.syncedAt, now)}`] : [env.error];
  if (env.syncedAt === null) return ["Never synced"];
  return [`${env.files ?? 0} ${env.files === 1 ? "file" : "files"}`, `synced ${ago(env.syncedAt, now)}`];
}

/** "Claude commands 4, Codex hooks 1, …": the sets with files, in the set's order, only those still synced (an older build's skill sets drop out); "" for none. */
export function setsText(sets: Record<string, number> | null, labels: readonly string[] = HARNESS_SET_LABELS): string {
  if (!sets) return "";
  return Object.entries(sets)
    .filter(([label, n]) => n > 0 && labels.includes(label))
    .map(([label, n]) => `${label} ${n}`)
    .join(", ");
}

/** "just now", "3m ago", "2d ago", or the date past a week ("Oct 3"). */
export function ago(at: number, now = Date.now()): string {
  const t = timeAgo(at, now);
  if (t === "now") return "just now";
  return /^\d+[mhd]$/.test(t) ? `${t} ago` : t;
}
