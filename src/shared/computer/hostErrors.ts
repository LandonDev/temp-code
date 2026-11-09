/**
 * The failures the host says itself, beside the service's own
 * `ComputerErrorKind` (docs/computer-protocol.md "Permission and Stop"). TS
 * only, never on the service's wire. Each line ends in the model's next move
 * (docs/computer-protocol.md "The model's words").
 */

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
  /** the card was denied because Away is on */
  'away',
  /** the gate refused the session tier */
  'session_refused',
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

/** Why the session tier was refused (tierGate.ts); the tier scheduling thread's gate names its own. */
export const SESSION_REFUSALS = ['no-scheduler', 'person-present', 'screen-locked', 'away-off', 'denied', 'timeout', 'cancelled'] as const
export type SessionTierRefusal = (typeof SESSION_REFUSALS)[number]

export const SESSION_REFUSAL_WORDS: Readonly<Record<SessionTierRefusal, string>> = {
  'no-scheduler': 'nothing schedules it yet',
  'person-present': 'the person is using the Mac',
  'screen-locked': 'the screen is locked',
  'away-off': 'the person is not away',
  denied: 'the person said no',
  timeout: 'it waited too long for its turn',
  cancelled: 'the call was given up'
}

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
  away: () => 'denied: the person is away; finish around this act and name it in your report',
  session_refused: (reason) =>
    `needs the session tier (the real pointer and keyboard), which is not available now${reason ? `: ${reason}` : ''}`,
  stopped: () => 'stopped by the person; no more computer use this turn',
  paused: () => 'refused: the thread is paused',
  cancelled: (why) => `cancelled: ${why ?? 'the call was given up'}`,
  refused_app: (why) => REFUSED_APP_WORDS[(why as RefusedApp | undefined) ?? 'tempcode'] ?? REFUSED_APP_WORDS.tempcode
}

/** `[12] comes from no read of TextEdit in this thread; read the window first`. */
export function noObservationLine(element: number, app: string): string {
  return `[${element}] comes from no read of ${app} in this thread; read the window first`
}

/** Text into an app this thread has not read: the host has no tree to check where it goes. */
export function noReadForTextLine(app: string): string {
  return `read ${app}'s window before typing into it`
}

export function hostErrorLine(kind: HostErrorKind, detail?: string): string {
  return HOST_ERROR_WORDS[kind](detail)
}

/** The session tier refused, in words. */
export function sessionRefusedLine(reason: SessionTierRefusal): string {
  return hostErrorLine('session_refused', SESSION_REFUSAL_WORDS[reason])
}
