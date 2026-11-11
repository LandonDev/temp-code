/** Pure judges for the TC Probe --fewer Mac leg (computer-protocol.md §27.15). */
import { parseObservation, type ElementLine, type ParsedObservation } from '../../src/shared/computer/observation'
import type { BatchResult, ComputerActionName, StepResult } from '../../src/shared/computer/protocol'

export const FEWER_PROBE = {
  window: 'TC Probe Fewer',
  note: 'TC Probe Note',
  popup: 'Destination',
  items: ['Personal', 'Team', 'Archive'],
  choice: 'Team',
  row: 'Draft note',
  renamed: 'Renamed note',
  text: 'A note from the fewer calls proof.',
  unchanged: 'No Change',
  forbidden: 'These keys must not run.'
} as const

type OkStep = Extract<StepResult, { status: 'ok' }>
interface Judged {
  errors: string[]
  steps: OkStep[]
  parsed?: ParsedObservation
  elements: ElementLine[]
}

function inspect(result: BatchResult, actions: ComputerActionName[], stopped = false): Judged {
  const errors: string[] = []
  const steps: OkStep[] = []
  if (result.steps.length !== actions.length) errors.push(`expected ${actions.length} step reports`)
  actions.forEach((action, i) => {
    const step = result.steps[i]
    if (!step || step.index !== i || step.action !== action) errors.push(`step ${i} must report ${action}`)
    if (stopped && i > 0) return
    if (step?.status !== 'ok') errors.push(`step ${i} must succeed`)
    else {
      steps[i] = step
      if (step.tier !== 'ax' && step.tier !== 'process') errors.push(`step ${i} must use ax or process`)
    }
  })
  let parsed: ParsedObservation | undefined
  if (!result.observation || result.observationError) errors.push('the batch must return its closing observation')
  else {
    try { parsed = parseObservation(result.observation.text) }
    catch { errors.push('the closing observation must parse') }
  }
  const elements = parsed?.lines.flatMap((line) => line.type === 'element' && line.marker !== '-' ? [line] : []) ?? []
  return { errors, steps, parsed, elements }
}

/** The click opens a pop-up and a name seen only at runtime picks its item in that same batch. */
export function judgeFewerPopup(result: BatchResult): string[] {
  const { errors, steps, elements, parsed } = inspect(result, ['left_click', 'left_click'])
  if (steps[0]?.effect !== 'changed') errors.push('opening the pop-up must change the state')
  if (steps[1]?.resolved === undefined) errors.push('the named pick must report its resolved element')
  if (!elements.some((e) => e.role === 'pop up' && e.name === FEWER_PROBE.popup && e.value === FEWER_PROBE.choice))
    errors.push('the closing observation must show Team selected in Destination')
  if (parsed?.lines.some((line) => line.type === 'menuBlock' || (line.type === 'element' && line.role === 'menu' && line.marker !== '-')))
    errors.push('the picked menu must be closed')
  return errors
}

/** A menu path opens a fresh window, and target-less type reaches that window's focused text view. */
export function judgeFewerNote(result: BatchResult, previousWindowId: number): string[] {
  const { errors, steps, elements, parsed } = inspect(result, ['left_click', 'type'])
  const opened = steps[0]?.opened
  if (!opened || opened.id === previousWindowId || opened.title !== FEWER_PROBE.note)
    errors.push('the menu step must report the new note window in opened')
  if (steps[0]?.resolved === undefined) errors.push('the menu path must report its resolved item')
  const o = result.observation
  if (!opened || o?.window.id !== opened.id || o?.window.title !== opened.title || o?.kind !== 'full' || parsed?.header.window !== opened.title)
    errors.push('the closing observation must be a full read of the opened window')
  const field = elements.find((e) => e.role === 'text area' && e.name === 'Note' && e.value === FEWER_PROBE.text && e.states.includes('focused'))
  if (!field || parsed?.header.focused !== field.index || steps[0]?.focusTo !== field.index)
    errors.push('the typed text must be in the new note text view at focusTo')
  return errors
}

/** Return enters the selected row's editor, target-less type replaces it, and Return commits it. */
export function judgeFewerRename(result: BatchResult): string[] {
  const { errors, steps, elements } = inspect(result, ['left_click', 'key', 'type', 'key'])
  if (steps[1]?.focusTo === undefined) errors.push('Return must report focus moving to the inline editor')
  if (steps[3]?.effect !== 'changed') errors.push('the final Return must commit a change')
  if (!elements.some((e) => e.role === 'row' && (e.name === FEWER_PROBE.renamed || e.value === FEWER_PROBE.renamed)))
    errors.push('the committed row must show the new name')
  if (elements.some((e) => e.role === 'input' && e.states.includes('focused')))
    errors.push('the inline editor must be closed after Return')
  return errors
}

/** A successful no-op click must stop every later key/text step, with the source step in each report. */
export function judgeFewerStopped(result: BatchResult): string[] {
  const { errors, steps, elements } = inspect(result, ['left_click', 'key', 'type', 'key'], true)
  if (steps[0]?.effect !== 'none') errors.push('the click must succeed with effect none')
  for (let i = 1; i < 4; i++) {
    const step = result.steps[i]
    if (step?.status !== 'not-run' || step.stopped?.afterStep !== 0 || step.stopped.reason !== 'no-change')
      errors.push(`step ${i} must be not-run with stopped after step 0`)
  }
  if (elements.some((e) => `${e.name ?? ''}\n${e.value ?? ''}`.includes(FEWER_PROBE.forbidden)))
    errors.push('the stopped text must not appear in the closing observation')
  return errors
}

/** The click-only call must carry the opened-menu block even if its normal body is a diff or unchanged. */
export function judgeFewerMenu(result: BatchResult): string[] {
  const { errors, steps, parsed } = inspect(result, ['left_click'])
  if (steps[0]?.effect !== 'changed') errors.push('opening the pop-up must change the state')
  const lines = parsed?.lines ?? []
  const at = lines.findIndex((line) => line.type === 'menuBlock' && line.step === 1)
  if (at < 0) errors.push('the closing observation must carry the menu opened by step 1 block')
  else {
    const block = lines[at]
    // A silent menu is a valid §27.4 block: its exact recovery sentence is checked by the parser.
    if (block.type === 'menuBlock' && block.menu) {
      const items: string[] = []
      for (const line of lines.slice(at + 1)) {
        if (line.type === 'menuBlock') break
        if (line.type === 'element' && line.role === 'menu item' && !line.states.includes('disabled')) items.push(line.name ?? '')
      }
      if (!FEWER_PROBE.items.every((name) => items.includes(name))) errors.push('the opened-menu block must list the three enabled choices')
    }
  }
  return errors
}
