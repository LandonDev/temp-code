import { z } from 'zod'

export const AccountProviderSchema = z.enum(['claude', 'codex', 'cursor'])
export const ServiceIdSchema = z.enum(['claude-code', 'codex', 'cursor'])

/** aliax-core sync.ts Transfer, as it crosses the wire. */
const LimitFieldSchema = z.object({ limit: z.number().optional(), remaining: z.number().optional(), resetsAt: z.number().optional() })
/** One host's view of one account (main/server/headroom.ts HostObservation). */
export const HostObservationSchema = z.object({
  seenAt: z.number(),
  requests: LimitFieldSchema.optional(),
  tokens: LimitFieldSchema.optional(),
  inputTokens: LimitFieldSchema.optional(),
  outputTokens: LimitFieldSchema.optional(),
  tier: z.string().optional(),
  recent: z.array(z.number()),
  throttles: z.array(z.object({ at: z.number(), status: z.number(), until: z.number(), model: z.string().nullable() }))
})
export const HeadroomSnapshotSchema = z.object({
  version: z.literal(1),
  hosts: z.record(z.string(), z.record(z.string(), HostObservationSchema))
})

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
/** A profile deleted on a host (shared/accounts.ts AccountRemoval). */
export const AccountRemovalSchema = z.object({
  service: ServiceIdSchema,
  accountId: z.string(),
  name: z.string(),
  static: z.boolean(),
  at: z.number()
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
  /** The file's modification time (ms), for the newer-copy rule when the
   *  same path exists on two hosts. */
  mtime?: number
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
  /** FTS5 bm25 of the row (negative, lower is a better match); absent for
   *  a row the scan found. */
  rank?: number
  /** `notes`: the hit is in the thread's working notes (threadNotes.ts), not a transcript row; seq is 0. */
  source?: 'notes'
}
export interface SessionSearchResult {
  hits: SessionSearchHit[]
  truncated: boolean
}
/** One note whose title or body mentions the query (`notes.search`). */
export interface NoteSearchHit {
  id: string
  title: string
  snippet: string
  updatedAt: number
  sourceCwd?: string
}
export interface NoteSearchResult {
  hits: NoteSearchHit[]
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
    method: z.literal('notes.search'),
    params: z.object({ query: z.string(), limit: z.number().int().positive().max(200).optional() })
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
  // A host deleted profiles (remote/accountSync.ts): the peer drops its
  // access-only copies of what the sender refreshed, and a static token only
  // when a removal names it; never what it owns, its CLI's sign-in, or a
  // provisional copy. `from` is the sender's environment id.
  z.object({
    id: z.string(),
    method: z.literal('accounts.removed'),
    params: z.object({ from: z.string(), removed: z.array(AccountRemovalSchema) })
  }),
  // Delete a saved profile on this host (the Accounts page's Remove, a proof):
  // the vault row goes, the snapshot rebuilds at once, and every peer hears.
  z.object({
    id: z.string(),
    method: z.literal('accounts.delete'),
    params: z.object({ service: ServiceIdSchema, name: z.string() })
  }),
  // A host's headroom picture (main/server/headroom.ts): per environment id,
  // per `service:account`, what its gateway saw of the account's rate limits.
  // Pushed every 30 s and on a 429; the answer carries the receiver's own.
  z.object({
    id: z.string(),
    method: z.literal('accounts.headroom'),
    params: z.object({ from: z.string(), snapshot: HeadroomSnapshotSchema.nullable() })
  }),
  z.object({ id: z.string(), method: z.literal('accounts.sync'), params: z.object({ environmentId: z.string().optional() }).optional() }),
  z.object({
    id: z.string(),
    method: z.literal('accounts.setHome'),
    params: z.object({ provider: AccountProviderSchema, environmentId: z.string().nullable() })
  })
] as const
