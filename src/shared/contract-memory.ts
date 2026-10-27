import { z } from 'zod'
import { HarnessEntrySchema } from './contract-harness'

// Memory sync (docs/box.md "Memory: synced both ways"): the notes the
// harnesses write for themselves (Claude Code's per-project memory and
// plans, Codex's memories; memorySet.ts) cross between every pair of hosts
// that share an admin link, in both directions. `memory.exchange` and
// `memory.files` are what one host's main process (the driver, the one
// holding the link) asks of the other (the receiver, which decides per
// file; memoryMerge.ts). `memory.status`, `.sync` and `.settings.set` are
// the Settings → Hosts page's. All admin. relPaths are relative to
// the sender's HOME and checked against the memory set on both ends; the
// receiver translates an encoded project dir through its path map.

/** Per-file budget on the wire: a memory file is text; anything bigger stays where it is. */
export const MEMORY_MAX_WIRE_BYTES = 1024 * 1024
/** base64 of the largest file, with room. */
const MAX_FILE_B64 = Math.ceil((MEMORY_MAX_WIRE_BYTES + 64) / 3) * 4 + 16
/** Files per `memory.files` frame (the driver batches by bytes too; MEMORY_FILES_FRAME_BYTES). */
export const MEMORY_FILES_PER_FRAME = 200
export const MEMORY_FILES_FRAME_BYTES = 2 * 1024 * 1024

export const MemoryEntrySchema = HarnessEntrySchema
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

export const MemoryTombstoneSchema = z.object({ relPath: z.string().min(1).max(1024), at: z.number() })
export type MemoryTombstone = z.infer<typeof MemoryTombstoneSchema>

/** One file's bytes on the wire, either way. */
export const MemoryFileSchema = z.object({
  relPath: z.string().min(1).max(1024),
  mtime: z.number(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.number().int().min(0).max(0o7777),
  dataBase64: z.string().max(MAX_FILE_B64)
})
export type MemoryFile = z.infer<typeof MemoryFileSchema>

export const MemoryExchangeParamsSchema = z.object({
  /** The driver's environment id. */
  from: z.string().min(1),
  /** The driver's host name, as a conflict copy of its content is named. */
  name: z.string().min(1).max(200).optional(),
  /** The driver's home directory: what the receiver's path translation maps from. */
  home: z.string().min(1).max(1024),
  /** The driver's work root (workRoot.ts), for the translation the other way. */
  workRoot: z.string().max(1024).optional(),
  generation: z.string().min(1).max(100),
  entries: z.array(MemoryEntrySchema).max(50_000),
  tombstones: z.array(MemoryTombstoneSchema).max(50_000)
})
export type MemoryExchangeParams = z.infer<typeof MemoryExchangeParamsSchema>

/** → what the driver sends, lands and deletes; the receiver's own files ride along. */
export interface MemoryExchangeAnswer {
  generation: string
  /** The receiver's host name. */
  name: string
  /** The receiver's home and work root: what the driver's translation maps from. */
  home: string
  workRoot?: string
  /** relPaths (the driver's spelling) the receiver wants. */
  pull: string[]
  /** The receiver's files the driver lands (the receiver's spelling; the driver translates). */
  push: MemoryFile[]
  /** relPaths (the driver's spelling) the driver deletes: the receiver's deletion won. */
  remove: string[]
  /** Entries the receiver refused (outside the set, a secret, a bad path); they never land. */
  refused: number
}

export const MemoryFilesParamsSchema = z.object({
  generation: z.string().min(1).max(100),
  files: z.array(MemoryFileSchema).max(MEMORY_FILES_PER_FRAME),
  /** The receiver's pushes the driver landed, with the hash of what landed there (translated), keyed by the receiver's relPath. */
  landed: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  /** The `remove` list the driver carried out. */
  removed: z.array(z.string().min(1).max(1024)).max(50_000).optional(),
  /** The last frame of the generation: the receiver lands everything and answers the totals. */
  done: z.boolean()
})
export type MemoryFilesParams = z.infer<typeof MemoryFilesParamsSchema>

export interface MemoryFilesAnswer {
  /** Files in the union after this round (the receiver's count). */
  files: number
  written: number
  deleted: number
  /** Conflict copies this round made on the receiver. */
  conflicts: number
  /** Files the receiver merged (MEMORY.md unions). */
  merged: number
  /** The receiver made files the driver should have now (a union result, a conflict copy): run one more round. */
  again: boolean
}

/** One saved environment, as the pane shows it. */
export interface MemoryEnvironmentStatus {
  id: string
  name: string
  connected: boolean
  running: boolean
  /** Files in the union after the last round, null before the first. */
  files: number | null
  syncedAt: number | null
  lastAttemptAt: number | null
  error: string | null
  /** Conflict copies the last round made, on either side. */
  conflicts: number
}

/** A conflict copy on this host's disk. */
export interface MemoryConflict {
  /** Absolute path here. */
  path: string
  /** The file it was kept beside, relative to HOME. */
  of: string
  /** The host whose copy lost. */
  host: string
  at: number
}

export interface MemorySyncStatus {
  enabled: boolean
  /** Files the walk left out (over 1 MiB, a symlink out of reach). */
  skipped: number
  environments: MemoryEnvironmentStatus[]
  /** Every conflict copy on this host, newest first. */
  conflicts: MemoryConflict[]
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const MemoryRequestSchemas = [
  request('memory.exchange', MemoryExchangeParamsSchema),
  request('memory.files', MemoryFilesParamsSchema),
  /** → MemorySyncStatus. */
  request('memory.status', z.object({}).optional()),
  /** → MemorySyncStatus once the sync (one host, or every one) finished. */
  request('memory.sync', z.object({ environmentId: z.string().optional() }).optional()),
  /** → MemorySyncStatus. */
  request('memory.settings.set', z.object({ enabled: z.boolean().optional() }))
] as const

/** The nudge a receiver (a host with no link of its own) pushes down a driver's link when a thread here went idle: the driver syncs. */
export interface MemoryNudgePush {
  push: 'memory.nudge'
  from: string
}
