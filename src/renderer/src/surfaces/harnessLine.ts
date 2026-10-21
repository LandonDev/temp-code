import type { HarnessEnvironmentStatus } from "@server/shared/contract-harness";
import { timeAgo } from "../lib/format";

/** The one status line per host on Settings → Remote access: files and when, or never, or the last error. */
export function harnessLine(env: HarnessEnvironmentStatus, now = Date.now()): string {
  if (env.running) return "Harness config: syncing…";
  if (env.error) return `Harness config: ${env.error}${env.syncedAt ? ` (last synced ${ago(env.syncedAt, now)})` : ""}`;
  if (env.syncedAt === null) return `Harness config: never synced${env.connected ? "" : " · not connected"}`;
  return `Harness config: ${env.files ?? 0} ${env.files === 1 ? "file" : "files"}, synced ${ago(env.syncedAt, now)}${env.connected ? "" : " · not connected"}`;
}

function ago(at: number, now: number): string {
  const t = timeAgo(at, now);
  return t === "now" ? "just now" : `${t} ago`;
}
