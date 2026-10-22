/**
 * The launch mirror's wire between renderer and main process (preload
 * `launch-mirror:read` / `launch-mirror:write`; the store is
 * src/main/server/launchMirror.ts). Summaries only, never transcript rows.
 */

/** The renderer's summary of one thread: a SessionMeta without its
 *  transient fields. The main process reads only these three keys. */
export type MirrorSummary = { id: string; archived: boolean; updatedAt: number } & Record<string, unknown>

/** Where a host's list stood when the mirror was written: what
 *  `session.changes` resumes from (src/main/server/listChanges.ts). */
export type MirrorCursor = { seq: number; generation: string }

export type MirrorHost = {
  environmentId: string
  cursor: MirrorCursor | null
  workspaces: unknown[]
  projects: unknown[]
  sessions: MirrorSummary[]
  writtenAt: number
}

/** One coalesced write from the renderer. `full` means the upserts are the
 *  host's whole list: every other summary of that host leaves. A field left
 *  out is left alone. */
export type MirrorWrite = {
  environmentId: string
  full?: boolean
  upserts?: MirrorSummary[]
  removed?: string[]
  cursor?: MirrorCursor | null
  workspaces?: unknown[]
  projects?: unknown[]
}

/** A saved remote host as the renderer's registry needs it at boot. */
export type MirrorEnvironment = {
  id: string
  name: string
  routes: { url: string; kind: 'loopback' | 'lan' | 'tunnel' }[]
  keyId?: string
  /** The host's platform from its last hello, for the host glyph. */
  platform?: string
}

/** The boot answer: the hosts to register and what each one last showed. */
export type LaunchMirrorSnapshot = {
  environments: MirrorEnvironment[]
  hosts: MirrorHost[]
}
