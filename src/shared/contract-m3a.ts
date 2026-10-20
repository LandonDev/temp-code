import { z } from 'zod'

export const AccountProviderSchema = z.enum(['claude', 'codex', 'cursor'])
export const ServiceIdSchema = z.enum(['claude-code', 'codex', 'cursor'])

/** aliax-core sync.ts Transfer, as it crosses the wire. */
export const AccountTransferSchema = z.object({
  service: ServiceIdSchema,
  mode: z.enum(['handoff', 'access']),
  profile: z.object({
    name: z.string(),
    accountId: z.string(),
    email: z.string().optional(),
    nickname: z.string().optional(),
    color: z.string().optional(),
    createdAt: z.number(),
    static: z.boolean(),
    owner: z.string().nullable()
  }),
  blob: z.string(),
  expiresAt: z.number().nullable()
})
/** One explicit account per gateway provider; a missing key inherits. */
export const AccountPinsSchema = z.object({ claude: z.string().min(1).optional(), codex: z.string().min(1).optional() })

export const NoteIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Invalid note id')
export const NoteUpsertSchema = z.object({
  id: NoteIdSchema,
  title: z.string(),
  body: z.string(),
  sourceSessionId: z.union([NoteIdSchema, z.literal('')]).optional(),
  sourceCwd: z.string().optional()
})
export type NoteUpsert = z.infer<typeof NoteUpsertSchema>
export interface Note extends NoteUpsert {
  slug: string
  createdAt: number
  updatedAt: number
}
export const ProjectSearchOptionsSchema = z.object({
  cwd: z.string(),
  query: z.string(),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  regex: z.boolean().optional(),
  include: z.string().optional(),
  exclude: z.string().optional()
})
export type ProjectSearchOptions = z.infer<typeof ProjectSearchOptionsSchema>
export interface ProjectSearchMatch {
  path: string
  relative: string
  line: number
  column: number
  preview: string
}
export interface ProjectSearchResult {
  matches: ProjectSearchMatch[]
  truncated: boolean
}
/** One row of the stored event log that mentions the query. */
export interface SessionSearchHit {
  sessionId: string
  seq: number
  role: 'user' | 'assistant'
  snippet: string
  ts: number
}
export interface SessionSearchResult {
  hits: SessionSearchHit[]
  truncated: boolean
}
export const WorkspaceSnapshotSchema = z.record(z.string(), z.json())
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>
export interface TextGenerateResult {
  text: string | null
}

export const M3aRequestSchemas = [
  z.object({
    id: z.string(),
    method: z.literal('session.pin'),
    params: z.object({ sessionId: z.string(), pinned: z.boolean() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('text.generate'),
    params: z.object({ prompt: z.string(), cwd: z.string().optional() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('workspace.getSnapshot'),
    params: z.object({ window: z.string().optional() }).optional()
  }),
  z.object({
    id: z.string(),
    method: z.literal('workspace.setSnapshot'),
    params: z.object({ snapshot: WorkspaceSnapshotSchema, window: z.string().optional() })
  }),
  z.object({ id: z.string(), method: z.literal('notes.list') }),
  z.object({
    id: z.string(),
    method: z.literal('notes.get'),
    params: z.object({ id: NoteIdSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('notes.upsert'),
    params: z.object({ note: NoteUpsertSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('notes.delete'),
    params: z.object({ id: NoteIdSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('search.project'),
    params: z.object({ options: ProjectSearchOptionsSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.search'),
    params: z.object({
      query: z.string(),
      workspaceId: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
      archived: z.boolean().optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('projectLogo.save'),
    params: z.object({ projectPath: z.string(), sourcePath: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('projectLogo.remove'),
    params: z.object({ projectPath: z.string() })
  }),
  z.object({ id: z.string(), method: z.literal('accounts.list') }),
  z.object({
    id: z.string(),
    method: z.literal('accounts.refresh'),
    params: z.object({ provider: AccountProviderSchema })
  }),
  // One account crossing to another host (aliax-core sync.ts Transfer): a
  // handoff carries the refresh token for the host it names as owner, an
  // access copy carries none. `from` is the sender's environment id.
  z.object({
    id: z.string(),
    method: z.literal('accounts.push'),
    params: z.object({ from: z.string(), transfer: AccountTransferSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('accounts.pull'),
    params: z.object({
      from: z.string(),
      service: ServiceIdSchema.optional(),
      name: z.string().optional(),
      /** The caller becomes the owner: the answer carries the refresh token and this host keeps an access-only copy. */
      takeOver: z.boolean().optional()
    })
  }),
  // The taker of a handed-out grant (accounts.pull with takeOver, or a
  // provisional copy from an earlier handoff) says it saved the grant whose
  // refresh token has this fingerprint: the owner strips its own copy and
  // answers ok; a release it already made answers ok too; anything else is
  // refused and the taker drops its provisional copy.
  z.object({
    id: z.string(),
    method: z.literal('accounts.confirm'),
    params: z.object({ from: z.string(), service: ServiceIdSchema, accountId: z.string(), refreshFingerprint: z.string() })
  }),
  // The sender of a handoff stripped its copy: the receiver, holding the
  // grant provisionally, makes itself the owner.
  z.object({
    id: z.string(),
    method: z.literal('accounts.released'),
    params: z.object({ from: z.string(), service: ServiceIdSchema, accountId: z.string() })
  }),
  z.object({ id: z.string(), method: z.literal('accounts.sync'), params: z.object({ environmentId: z.string().optional() }).optional() }),
  z.object({
    id: z.string(),
    method: z.literal('accounts.setHome'),
    params: z.object({ provider: AccountProviderSchema, environmentId: z.string().nullable() })
  })
] as const
