import { z } from 'zod'

/**
 * The gate out of the children (CLAUDE.md "Master threads"). A thread lands
 * its branch through merge_branch; what runs before the fast-forward depends
 * on who calls: a batch child (a session with `masterId`) gets typecheck
 * alone, so a break is named to its thread; a thread outside any batch gets
 * the gate's commit tier as before. Both run on the host's one gate queue
 * (gateQueue.ts). The batch's end runs the commit tier once on the merged
 * tree and then the release train, through the master's `batch_gate` tool.
 * Every run lands as a `notice` row of kind `gate` carrying this payload.
 */
export const GateStepSchema = z.enum(['typecheck', 'gate', 'release'])
export type GateStep = z.infer<typeof GateStepSchema>

export const GateNoticeSchema = z.object({
  step: GateStepSchema,
  branch: z.string(),
  ok: z.boolean(),
  /** the run's last lines (gateRun.ts keeps GATE_LOG_TAIL of them) */
  log: z.string(),
  at: z.number().int()
})
export type GateNotice = z.infer<typeof GateNoticeSchema>

/** How many lines of a run's output the notice keeps. */
export const GATE_LOG_TAIL = 40
/** How many of them the tool's HELD answer quotes. */
export const GATE_TEXT_TAIL = 20

const STEP_LABEL: Record<GateStep, string> = { typecheck: 'Typecheck', gate: 'Gate', release: 'Release' }

/** tsc's error count from a typecheck log: its "Found N errors" line, else
 *  the `error TS` lines; 0 when neither appears. */
export function typecheckErrorCount(log: string): number {
  const found = /Found (\d+) errors?/.exec(log)
  if (found) return Number(found[1])
  return (log.match(/error TS\d+/g) ?? []).length
}

/** The failed gate step named in its own log (`✗ vitest 12s failed`), else null. */
export function failedGateStep(log: string): string | null {
  const lines = log.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /✗ (\S+)/.exec(lines[i])
    if (m) return m[1]
  }
  return null
}

/** The row's one line: "Typecheck failed on <branch> · 3 errors". */
export function gateLine(n: GateNotice): string {
  const label = STEP_LABEL[n.step]
  if (n.ok) return `${label} passed on ${n.branch}`
  if (n.step === 'typecheck') {
    const errors = typecheckErrorCount(n.log)
    return `${label} failed on ${n.branch}${errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}`
  }
  if (n.step === 'gate') {
    const step = failedGateStep(n.log)
    return `${label} failed on ${n.branch}${step ? ` · at ${step}` : ''}`
  }
  return `${label} failed on ${n.branch}`
}

/** The last `n` non-empty lines of a log. */
export function logTail(log: string, n: number): string {
  return log
    .split('\n')
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n')
}

// ── the master's tool (apptools.ts; scripts/app-mcp-bridge.mjs copies these) ──

export const BATCH_GATE_TOOL_NAME = 'batch_gate'
export const BATCH_GATE_TOOL_DESCRIPTION =
  "Run the batch's gate once on the merged tree, then tag the release. Only the project's master thread may call it, after its children have landed through merge_branch (a child still unlanded is left out and the land step says so). The gate is `bun run gate --tier commit` on the project checkout at the project branch's head, in the host's gate queue, so it never runs beside a child's typecheck or another batch's gate; with a green gate the release train (`bun scripts/release.ts`) commits the version bump and tags release-N. Answers \"passed in 4m 12s · release-N tagged\", or \"FAILED at <step>\" with the log tail: fix on a child branch, land it, call again."
export const BATCH_GATE_PARAMS = {
  notes: "The release's one-line notes. Defaults to this thread's title followed by the landed children's commit subjects.",
  release: 'Tag the release after a green gate. Default true; false runs the gate alone.'
}

export const BATCH_RULES_TOOL_NAME = 'batch_rules'
export const BATCH_RULES_TOOL_DESCRIPTION =
  "Read or set what the app does when every thread of your batch is done. Only the project's master thread may call it. With no field it answers the rules as they stand; with fields it sets those and keeps the rest. Set them when you open a batch and state them to the person. Defaults: land as-they-finish, gate, release, no deploy, then notify. The app runs the steps in order on the host's gate queue when the last thread is done (idle after a turn, done, archived or deleted; one that errored or stopped blocks the end and you are told); a red step stops the rest and you are told; the steps run again once a thread changes."
export const BATCH_RULES_PARAMS = {
  land: "as-they-finish: merge_branch fast-forwards each thread's branch as it lands. all-at-once: merge_branch answers HELD and records the branch; the app merges them in landing order at the end.",
  gate: 'Run the commit tier once on the project head after the last landing (bun run gate --tier commit).',
  release: 'Tag with scripts/release.ts after a green gate, and push.',
  deploy: "none, or box: after the release, fire the box's deploy trigger (host.deploy) for the project branch.",
  then: 'notify: a notice row on this thread and a wake. archive-children: the same, and every done thread of the batch archived.',
  summary: 'One line in your words, e.g. "Land all seven, gate once, release, then tell me".'
}
