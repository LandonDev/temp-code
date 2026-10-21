import { z } from 'zod'

/**
 * A master thread's batch over the wire (CLAUDE.md "Master threads"). A
 * project pins one thread as its master; it starts, watches and steers a
 * batch of root threads that carry its id in `masterId`. The batch's own
 * work happens outside the children, in steps the master's rules name:
 * land every branch, one gate on the merged tree, the release, the box
 * deploy, then tell the person or archive the done children. The master
 * sets the rules with `batch_rules` when it opens the batch; a person can
 * set them over `batch.setRules`; the engine (src/main/server/batch.ts)
 * runs the steps when the last child is done.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const BatchStepIdSchema = z.enum(['land', 'gate', 'release', 'deploy'])
export type BatchStepId = z.infer<typeof BatchStepIdSchema>

export const BatchStepStatusSchema = z.enum(['pending', 'running', 'done', 'failed'])
export type BatchStepStatus = z.infer<typeof BatchStepStatusSchema>

export const BatchStepSchema = z.object({
  id: BatchStepIdSchema,
  status: BatchStepStatusSchema,
  /** one line for the board's foot: "3 of 5 branches landed", the failed step's last log line */
  detail: z.string(),
  /** when the step last changed, or null while pending */
  at: z.number().int().nullable()
})
export type BatchStep = z.infer<typeof BatchStepSchema>

/**
 * What happens when the batch is done, decided by the master (the
 * `batch_rules` tool) or the person (`batch.setRules`), run by the app.
 */
export const BatchRulesSchema = z.object({
  /** merge each branch when its thread lands, or hold every merge until all are done */
  land: z.enum(['as-they-finish', 'all-at-once']),
  /** run the commit tier once on the project head after the last landing */
  gate: z.boolean(),
  /** tag with scripts/release.ts after a green gate */
  release: z.boolean(),
  /** after a release: fire the box deploy trigger (docs/box.md "Deploy from the app", host.deploy) */
  deploy: z.enum(['none', 'box']),
  /** when everything above is done: notify the person, or also archive the done children */
  then: z.enum(['notify', 'archive-children']),
  /** one line the master writes, e.g. "Land all seven, gate once, release, then tell me" */
  summary: z.string().optional()
})
export type BatchRules = z.infer<typeof BatchRulesSchema>

export const DEFAULT_BATCH_RULES: BatchRules = {
  land: 'as-they-finish',
  gate: true,
  release: true,
  deploy: 'none',
  then: 'notify'
}

/** What `batch.get` answers. */
export const BatchStateSchema = z.object({
  masterId: z.string(),
  rules: BatchRulesSchema,
  /** the steps in order: land, gate, release, and deploy when the rules ask for it */
  steps: z.array(BatchStepSchema),
  /** children whose branch has landed on the project branch */
  landed: z.array(z.string()),
  /** children not yet landed (queued, running, waiting, done but unmerged) */
  pending: z.array(z.string()),
  /** under `all-at-once`: children whose merge_branch was held, their branch recorded, in landing order */
  held: z.array(z.string()),
  /** the child that blocks the batch's end (errored or stopped), with why; null when nothing blocks */
  blocked: z.object({ sessionId: z.string(), why: z.enum(['errored', 'stopped']) }).nullable(),
  /** when the engine finished the last step the rules named; null until then */
  finishedAt: z.number().int().nullable()
})
export type BatchState = z.infer<typeof BatchStateSchema>

/** The steps the rules name, in order. */
export function stepsFor(rules: Pick<BatchRules, 'deploy'>): BatchStepId[] {
  return rules.deploy === 'box' ? ['land', 'gate', 'release', 'deploy'] : ['land', 'gate', 'release']
}

/** The batch nobody has run yet: every step pending, nothing landed. */
export function emptyBatch(masterId: string, children: readonly string[] = [], rules: BatchRules = DEFAULT_BATCH_RULES): BatchState {
  return {
    masterId,
    rules: { ...rules },
    steps: stepsFor(rules).map((id) => ({ id, status: 'pending', detail: '', at: null })),
    landed: [],
    pending: [...children],
    held: [],
    blocked: null,
    finishedAt: null
  }
}

/** One line of the rules for a card or a tool answer: "land as they finish · gate · release · then notify". */
export function rulesLine(rules: BatchRules): string {
  const parts = [rules.land === 'all-at-once' ? 'land all at once' : 'land as they finish']
  parts.push(rules.gate ? 'gate' : 'no gate')
  parts.push(rules.release ? 'release' : 'no release')
  if (rules.deploy === 'box') parts.push('deploy to the box')
  parts.push(rules.then === 'archive-children' ? 'then archive the children' : 'then notify')
  return parts.join(' · ')
}

export const BatchRequestSchemas = [
  // → BatchState
  request('batch.get', z.object({ masterId: z.string() })),
  // → { children: SessionMeta[] }: the root threads carrying this masterId, unarchived.
  request('batch.children', z.object({ masterId: z.string() })),
  // → BatchState: set some or all of the rules; every change is the `batch` push.
  request('batch.setRules', z.object({ masterId: z.string(), rules: BatchRulesSchema.partial() }))
] as const
