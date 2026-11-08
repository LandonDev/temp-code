import { z } from 'zod'
import { ADDON_NAME_RE, WriterSchema } from './addons'

/**
 * The add-on registry over the wire (CLAUDE.md "Add-ons and skills: one
 * store, on the box"). An add-on is an MCP server every harness reaches
 * through the one `app` server: a stdio command each host runs, or an http
 * address. One copy lives on the box (remote/storeSync.ts); the Mac's
 * writes go there. No value of a secret ever rides in a row: `env` and
 * `headers` name the values, which live in the add-on's grant
 * (addonGrant.ts), an aliax-core profile named by the row's id.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/
export const AddonAuthSchema = z.enum(['none', 'fields', 'oauth'])
export type AddonAuth = z.infer<typeof AddonAuthSchema>
export const AddonPlatformSchema = z.enum(['darwin', 'linux'])
export type AddonPlatform = z.infer<typeof AddonPlatformSchema>

const shared = {
  /** none; fields: the person types the values `env`/`headers` name; oauth: the person signs in on the Mac */
  auth: AddonAuthSchema,
  /** the hosts it runs on when it needs one kind; absent: every host */
  platforms: z.array(AddonPlatformSchema).min(1).max(2).optional()
}
export const AddonStdioSpecSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1).max(512),
  args: z.array(z.string().max(2_000)).max(64),
  /** env NAMES the server gets; each value is the grant's field of the same name */
  env: z.array(z.string().regex(ENV_NAME_RE)).max(32),
  /** auth oauth: the env name that gets the grant's access token */
  tokenEnv: z.string().regex(ENV_NAME_RE).optional(),
  ...shared
})
export const AddonHttpSpecSchema = z.object({
  /** Streamable HTTP; the registry core may fall back to SSE */
  transport: z.literal('http'),
  /** https, or plain http to a loopback host */
  url: z.string().url().max(2_000),
  /** header NAMES sent; each value is the grant's field of the same name; an oauth grant also sends Authorization: Bearer <access token> */
  headers: z.array(z.string().regex(HEADER_NAME_RE)).max(16),
  ...shared
})
export const AddonSpecSchema = z.discriminatedUnion('transport', [AddonStdioSpecSchema, AddonHttpSpecSchema])
export type AddonSpec = z.infer<typeof AddonSpecSchema>

export const AddonRowSchema = z.object({
  id: z.string(),
  name: z.string().regex(ADDON_NAME_RE),
  /** this host's workspace id; null: every workspace */
  workspaceId: z.string().nullable(),
  description: z.string().max(500),
  spec: AddonSpecSchema,
  enabled: z.boolean(),
  /** who created it; never changes */
  addedBy: WriterSchema,
  /** who wrote it last; the cards read it */
  writtenBy: WriterSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type AddonRow = z.infer<typeof AddonRowSchema>

/** What addons.set takes: a new row without id, or a whole replacement with it. The host stamps times and writers unless the caller is the sync. */
export const AddonInputSchema = AddonRowSchema.omit({ id: true, createdAt: true, updatedAt: true, addedBy: true, writtenBy: true }).extend({
  id: z.string().optional(),
  /** default true */
  enabled: z.boolean().optional(),
  description: z.string().max(500).optional(),
  addedBy: WriterSchema.optional(),
  writtenBy: WriterSchema.optional()
})
export type AddonInput = z.infer<typeof AddonInputSchema>

/** One downstream tool as this host last listed it (addon_tool_cache). */
export const AddonToolSchema = z.object({
  /** the downstream tool's own name */
  name: z.string(),
  /** what threads call it: `<addon>__<tool>`, exposedNames() */
  exposed: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** the server's annotations.readOnlyHint */
  readOnly: z.boolean().optional()
})
export type AddonTool = z.infer<typeof AddonToolSchema>

export const AddonStateSchema = z.enum(['off', 'starting', 'ready', 'failed', 'needs-grant', 'other-platform'])
export type AddonState = z.infer<typeof AddonStateSchema>
/** An add-on on THIS host: each host runs its own downstream, so status never syncs. */
export const AddonStatusSchema = z.object({
  state: AddonStateSchema,
  tools: z.number().int(),
  /** one line: the failure's first line, which grant field is missing */
  detail: z.string().optional(),
  at: z.number().int()
})
export type AddonStatus = z.infer<typeof AddonStatusSchema>

/** Where a scope's one copy lives when another host holds it (the settings pages print "Saved on box"); null when this host's copy is the one. */
export const StoreHomeSchema = z.object({ name: z.string(), online: z.boolean() }).nullable()
export type StoreHome = z.infer<typeof StoreHomeSchema>

export const AddonRequestSchemas = [
  /** → AddonsList: every scope's rows, this host's status, and the home of the named scope (null: every workspace) */
  z.object({ id: z.string(), method: z.literal('addons.list'), params: z.object({ workspaceId: z.string().nullable().optional() }).optional() }),
  /** → { addon: AddonRow }: create or replace (by id, else by scope and name); forwarded to the home */
  request('addons.set', z.object({ addon: AddonInputSchema })),
  /** → { removed: boolean }: the row and, on the home, its grant profile */
  request('addons.remove', z.object({ id: z.string() })),
  /** → AddonToolsAnswer: this host's cached tools/list */
  request('addons.tools', z.object({ id: z.string() }))
] as const

export interface AddonsList {
  addons: AddonRow[]
  status: Record<string, AddonStatus>
  home: StoreHome
}
export interface AddonToolsAnswer {
  tools: AddonTool[]
  fetchedAt: number | null
}

// ── the tools threads get: their arguments (addons.ts has their words) ──
// The claude tools take these shapes; the codex and muse bridge sends them
// with its `sessionId` as `app.addon*` (contract.ts).

/** Where a thread's write lands: its own workspace (the default) or every workspace. */
export const ToolScopeSchema = z.enum(['workspace', 'global'])
export type ToolScope = z.infer<typeof ToolScopeSchema>

export const AddonAddArgsSchema = z.object({
  name: z.string(),
  description: z.string().max(500).optional(),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
  tokenEnv: z.string().optional(),
  url: z.string().optional(),
  headers: z.array(z.string()).optional(),
  auth: AddonAuthSchema.optional(),
  scope: ToolScopeSchema.optional(),
  platforms: z.array(AddonPlatformSchema).optional()
})
export const AddonRemoveArgsSchema = z.object({ name: z.string(), scope: ToolScopeSchema.optional() })
export const AddonFindArgsSchema = z.object({ query: z.string().optional(), addon: z.string().optional() })
export const AddonCallArgsSchema = z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })

/** To every client socket whenever a row changes. */
export type AddonsPush = { push: 'addons'; addons: AddonRow[] }
/** To every client socket whenever this host's status of an add-on changes. */
export type AddonStatusPush = { push: 'addon-status'; status: Record<string, AddonStatus> }
