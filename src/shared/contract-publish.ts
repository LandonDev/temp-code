import { z } from 'zod'
import { CrossHostCallerSchema } from './contract-crosshost'

/** A Mac that can publish a release already cut on the box. */
export const PUBLISH_OFFER = 'publish'
export const PUBLISH_PEER_METHODS = ['publish.start', 'publish.stop'] as const
export type PublishPeerMethod = (typeof PUBLISH_PEER_METHODS)[number]
export const isPublishPeerMethod = (method: string): method is PublishPeerMethod =>
  (PUBLISH_PEER_METHODS as readonly string[]).includes(method)

export const PublishCallerSchema = CrossHostCallerSchema.pick({
  environmentId: true,
  sessionId: true
})
export const PublishStartArgsSchema = z.object({
  sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
  branch: z.string().min(1).max(200),
  version: z.string().regex(/^1\.0\.\d+$/),
  notes: z.string()
})
export const PublishStartParamsSchema = z.object({
  caller: PublishCallerSchema,
  args: PublishStartArgsSchema
})
export const PublishStopParamsSchema = z.object({
  caller: PublishCallerSchema,
  args: z.object({}).strict()
})
export type PublishStartArgs = z.infer<typeof PublishStartArgsSchema>
export type PublishCallParams =
  z.infer<typeof PublishStartParamsSchema> | z.infer<typeof PublishStopParamsSchema>

export interface PublishRun {
  ok: boolean
  exit: number | null
  version: string | null
  text: string
}
