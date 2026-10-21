import { z } from 'zod'

// Attachments on a remote thread (docs/box.md "Attachments on a remote
// thread"). A file attached on one host (the Mac's disk, a pasted blob) is
// streamed to the host that runs the thread before the turn names it:
// `attachment.begin` → `attachment.chunk` × n (in order, the sender awaits
// each answer: that is the backpressure) → `attachment.commit`, which checks
// size and sha256 and answers the landed path under the thread's attachment
// directory (src/main/server/attachmentDir.ts). `attachment.digest` and
// `attachment.readRange` are how the uploader reads a file on the host it
// lives on without pulling all of it into one frame.

/** Raw bytes per `attachment.chunk` / `attachment.readRange` frame. */
export const ATTACHMENT_CHUNK_BYTES = 2 * 1024 * 1024
/** base64 of the largest chunk, with room. */
const MAX_CHUNK_B64 = Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4 + 16
/** `attachment.maxBytes` when the host has no setting: 200 MB per file. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024
/** An upload with no chunk for this long is dropped, its partial file removed. */
export const ATTACHMENT_UPLOAD_TTL_MS = 10 * 60_000

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const AttachmentBeginParamsSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().min(1).max(1024),
  size: z.number().int().min(0),
  mime: z.string().max(255).optional(),
  sha256
})
export type AttachmentBeginParams = z.infer<typeof AttachmentBeginParamsSchema>

export const AttachmentChunkParamsSchema = z.object({
  uploadId: z.string().min(1).max(100),
  index: z.number().int().min(0),
  dataBase64: z.string().max(MAX_CHUNK_B64)
})
export type AttachmentChunkParams = z.infer<typeof AttachmentChunkParamsSchema>

// Answers, as zod so the Swift generator (scripts/gen-swift-contract.ts)
// emits them; the interfaces are the inferred shapes.

export const AttachmentBeginAnswerSchema = z.object({
  uploadId: z.string(),
  /** The chunk size the host expects (raw bytes, the last chunk may be shorter). */
  chunkBytes: z.number().int()
})
export type AttachmentBeginAnswer = z.infer<typeof AttachmentBeginAnswerSchema>

export const AttachmentChunkAnswerSchema = z.object({
  /** Bytes the host holds so far. */
  received: z.number().int()
})
export type AttachmentChunkAnswer = z.infer<typeof AttachmentChunkAnswerSchema>

/** What `attachment.commit` answers: an events `Attachment` plus its size. */
export const CommittedAttachmentSchema = z.object({
  path: z.string(),
  name: z.string(),
  mime: z.string().optional(),
  kind: z.enum(['image', 'file']),
  size: z.number().int()
})
export type CommittedAttachment = z.infer<typeof CommittedAttachmentSchema>

export const AttachmentSettingsSchema = z.object({
  maxBytes: z.number().int(),
  chunkBytes: z.number().int()
})
export type AttachmentSettings = z.infer<typeof AttachmentSettingsSchema>

export interface AttachmentDigest {
  size: number
  sha256: string
}

export interface AttachmentRange {
  dataBase64: string
  /** The file's whole size, so the reader knows when it is done. */
  size: number
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const AttachmentRequestSchemas = [
  /** → AttachmentBeginAnswer. Refused when `size` is over the host's `attachment.maxBytes`. */
  request('attachment.begin', AttachmentBeginParamsSchema),
  /** → AttachmentChunkAnswer. `index` must be the next one; anything else is refused. */
  request('attachment.chunk', AttachmentChunkParamsSchema),
  /** → CommittedAttachment. Size and sha256 must match what `begin` declared. */
  request('attachment.commit', z.object({ uploadId: z.string().min(1).max(100) })),
  /** → null. Drops the upload and its partial file. */
  request('attachment.abort', z.object({ uploadId: z.string().min(1).max(100) })),
  /** → AttachmentDigest of a file on this host (the uploader's sha256 for `begin`). */
  request('attachment.digest', z.object({ path: z.string().min(1).max(4096) })),
  /** → AttachmentRange: raw bytes [offset, offset + length) of a file on this host. */
  request(
    'attachment.readRange',
    z.object({
      path: z.string().min(1).max(4096),
      offset: z.number().int().min(0),
      length: z.number().int().min(1).max(ATTACHMENT_CHUNK_BYTES)
    })
  ),
  /** → AttachmentSettings. */
  request('attachment.settings', z.object({}).optional()),
  /** → AttachmentSettings. `maxBytes` null puts back the default. */
  request('attachment.settings.set', z.object({ maxBytes: z.number().int().min(1).nullable() }))
] as const
