/**
 * The vocabulary of a status line, shared by every host writer and every
 * reader (the desktop's strip, rows and board; the phone's StripWords reads
 * the same).
 *
 * Drawn, a state is two spans: the word in medium weight and its tone, then
 * what it is about in regular weight and muted, 6px after it ("Queued"
 * "Waiting for memory"). Written as one string (a tooltip, an accessible
 * name, a toast, a notification) it is `plainStatus`: "Queued: Waiting for
 * memory", or the word alone. The host sends the detail on its own
 * (`SessionMeta.statusDetail`); `activity` keeps its legacy shape
 * (`legacyActivity`) for old readers only.
 *
 * A detail is sentence-cased when it is a sentence ("Waiting for memory",
 * "Approve Bash", "Landed 12:08") and written as it is when it is a name or
 * a count ("3 subagents", "sleep 45 seconds", "Rail.tsx"). It never ends in
 * a full stop and never repeats the word. A phase keeps its comma inside
 * the detail ("Rate limited, retry 3 in 32 s"): prose punctuation within one
 * fact, not a joiner between two. No visible text separates two facts with
 * a run of spaces, a middle dot, a pipe or a bullet. Titles, labels and
 * model marks ("claude · opus") are not status lines and keep their dot.
 */

/** A state word and what it is about as one string: "Queued: Waiting for memory"; the word alone with nothing to say. */
export function plainStatus(word: string, detail?: string | null): string {
  const d = detail ? detailText(detail) : null
  return d ? `${word}: ${d}` : word
}

/** What joined a state word and its detail in the legacy `activity` string. */
const FACT_GAP = '  '

/** The legacy `activity` string ("Queued  waiting for memory"), written ONLY
 *  into `SessionMeta.activity` for old readers (older phone builds, an older
 *  desktop, the MCP facade, the Live Activity's task line). Nothing current
 *  draws it; current readers take `statusDetail`. */
export function legacyActivity(word: string, detail?: string | null): string {
  const d = detail?.trim()
  return d ? `${word}${FACT_GAP}${d}` : word
}

/** A detail as written: trimmed, a trailing full stop dropped, its case
 *  untouched; null when nothing is left. */
export function detailText(text: string | null | undefined): string | null {
  const t = text?.trim().replace(/\.+$/, '').trim()
  return t ? t : null
}

/** The detail of an old host's legacy `activity` past its lead, the first
 *  letter upper-cased when the first word is plain lower-case letters
 *  ("Queued  waiting for memory" → "Waiting for memory"; "Waiting on 3
 *  subagents" → "3 subagents"); reads the two spaces, the old dot and a colon
 *  like `leadDetail`. */
export function legacyDetail(line: string | null | undefined, lead: string): string | null {
  return sentenceStart(detailText(leadDetail(line, lead)))
}

/** Upper-case the first letter when the first word is plain lower-case
 *  letters ("waiting for memory" → "Waiting for memory"); a first word that
 *  is a name or a count ("rail.tsx", "3 subagents") keeps its case. Only for
 *  text an old host lower-cased: the current host sends details as written. */
export function sentenceStart(text: string | null): string | null {
  if (!text) return null
  const first = /^\S+/.exec(text)?.[0] ?? ''
  return /^[a-z]+$/.test(first) ? text[0]!.toUpperCase() + text.slice(1) : text
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

/** A message sent into an open turn that the model has not read yet: it is
 *  behind whatever the turn does, which the CLI finishes first ("Running the
 *  gate, then your message", "Compacting context, then your message"). */
export function thenYourMessage(line: string): string {
  return `${line}, then your message`
}

/** A compaction in progress, from its start to its outcome: the activity,
 *  the context meter and the transcript's row all say it. */
export const COMPACTING_WORDS = 'Compacting context'

/** The claude driver's status detail while it asks the model about background tasks it left idle; the desktop folds it into the turn's working line. */
export const BACKGROUND_CHECK_WORDS = 'Checking background tasks'

/** The tier a computer action ran at, as a person reads it: the Activity row's detail and the held line. Never ax, process or session. */
export const COMPUTER_TIER_WORDS: Readonly<Record<'ax' | 'process' | 'front' | 'session', string>> = {
  ax: 'in the background',
  process: 'to the app',
  /** the app brought forward for a moment (§26) */
  front: 'in front',
  session: 'on the screen'
}

/** 1 → 1st, 2 → 2nd, 3 → 3rd, 11 → 11th, 22 → 22nd. */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  const one = n % 10
  return `${n}${one === 1 ? 'st' : one === 2 ? 'nd' : one === 3 ? 'rd' : 'th'}`
}

/** A computer step held for the session tier (computer/schedule.ts): "Waiting
 *  for the Mac to be free", or "…, 2nd in line" behind another thread's
 *  session call. */
export function macFreeWords(place?: number): string {
  return place && place > 1 ? `Waiting for the Mac to be free, ${ordinal(place)} in line` : 'Waiting for the Mac to be free'
}

/** A paste held until the person's last copy is a few seconds old. */
export const CLIPBOARD_WAIT_WORDS = 'Waiting for the clipboard'

// ── a computer step as the Computer section reads it (shared/computer/historyWords.ts) ──
// These are a person's words for a step that already ran; the model's own are
// errorWords.ts and hostErrors.ts. Each is one fact of a comma run or one line.

/**
 * A background route a step took in place of its tier (§24.8), as an open
 * step's fact; `on` is what the route acted on (`File › Save…`).
 */
export const COMPUTER_ROUTE_WORDS: Readonly<
  Record<'menu' | 'hit' | 'caret' | 'scroll-bar' | 'scroll-page' | 'pick' | 'scroll-into-view' | 'panel', (on?: string) => string>
> = {
  menu: (on) => (on ? `through the menu ${on}` : 'through its menu item'),
  hit: () => 'on the element under the point',
  caret: () => 'at the caret',
  'scroll-bar': () => 'by the scroll bar',
  'scroll-page': () => 'a page at a time',
  pick: () => 'picked from its menu',
  'scroll-into-view': () => 'scrolled into view',
  panel: () => 'through the save panel'
}

/** What a step that ran says of how it went; `changed` is the plain case and says nothing. */
export const COMPUTER_EFFECT_FACTS: Readonly<Record<'none' | 'unknown' | 'uncommitted', string>> = {
  none: 'nothing changed',
  unknown: "can't tell if it changed",
  uncommitted: 'on screen only, not on disk'
}

/** Why a step failed, by the service's error kind; a kind with no line here reads the service's own sentence (`failureWords`). */
export const COMPUTER_FAILURE_WORDS: Readonly<Record<string, string>> = {
  app_not_found: 'The app was not found',
  window_not_found: 'The window was gone',
  window_minimized: 'The window was minimized',
  stale_element: 'The element was gone',
  no_such_element: 'The element was not in the window',
  action_unsupported: "The element can't do that",
  needs_tier: 'It needed your pointer and keyboard',
  out_of_bounds: 'The point was outside the window',
  invalid_key: 'There is no such key',
  interrupted: 'Stopped when you used the mouse or keyboard',
  app_busy: 'Another thread was using the app',
  cancelled: 'Cancelled before it finished',
  clipboard_busy: 'The clipboard was busy',
  capture_failed: 'The window could not be captured',
  timeout: 'The app did not answer',
  text_not_found: 'The text was not there',
  key_window_unavailable: "The window couldn't take keys",
  session_unavailable: 'The screen could not be used',
  open_refused: 'The item could not be opened',
  value_not_taken: 'The field did not take the value',
  focus_moved: 'The focus had moved',
  tab_in_use: 'You had another tab in front',
  not_committed: 'Nothing reached the disk',
  file_exists: 'The file already exists',
  named_target: 'Nothing by that name was found'
}

/** Why a call never ran, by the host's refusal kind (shared/computer/hostErrors.ts). */
export const COMPUTER_REFUSAL_WORDS: Readonly<
  Record<
    | 'service_unavailable'
    | 'service_restarted'
    | 'no_observation'
    | 'invalid_args'
    | 'denied'
    | 'away'
    | 'session_refused'
    | 'clipboard_recent'
    | 'stopped'
    | 'paused'
    | 'cancelled'
    | 'refused_app',
    string
  >
> = {
  service_unavailable: 'Computer use was off',
  service_restarted: 'The computer service restarted',
  no_observation: 'The window had not been read',
  invalid_args: 'The call was not valid',
  denied: "You didn't allow it",
  away: 'You were away and it spends money',
  session_refused: 'The Mac was not free',
  clipboard_recent: 'You had just copied something',
  stopped: 'Stopped',
  paused: 'The thread was paused',
  cancelled: 'Cancelled',
  refused_app: 'That app is off limits'
}

/** Why a call ended before its answer, by its abort reason (computer/run.ts `abortedLine`). */
/** A step the person chose Skip for on the Run-now card. */
export const COMPUTER_SKIPPED_WORDS = 'You chose Skip'

export const COMPUTER_ABORT_WORDS: Readonly<Record<string, string>> = {
  stopped: 'Stopped',
  interrupt: 'Stopped',
  paused: 'The thread was paused',
  ended: 'The thread ended',
  settled: 'The turn ended',
  unread: 'Its answer was never read',
  superseded: 'A later call replaced it',
  cancel: 'The model cancelled it'
}
