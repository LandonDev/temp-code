import { z } from 'zod'

const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Invalid session id')
const session = z.object({ sessionId: SessionIdSchema })
const oneOrAll = session.extend({ relative: z.string().nullish() })
const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

/** Per-session undo checkpoints (donor `session_checkpoint_*`). The host
 *  keeps them from its own turns (checkpointTurns.ts) in the thread's cwd;
 *  a caller names the thread only. */
export const CheckpointRequestSchemas = [
  request('checkpoint.status', session),
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
