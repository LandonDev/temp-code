import type { Failure } from './events'

/** The summary of a turn the CLI ended itself (`turn_ended`) and of a row
 *  with no verdict: the host's classifier (failureKind.ts) and this
 *  fallback say the same words. */
export const TURN_ENDED_SUMMARY = 'The turn ended before it finished'

/**
 * The words a failure reads when the host gave no verdict: a row written
 * before verdicts existed. The transcript's FailureCard prints them with
 * its one Retry, so no raw harness string ever reaches the person. The
 * host's classifier reads it for an `unknown` with no reason, so both
 * sides say the same thing.
 */
export function fallbackFailure(): Failure {
  return {
    kind: 'unknown',
    account: null,
    summary: TURN_ENDED_SUMMARY,
    cause: 'The harness gave no reason.'
  }
}
