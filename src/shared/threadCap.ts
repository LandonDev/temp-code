import { z } from 'zod'

/**
 * The host's running cap (CLAUDE.md "Master threads"): how many root
 * threads may be in a turn at once. A thread created over it, when the
 * request opts into the queue (`session.create { queue: true }`, or any
 * thread of a master), is created `queued` and started by the scheduler
 * (src/main/server/scheduler.ts) when a slot frees. Stored in the settings
 * table under `threads.maxRunning`; 0 = unlimited.
 */
export const THREAD_CAP_KEY = 'threads.maxRunning'
export const DEFAULT_MAX_RUNNING = 4
export const MAX_RUNNING_LIMIT = 999

export const ThreadCapSchema = z.object({
  maxRunning: z.number().int().min(0).max(MAX_RUNNING_LIMIT)
})
export type ThreadCap = z.infer<typeof ThreadCapSchema>

/** The stored value, or the default when unset or unreadable. */
export function parseMaxRunning(raw: string | null | undefined): number {
  if (raw == null || raw === '') return DEFAULT_MAX_RUNNING
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= MAX_RUNNING_LIMIT ? n : DEFAULT_MAX_RUNNING
}

/** "1st", "2nd", "3rd", "4th"… for the queue's position line. */
export function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}
