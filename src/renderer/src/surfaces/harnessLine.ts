import type { HarnessEnvironmentStatus } from "@server/shared/contract-harness";
import { timeAgo } from "../lib/format";

/** The one status line per host on Settings → Remote access: files and when (each set with its count), or never, or the last error. */
export function harnessLine(env: HarnessEnvironmentStatus, now = Date.now()): string {
  if (env.running) return "Harness config: syncing…";
  if (env.error) return `Harness config: ${env.error}${env.syncedAt ? ` (last synced ${ago(env.syncedAt, now)})` : ""}`;
  if (env.syncedAt === null) return `Harness config: never synced${env.connected ? "" : " · not connected"}`;
  return `Harness config: ${env.files ?? 0} ${env.files === 1 ? "file" : "files"}${setsLine(env.sets)}, synced ${ago(env.syncedAt, now)}${env.connected ? "" : " · not connected"}`;
}

/** " (Claude skills 80, Codex hooks 1, …)": the sets with files, in the set's order; nothing for an older sender. */
export function setsLine(sets: Record<string, number> | null): string {
  if (!sets) return "";
  const parts = Object.entries(sets).filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function ago(at: number, now: number): string {
  const t = timeAgo(at, now);
  return t === "now" ? "just now" : `${t} ago`;
}
