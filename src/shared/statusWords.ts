/**
 * The vocabulary of a status line, shared by every host writer and every
 * reader (the desktop's strip and agent rows; the phone's StripWords reads
 * the same): a phase is one fact with a comma before its detail ("Rate
 * limited, retry 3 in 32 s", "Waiting for the provider, 25 s", "Waiting for
 * the Mac, load 12.3 of 8, 3rd in line"); a state word and what it is about
 * are joined by two spaces ("Queued  120 of 120 running"). The middle dot
 * the host wrote until 2026-10-28 (" · ") and a colon are still read, so a
 * stored row keeps parsing. Titles, labels and model marks ("claude · opus")
 * are not status lines and keep their dot.
 */

/** What joins a state word and what it is about. */
export const FACT_GAP = '  '

/** A state word and what it is about: "Queued  120 of 120 running"; the word alone with nothing to say. */
export function joinFacts(word: string, detail?: string | null): string {
  const d = detail?.trim()
  return d ? `${word}${FACT_GAP}${d}` : word
}

/** The detail after a lead ("Queued  3rd in line" → "3rd in line"): past
 *  the lead's word and whatever joins them (two spaces, the old " · ", a
 *  colon, a comma, or one space for a sentence lead like "Waiting on");
 *  null when the line does not begin with the lead or says nothing more. */
export function leadDetail(line: string | null | undefined, lead: string): string | null {
  const text = line?.trim()
  const word = lead.trim()
  if (!text || !word || !text.startsWith(word)) return null
  const rest = text.slice(word.length)
  const joiner = /^(?:\s*·\s*|\s*[:,]\s*|\s+)/.exec(rest)
  if (!joiner) return null
  return rest.slice(joiner[0].length).trim() || null
}

export type RetryWhy = 'rate-limited' | 'overloaded' | 'reconnecting' | 'retrying'

const RETRY_WORD: Record<RetryWhy, string> = {
  'rate-limited': 'Rate limited',
  overloaded: 'Provider overloaded',
  reconnecting: 'Reconnecting',
  retrying: 'Retrying'
}

/** A retry the harness runs itself: "Rate limited, retry 3 in 32 s",
 *  "Provider overloaded, retry 2 in 8 s", "Reconnecting, retry 2 of 5",
 *  "Retrying, retry 4" (no wait known). */
export function retryWords(r: { why: RetryWhy; attempt: number; delayMs?: number; of?: number | string }): string {
  const of = r.of === undefined || r.of === '' ? '' : ` of ${r.of}`
  const wait = !of && r.delayMs && r.delayMs > 0 ? ` in ${Math.max(1, Math.round(r.delayMs / 1000))} s` : ''
  return `${RETRY_WORD[r.why]}, retry ${r.attempt}${of}${wait}`
}

/** A request out at the provider past the threshold: "Waiting for the provider, 25 s". */
export function providerWaitWords(seconds: number): string {
  return `Waiting for the provider, ${seconds} s`
}
