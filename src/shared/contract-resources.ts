import { z } from 'zod'

// Thread-owned resources (docs/box.md "Thread resources"). A thread that
// creates a git worktree, a simulator or an isolated dev instance, on its
// own host or on the Mac through the bridge, gets a row in the ledger
// (`thread_resources`, src/main/server/threadResources.ts) naming where the
// resource lives and how to remove it. A subagent's resources are filed
// under its top-level thread. Archiving the thread may remove them; the
// panel in the thread header removes one at a time. Rows are only ever added
// and stamped (`remove_requested_at`, `removed_at`), never deleted, so a
// reader that joins on the table (the device row) sees history too.

export const THREAD_RESOURCE_KINDS = ['worktree', 'simulator', 'devInstance'] as const
export type ThreadResourceKind = (typeof THREAD_RESOURCE_KINDS)[number]

export interface ThreadResource {
  id: string
  /** The top-level thread that owns it (a subagent's resources are its parent's). */
  sessionId: string
  /** The host the resource lives on: this host's environment id, or the Mac's for a bridged call. */
  environmentId: string
  kind: ThreadResourceKind
  /** worktree: the absolute path; simulator: the UDID; devInstance: the userData dir. */
  identifier: string
  /** What a person recognises it by: the branch, the simulator's name, the dir's base name. */
  label: string
  /** worktree only: the branch the command created, deleted with it when it has no unpushed commits; null means none to delete. */
  branch: string | null
  createdAt: number
  /** Removal was asked for and has not landed (the host was offline; a link-up retries). */
  removeRequestedAt: number | null
  removedAt: number | null
  /** The last removal outcome, for the row: "branch kept: 2 unpushed commits", "Mac offline, waiting". */
  note: string | null
}

/** One row's answer to resources.remove. */
export interface ThreadResourceRemoval {
  id: string
  /** removed: gone from the host; waiting: the host is offline, the row waits; failed: the host refused (note says why). */
  outcome: 'removed' | 'waiting' | 'failed'
  note: string | null
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })
const id = z.string().min(1).max(200)

export const ResourcesRequestSchemas = [
  /** → { resources: ThreadResource[] }: the thread's rows, newest first; removed ones only with includeRemoved. */
  request('resources.list', z.object({ sessionId: id, includeRemoved: z.boolean().optional() })),
  /** → { resources: ThreadResource[] }: every live (unremoved) row on this host's ledger, any thread; a device list reads this. */
  request(
    'resources.listAll',
    z.object({ kind: z.enum(THREAD_RESOURCE_KINDS).optional(), environmentId: id.optional() }).optional()
  ),
  /** → { results: ThreadResourceRemoval[] }: remove the named rows (default: every live row of the thread) on their hosts. */
  request('resources.remove', z.object({ sessionId: id, ids: z.array(id).max(500).optional() }))
] as const

export type ResourcesPush = { push: 'resources'; sessionId: string; resources: ThreadResource[] }
