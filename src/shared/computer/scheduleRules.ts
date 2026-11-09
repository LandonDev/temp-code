/**
 * When the `session` tier may take the Mac (docs/computer-protocol.md "Tier
 * scheduling"): the pure half of the scheduler in
 * src/main/server/computer/schedule.ts. A session step activates the app,
 * moves the real pointer and types at the focused field, so it runs only
 * while the person is away: no input for `computer.sessionIdleMs`, or the
 * Away switch with ten seconds of quiet. A present person keeps the Mac; the
 * step waits, then asks once with Run now and Skip. A paste waits out a copy
 * the person just made, at any tier.
 */
import type { PermissionPolicy } from '../events'

export const SCHEDULE = {
  /** `computer.sessionIdleMs` when unset: attention.ts's away threshold */
  sessionIdleMsDefault: 120_000,
  /** the setting is clamped to this range; 5 s lets the Mac proof shorten it */
  sessionIdleMsMin: 5_000,
  sessionIdleMsMax: 3_600_000,
  /** with the Away switch on, the session tier still waits for this long without input: never while the person types */
  switchQuietMs: 10_000,
  /** full access: how long a step waits for the person to go away before it asks */
  askAfterMs: 180_000,
  /** how often a held step looks again */
  pollMs: 1_000,
  /** an Allow's own click is not the person's next input */
  leaseSlackMs: 1_500,
  /** a paste waits until the person has not copied for this long (the shell proof reads it) */
  recentCopyMs: 5_000,
  /** a paste waits at most this long, then fails */
  pasteWaitMaxMs: 10_000,
  clipboardPollMs: 500
} as const

export const RECENT_COPY_MS = SCHEDULE.recentCopyMs
export const SESSION_IDLE_SETTING = 'computer.sessionIdleMs'

/** The setting's raw text → ms: an integer within the clamp, else the default. */
export function sessionIdleMs(raw: string | null): number {
  const text = raw?.trim() ?? ''
  if (!/^\d+$/.test(text)) return SCHEDULE.sessionIdleMsDefault
  const ms = Number(text)
  if (ms < SCHEDULE.sessionIdleMsMin || ms > SCHEDULE.sessionIdleMsMax) return SCHEDULE.sessionIdleMsDefault
  return ms
}

/** What the scheduler reads of src/main/presence.ts: `unknown` reads as unlocked and awake. */
export interface Presence {
  screen: 'locked' | 'unlocked' | 'unknown'
  power: 'asleep' | 'awake' | 'unknown'
}

/** How a session step got the Mac: the person away, the Away switch, or the person's own Run now (or the call's card naming the session). */
export type AdmitVia = 'away' | 'switch' | 'allowed'
export type Freedom = { free: true; via: AdmitVia } | { free: false; why: 'present' | 'locked' | 'asleep' }

export interface FreedomInput {
  now: number
  /** whole seconds since the person's last input (PersonIdle) */
  idleS: number
  presence: Presence
  awaySwitch: boolean
  sessionIdleMs: number
  /** when this thread was last allowed (Run now, or its call's own card naming the session): valid until the person's next input */
  leaseFrom: number | null
}

/** Asleep, then locked ('unknown' reads as unlocked: the service checks again), then a lease, then away, then the switch. */
export function freedom(i: FreedomInput): Freedom {
  if (i.presence.power === 'asleep') return { free: false, why: 'asleep' }
  if (i.presence.screen === 'locked') return { free: false, why: 'locked' }
  const idleMs = Math.max(0, i.idleS) * 1000
  if (i.leaseFrom !== null && i.now - idleMs <= i.leaseFrom + SCHEDULE.leaseSlackMs) return { free: true, via: 'allowed' }
  if (idleMs >= i.sessionIdleMs) return { free: true, via: 'away' }
  if (i.awaySwitch && idleMs >= SCHEDULE.switchQuietMs) return { free: true, via: 'switch' }
  return { free: false, why: 'present' }
}

/** How long a held step waits before the card: `fullAccessMs` in full access, 0 in safe and edits (the call already asks). */
export function askAfter(permission: PermissionPolicy, fullAccessMs: number = SCHEDULE.askAfterMs): number {
  return permission === 'auto' ? fullAccessMs : 0
}

/** What `clipboard.state` answers that the quiet rule reads (protocol.ts ClipboardState). */
export interface ClipboardQuietInput {
  foreignChangeAt: number | null
  watchingSince: number
}

/** `now − max(foreignChangeAt ?? 0, watchingSince) ≥ recentCopyMs`: a copy made before the watch began counts as made at its start. */
export function clipboardQuiet(state: ClipboardQuietInput, now: number): boolean {
  return now - Math.max(state.foreignChangeAt ?? 0, state.watchingSince) >= SCHEDULE.recentCopyMs
}

/** 4s, 2m 14s, 3m, 1h 2m: a wait as the held line says it. */
export function waitedWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`
}

/** The line before a held step's own line in the tool result; null under 1 s. */
export function formatHeldLine(h: { waitedMs: number; via: AdmitVia | 'clipboard' }): string | null {
  if (h.waitedMs < 1000) return null
  const waited = waitedWords(h.waitedMs)
  switch (h.via) {
    case 'clipboard':
      return `waited ${waited} for the clipboard, the person had just copied`
    case 'allowed':
      return `waited ${waited} for the Mac to be free, then the person chose Run now`
    default:
      return `waited ${waited} for the Mac to be free`
  }
}

/** Why the session tier was refused (tierGate.ts), read by hostErrors.ts's `session_refused` line. */
export const SESSION_REFUSALS = [
  /** the default gate: no scheduler is set (headless, or before the server wires one) */
  'no-scheduler',
  'screen-locked',
  'asleep',
  /** the person chose Skip, or the card timed out: the answer is one boolean, so the two read alike */
  'skipped',
  /** Skip or a timeout on this app earlier in the turn */
  'skipped-earlier',
  /** the card was denied because the Away switch is on */
  'away',
  /** the call's signal aborted while held: run.ts words it from the abort's cause */
  'cancelled'
] as const
export type SessionTierRefusal = (typeof SESSION_REFUSALS)[number]

/** What follows `needs the session tier (…), which is not available now:`; `app` names the app a `skipped-earlier` was about. */
export function sessionRefusalWords(reason: SessionTierRefusal, app?: string): string {
  switch (reason) {
    case 'no-scheduler':
      return 'nothing schedules it yet'
    case 'screen-locked':
      return "the Mac's screen is locked"
    case 'asleep':
      return 'the Mac is asleep'
    case 'skipped':
      return 'the person did not choose Run now'
    case 'skipped-earlier':
      return `the person did not choose Run now${app ? ` for ${app}` : ''} earlier in this turn`
    case 'away':
      return 'the person is set to away, so nobody could choose Run now'
    case 'cancelled':
      return 'the call was given up'
  }
}
