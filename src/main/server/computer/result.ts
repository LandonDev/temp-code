import { readFile } from 'node:fs/promises'
import { MAX_IMAGE_PARTS, OBSERVATION_FAILED_PREFIX, formatShotLine, formatStepLine, type ComputerToolResult } from '@shared/computer/tools'
import type { AppInfo, ComputerAction, ComputerError, Observation, StepResult } from '@shared/computer/protocol'

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
}

/** The outcome of actions that ran: step lines (a host line takes a step's place where given), the shots, the body. */
export function outcomeOf(actions: ComputerAction[], result: StepsResult, shots: LandedShot[], hostLines: ReadonlyMap<number, string> = new Map()): ComputerToolOutcome {
  const steps = result.steps.map((step, i) => hostLines.get(i) ?? formatStepLine(step, actions[i] ?? { action: step.action }))
  const body = result.observation
    ? result.observation.text
    : result.observationError
      ? OBSERVATION_FAILED_PREFIX + result.observationError.message
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

/**
 * One app a line, the active one first: `TextEdit (com.apple.TextEdit) · active · windows: "Untitled", "Notes.rtf" minimized`.
 * With a launch, a first line says whether it started.
 */
export function formatAppsList(apps: AppInfo[], launched?: { name: string; launched: boolean }): string {
  const lines: string[] = []
  if (launched) lines.push(launched.launched ? `Launched ${launched.name}` : `${launched.name} was already running`)
  const ordered = [...apps.filter((a) => a.active), ...apps.filter((a) => !a.active)]
  for (const app of ordered) {
    const parts = [app.bundleId ? `${app.name} (${app.bundleId})` : app.name]
    if (app.active) parts.push('active')
    if (app.hidden) parts.push('hidden')
    const windows = app.windows ?? []
    parts.push(
      windows.length
        ? `windows: ${windows.map((w) => quote(w.title) + (w.minimized ? ' minimized' : w.space === 'other' ? ' other Space' : '')).join(', ')}`
        : 'no windows'
    )
    lines.push(parts.join(' · '))
  }
  return lines.join('\n') || 'no apps are running'
}
