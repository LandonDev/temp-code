import { errorLine } from '@shared/computer/errorWords'
import { hostErrorLine } from '@shared/computer/hostErrors'
import type { ConfirmNeed } from '@shared/computer/policy'
import { NO_INPUT_ACTIONS, type AppInfo, type ComputerAction, type ComputerError } from '@shared/computer/protocol'
import type { ElementBook } from './elements'

/**
 * What the host enforces of the confirmations policy, whatever the model
 * flagged (docs/computer-protocol.md "The model's words"): the app a call
 * acts on, pinned by pid before any request, so the app checked is the app
 * acted on; the apps no call may touch; the password rule; and a text step's
 * known destination.
 */

/** The installed app's bundle id: no instance reads or acts on any TempCode window. */
export const TEMPCODE_BUNDLE_ID = 'dev.landon.tempcode'

/**
 * macOS's password and Touch ID prompts: the person answers them. Not regular
 * apps, so apps.list never names them and the pinned target cannot reach them
 * by name; this list is the second line.
 * Read from their bundles on macOS 27.2 (26B5112a):
 * `com.apple.SecurityAgent`: /System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle.
 * `com.apple.LocalAuthentication.UIAgent`: /System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle.
 */
export const REFUSED_ACT_BUNDLES: readonly string[] = ['com.apple.SecurityAgent', 'com.apple.LocalAuthentication.UIAgent']

export interface PinnedApp {
  pid: number
  bundleId: string | null
  name: string
}

/** The service's two app methods, as the resolver needs them. */
export interface AppsSource {
  list(): Promise<AppInfo[]>
  /** answers the pid, or throws with the service's error data */
  launch(app: string): Promise<{ pid: number; launched: boolean }>
  sleep(ms: number): Promise<void>
}

/** How long a launched app has to show in apps.list. */
export const LAUNCH_REGISTER_MS = 2000
const REGISTER_POLL_MS = 100

export type Resolved = { app: PinnedApp } | { line: string }

const pinned = (a: AppInfo): PinnedApp => ({ pid: a.pid, bundleId: a.bundleId, name: a.name })
const lower = (s: string): string => s.toLowerCase()

/**
 * Turns a call's `app` into a pid, in the service's own match order: a
 * running app by bundle id, then by name; else `apps.launch`, which matches
 * installed apps and never brings one forward, then the pid it answered in a
 * fresh list; else, when launch found nothing, a unique prefix of a running
 * app's name. The list is cached until `apps/changed`.
 */
export class TargetResolver {
  private cached: AppInfo[] | null = null

  invalidate(): void {
    this.cached = null
  }

  async resolve(query: string, src: AppsSource, errorData: (e: unknown) => ComputerError | null): Promise<Resolved> {
    const q = lower(query)
    const running = (this.cached ??= await src.list())
    const exact = running.find((a) => a.bundleId !== null && lower(a.bundleId) === q) ?? running.find((a) => lower(a.name) === q)
    if (exact) return { app: pinned(exact) }

    let launchError: ComputerError | null = null
    try {
      const { pid } = await src.launch(query)
      for (let waited = 0; ; waited += REGISTER_POLL_MS) {
        this.cached = await src.list()
        const found = this.cached.find((a) => a.pid === pid)
        if (found) return { app: pinned(found) }
        if (waited >= LAUNCH_REGISTER_MS) return { line: hostErrorLine('refused_app', 'unchecked') }
        await src.sleep(REGISTER_POLL_MS)
      }
    } catch (e) {
      launchError = errorData(e)
      if (launchError?.kind !== 'app_not_found') throw e
    }

    const prefixed = (this.cached ?? running).filter((a) => lower(a.name).startsWith(q))
    if (prefixed.length === 1) return { app: pinned(prefixed[0]) }
    const candidates = prefixed.length ? prefixed.map((a) => a.name) : (launchError.candidates ?? [])
    return { line: errorLine({ ...launchError, candidates }, { app: query }) }
  }
}

/** Why a call may not touch this app, or null. Reads are refused only for TempCode itself. */
export function refusedTarget(app: { pid: number; bundleId: string | null }, use: 'read' | 'act', ownPid = process.pid): string | null {
  if (app.pid === ownPid || app.bundleId === TEMPCODE_BUNDLE_ID) return hostErrorLine('refused_app', 'tempcode')
  if (use === 'act' && app.bundleId && REFUSED_ACT_BUNDLES.includes(app.bundleId)) return hostErrorLine('refused_app', 'prompts')
  return null
}

/** computer_apps { launch }: a query naming TempCode or a refused prompt is refused before the service hears it. */
export function refusedLaunch(query: string): string | null {
  const q = lower(query)
  if (q === TEMPCODE_BUNDLE_ID || q === 'tempcode') return hostErrorLine('refused_app', 'tempcode')
  if (REFUSED_ACT_BUNDLES.some((b) => lower(b) === q)) return hostErrorLine('refused_app', 'prompts')
  return null
}

const TEXT_STEPS: readonly ComputerAction['action'][] = ['type', 'paste']
const sendsInput = (a: ComputerAction): boolean => !NO_INPUT_ACTIONS.includes(a.action)

/**
 * A text step's destination is its own element or the latest read's focused
 * one, never a guess about where focus went: in one call, a type or paste
 * with no element after another step that sends input is refused before
 * anything runs.
 */
export function textTargetProblem(actions: readonly ComputerAction[]): string | null {
  for (const [i, a] of actions.entries()) {
    if (!TEXT_STEPS.includes(a.action) || a.element !== undefined) continue
    if (actions.slice(0, i).some(sendsInput)) return hostErrorLine('invalid_args', 'in a batch, type and paste after another action name their element')
  }
  return null
}

const isPasswordLine = (book: ElementBook, index: number): boolean => {
  const brief = book.brief(index)
  return !!brief && (brief.line === 'password' || brief.line.startsWith('password '))
}

/**
 * The host's own card: a type, paste or set_value step whose destination is a
 * password field asks in every mode. The destination is the step's element,
 * else the latest read's focused element; with neither, a window that shows a
 * password field asks too. Its `what` is empty: the card's steps say where,
 * and never what is typed.
 */
export function passwordTarget(actions: readonly ComputerAction[], book: ElementBook | undefined): ConfirmNeed | null {
  if (!book) return null
  for (const a of actions) {
    if (!TEXT_STEPS.includes(a.action) && a.action !== 'set_value') continue
    const at = a.element ?? book.focused
    if (at !== null && at !== undefined ? isPasswordLine(book, at) : book.hasRole('password')) return { kind: 'password', what: '' }
  }
  return null
}
