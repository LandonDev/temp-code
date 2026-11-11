/** How long a launch watches the front after a scratch app's `open`, and how often it reads it. */
export const SETTLE_FRONT_MS = 3_000
export const SETTLE_FRONT_EVERY_MS = 100

/**
 * Chrome's switches that keep a covered window drawing and its page's tree built (docs/computer-protocol.md
 * §25.10 C1, M2): the person's windows cover a scratch Chrome, and Chrome 156 then draws and builds no page for
 * an outside reader. The web leg's browser and the bench's scratch Chrome both launch with them.
 */
export const CHROME_DRAW_COVERED = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--force-renderer-accessibility'] as const

/** An app in front and its front window: computer-proof-probe's `frontwindow`. */
export interface FrontWindow {
  pid: number
  window: number
}

/**
 * Puts the person's front app and window back after a scratch app took it: by pid and the saved window, else,
 * once the person closed or changed that window meanwhile, their app alone. Never by bundle id, which a second
 * Chrome or another Electron app shares. `restore` is the probe's `restore-front <pid> <window>` (window 0: the
 * app alone) and throws when it cannot. What it did, for the step's data.
 */
export function restoreFront(restore: (pid: number, window: number) => void, before: FrontWindow): 'window' | 'app' | 'gone' {
  try {
    restore(before.pid, before.window)
    return 'window'
  } catch {
    try {
      restore(before.pid, 0)
      return 'app'
    } catch {
      return 'gone'
    }
  }
}

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

/**
 * A scratch app's launch, as the web leg and the bench's rig both keep the person's front: put back at once if
 * the app has it now, then watched for `ms` (settleFront). 'kept' when it never took the front, 'bounced' when it
 * did and was put back, 'took' when it still has it at the end.
 */
export async function keepFrontAfterLaunch(pid: number, deps: SettleFrontDeps): Promise<{ front: 'kept' | 'bounced' | 'took'; steals: number }> {
  let steals = 0
  if (deps.frontPid() === pid) {
    steals++
    deps.restore()
  }
  steals += await settleFront(pid, deps)
  return { front: deps.frontPid() === pid ? 'took' : steals ? 'bounced' : 'kept', steals }
}
