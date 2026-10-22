import { z } from 'zod'

/**
 * A master thread's batch over the wire (CLAUDE.md "Master threads"). A
 * thread pinned as a master (`SessionMeta.isMaster`, `session.setMaster`)
 * starts, watches and steers a batch of root threads that carry its id in
 * `masterId`. The batch's own work happens outside the children, in the
 * steps the master writes: the built-in kinds (land every branch, one gate
 * on the merged tree, the release, the Mac publish, the box deploy) and
 * `shell` steps of its own (a build, a deploy to a dev server, a smoke
 * test), then tell the person or archive the done children. The master
 * sets the rules with `batch_rules` when it opens the batch; a person can
 * set them over `batch.setRules`; the engine (src/main/server/batch.ts)
 * runs the steps when the last child is done.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const BatchStepKindSchema = z.enum(['land', 'gate', 'release', 'publish', 'deploy', 'shell'])
export type BatchStepKind = z.infer<typeof BatchStepKindSchema>

export const BatchStepStatusSchema = z.enum(['pending', 'running', 'passed', 'failed', 'skipped'])
export type BatchStepStatus = z.infer<typeof BatchStepStatusSchema>

/** How many log lines a step keeps (the newest). */
export const BATCH_STEP_LOG_LINES = 200

/**
 * One step the master wrote. The built-in kinds keep the app's behaviour
 * (batch.ts); `shell` runs `run` through the login shell in `cwd` (default
 * the project checkout) on the host's gate queue, exit 0 passes. `when`
 * is `all-done` (the end of the batch, the default) or `each-landing`
 * (again after every landing, e.g. a dev-server deploy).
 */
export const BatchStepSpecSchema = z.object({
  /** unique in the list; the board and `batch.stopStep` name it */
  id: z.string().min(1).max(64),
  /** what the board shows: "Gate", "Deploy to dev", "Smoke test" */
  name: z.string().min(1).max(80),
  kind: BatchStepKindSchema,
  /** shell: the command line, run through the login shell */
  run: z.string().max(4_000).optional(),
  /** shell: the working directory; default the project checkout */
  cwd: z.string().max(2_000).optional(),
  when: z.enum(['all-done', 'each-landing']).optional()
})
export type BatchStepSpec = z.infer<typeof BatchStepSpecSchema>

export const BatchStepSchema = z.object({
  /** the spec's id */
  id: z.string(),
  name: z.string(),
  kind: BatchStepKindSchema,
  status: BatchStepStatusSchema,
  /** one line for the board's foot: "3 of 5 branches landed", the failed step's last log line, why it was skipped */
  detail: z.string(),
  /** when the step last changed, or null while pending */
  at: z.number().int().nullable(),
  /** epoch ms the step started running */
  startedAt: z.number().int().optional(),
  /** epoch ms the step passed, failed or was skipped */
  endedAt: z.number().int().optional(),
  /** land: branches merged of total; gate: the tier's steps done of total with the running one as label; publish and deploy: their stage */
  progress: z.object({ done: z.number().int(), total: z.number().int(), label: z.string().optional() }).optional(),
  /** the step's console lines as they arrive, the newest BATCH_STEP_LOG_LINES kept */
  log: z.array(z.string())
})
export type BatchStep = z.infer<typeof BatchStepSchema>

/** The steps every batch has unless the master writes others: land, the gate, the release. */
export const DEFAULT_BATCH_STEPS: readonly BatchStepSpec[] = [
  { id: 'land', name: 'Land', kind: 'land' },
  { id: 'gate', name: 'Gate', kind: 'gate' },
  { id: 'release', name: 'Release', kind: 'release' }
]

/**
 * What happens when the batch is done, decided by the master (the
 * `batch_rules` tool) or the person (`batch.setRules`): the steps, run by
 * the app in the order written, then `then`.
 */
export const BatchRulesSchema = z.object({
  /** merge each branch when its thread lands, or hold every merge until all are done */
  land: z.enum(['as-they-finish', 'all-at-once']),
  /** the steps in order; a list without a `land` step gets one at the front */
  steps: z.array(BatchStepSpecSchema).max(32),
  /** when every step is done: notify the person, or also archive the done children */
  then: z.enum(['notify', 'archive-children']),
  /** one line the master writes, e.g. "Land all seven, gate once, release, then tell me" */
  summary: z.string().optional()
})
export type BatchRules = z.infer<typeof BatchRulesSchema>

export const DEFAULT_BATCH_RULES: BatchRules = {
  land: 'as-they-finish',
  steps: [...DEFAULT_BATCH_STEPS],
  then: 'notify'
}

/** The land step every list has: the list's own, else the default at the front. */
export function withLandStep(steps: readonly BatchStepSpec[]): BatchStepSpec[] {
  return steps.some((s) => s.kind === 'land') ? [...steps] : [DEFAULT_BATCH_STEPS[0], ...steps]
}

/**
 * Why a steps list is refused, or null: ids unique and plain, one step
 * per built-in kind, `run` on every shell step and on nothing else.
 */
export function stepsProblem(steps: readonly BatchStepSpec[]): string | null {
  const ids = new Set<string>()
  const kinds = new Set<BatchStepKind>()
  for (const s of steps) {
    if (!/^[A-Za-z0-9][\w.-]*$/.test(s.id)) return `step id "${s.id}" must be letters, digits, dots, dashes or underscores`
    if (ids.has(s.id)) return `step id "${s.id}" is used twice`
    ids.add(s.id)
    if (s.kind === 'shell') {
      if (!s.run?.trim()) return `shell step "${s.id}" has no run`
    } else {
      if (kinds.has(s.kind)) return `two ${s.kind} steps; one per built-in kind`
      kinds.add(s.kind)
      if (s.run) return `step "${s.id}" is ${s.kind}, which takes no run`
    }
  }
  return null
}

/** One thread of the batch as the board draws it: on this host or another (`environmentId`), with the state the host last saw. */
export const BatchChildSchema = z.object({
  /** the host's own session id; a child on another host is keyed `<environmentId>:<sessionId>` in `landed`, `pending` and `held` */
  sessionId: z.string(),
  environmentId: z.string(),
  title: z.string(),
  status: z.string(),
  threadType: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  /** a child on another host: when its host last answered, and whether the link to it is down */
  seenAt: z.number().optional(),
  linkDown: z.boolean().optional()
})
export type BatchChild = z.infer<typeof BatchChildSchema>

/** What `batch.get` answers. */
export const BatchStateSchema = z.object({
  masterId: z.string(),
  rules: BatchRulesSchema,
  /** the rules' steps in order, each with its telemetry (a `land` step first) */
  steps: z.array(BatchStepSchema),
  /** children whose branch has landed on the project branch */
  landed: z.array(z.string()),
  /** children not yet landed (queued, running, waiting, done but unmerged) */
  pending: z.array(z.string()),
  /** under `all-at-once`: children whose merge_branch was held, their branch recorded, in landing order */
  held: z.array(z.string()),
  /** the child that blocks the batch's end (errored, stopped, or on a host out of reach), with why; null when nothing blocks */
  blocked: z
    .object({
      sessionId: z.string(),
      why: z.enum(['errored', 'stopped', 'unreachable']),
      /** `unreachable`: the host the child lives on */
      environmentId: z.string().optional()
    })
    .nullable(),
  /** when the engine finished the last step the rules named; null until then */
  finishedAt: z.number().int().nullable(),
  /** every child of the batch, local and on other hosts, oldest first (additive: an older host leaves it out) */
  children: z.array(BatchChildSchema).optional()
})
export type BatchState = z.infer<typeof BatchStateSchema>

/** A step nobody has run: pending, no log. */
export const emptyStep = (spec: BatchStepSpec): BatchStep => ({
  id: spec.id,
  name: spec.name,
  kind: spec.kind,
  status: 'pending',
  detail: '',
  at: null,
  log: []
})

/** The batch nobody has run yet: every step pending, nothing landed. */
export function emptyBatch(masterId: string, children: readonly string[] = [], rules: BatchRules = DEFAULT_BATCH_RULES): BatchState {
  return {
    masterId,
    rules: { ...rules, steps: rules.steps.map((s) => ({ ...s })) },
    steps: withLandStep(rules.steps).map(emptyStep),
    landed: [],
    pending: [...children],
    held: [],
    blocked: null,
    finishedAt: null
  }
}

/** One line of the rules for a card or a tool answer: "land as they finish · Gate · Release · then notify". */
export function rulesLine(rules: BatchRules): string {
  const parts = [rules.land === 'all-at-once' ? 'land all at once' : 'land as they finish']
  for (const s of rules.steps) if (s.kind !== 'land') parts.push(s.when === 'each-landing' ? `${s.name} (each landing)` : s.name)
  parts.push(rules.then === 'archive-children' ? 'then archive the children' : 'then notify')
  return parts.join(' · ')
}

/** What `batch.adopt` answers: the threads now in the batch, and each refusal with its reason. */
export const BatchAdoptResultSchema = z.object({
  adopted: z.array(z.string()),
  refused: z.array(z.object({ sessionId: z.string(), why: z.string() })),
  state: BatchStateSchema
})
export type BatchAdoptResult = z.infer<typeof BatchAdoptResultSchema>

export const BatchRequestSchemas = [
  // → BatchState
  request('batch.get', z.object({ masterId: z.string() })),
  // → { children: SessionMeta[] }: the root threads carrying this masterId, unarchived.
  request('batch.children', z.object({ masterId: z.string() })),
  // → BatchState: set some or all of the rules; every change is the `batch` push.
  request('batch.setRules', z.object({ masterId: z.string(), rules: BatchRulesSchema.partial() })),
  // → { stopped: boolean }: stop a running step that can be stopped (a shell step's process group, the Mac's publish job).
  request('batch.stopStep', z.object({ masterId: z.string(), stepId: z.string() })),
  // → BatchAdoptResult: existing unarchived root threads join the batch: this host's by id, another
  //   host's as `<envId>:<sessionId>` (adopted there over the link); a master, a subagent, a thread
  //   of another batch or a host out of reach is refused, each id with its reason.
  request('batch.adopt', z.object({ masterId: z.string(), sessionIds: z.array(z.string()).min(1).max(200) })),
  // → SessionBatchResult: archive the batch's children (done = done, or idle after a turn; all = every one,
  //   live ones stopped first), through the fleet's cleanup when removeResources; the master stays.
  request(
    'batch.archive',
    z.object({ masterId: z.string(), which: z.enum(['done', 'all']), removeResources: z.boolean().optional() })
  )
] as const
