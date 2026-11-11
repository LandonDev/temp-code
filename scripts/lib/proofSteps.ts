/**
 * The Mac computer proofs' step rules, pure (docs/computer-protocol.md "The unattended proof modes"):
 * when a chain runs a step after a failure, when a voided step runs again, and how a call that may
 * bring an app forward is judged while the person uses the Mac.
 */
import type { FrontReport } from '../../src/shared/computer/protocol'

/** A hand run's `--keep-going` or `TC_PROOF_KEEP_GOING=1`: a failed step skips only what needs it. */
export function keepGoing(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes('--keep-going') || env.TC_PROOF_KEEP_GOING === '1'
}

/**
 * A step that makes what the leg's later steps act on (a launch, a build, a service, a scratch app or
 * window): when it fails, nothing after it in its chain has a target, keep-going or not.
 */
export function isSetupStep(name: string): boolean {
  return /\b(launch|launches)\b|^build\b|^a service\b|\bin the background$/i.test(name)
}

/**
 * Why a chain skips its next step, or null to run it. The gate stops a chain at its first failure;
 * a keep-going run stops only at a failed setup step, and runs the rest after any other.
 */
export function chainSkip(broken: { name: string; setup: boolean } | null, keep: boolean): string | null {
  if (!broken) return null
  if (keep && !broken.setup) return null
  return `${broken.name} failed`
}

/** A step the person voided runs again at once this many times before it is recorded void. */
export const VOID_RETRIES = 3

/** Whether a void on try `attempt` (0 the first) runs the step again. */
export function retriesVoid(attempt: number): boolean {
  return attempt < VOID_RETRIES
}

/** A skip reason that says the person, not the proof, decided the step. */
export function isVoid(why: string): boolean {
  return why.startsWith('void:')
}

export interface FrontSample {
  pid: number
  /** the front window's id; absent where only the app was read */
  window?: number
}

/**
 * A call that may bring an app forward, judged by what the service did: its own `front` report and
 * whether a scratch app (the target, or one the run launched) holds the front after it. The service
 * raises only its target, so another app in front is the person's or the system's (a screen saver
 * ending gives the front from loginwindow to the app under it), never a failure; nor is a window
 * change within the person's app while they used the Mac. A window change there with no input is the
 * guard's restore gone wrong.
 */
export type FrontVerdict =
  | { verdict: 'kept' | 'theirs' | 'person-chose' }
  | { verdict: 'failed'; why: string }

export function judgeFront(input: {
  before: FrontSample
  after: FrontSample
  scratch: readonly number[]
  report?: FrontReport | null
  personInput: boolean
}): FrontVerdict {
  const { before, after, scratch, report, personInput } = input
  if (report?.raised && report.restored === 'failed')
    return { verdict: 'failed', why: `the service raised the app and could not put the front back (pid ${after.pid} in front)` }
  if (report?.raised && report.restored === 'person-chose') return { verdict: 'person-chose' }
  if (after.pid !== before.pid && scratch.includes(after.pid))
    return { verdict: 'failed', why: `the scratch app ${after.pid} kept the front` }
  if (after.pid === before.pid && (after.window === undefined || before.window === undefined || after.window === before.window))
    return { verdict: 'kept' }
  if (personInput || after.pid !== before.pid) return { verdict: 'theirs' }
  return { verdict: 'failed', why: `the front window of pid ${after.pid} changed from ${before.window} to ${after.window} with no input` }
}

/** The service never moves the person's pointer below the session tier: a move is theirs only with their input. */
export function judgePointer(moved: number, personInput: boolean): 'still' | 'theirs' | 'moved' {
  if (moved < 0.5) return 'still'
  return personInput ? 'theirs' : 'moved'
}
