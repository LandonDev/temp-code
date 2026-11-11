import { readFile } from 'node:fs/promises'
import { errorLine, type ErrorContext } from '@shared/computer/errorWords'
import { MAX_IMAGE_PARTS, OBSERVATION_FAILED_PREFIX, formatShotLine, formatStepLine, type ComputerToolResult } from '@shared/computer/tools'
import type { AppInfo, ComputerAction, ComputerError, FrontReport, LaunchedWindow, Observation, StepResult, WindowInfo } from '@shared/computer/protocol'
import { openItemsWords } from '@shared/computer/words'

/**
 * A computer call's result as the model reads it (docs/computer-protocol.md
 * §9): one step line per action, a line per picture, a blank line, then the
 * observation's text. Claude and Muse get each picture as an image part; the
 * codex path names the file in its line.
 */

export interface LandedShot {
  /** `step 2` or `observation` */
  label: string
  /** the 1-based step it came from, or the observation */
  where: number | 'observation'
  /** under the thread's attachment dir */
  path: string
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
}

export interface ComputerToolOutcome {
  /** one line per action (formatStepLine), host lines included */
  steps: string[]
  /** in order: each screenshot or zoom step, then the observation's */
  shots: LandedShot[]
  /** the observation's text, `observation failed: …`, the apps list, or a refusal */
  body: string | null
  /** nothing ran: refused, denied, a JSON-RPC error, the service gone, a stop */
  isError: boolean
}

export interface StepsResult {
  steps: StepResult[]
  observation?: Observation
  observationError?: ComputerError
  /** the app came forward during the call (§23.4) */
  front?: FrontReport
  /** menus the call opened and could not close (§26.11) */
  menusLeftOpen?: string[]
}

/** `menu left open: Action` (§26.11): never silently left. */
export const menuLeftOpenLine = (titles: readonly string[]): string => `menu left open: ${titles.join(', ')}`

/**
 * What the front guard did when `name` came forward (§23.5), or null when it
 * did not: `TextEdit came to the front; Safari was put back in 180 ms`.
 * `person` is the person's app when the host knows it; `afterMs` marks a steal
 * told after its call answered.
 */
export function frontLine(name: string, front: FrontReport | undefined, person?: string | null, afterMs?: number): string | null {
  if (!front?.raised) return null
  const when = afterMs !== undefined ? ` ${Math.max(1, Math.round(afterMs / 1000))} s after the call` : ''
  const came = `${name} came to the front${when}`
  switch (front.restored) {
    case 'restored':
      return `${came}; ${person ?? "the person's app"} was put back${front.ms !== undefined ? ` in ${front.ms} ms` : ''}`
    case 'person-chose':
      return `${came}; the person chose it, so it stays in front`
    case 'failed':
      return `${came} and could not be put back: tell the person`
    case 'hid-app':
      return `${name} kept taking the front${when}, so it is hidden`
    default:
      return came
  }
}

/** Two guard reports of one call as one: the worse outcome, since a call names its app once. */
export function mergeFront(a: FrontReport | undefined, b: FrontReport | undefined): FrontReport | undefined {
  if (!a?.raised) return b?.raised ? b : (a ?? b)
  if (!b?.raised) return a
  const rank = (f: FrontReport): number => ['restored', 'person-chose', 'failed', 'hid-app'].indexOf(f.restored ?? 'restored')
  return rank(b) >= rank(a) ? b : a
}

/**
 * The outcome of actions that ran: step lines (a host line takes a step's
 * place where given; a failed step in the host's words, errorLine), the
 * shots, the body.
 */
export function outcomeOf(
  actions: ComputerAction[],
  result: StepsResult,
  shots: LandedShot[],
  hostLines: ReadonlyMap<number, string> = new Map(),
  ctx: ErrorContext = {},
  person?: string | null
): ComputerToolOutcome {
  const steps = result.steps.map((step, i) => {
    const action = actions[i] ?? ({ action: step.action } as ComputerAction)
    const worded = step.status === 'failed' ? { ...step, error: { ...step.error, message: errorLine(step.error, { ...ctx, action }) } } : step
    return hostLines.get(i) ?? formatStepLine(worded, action)
  })
  if (result.observation?.selectedTab !== undefined)
    steps.unshift(`Selected tab ${JSON.stringify(result.observation.selectedTab)} in window ${JSON.stringify(result.observation.window.title)}`)
  const front = frontLine(result.observation?.app.name ?? ctx.app ?? 'the app', result.front, person)
  if (front) steps.push(front)
  if (result.menusLeftOpen?.length) steps.push(menuLeftOpenLine(result.menusLeftOpen))
  const body = result.observation
    ? result.observation.text
    : result.observationError
      ? OBSERVATION_FAILED_PREFIX + errorLine(result.observationError, { app: ctx.app, window: ctx.window })
      : null
  return { steps, shots, body, isError: false }
}

/** Nothing ran, or the call ended before its result: one line, after any step lines that did run. */
export function refusal(line: string, steps: string[] = []): ComputerToolOutcome {
  return { steps, shots: [], body: line, isError: true }
}

/** The final text: step lines, the shot lines (` (not attached)` past MAX_IMAGE_PARTS), a blank line, the body. */
export function renderText(o: ComputerToolOutcome, opts: { shotLines?: boolean } = {}): string {
  const lines = [...o.steps]
  if (opts.shotLines !== false) o.shots.forEach((s, i) => lines.push(formatShotLine(i + 1, s.where, s, i < MAX_IMAGE_PARTS)))
  if (o.body !== null) {
    if (lines.length) lines.push('')
    lines.push(o.body)
  }
  return lines.join('\n')
}

/** The bridge path's result: the text without its screenshot lines, each picture read back as base64. */
export async function outcomeToPeer(o: ComputerToolOutcome): Promise<ComputerToolResult> {
  const images = await Promise.all(
    o.shots.map(async (s) => ({ label: s.label, data: (await readFile(s.path)).toString('base64'), mimeType: s.mimeType, width: s.width, height: s.height }))
  )
  return { text: renderText(o, { shotLines: false }), images }
}

const quote = (s: string): string => JSON.stringify(s)

/** What a `computer_apps { launch, open }` did, as formatAppsList says it. */
export interface LaunchReport {
  name: string
  launched: boolean
  open?: string[]
  front?: FrontReport
  window?: LaunchedWindow
  others?: LaunchedWindow[]
  /** the person's app, for the front line */
  person?: string | null
}

/** The launch's own lines: whether it started, what opened where, the other windows that changed, the front. */
function launchLines(r: LaunchReport): string[] {
  const lines = [r.launched ? `Launched ${r.name}` : `${r.name} was already running`]
  if (r.open?.length)
    lines.push(
      r.window
        ? `Opened ${openItemsWords(r.open)} in window ${quote(r.window.title)}`
        : `Opened ${openItemsWords(r.open)}; no new window appeared (it may be a tab or an existing window)`
    )
  if (r.others?.length) lines.push(`Its other windows changed: ${r.others.map((w) => quote(w.title)).join(', ')}`)
  const front = frontLine(r.name, r.front, r.person)
  if (front) lines.push(front)
  return lines
}

/** A window's title, browser tabs, and the state that affects targeting it. */
function windowWords(w: WindowInfo): string {
  let text = quote(w.title)
  if (w.tabs) {
    const tabs = w.tabs.map((t) => quote(t.title) + (t.selected ? ' selected' : ''))
    if (w.moreTabs) tabs.push(`and ${w.moreTabs} more`)
    text += ` (tabs: ${tabs.join(', ')})`
  }
  return text + (w.minimized ? ' minimized' : w.space === 'other' ? ' other Space' : '')
}

/**
 * One app a line, the active one first: `TextEdit (com.apple.TextEdit) · active · windows: "Untitled", "Notes.rtf" minimized`.
 * With a launch, its lines come first (launchLines).
 */
export function formatAppsList(apps: AppInfo[], launched?: LaunchReport): string {
  const lines: string[] = []
  if (launched) lines.push(...launchLines(launched))
  const ordered = [...apps.filter((a) => a.active), ...apps.filter((a) => !a.active)]
  for (const app of ordered) {
    const parts = [app.bundleId ? `${app.name} (${app.bundleId})` : app.name]
    if (app.active) parts.push('active')
    if (app.hidden) parts.push('hidden')
    const windows = app.windows ?? []
    parts.push(
      windows.length
        ? `windows: ${windows.map(windowWords).join(', ')}`
        : 'no windows'
    )
    lines.push(parts.join(' · '))
  }
  return lines.join('\n') || 'no apps are running'
}
