import type { Failure } from './events'

/**
 * The words a failure reads when the host gave no verdict: a row written
 * before verdicts existed, or one the classifier left alone (a bare
 * `turn ended: …`). The transcript's FailureCard prints them with its one
 * Retry, so no raw harness string ever reaches the person. The host's
 * classifier (failureKind.ts) may import it for its own `unknown` with no
 * reason, so both sides say the same thing.
 */
export function fallbackFailure(): Failure {
  return {
    kind: 'unknown',
    account: null,
    summary: 'The turn ended before it finished',
    cause: 'The harness gave no reason.'
  }
}
