import type { AdmissionState } from "@server/shared/contract-admission";
import type { PublishStatus } from "@server/shared/contract-host";
import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";

/**
 * The facts the Hosts page's rows show, each a separate string that `Facts`
 * draws with space between (never a middle dot). Pure, so every state is
 * testable.
 */

/** 81920 → "80 GiB", 9216 → "9 GiB", 2560 → "2.5 GiB". */
export function gib(mb: number): string {
  const n = mb / 1024;
  return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} GiB`;
}

/** "118 of 120 running", "7 queued". */
export function runningParts(s: AdmissionState): string[] {
  const parts = [`${s.running} of ${s.cap} running`];
  if (s.queued > 0) parts.push(`${s.queued} queued`);
  return parts;
}

/** "80 GiB budget", "331 MB per thread", "9 GiB free": what the default cap is sized from. */
export function budgetParts(s: AdmissionState): string[] {
  return [`${gib(s.memory.budgetMB)} budget`, `${s.memory.perProcessMB} MB per thread`, `${gib(s.memory.freeMB)} free`];
}

/** "1 running", "2 waiting", "1 thread": what a host has on this Mac right now; "Nothing running" when idle. */
export function usageParts(host: Pick<MacBridgeHostPolicy, "running" | "held" | "threads">): string[] {
  const parts: string[] = [];
  if (host.running) parts.push(`${host.running} running`);
  if (host.held) parts.push(`${host.held} waiting`);
  if (host.threads) parts.push(`${host.threads} ${host.threads === 1 ? "thread" : "threads"}`);
  return parts.length ? parts : ["Nothing running"];
}

/** The Publish row: "v1.0.306", "last v1.0.305", and what would stop a publish. The checkout is the field beside it. */
export function publishParts(p: PublishStatus | null): string[] {
  if (!p) return [];
  if (!p.readable) return [p.refusal ?? `${p.checkout} is not readable`];
  const parts = [p.version ? `v${p.version}` : "HEAD"];
  if (p.publishedVersion) parts.push(`last v${p.publishedVersion}`);
  if (p.branch && p.branch !== "master") parts.push(`on ${p.branch}, not master`);
  if (p.dirty) parts.push("uncommitted changes");
  return parts;
}
