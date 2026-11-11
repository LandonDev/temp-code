/** The five §27.14 counts. These rules use saved facts, never inferred intent. */
import type { BenchCall, BenchReport } from './computerBench'

export interface FieldWaste {
  model: string
  rereads: number
  windowMisses: number
  refusedArguments: number
  screenshotCalls: number
  toolSearches: number
}

const bare = (name: string): string => name.replace(/^.*(?:__|\.)/, '')
const argsOf = (call: BenchCall): Record<string, unknown> | null =>
  call.args !== null && typeof call.args === 'object' ? call.args as Record<string, unknown> : null

function screenshot(call: BenchCall): boolean {
  const args = argsOf(call)
  const tool = bare(call.tool)
  return tool === 'computer_screenshot' || args?.action === 'screenshot' ||
    (Array.isArray(args?.actions) && args.actions.some((a) => a?.action === 'screenshot')) ||
    (tool === 'computer_observe' && args?.screenshot === true) ||
    call.steps.some((step) => step.action === 'screenshot')
}

export function fieldWaste(report: Pick<BenchReport, 'runs' | 'models'>): FieldWaste[] {
  const rows = new Map<string, FieldWaste>()
  const rowFor = (model: string): FieldWaste => {
    let row = rows.get(model)
    if (!row) {
      row = { model, rereads: 0, windowMisses: 0, refusedArguments: 0, screenshotCalls: 0, toolSearches: 0 }
      rows.set(model, row)
    }
    return row
  }
  for (const model of report.models) rowFor(model.model)
  for (const run of report.runs) {
    const row = rowFor(run.model)
    row.toolSearches += run.toolSearches?.length ?? 0
    for (const [i, call] of run.calls.entries()) {
      const args = argsOf(call)
      const prev = run.calls[i - 1]
      const before = prev && argsOf(prev)
      // Compare explicit apps and identical window arguments; do not infer aliases.
      if (bare(call.tool) === 'computer_observe' && prev && ['computer_act', 'computer_batch'].includes(bare(prev.tool)) &&
          args && before && typeof args.app === 'string' && args.app === before.app && args.window === before.window &&
          (call.order === undefined || prev.order === undefined || call.order === prev.order + 1) &&
          !(run.toolSearches ?? []).some((search) => search.order !== undefined && prev.order !== undefined && call.order !== undefined && search.order > prev.order && search.order < call.order))
        row.rereads++
      if (/^no window of\b/i.test(call.answerHead ?? '')) row.windowMisses++
      if (/^invalid arguments\b/i.test(call.answerHead ?? '')) row.refusedArguments++
      if (screenshot(call)) row.screenshotCalls++
    }
  }
  return [...rows.values()]
}

export function renderFieldWaste(report: Pick<BenchReport, 'runs' | 'models'>, title = 'Waste'): string {
  return [
    `## ${title}`, '',
    '| model | re-read | window miss | refused argument | screenshot call | tool search |',
    '|---|---:|---:|---:|---:|---:|',
    ...fieldWaste(report).map((r) => `| ${r.model.replace(/\|/g, '\\|')} | ${r.rereads} | ${r.windowMisses} | ${r.refusedArguments} | ${r.screenshotCalls} | ${r.toolSearches} |`)
  ].join('\n')
}
