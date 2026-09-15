/**
 * The limit an error message names, for the error event. Messages that
 * mention a limit but match no template land in a miss log so the
 * classifier's fixtures can grow from real text.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { classifyLimitText, type TextProvider } from 'aliax-core'
import type { LimitWindow } from '@shared/events'

let missLog: string | null = null

/** Where unmatched limit-looking messages go; set once at boot. */
export function setLimitMissLog(logDir: string | null): void {
  missLog = logDir ? join(logDir, 'limit-text-misses.log') : null
}

export function limitOf(provider: TextProvider, message: string): { window: LimitWindow } | undefined {
  const limit = classifyLimitText(provider, message)
  if (limit) return limit
  if (missLog && /limit/i.test(message)) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), provider, message })}\n`
    const file = missLog
    void mkdir(dirname(file), { recursive: true })
      .then(() => appendFile(file, line))
      .catch(() => {})
  }
  return undefined
}

/** `{ limit }` to spread into an error event, or nothing. */
export function limitField(provider: TextProvider, message: string): { limit?: { window: LimitWindow } } {
  const limit = limitOf(provider, message)
  return limit ? { limit } : {}
}
