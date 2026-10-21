import type { AccountHeadroom } from "@server/shared/accounts";
import { resetLabel, untilLabel } from "./accounts";

/**
 * One account's headroom as a row shows it: the bar's fill, the word beside
 * it, and the hover text with the reset moment. Pure, so the popover and the
 * Claude panel read the same words.
 */
export interface HeadroomLook {
  /** Fill of the bar, 0..100; 0 while throttled or before any answer. */
  percent: number;
  /** The word beside the bar. */
  text: string;
  /** "muted" before any answer, "limited" inside a 429's cooldown, else by how much is left. */
  tone: "muted" | "ok" | "low" | "limited";
  /** The hover text: when the limit refills or the cooldown lifts, and the rate. */
  title: string;
}

const LOW_BELOW = 0.25;

export function headroomLook(h: AccountHeadroom | undefined, now: number): HeadroomLook {
  const rate = h && h.ratePerMin > 0 ? `${h.ratePerMin} answer${h.ratePerMin === 1 ? "" : "s"} in the last minute, every host` : null;
  if (!h || (h.room === null && !h.throttledUntil)) {
    return { percent: 0, text: "no answer yet", tone: "muted", title: rate ?? "No answer seen from this account yet" };
  }
  if (h.throttledUntil !== undefined && h.throttledUntil > now) {
    const lead = `Rate limited · picks again ${resetLabel(h.throttledUntil)} (in ${untilLabel(h.throttledUntil, now)})`;
    return { percent: 0, text: `rate limited · ${untilLabel(h.throttledUntil, now)}`, tone: "limited", title: rate ? `${lead}\n${rate}` : lead };
  }
  const room = h.room ?? 1;
  const percent = Math.round(room * 100);
  const lead = h.resetsAt !== undefined && h.resetsAt > now ? `Refills ${resetLabel(h.resetsAt)} (in ${untilLabel(h.resetsAt, now)})` : "No reset announced";
  const title = [lead, rate, h.tier ? `Provider says ${h.tier}` : null].filter((s): s is string => !!s).join("\n");
  return { percent, text: `${percent}% left`, tone: room < LOW_BELOW ? "low" : "ok", title };
}
