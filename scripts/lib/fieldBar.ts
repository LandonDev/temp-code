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
 * Every miss is named. The judge takes the EXPECTED models and tasks (C5):
 * a (model, task) a given report lacks is a 'missing' miss, so "bar met" is
 * impossible with a hole; only a whole report may be absent, which skips its
 * bar with a note.
 * Without a Codex report, dated targets judge Mac time and calls for their
 * task ids. Finder counts as one group. Targets cannot prove parity, so
 * that result stays incomplete. Every report prints its waste counts.
 */
import { passNeed, summarize, type BenchReport, type TaskSummary } from './computerBench'
import { FIELD_TARGETS } from './fieldTargets'
import { renderFieldWaste } from './fieldWaste'

export type FieldKind = 'mac' | 'box' | 'codex'

/** What a saved report is, from its own fields: the reference is codex, else the host kind. */
export const classifyFieldReport = (r: BenchReport): FieldKind => (r.mode === 'reference' ? 'codex' : r.hostKind === 'box' ? 'box' : 'mac')

/** What a round must cover: the field models and every field task id; the judge CLI passes FIELD_MODELS × FIELD_TASKS. */
export interface FieldExpectation {
  models: readonly string[]
  tasks: readonly string[]
}

export interface FieldMiss {
  kind: 'parity' | 'no-win' | 'slower' | 'more-calls' | 'box-total' | 'missing'
  model: string
  task?: string
  detail: string
}

export interface FieldJudgement {
  ok: boolean
  /** Targets measure time and calls only; parity still needs a reference. */
  complete: boolean
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
 * two of one kind, or a report that is no field report, throw) against the
 * expected models and tasks. Returns the verdict, each miss named, and the
 * markdown table a judge run prints.
 */
export function fieldBar(reports: readonly BenchReport[], expect: FieldExpectation): FieldJudgement {
  const byKind = new Map<FieldKind, BenchReport>()
  for (const r of reports) {
    if (r.set !== 'field') throw new Error(`a report without set: 'field' (mode ${r.mode}, commit ${r.commit.slice(0, 8)}) is no field report; the bar does not judge it`)
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
  const codexModel = [...codexCells.byModel.keys()][0] ?? codex?.models[0]?.model ?? 'the reference model'
  const codexByTask = codexCells.byModel.get(codexModel) ?? new Map<string, TaskSummary>()

  const misses: FieldMiss[] = []
  const skipped: string[] = []
  if (!mac) skipped.push('no Mac report: the parity and speed bars not judged')
  if (!codex) skipped.push('no Codex reference report: parity not judged; targets measure seconds and calls only')
  if (!box) skipped.push('no box report: the box-total bar not judged')

  // C5: a hole in a GIVEN report is a named miss, never a silent pass.
  for (const [kind, host] of [['mac', mac], ['box', box]] as const) {
    if (!host) continue
    const cells = kind === 'mac' ? macCells : boxCells
    for (const model of expect.models) {
      for (const task of expect.tasks) {
        const s = cells.byModel.get(model)?.get(task)
        if (!s || !s.runs) misses.push({ kind: 'missing', model, task, detail: `no ${kind} run${s?.skipped ? ` (${s.skipped})` : ''}` })
      }
    }
  }
  if (codex)
    for (const task of expect.tasks) {
      const s = codexByTask.get(task)
      if (!s || !s.runs) misses.push({ kind: 'missing', model: codexModel, task, detail: `no codex run${s?.skipped ? ` (${s.skipped})` : ''}` })
    }

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
        // a hole (no run of ours) is already a 'missing' miss; parity judges only runs that ran
        if (!ran(ours)) continue
        if (!passed(ours)) {
          misses.push({ kind: 'parity', model, task, detail: `Codex passed, ${model} failed` })
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

  const targetLines: string[] = []
  if (mac && !codex) {
    const version = mac.fieldTargetsVersion
    if (version !== undefined && version !== FIELD_TARGETS.version)
      skipped.push(`target version ${version} differs from ${FIELD_TARGETS.version}: targets ignored`)
    else {
      targetLines.push(`Targets ${FIELD_TARGETS.version}: Codex seconds and calls; parity needs a reference report.`, '',
        '| model | task or group | seconds | target s | calls | target calls |', '|---|---|---:|---:|---:|---:|')
      for (const [model, byTask] of macCells.byModel) {
        for (const target of FIELD_TARGETS.targets) {
          if (!target.tasks.some((t) => expect.tasks.includes(t.id))) continue
          const task = target.tasks.map((t) => t.id).join(' + ')
          const summaries = target.tasks.map((t) => byTask.get(t.id))
          const mismatch = target.tasks.filter((t, i) => summaries[i] && summaries[i]!.taskVersion !== t.version)
          if (mismatch.length) {
            skipped.push(`${model} · ${task}: target task version mismatch (${mismatch.map((t) => `${t.id}: report ${byTask.get(t.id)!.taskVersion}, target ${t.version}`).join('; ')}); target ignored`)
            continue
          }
          if (!summaries.every(ran)) {
            // A partial Finder group cannot be compared with the whole group's target.
            skipped.push(`${model} · ${task}: target not judged; group or task has no complete run`)
            continue
          }
          const wall = summaries.reduce((sum, s) => sum + (s.wallMsMedian ?? 0), 0)
          const calls = summaries.reduce((sum, s) => sum + (s.callsMedian ?? 0), 0)
          targetLines.push(`| ${model} | ${task} | ${seconds(wall)} | ${target.seconds} | ${calls} | ${target.calls} |`)
          if (wall > target.seconds * 1000) misses.push({ kind: 'slower', model, task, detail: `${seconds(wall)} s against target ${target.seconds} s` })
          if (calls > target.calls) misses.push({ kind: 'more-calls', model, task, detail: `${calls} calls against target ${target.calls}` })
        }
      }
      const untargeted = expect.tasks.filter((id) => !FIELD_TARGETS.targets.some((t) => t.tasks.some((task) => task.id === id)))
      if (untargeted.length) skipped.push(`no Codex target for ${untargeted.join(', ')}: seconds and calls not judged`)
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

  // A task edited between rounds compares different content: say so (never silently).
  const allCells = [macCells, boxCells, codexCells]
  for (const task of expect.tasks) {
    const versions = new Set(allCells.flatMap((c) => [...c.byModel.values()].flatMap((m) => (m.get(task) ? [m.get(task)!.taskVersion] : []))))
    if (versions.size > 1) skipped.push(`${task}: compared across task versions ${[...versions].sort().join(' and ')}`)
  }

  // ── the table ──
  const out: string[] = ['# Field suite', '']
  for (const [kind, r] of byKind) out.push(`- ${kind}: round ${roundOf(r)}, commit ${r.commit.slice(0, 8)}, ${new Date(r.startedAt).toISOString()}${r.ungated ? ', ungated' : ''}`)
  const tasks = [...new Set([...expect.tasks, ...macCells.tasks, ...boxCells.tasks, ...codexCells.tasks])]
  const models = [...new Set([...expect.models, ...macCells.byModel.keys(), ...boxCells.byModel.keys()])]
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
  if (targetLines.length) out.push('', '## Targets', '', ...targetLines)
  for (const [kind, report] of byKind) out.push('', renderFieldWaste(report, `${kind} report waste`))
  out.push('', '## The bar', '')
  if (misses.length) for (const m of misses) out.push(`- MISS ${m.kind} · ${m.model}${m.task ? ` · ${m.task}` : ''}: ${m.detail}`)
  else out.push('- no misses')
  if (skipped.length) out.push('', '## Not judged', '', ...skipped.map((s) => `- ${s}`))
  const complete = !!mac && !!codex
  out.push('', misses.length ? `field bar missed: ${misses.length} miss(es)` : complete ? 'field bar met' : 'field bar incomplete: no measured misses; parity needs Mac and Codex reference reports')
  return { ok: misses.length === 0 && complete, complete, misses, skipped, table: out.join('\n') + '\n' }
}
