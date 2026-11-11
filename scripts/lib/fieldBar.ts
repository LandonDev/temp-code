/**
 * The field suite's bar (docs/computer-protocol.md §21.7): a pure judge over
 * saved field reports — a Mac run and a box run of our tools, and the Codex
 * reference — invoked by `--judge-field a.json b.json …`, which runs nothing
 * and works on any host. The bar:
 *  (a) on every task a model's Mac run passes wherever Codex passed, and
 *      passes at least one task Codex failed;
 *  (b) per task, each model's Mac medians (wall seconds and computer calls)
 *      are at or under Codex's;
 *  (c) a model's box run's total seconds are within 15% of its Mac run's.
 * Every miss is named; a missing report skips its bar, never fails it.
 */
import { passNeed, summarize, type BenchReport, type TaskSummary } from './computerBench'

export type FieldKind = 'mac' | 'box' | 'codex'

/** What a saved report is, from its own fields: the reference is codex, else the host kind. */
export const classifyFieldReport = (r: BenchReport): FieldKind => (r.mode === 'reference' ? 'codex' : r.hostKind === 'box' ? 'box' : 'mac')

export interface FieldMiss {
  kind: 'parity' | 'no-win' | 'slower' | 'more-calls' | 'box-total'
  model: string
  task?: string
  detail: string
}

export interface FieldJudgement {
  ok: boolean
  misses: FieldMiss[]
  /** what could not be judged: a report absent, a task skipped */
  skipped: string[]
  table: string
}

/** Within 15%: a slower box run fails, a faster one never does. */
export const BOX_TOTAL_RATIO = 1.15

const ran = (s: TaskSummary | undefined): s is TaskSummary => !!s && s.runs > 0
const passed = (s: TaskSummary): boolean => s.passed >= passNeed(s.runs)
const seconds = (ms: number | null): string => (ms === null ? '–' : (ms / 1000).toFixed(1))
const cellOf = (s: TaskSummary | undefined): string =>
  !s ? '– | – | –' : !s.runs ? 'skip | – | –' : `${passed(s) ? 'pass' : 'FAIL'} ${s.passed}/${s.runs} | ${seconds(s.wallMsMedian)} | ${s.callsMedian ?? '–'}`

interface Cells {
  byModel: Map<string, Map<string, TaskSummary>>
  tasks: string[]
}

function cellsOf(report: BenchReport | undefined): Cells {
  const byModel = new Map<string, Map<string, TaskSummary>>()
  const tasks: string[] = []
  for (const s of report ? summarize(report.runs) : []) {
    const m = byModel.get(s.model) ?? new Map<string, TaskSummary>()
    m.set(s.task, s)
    byModel.set(s.model, m)
    if (!tasks.includes(s.task)) tasks.push(s.task)
  }
  return { byModel, tasks }
}

const roundOf = (r: BenchReport): string => r.round ?? new Date(r.startedAt).toISOString().slice(0, 10)

/**
 * Judges the bar over the reports given (each classified by its own fields;
 * two of one kind throw). Returns the verdict, each miss named, and the
 * markdown table a judge run prints.
 */
export function fieldBar(reports: readonly BenchReport[]): FieldJudgement {
  const byKind = new Map<FieldKind, BenchReport>()
  for (const r of reports) {
    const kind = classifyFieldReport(r)
    if (byKind.has(kind)) throw new Error(`two ${kind} reports given; one of each at most`)
    byKind.set(kind, r)
  }
  const mac = byKind.get('mac')
  const box = byKind.get('box')
  const codex = byKind.get('codex')
  const macCells = cellsOf(mac)
  const boxCells = cellsOf(box)
  const codexCells = cellsOf(codex)
  // The reference runs one model; its summaries apply to every model's bar.
  const codexByTask = [...codexCells.byModel.values()][0] ?? new Map<string, TaskSummary>()

  const misses: FieldMiss[] = []
  const skipped: string[] = []
  if (!mac) skipped.push('no Mac report: the parity and speed bars not judged')
  if (!codex) skipped.push('no Codex reference report: the parity and speed bars not judged')
  if (!box) skipped.push('no box report: the box-total bar not judged')

  // (a) parity and a win, (b) medians, per model on the Mac.
  if (mac && codex) {
    for (const [model, byTask] of macCells.byModel) {
      let win = false
      let codexFailedAny = false
      for (const [task, c] of codexByTask) {
        if (!ran(c)) continue
        const ours = byTask.get(task)
        if (!passed(c)) {
          codexFailedAny = true
          if (ran(ours) && passed(ours)) win = true
          continue
        }
        if (!ran(ours) || !passed(ours)) {
          misses.push({ kind: 'parity', model, task, detail: `Codex passed, ${model} ${!ran(ours) ? 'never ran it' : 'failed'}` })
          continue
        }
        // (b) only where Codex passed: a speed on a task it failed proves nothing.
        if (ours.wallMsMedian !== null && c.wallMsMedian !== null && ours.wallMsMedian > c.wallMsMedian)
          misses.push({ kind: 'slower', model, task, detail: `${seconds(ours.wallMsMedian)} s against Codex's ${seconds(c.wallMsMedian)} s` })
        if (ours.callsMedian !== null && c.callsMedian !== null && ours.callsMedian > c.callsMedian)
          misses.push({ kind: 'more-calls', model, task, detail: `${ours.callsMedian} calls against Codex's ${c.callsMedian}` })
      }
      if (!win)
        misses.push({
          kind: 'no-win',
          model,
          detail: codexFailedAny ? 'passed none of the tasks Codex failed' : 'Codex failed no task, so no task shows our tools ahead'
        })
    }
  }

  // (c) the box run's total against the Mac's, per model, over the tasks both ran.
  if (mac && box) {
    for (const [model, boxTasks] of boxCells.byModel) {
      const macTasks = macCells.byModel.get(model)
      if (!macTasks) {
        skipped.push(`${model}: in the box report alone, its box total not judged`)
        continue
      }
      let macTotal = 0
      let boxTotal = 0
      let shared = 0
      for (const [task, b] of boxTasks) {
        const m = macTasks.get(task)
        if (!ran(b) || !ran(m) || b.wallMsMedian === null || m.wallMsMedian === null) continue
        shared++
        boxTotal += b.wallMsMedian
        macTotal += m.wallMsMedian
      }
      if (!shared) skipped.push(`${model}: no task ran on both hosts, its box total not judged`)
      else if (boxTotal > macTotal * BOX_TOTAL_RATIO)
        misses.push({ kind: 'box-total', model, detail: `box ${seconds(boxTotal)} s against Mac ${seconds(macTotal)} s over ${shared} tasks (limit +15%)` })
    }
  }

  // ── the table ──
  const out: string[] = ['# Field suite', '']
  for (const [kind, r] of byKind) out.push(`- ${kind}: round ${roundOf(r)}, commit ${r.commit.slice(0, 8)}, ${new Date(r.startedAt).toISOString()}${r.ungated ? ', ungated' : ''}`)
  const tasks = [...new Set([...macCells.tasks, ...boxCells.tasks, ...codexCells.tasks])]
  const models = [...new Set([...macCells.byModel.keys(), ...boxCells.byModel.keys()])]
  for (const model of models.length ? models : [...codexCells.byModel.keys()]) {
    out.push(
      '',
      `## ${model}`,
      '',
      '| task | mac | mac s | mac calls | box | box s | box calls | codex | codex s | codex calls |',
      '|---|---|---|---|---|---|---|---|---|---|'
    )
    for (const task of tasks)
      out.push(`| ${task} | ${cellOf(macCells.byModel.get(model)?.get(task))} | ${cellOf(boxCells.byModel.get(model)?.get(task))} | ${cellOf(codexByTask.get(task))} |`)
  }
  out.push('', '## The bar', '')
  if (misses.length) for (const m of misses) out.push(`- MISS ${m.kind} · ${m.model}${m.task ? ` · ${m.task}` : ''}: ${m.detail}`)
  else out.push('- no misses')
  if (skipped.length) out.push('', '## Not judged', '', ...skipped.map((s) => `- ${s}`))
  out.push('', misses.length ? `field bar missed: ${misses.length} miss(es)` : 'field bar met')
  return { ok: misses.length === 0, misses, skipped, table: out.join('\n') + '\n' }
}
