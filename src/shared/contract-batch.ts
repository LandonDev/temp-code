import { z } from 'zod'

/**
 * A master thread's batch over the wire (CLAUDE.md "Master threads"). A
 * project pins one thread as its master; it starts, watches and steers a
 * batch of root threads that carry its id in `masterId`. The batch's own
 * work happens outside the children, in three steps: land every branch,
 * one gate on the merged tree, the release. Wave 0 fixes the shapes; the
 * server answers an empty batch (every step pending, the children from the
 * sessions table) until wave 1 runs the steps.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const BatchStepIdSchema = z.enum(['land', 'gate', 'release'])
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

/** What `batch.get` answers. */
export const BatchStateSchema = z.object({
  masterId: z.string(),
  /** the three steps in order: land, gate, release */
  steps: z.array(BatchStepSchema),
  /** children whose branch has landed on the project branch */
  landed: z.array(z.string()),
  /** children not yet landed (queued, running, waiting, done but unmerged) */
  pending: z.array(z.string())
})
export type BatchState = z.infer<typeof BatchStateSchema>

/** The batch nobody has run yet: every step pending, nothing landed. */
export function emptyBatch(masterId: string, children: readonly string[] = []): BatchState {
  return {
    masterId,
    steps: BatchStepIdSchema.options.map((id) => ({ id, status: 'pending', detail: '', at: null })),
    landed: [],
    pending: [...children]
  }
}

export const BatchRequestSchemas = [
  // → BatchState
  request('batch.get', z.object({ masterId: z.string() })),
  // → { children: SessionMeta[] }: the root threads carrying this masterId, unarchived.
  request('batch.children', z.object({ masterId: z.string() }))
] as const
