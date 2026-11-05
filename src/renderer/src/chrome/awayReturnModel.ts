import type { AwayDecided } from "@server/shared/away";
import type { AwayPushListener } from "../lib/away";

/** A thread that decided without the person, on its host. */
export type AwayDecidedThread = { environmentId: string; sessionId: string; count: number };

/** How long after a host turns Away off its peers' tallies still join the toast. */
export const AWAY_RETURN_GATHER_MS = 3_000;

export const AWAY_RETURN_TOAST = "away-return";

/** "Decided without you in 4 threads", "in 1 thread". */
export function returnLine(threads: number): string {
  return `Decided without you in ${threads} ${threads === 1 ? "thread" : "threads"}`;
}

/** "3 decisions", "1 decision". */
export function decisionsLabel(count: number): string {
  return `${count} ${count === 1 ? "decision" : "decisions"}`;
}

/** Every thread of every gathered tally that decided at least once. */
export function decidedThreadsOf(tallies: ReadonlyMap<string, AwayDecided>): AwayDecidedThread[] {
  return [...tallies].flatMap(([environmentId, decided]) =>
    decided.threads.filter((t) => t.count > 0).map((t) => ({ environmentId, sessionId: t.sessionId, count: t.count })),
  );
}

/**
 * The return: a live push turning a host's Away from on to off opens a
 * window of `AWAY_RETURN_GATHER_MS`, and each host's tally that lands in it
 * (the host that flipped, then its peers as the flip reaches them) joins
 * one list, handed to `show` each time it holds a thread. The state at a
 * link's open is no push, so a boot never shows anything.
 */
export function createAwayReturn(show: (threads: AwayDecidedThread[]) => void, now: () => number = Date.now): AwayPushListener {
  let until = -Infinity;
  let tallies = new Map<string, AwayDecided>();
  return (environmentId, before, after) => {
    const returned = before?.state.enabled === true && !after.state.enabled;
    if (returned && now() > until) {
      until = now() + AWAY_RETURN_GATHER_MS;
      tallies = new Map();
    }
    // A host still away (or away again) has nothing to report yet.
    if (now() > until || after.state.enabled) return;
    tallies.set(environmentId, after.decided);
    const threads = decidedThreadsOf(tallies);
    if (threads.length > 0) show(threads);
  };
}
