import { z } from 'zod'

// Harness config sync (docs/box.md "Harness config: synced from the Mac"):
// the Mac's main process mirrors the user's Claude Code and Codex config
// (skills, commands, agents, hooks, settings, plugins, two keys of ~/.claude.json)
// onto the hosts it holds admin keys for, over the peer link. `harness.
// manifest`, `.file` and `.commit` are what one host's main process asks of
// another; `harness.status`, `.sync` and `.settings.set` are the Settings →
// Remote access pane's. All admin. relPaths are relative to the receiver's
// HOME and checked against the sync set there; none names a host path.

/** Raw bytes per `harness.file` frame. Frames are JSON over the socket (HTTP bodies stop at 1 MB). */
export const HARNESS_CHUNK_BYTES = 2 * 1024 * 1024
/** base64 of the largest chunk, with room. */
const MAX_CHUNK_B64 = Math.ceil((4 * 1024 * 1024) / 3) * 4 + 16

export const HarnessEntrySchema = z.object({
  relPath: z.string().min(1).max(1024),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.number().int().min(0).max(0o7777),
  mtime: z.number()
})
export type HarnessEntry = z.infer<typeof HarnessEntrySchema>

/** The two keys of ~/.claude.json that cross; the schema drops any other. Absent: leave the receiver's alone this round. */
export const HarnessClaudeJsonSchema = z.object({
  enabledPlugins: z.unknown().optional(),
  mcpServers: z.unknown().optional()
})
export type HarnessClaudeJson = z.infer<typeof HarnessClaudeJsonSchema>

export const HarnessManifestParamsSchema = z.object({
  /** The sender's environment id. */
  from: z.string().min(1),
  /** The sender's home directory: what the receiver's path translation maps from. */
  home: z.string().min(1).max(1024),
  generation: z.string().min(1).max(100),
  entries: z.array(HarnessEntrySchema).max(50_000),
  claudeJson: HarnessClaudeJsonSchema.optional()
})
export type HarnessManifestParams = z.infer<typeof HarnessManifestParamsSchema>

export const HarnessFileParamsSchema = z.object({
  generation: z.string().min(1).max(100),
  relPath: z.string().min(1).max(1024),
  chunkIndex: z.number().int().min(0),
  chunks: z.number().int().min(1).max(64),
  dataBase64: z.string().max(MAX_CHUNK_B64)
})
export type HarnessFileParams = z.infer<typeof HarnessFileParamsSchema>

/** → what the receiver needs sent, and what it will delete on commit. */
export interface HarnessManifestAnswer {
  need: string[]
  remove: string[]
  /** Entries the receiver refused (outside the set, a secret, a bad path); they never land. */
  refused: number
}

export interface HarnessCommitAnswer {
  /** Files in the manifest that landed or were already current. */
  files: number
  written: number
  deleted: number
  /** Whether the receiver's ~/.claude.json changed. */
  claudeJson: boolean
}

/** One saved environment, as the pane shows it. */
export interface HarnessEnvironmentStatus {
  id: string
  name: string
  connected: boolean
  running: boolean
  /** Files in the last manifest the host committed, null before the first. */
  files: number | null
  /** Those files per set label (harnessSet.ts), every label present; null before the first sync or from an older sender. */
  sets: Record<string, number> | null
  syncedAt: number | null
  lastAttemptAt: number | null
  error: string | null
}

export interface HarnessSyncStatus {
  enabled: boolean
  /** Files the sender left out (over the size budget, a symlink out of reach). */
  skipped: number
  environments: HarnessEnvironmentStatus[]
  /** The map in force (the setting, else the shipped history-map.json): the
   *  renderer pairs the same project across hosts with it. */
  pathMap?: { roots: Record<string, string>; prefixes: Record<string, string> }
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const HarnessRequestSchemas = [
  request('harness.manifest', HarnessManifestParamsSchema),
  request('harness.file', HarnessFileParamsSchema),
  request('harness.commit', z.object({ generation: z.string().min(1).max(100) })),
  /** → HarnessSyncStatus. */
  request('harness.status', z.object({}).optional()),
  /** → HarnessSyncStatus once the sync (one host, or every one) finished. */
  request('harness.sync', z.object({ environmentId: z.string().optional() }).optional()),
  /** → HarnessSyncStatus. `pathMap` null puts back the shipped map. */
  request(
    'harness.settings.set',
    z.object({
      enabled: z.boolean().optional(),
      pathMap: z.object({ roots: z.record(z.string(), z.string()).optional(), prefixes: z.record(z.string(), z.string()).optional() }).nullable().optional()
    })
  )
] as const
