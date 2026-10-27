import type { AccountHeadroom } from "@server/shared/accounts";
import { resetLabel, untilLabel } from "./accounts";

/**
 * One account's headroom as a row shows it: the bar's fill, the word beside
 * it, and the hover lines with the reset moment. Pure, so the popover and the
 * Claude panel read the same words.
 */
export interface HeadroomLook {
  /** Fill of the bar, 0..100; 0 while throttled or before any answer. */
  percent: number;
  /** The word beside the bar. */
  text: string;
  /** How long a cooldown has left, shown after the word; null outside one. */
  until: string | null;
  /** "muted" before any answer, "limited" inside a 429's cooldown, else by how much is left. */
  tone: "muted" | "ok" | "low" | "limited";
  /** The hover text, one line each: when the limit refills or the cooldown lifts, and the rate. */
  lines: string[];
}

const LOW_BELOW = 0.25;

export function headroomLook(h: AccountHeadroom | undefined, now: number): HeadroomLook {
  const rate = h && h.ratePerMin > 0 ? `${h.ratePerMin} answer${h.ratePerMin === 1 ? "" : "s"} in the last minute, every host` : null;
  const lines = (...all: (string | null | undefined)[]) => all.filter((s): s is string => !!s);
  if (!h || (h.room === null && !h.throttledUntil)) {
    return { percent: 0, text: "No answer yet", until: null, tone: "muted", lines: lines(rate ?? "No answer seen from this account yet") };
  }
  if (h.throttledUntil !== undefined && h.throttledUntil > now) {
    const until = untilLabel(h.throttledUntil, now);
    return { percent: 0, text: "Limited", until, tone: "limited", lines: lines(`Picks again ${resetLabel(h.throttledUntil)}, in ${until}`, rate) };
  }
  const room = h.room ?? 1;
  const percent = Math.round(room * 100);
  const lead = h.resetsAt !== undefined && h.resetsAt > now ? `Refills ${resetLabel(h.resetsAt)}, in ${untilLabel(h.resetsAt, now)}` : "No reset announced";
  return {
    percent,
    text: `${percent}% left`,
    until: null,
    tone: room < LOW_BELOW ? "low" : "ok",
    lines: lines(lead, rate, h.tier ? `Provider says ${h.tier}` : null),
  };
}
