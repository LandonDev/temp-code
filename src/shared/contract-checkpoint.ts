import { z } from 'zod'

const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Invalid session id')
const scope = z.object({ sessionId: SessionIdSchema, cwd: z.string() })
const oneOrAll = scope.extend({ relative: z.string().nullish() })
const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

/** Per-session undo checkpoints (donor `session_checkpoint_*`). */
export const CheckpointRequestSchemas = [
  request('checkpoint.ensure', scope),
  request('checkpoint.capture', scope.extend({ paths: z.array(z.string()).max(500, 'Too many paths') })),
  request('checkpoint.sync', scope),
  request('checkpoint.status', scope),
  request('checkpoint.undo', oneOrAll),
  request('checkpoint.keep', oneOrAll)
] as const

export type CheckpointRequest = z.infer<(typeof CheckpointRequestSchemas)[number]>

export interface CheckpointFile {
  path: string
  relative: string
  status: string
  additions: number
  deletions: number
}
export interface CheckpointStatus {
  files: CheckpointFile[]
}
