import type { MemoryEnvironmentStatus } from "@server/shared/contract-memory";
import { timeAgo } from "../lib/format";

/** The memory line under a host's harness line on Settings → Remote access: files and when, the conflicts of the last round, or never, or the last error. */
export function memoryLine(env: MemoryEnvironmentStatus, now = Date.now()): string {
  if (env.running) return "Memory: syncing…";
  if (env.error) return `Memory: ${env.error}${env.syncedAt ? ` (last synced ${ago(env.syncedAt, now)})` : ""}`;
  if (env.syncedAt === null) return `Memory: never synced${env.connected ? "" : " · not connected"}`;
  const conflicts = env.conflicts > 0 ? `, ${env.conflicts} ${env.conflicts === 1 ? "conflict" : "conflicts"}` : "";
  return `Memory: ${env.files ?? 0} ${env.files === 1 ? "file" : "files"}, synced ${ago(env.syncedAt, now)}${conflicts}${env.connected ? "" : " · not connected"}`;
}

function ago(at: number, now: number): string {
  const t = timeAgo(at, now);
  return t === "now" ? "just now" : `${t} ago`;
}
