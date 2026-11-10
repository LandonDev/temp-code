/**
 * The no-jerk scenarios as a timeline the synthetic host plays on one chat
 * thread (scripts/lib/soakHost.ts, `--scene scenarios`), for the soak's
 * screencast (scripts/measure-renderer-soak.ts `--screencast <dir>`): the
 * same scenarios the jsdom runner checks
 * (src/renderer/src/surfaces/AgentTranscript.scenarios.dom.test.tsx),
 * here as the host's own events at real speed, so a recording shows each
 * transition frame by frame. docs/TRANSCRIPT.md "No jerk in any scenario".
 *
 * Each step is a label (the screencast's index names the frames around it)
 * and the events appended at its time, in ms from the start.
 */
import type { AgentEvent } from '../../src/shared/events'

export interface ScenarioStep {
  at: number
  label: string
  events: AgentEvent[]
  /** The host's resume of a paused turn: a paused row drops status events,
   *  so the host writes the row as `session.resume` would (markStatusForProof). */
  resume?: true
  /** The person's clicks in the window after the step's events, in order: each
   *  the question card's button whose text ends with these words (the soak
   *  performs them over CDP, `questionClicks`). */
  clicks?: string[]
}

const text = (t: string, msg: string): AgentEvent => ({ type: 'assistant-text', text: t, delta: false, msgId: msg, blockIndex: 0 })
const delta = (t: string, msg: string): AgentEvent => ({ type: 'assistant-text', text: t, delta: true, msgId: msg, blockIndex: 0 })
const think = (t: string, msg: string, isDelta = true): AgentEvent => ({ type: 'thinking', text: t, delta: isDelta, msgId: msg, blockIndex: 0 })
const call = (callId: string, name: string, input: unknown): AgentEvent => ({ type: 'tool-call', callId, name, input })
const result = (callId: string, output: string): AgentEvent => ({ type: 'tool-result', callId, output, isError: false })
const status = (s: 'running' | 'idle' | 'paused' | 'watching' | 'waiting'): AgentEvent => ({ type: 'status', status: s })
const end: AgentEvent[] = [{ type: 'turn-complete' }, status('idle')]

const BURST =
  'The index goes on the owner and the updated time, so the inbox, the search and the board each read a few rows instead of the table. ' +
  'The migration adds it without a lock, and the queries already sort on those two columns, so nothing else changes. ' +
  'I checked the three call sites and the tests that cover them; all of them pass with the index in place.'

/** A thought's sentences, one at a time. */
function sentences(at: number, every: number, msg: string, lines: string[]): ScenarioStep[] {
  return lines.map((line, i) => ({ at: at + i * every, label: `thought sentence ${i + 1} (every ${every} ms)`, events: [think(`${line} `, msg)] }))
}

/** Words of `body` as deltas `every` ms apart from `at`, `size` words a delta. */
function stream(at: number, every: number, msg: string, body: string, size = 2, label = 'prose streams'): ScenarioStep[] {
  const words = body.split(' ')
  const steps: ScenarioStep[] = []
  for (let i = 0; i < words.length; i += size) {
    steps.push({ at: at + (i / size) * every, label, events: [delta(`${words.slice(i, i + size).join(' ')} `, msg)] })
  }
  return steps
}

export function scenarioTimeline(): ScenarioStep[] {
  const steps: ScenarioStep[] = []
  let t = 0
  const at = (ms: number) => (t += ms)

  // 1. A turn from the composer: the host's wait, a thought, calls, prose, the group opening at two calls, the close.
  steps.push({ at: at(0), label: 'turn 1: the person sends', events: [{ type: 'user-text', text: 'Add an index for the inbox query.' }, status('running')] })
  steps.push({ at: at(300), label: "turn 1: the host's wait", events: [{ type: 'phase', phase: 'waiting-provider' }] })
  steps.push(...sentences(at(1_200), 2_000, 't1-think', ['The inbox reads the table by owner.', 'An index on owner and time would cover it.']))
  at(4_000)
  steps.push({ at: at(0), label: 'turn 1: first call', events: [call('t1-r1', 'Read', { file_path: 'convex/schema.ts' })] })
  steps.push({ at: at(1_500), label: 'turn 1: first call done', events: [result('t1-r1', 'export default defineSchema({})\n')] })
  steps.push(...stream(at(200), 60, 't1-p1', 'The schema has no index on the inbox table yet.'))
  steps.push({ at: at(1_200), label: 'turn 1: second call, the group opens', events: [call('t1-r2', 'Grep', { pattern: 'inbox', path: 'convex' })] })
  steps.push({ at: at(800), label: 'turn 1: second call done', events: [result('t1-r2', 'convex/inbox.ts:12\n')] })
  steps.push({ at: at(200), label: 'turn 1: an edit', events: [call('t1-e1', 'Edit', { file_path: 'convex/schema.ts', old_string: 'a', new_string: 'b\nc\nd' })] })
  steps.push({ at: at(1_500), label: 'turn 1: the edit lands', events: [result('t1-e1', 'ok')] })
  steps.push(...stream(at(300), 60, 't1-p2', 'Added the index on owner and updated time.'))
  steps.push({ at: at(1_500), label: 'turn 1: settles', events: end })

  // 2. A fast turn: the answer inside a second.
  steps.push({ at: at(2_500), label: 'turn 2 (fast): sent', events: [{ type: 'user-text', text: 'Does it need a migration?' }, status('running')] })
  steps.push({ at: at(150), label: 'turn 2: a short thought', events: [think('No. ', 't2-think')] })
  steps.push({ at: at(100), label: 'turn 2: the answer', events: [text('No: Convex builds the index on deploy.', 't2-p')] })
  steps.push({ at: at(250), label: 'turn 2: settles', events: end })

  // 3. A long call with no output, then a burst of calls.
  steps.push({ at: at(2_500), label: 'turn 3: sent', events: [{ type: 'user-text', text: 'Run the tests, then fix what fails.' }, status('running')] })
  steps.push({ at: at(300), label: 'turn 3: a long command', events: [call('t3-b1', 'Bash', { command: 'bun test convex' })] })
  steps.push({ at: at(5_000), label: 'turn 3: the command ends, a burst follows', events: [result('t3-b1', '42 pass\n'), call('t3-r1', 'Read', { file_path: 'convex/inbox.ts' }), result('t3-r1', 'ok'), call('t3-r2', 'Read', { file_path: 'convex/search.ts' }), result('t3-r2', 'ok'), call('t3-r3', 'Read', { file_path: 'convex/board.ts' })] })
  steps.push({ at: at(600), label: 'turn 3: the burst settles', events: [result('t3-r3', 'ok')] })
  // Eight sentences, the last three long: the reasoning column under the
  // working line passes its 192px cap and scrolls to its newest line.
  steps.push(
    ...sentences(at(300), 100, 't3-think', [
      'Fast one.',
      'Then another.',
      'And a third.',
      'Then a fourth.',
      'A fifth one now.',
      'The board test reads the same table as the inbox, so the index serves it too, and its fixture seeds the rows in the order the index sorts by.',
      'The search test is the odd one: it orders by created time, which the index does not cover, so that query keeps its scan and the test stays as it is.',
      'So the failing test is the inbox one, and the fix is the index alone.',
    ]),
  )

  // 4. A steer mid-turn, a compaction starting and ending, a pause and resume, a Stop.
  steps.push({ at: at(1_000), label: 'turn 3: the person steers', events: [{ type: 'user-text', text: 'Skip the board tests.', steerId: 'steer-1' }, { type: 'steer', steerId: 'steer-1', state: 'sent' }] })
  steps.push({ at: at(800), label: 'turn 3: the steer is received', events: [{ type: 'steer', steerId: 'steer-1', state: 'received', how: 'in-turn' }] })
  steps.push({ at: at(600), label: 'turn 3: compaction starts', events: [{ type: 'compaction', phase: 'start', trigger: 'auto' }] })
  steps.push({ at: at(3_000), label: 'turn 3: compaction done', events: [{ type: 'compaction', phase: 'done', trigger: 'auto', preTokens: 412_000, postTokens: 36_000, durationMs: 3_000 }] })
  steps.push({ at: at(400), label: 'turn 3: a call', events: [call('t3-b2', 'Bash', { command: 'bun test convex/inbox' })] })
  steps.push({ at: at(1_500), label: 'turn 3: paused', events: [status('paused')] })
  steps.push({ at: at(2_500), label: 'turn 3: resumed', events: [], resume: true })
  steps.push({ at: at(1_500), label: 'turn 3: stopped', events: [{ type: 'error', message: 'Stopped', stopped: true }, status('idle')] })

  // 5. A burst lands whole and the turn ends 30 ms later.
  steps.push({ at: at(2_500), label: 'turn 4: sent', events: [{ type: 'user-text', text: 'Summarise what changed.' }, status('running')] })
  steps.push({ at: at(1_200), label: 'turn 4: a burst lands whole', events: [text(BURST, 't4-p')] })
  steps.push({ at: at(30), label: 'turn 4: ends 30 ms later', events: end })
  // 6. A question: the card arrives, Next pages it, the answer folds it into its lines.
  steps.push(...questionSteps(at(2_500)))
  t = steps[steps.length - 1]!.at
  // 7. Ten parallel calls land in the open table, one every 300 ms, then four
  // in one push (a running call is no row while the turn is open: each lands
  // with its result); then a 40-line code fence streams in, then a list of
  // 8 items and a table of 6 rows.
  steps.push({ at: at(4_000), label: 'turn 6: sent', events: [{ type: 'user-text', text: 'Check every module, then show the new one.' }, status('running')] })
  const reads = Array.from({ length: 10 }, (_, i) => `convex/module${i}.ts`)
  steps.push({ at: at(300), label: 'turn 6: ten calls start', events: reads.map((file, i) => call(`t6-r${i}`, 'Read', { file_path: file })) })
  for (let i = 0; i < 6; i++) steps.push({ at: at(300), label: `turn 6: call ${i + 1} lands in the table`, events: [result(`t6-r${i}`, 'ok')] })
  steps.push({ at: at(300), label: 'turn 6: four calls land at once', events: [6, 7, 8, 9].map((i) => result(`t6-r${i}`, 'ok')) })
  steps.push(...stream(at(600), 60, 't6-p', 'Here is the new module:', 2, 'turn 6: prose before the fence'))
  at(200)
  steps.push({ at: at(0), label: 'turn 6: the fence opens', events: [delta('\n\n```ts\n', 't6-p')] })
  for (let i = 0; i < 40; i++) {
    const line = `export const value${i} = compute(${i}, { cached: true });`
    steps.push({ at: at(60), label: 'turn 6: the fence streams', events: [delta(line.slice(0, 24), 't6-p')] })
    steps.push({ at: at(60), label: 'turn 6: the fence streams', events: [delta(`${line.slice(24)}\n`, 't6-p')] })
  }
  steps.push({ at: at(60), label: 'turn 6: the fence closes', events: [delta('```\n\nThe steps, in order:\n\n', 't6-p')] })
  for (let i = 1; i <= 8; i++) {
    steps.push({ at: at(90), label: 'turn 6: a list streams', events: [delta(`- Step ${i} moves `, 't6-p')] })
    steps.push({ at: at(90), label: 'turn 6: a list streams', events: [delta(`the thing number ${i}\n`, 't6-p')] })
  }
  steps.push({ at: at(120), label: 'turn 6: a table starts', events: [delta('\nAnd the figures:\n\n| Name | Value |\n|---|---|\n', 't6-p')] })
  for (let i = 1; i <= 6; i++) steps.push({ at: at(150), label: 'turn 6: a table streams', events: [delta(`| row ${i} | ${i * 10} |\n`, 't6-p')] })
  steps.push({ at: at(1_500), label: 'turn 6: settles', events: end })
  steps.push({ at: at(4_000), label: 'the end', events: [] })
  return steps
}

const QUESTIONS = [
  { question: 'Which table gets the index?', header: 'Index', options: [{ label: 'inbox' }, { label: 'threads' }] },
  { question: 'Backfill the old rows?', options: [{ label: 'Yes', description: 'One pass at deploy' }, { label: 'No' }] },
]

/** The question card's steps from `at`: it enters, the person picks and pages
 *  with Next (its height glides, the questions cross-fade), then the answer
 *  folds the card into its answered lines and the turn ends. */
export function questionSteps(at: number): ScenarioStep[] {
  return [
    { at, label: 'turn 5: sent', events: [{ type: 'user-text', text: 'Index the inbox, then ask me what to backfill.' }, status('running')] },
    {
      at: at + 1_200,
      label: 'turn 5: a question arrives',
      events: [call('t5-ask', 'AskUserQuestion', { questions: QUESTIONS }), { type: 'question-request', requestId: 't5-q', questions: QUESTIONS, callId: 't5-ask' }, status('waiting')],
    },
    { at: at + 3_200, label: 'turn 5: the question card pages with Next', events: [], clicks: ['inbox', 'Next'] },
    { at: at + 5_200, label: 'turn 5: the answer folds the card', events: [{ type: 'question-resolved', requestId: 't5-q', answers: [['inbox'], ['Yes']] }, result('t5-ask', 'inbox; Yes'), status('running')] },
    ...stream(at + 5_800, 60, 't5-p', 'Backfilling the inbox rows once at deploy.', 2, 'turn 5: prose streams'),
    { at: at + 7_000, label: 'turn 5: settles', events: end },
  ]
}

/** A page script that performs the person's clicks: each the question card's
 *  button whose text ends with the words, one frame apart, as a hand would. */
export function questionClicks(clicks: string[]): string {
  return `(async () => {
    for (const words of ${JSON.stringify(clicks)}) {
      const button = [...document.querySelectorAll('[data-slot="question-card"] button')].find((b) => (b.textContent ?? '').trim().endsWith(words) || (b.textContent ?? '').trim().startsWith(words))
      button?.click()
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    }
  })()`
}

/** The event with its message, call, request and steer ids suffixed by the play
 *  (`~2`, `~3`; the first play keeps its own), so a second play on the same
 *  thread makes rows of its own instead of folding into the first play's
 *  (the iOS test server's POST /scenario replays it on one chat). */
export function uniqueScenarioIds(event: AgentEvent, play: number): AgentEvent {
  if (play <= 1) return event
  const fields = event as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...fields }
  for (const key of ['msgId', 'callId', 'steerId', 'requestId']) {
    if (typeof fields[key] === 'string') out[key] = `${fields[key]}~${play}`
  }
  return out as unknown as AgentEvent
}

/** The timeline's length, ms. */
export function scenarioLength(steps: ScenarioStep[] = scenarioTimeline()): number {
  return steps.reduce((ms, s) => Math.max(ms, s.at), 0)
}

/** Plays the timeline from now: each step's events appended at its time. Returns a stop. */
export function playScenarios(
  append: (event: AgentEvent) => void,
  onStep: (step: ScenarioStep) => void = () => {},
  steps = scenarioTimeline(),
  resume: () => void = () => {},
): () => void {
  const timers = steps.map((step) =>
    setTimeout(() => {
      onStep(step)
      if (step.resume) resume()
      for (const event of step.events) append(event)
    }, step.at),
  )
  return () => {
    for (const timer of timers) clearTimeout(timer)
  }
}
