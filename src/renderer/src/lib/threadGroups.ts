import type { SessionMeta } from "./tcserver/types";
import { threadStateOf } from "../components/ui/status";

/**
 * The sections a list of threads falls into, in the order they are read:
 * Needs you, Working, Queued, Done. The master board's rows and the right
 * panel's Agents rows section by this one rule.
 */

export type MasterGroupId = "needsYou" | "running" | "queued" | "done";

export const GROUP_ORDER: readonly MasterGroupId[] = ["needsYou", "running", "queued", "done"];

export const GROUP_LABEL: Record<MasterGroupId, string> = {
  needsYou: "Needs you",
  running: "Working",
  queued: "Queued",
  done: "Done",
};

/** What a row's section reads off its meta. */
export type GroupedMeta = Pick<SessionMeta, "status"> & { background?: SessionMeta["background"] };

/** Which section a row sits in. A paused thread holds a live turn the
 *  person can resume, so it sits with the running ones; a queued one
 *  waits for a sibling. A settled one whose subagents still work is
 *  watching them (its row says Watching, settledWithAgents) and sits with
 *  the running ones too: the host's done rule and Archive done leave it
 *  out until they settle (batch.ts). */
export function groupOf(meta: GroupedMeta): MasterGroupId {
  const { status } = meta;
  if (status === "waiting" || status === "error") return "needsYou";
  if (threadStateOf(status) === "working" || status === "watching" || status === "paused") return "running";
  if (status === "queued") return "queued";
  if ((status === "idle" || status === "done") && meta.background?.agents.length) return "running";
  return "done";
}
