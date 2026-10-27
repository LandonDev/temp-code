import type { MemoryEnvironmentStatus } from "@server/shared/contract-memory";
import { ago } from "./harnessLine";

/** A host's memory sync on Settings → Hosts, as separate facts: files and when, the conflicts of the last round, or never, or the last error. */
export function memoryParts(env: MemoryEnvironmentStatus, now = Date.now()): string[] {
  if (env.running) return ["Syncing…"];
  if (env.error) return env.syncedAt ? [env.error, `last synced ${ago(env.syncedAt, now)}`] : [env.error];
  if (env.syncedAt === null) return ["Never synced"];
  const parts = [`${env.files ?? 0} ${env.files === 1 ? "file" : "files"}`, `synced ${ago(env.syncedAt, now)}`];
  if (env.conflicts > 0) parts.push(`${env.conflicts} ${env.conflicts === 1 ? "conflict" : "conflicts"}`);
  return parts;
}
