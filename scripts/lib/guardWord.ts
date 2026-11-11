/**
 * The front guard's word on one steal (docs/computer-protocol.md §23.5): a call's result carries the guard's
 * report as it goes out, and an outcome that came after, a later steal or a restore still running then, is
 * the `apps/frontRestored` notice for that pid.
 */
import type { FrontReport } from '../../src/shared/computer/protocol'

/** The result's word is the whole story once it says how the steal ended. */
export function settledInResult(front: FrontReport | undefined): boolean {
  return !!front?.raised && front.restored !== undefined
}

/** The word to judge: the notice's when one came, else the result's raise, else null (never came forward). */
export function guardOutcome(front: FrontReport | undefined, late: FrontReport | null): FrontReport | null {
  if (settledInResult(front)) return front!
  return late ?? (front?.raised ? front : null)
}
