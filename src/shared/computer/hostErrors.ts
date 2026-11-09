/**
 * The failures the host says itself, beside the service's own
 * `ComputerErrorKind` (docs/computer-protocol.md "Permission and Stop"). TS
 * only, never on the service's wire. The words are first words: the Computer
 * model instructions thread owns the wording and replaces them here.
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
  'cancelled'
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

/** Each kind's line; `detail` is the reason, the zod issue or the app, as the kind takes it. */
export const HOST_ERROR_WORDS: Readonly<Record<HostErrorKind, (detail?: string) => string>> = {
  service_unavailable: (reason) => `computer use is unavailable here${reason ? `: ${reason}` : ''}`,
  service_restarted: () =>
    'the computer service restarted during this call, so the action may or may not have happened; read the window again',
  /** the detail is the whole line, noObservationLine's */
  no_observation: (line) => line ?? 'that element comes from no observation in this thread; read the window first',
  invalid_args: (issue) => `invalid arguments${issue ? `: ${issue}` : ''}`,
  denied: () => 'denied: the person did not allow it',
  away: () => 'denied: the person is away',
  session_refused: (reason) =>
    `needs the session tier (the real pointer and keyboard), which is not available now${reason ? `: ${reason}` : ''}`,
  stopped: () => 'stopped by the person',
  paused: () => 'refused: the thread is paused',
  cancelled: (why) => `cancelled: ${why ?? 'the call was given up'}`
}

/** `[12] comes from no observation of TextEdit in this thread; read the window first`. */
export function noObservationLine(element: number, app: string): string {
  return `[${element}] comes from no observation of ${app} in this thread; read the window first`
}

export function hostErrorLine(kind: HostErrorKind, detail?: string): string {
  return HOST_ERROR_WORDS[kind](detail)
}

/** The session tier refused, in words. */
export function sessionRefusedLine(reason: SessionTierRefusal): string {
  return hostErrorLine('session_refused', SESSION_REFUSAL_WORDS[reason])
}
