/**
 * The failures the host says itself, beside the service's own
 * `ComputerErrorKind` (docs/computer-protocol.md "Permission and Stop"). TS
 * only, never on the service's wire. Each line ends in the model's next move
 * (docs/computer-protocol.md "The model's words").
 */
import { SESSION_REFUSALS, sessionRefusalWords, type SessionTierRefusal } from './scheduleRules'

export const HOST_ERROR_KINDS = [
  /** not a Mac, headless, turned off, not built, down after crashes */
  'service_unavailable',
  /** the process died during the call */
  'service_restarted',
  /** an element named in an app this thread has not read */
  'no_observation',
  /** the tool's schema refused the call */
  'invalid_args',
  /** the card was denied, or timed out */
  'denied',
  /** the card was denied because Away is on and the act spends money (@shared/away awayAllowsKind) */
  'away',
  /** the gate refused the session tier */
  'session_refused',
  /** a paste waited out the person's copies for as long as it may (scheduleRules.ts SCHEDULE.pasteWaitMaxMs) */
  'clipboard_recent',
  /** Stop on the Activity row */
  'stopped',
  /** the thread is paused */
  'paused',
  /** the call was given up before it ran, or a pause cancelled it */
  'cancelled',
  /** TempCode's own window, macOS's password and Touch ID prompts, or an app whose identity could not be checked */
  'refused_app'
] as const
export type HostErrorKind = (typeof HOST_ERROR_KINDS)[number]

/** Why the session tier was refused, and its words, are the tier scheduler's (scheduleRules.ts). */
export { SESSION_REFUSALS, sessionRefusalWords, type SessionTierRefusal }

/** Why refused_app refused: TempCode itself, the system's prompts, or a launched app the host could not identify. */
export type RefusedApp = 'tempcode' | 'prompts' | 'unchecked'

const REFUSED_APP_WORDS: Readonly<Record<RefusedApp, string>> = {
  tempcode: "TempCode's own window is off limits to computer use",
  prompts: "macOS's password and Touch ID prompts are the person's to answer",
  unchecked: "couldn't check which app this is, so nothing was sent; try the call again"
}

/** Each kind's line; `detail` is the reason, the zod issue or the app, as the kind takes it. */
export const HOST_ERROR_WORDS: Readonly<Record<HostErrorKind, (detail?: string) => string>> = {
  service_unavailable: (reason) => `computer use is off on this host${reason ? `: ${reason}` : ''}; do the work another way`,
  service_restarted: () =>
    'the computer service restarted during this call, so the action may or may not have happened; read the window again before acting',
  /** the detail is the whole line, noObservationLine's or noReadForTextLine's */
  no_observation: (line) => line ?? 'that element comes from no read in this thread; read the window first',
  invalid_args: (issue) => `invalid arguments${issue ? `: ${issue}` : ''}; see the tool's description`,
  denied: () => 'denied: the person did not allow it; do not reach the same effect another way',
  away: () => 'denied: the person is away and this act spends money; finish around it and name it in your report',
  session_refused: (reason) =>
    `needs the session tier (the real pointer and keyboard), which is not available now${reason ? `: ${reason}` : ''}`,
  clipboard_recent: () => 'the person copied something just now and a paste would swap their clipboard; try again in a minute',
  stopped: () => 'stopped by the person; no more computer use this turn',
  paused: () => 'refused: the thread is paused',
  cancelled: (why) => `cancelled: ${why ?? 'the call was given up'}`,
  refused_app: (why) => REFUSED_APP_WORDS[(why as RefusedApp | undefined) ?? 'tempcode'] ?? REFUSED_APP_WORDS.tempcode
}

/** `[12] comes from no read of TextEdit in this thread; read the window first`. */
export function noObservationLine(element: number, app: string): string {
  return `[${element}] comes from no read of ${app} in this thread; read the window first`
}

/** Text into an app, or a window, this thread has not read: the host has no tree to check where it goes. */
export function noReadForTextLine(app: string, window?: string): string {
  return `read ${app}'s window${window ? ` ${JSON.stringify(window)}` : ''} before typing into it`
}

export function hostErrorLine(kind: HostErrorKind, detail?: string): string {
  return HOST_ERROR_WORDS[kind](detail)
}

/**
 * The session tier refused, in words; `app` names the app a `skipped-earlier` was about. A step the
 * service sent to the session tier because its menu item is disabled in the background (§24.2) says
 * that first: `File › Close is disabled while TextEdit is in the background; needs the session tier …`.
 * A `front` step held under "wait until I'm away" says it needs the app in front instead.
 */
export function sessionRefusedLine(reason: SessionTierRefusal, app?: string, opts: { menu?: readonly string[]; tier?: 'front' | 'session' } = {}): string {
  const line =
    opts.tier === 'front'
      ? // a step that needed the app in front, under "wait until I'm away" (§26.6)
        `needs ${app ?? 'the app'} in front for a moment, which the person set to wait until they are away: ${sessionRefusalWords(reason, app)}`
      : hostErrorLine('session_refused', sessionRefusalWords(reason, app))
  return opts.menu?.length ? `${opts.menu.join(' › ')} is disabled while ${app ?? 'the app'} is in the background; ${line}` : line
}
