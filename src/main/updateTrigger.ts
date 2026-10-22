import { compareVersions } from './updateInstall'

/**
 * The rules of a release the app is TOLD about (update.ts `selfUpdate`),
 * as against one its poll finds: the Publish button's script exiting
 * green in this very process, or the box saying `release-available` over
 * the peer link after its deploy. A told release is fetched at once and
 * offered as "Restart to update"; a polled one is offered and fetched only
 * when the person asks, as before. Pure, so the decisions are unit-tested
 * without Electron.
 */

/** The poll: every five minutes, so a release nobody told this app about is seen within that. */
export const CHECK_EVERY_MS = 5 * 60 * 1000
/** A told release the feed does not show yet (the CDN lagging the script's own check): look again this many times, this far apart. */
export const FEED_RETRIES = 3
export const FEED_RETRY_MS = 15_000
/** How long `selfUpdate` waits for the download before giving up on the wait (the download itself goes on). */
export const SELF_UPDATE_TIMEOUT_MS = 4 * 60 * 1000

export type FetchDecision =
  /** the told version is no newer than the one running: nothing to do */
  | 'current'
  /** that version (or a newer one) is already downloaded, or a download is in flight */
  | 'already'
  /** check the feed now and download what it offers */
  | 'fetch'

export interface FetchState {
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  latest: string | null
}

/** Whether a told `version` is worth fetching on an app running `current` in `state`. */
export function decideFetch(version: string, current: string, state: FetchState): FetchDecision {
  if (!/^\d+\.\d+\.\d+$/.test(version) || compareVersions(version, current) <= 0) return 'current'
  if (state.phase === 'downloading') return 'already'
  if (state.phase === 'ready' && state.latest && compareVersions(state.latest, version) >= 0) return 'already'
  return 'fetch'
}

export type SelfUpdateOutcome =
  /** downloaded and waiting for the restart click */
  | 'ready'
  /** the told version is the one running, or older */
  | 'current'
  /** a dev instance, or the feed never showed the version */
  | 'unavailable'
  /** the download failed; the error is in the update status */
  | 'error'
  /** the download is still going after the wait; it finishes on its own */
  | 'timeout'

/** The line the publish log carries for the outcome: `phase ✓ update 31s`, `phase – update skipped (current)`, `phase ✗ update 4m00s timeout`. */
export function updatePhaseLine(outcome: SelfUpdateOutcome, ms: number, format: (ms: number) => string): string {
  if (outcome === 'ready') return `phase ✓ update ${format(ms)}`
  if (outcome === 'current' || outcome === 'unavailable') return `phase – update skipped (${outcome})`
  return `phase ✗ update ${format(ms)} ${outcome}`
}
