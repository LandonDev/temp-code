/** How long a launch watches the front after a scratch app's `open`, and how often it reads it. */
export const SETTLE_FRONT_MS = 3_000
export const SETTLE_FRONT_EVERY_MS = 100

export interface SettleFrontDeps {
  /** the pid of the app in front now */
  frontPid: () => number
  /** puts the person's front app and window back */
  restore: () => void
  sleep: (ms: number) => Promise<void>
  now?: () => number
  ms?: number
  everyMs?: number
}

/**
 * Watches the front for `ms` after a scratch app's launch and puts the person's back each time `pid` took it.
 * Chrome brings its first window forward by itself some seconds after an `open -g`, outside any service call,
 * so no guard sees it. Answers how many times it took the front.
 */
export async function settleFront(pid: number, deps: SettleFrontDeps): Promise<number> {
  const { frontPid, restore, sleep, now = Date.now, ms = SETTLE_FRONT_MS, everyMs = SETTLE_FRONT_EVERY_MS } = deps
  let steals = 0
  for (const end = now() + ms; now() < end; ) {
    if (frontPid() === pid) {
      steals++
      restore()
    }
    await sleep(everyMs)
  }
  return steals
}
