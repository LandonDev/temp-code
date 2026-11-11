/**
 * A context window that refills to its limit on every request: the thread
 * compacts, the harness attaches the same fixed overhead again, and the next
 * request compacts again (docs/agents/prompt-overhead.md has the two
 * sightings, both compacting every 30–70 s). A healthy long thread compacts
 * tens of minutes apart, so four compactions inside ten minutes is a turn
 * that makes no progress; the host ends it as `context_thrash`
 * (sessions.ts, failureKind.ts).
 */
export const THRASH = { compactions: 4, withinMs: 10 * 60_000 } as const

/** The finished compactions still inside the window ending now, oldest first. */
export function recentCompactions(doneTimes: readonly number[], now: number): number[] {
  return doneTimes.filter((t) => now - t <= THRASH.withinMs)
}

/** Whether the compactions finished so far say the window keeps refilling. */
export function isThrashing(doneTimes: readonly number[], now: number): boolean {
  return recentCompactions(doneTimes, now).length >= THRASH.compactions
}

const tokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** The host's error row for a turn it ended this way, which failureKind.ts reads back:
 *  `context thrash: 4 compactions in 6 min; first request 167k of 200k` (the clause after `;` only when the harness's first context reading is known). */
export function contextThrashRow(count: number, spanMs: number, first?: { tokens: number; window: number | null } | null): string {
  const minutes = Math.max(1, Math.round(spanMs / 60_000))
  const head = `context thrash: ${count} compactions in ${minutes} min`
  return first && first.window ? `${head}; first request ${tokens(first.tokens)} of ${tokens(first.window)}` : head
}

/** The row's parts, or null for any other message. */
export function parseContextThrashRow(message: string): { count: number; minutes: number; first: string | null; window: string | null } | null {
  const m = /^context thrash: (\d+) compactions in (\d+) min(?:; first request (\S+) of (\S+))?/.exec(message.trim())
  return m ? { count: Number(m[1]), minutes: Number(m[2]), first: m[3] ?? null, window: m[4] ?? null } : null
}

/** Claude Code's own guard, ending the turn: "Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row." */
export const CLI_THRASH = /Autocompact is thrashing/i
