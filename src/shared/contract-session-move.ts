import { z } from 'zod'
import { ProjectLinkFactsSchema } from './projectLinks'

// Moving one thread between hosts (docs/box.md "Moving a thread between
// hosts"). Only the desktop's own server starts a move (`session.move`,
// local): it pushes a thread it holds to a peer (`session.import.*` there)
// or pulls one a peer holds (`session.export.*` there) over the admin peer
// link (remote/peers.ts). The thread and its subagents cross as one bundle:
// the sessions rows, every event row (hot and cold), the folds, the agent's
// HTML pages and the harness's native transcript. Checkpoints stay behind:
// they are baselines of the source host's tree. These methods take ids,
// never caller paths: the receiver remaps the sender's paths itself.

/** JSON bytes of event rows per part frame (a single larger row travels alone). */
export const SESSION_MOVE_PART_BYTES = 2 * 1024 * 1024
/** Raw bytes per file chunk; base64 in the frame. */
export const SESSION_MOVE_FILE_CHUNK = 2 * 1024 * 1024
const MAX_CHUNK_B64 = Math.ceil((SESSION_MOVE_FILE_CHUNK + 3) / 3) * 4 + 16
const SHA = z.string().regex(/^[0-9a-f]{64}$/)
const COMMIT = z.string().regex(/^[0-9a-f]{40}$/)
const ID = z.string().min(1).max(200)

// ── the branch travels with the thread ────────────────────────────────────
// Before the session parts go, the source finds the thread's working branch
// (sessionMoveBranch.ts): the cwd's checked-out branch, whether the cwd is a
// worktree of the project, and its uncommitted changes. The commits reach the
// receiver through `origin` when the repo has one and the push lands, else
// as a `git bundle` over the link; the uncommitted changes always cross as a
// patch (tracked changes plus untracked files, `--binary`), and the source
// keeps everything it has. The receiver checks the branch out at the same
// commit (a worktree under <project>/.claude/worktrees/<branch>, or the
// project itself when the source was on it directly and the project here is
// clean on its default branch) and applies the patch with `git apply --3way`;
// a patch that does not apply is kept at <cwd>/.temp-code/moved-changes.patch
// and the thread gets one system row.

/** Raw bytes per branch blob chunk; base64 in the frame. */
export const SESSION_MOVE_BLOB_CHUNK = SESSION_MOVE_FILE_CHUNK
/** A patch past this many bytes does not travel; the toast says so. */
export const SESSION_MOVE_PATCH_CAP = 64 * 1024 * 1024
/** A bundle past this many bytes does not travel (push to origin, or commit less). */
export const SESSION_MOVE_BUNDLE_CAP = 512 * 1024 * 1024

export const SessionMoveBlobSchema = z.object({ size: z.number().int().min(0), sha256: SHA, chunks: z.number().int().min(1) })
export type SessionMoveBlob = z.infer<typeof SessionMoveBlobSchema>

/** The branch as the source found it, in the manifest (`branch: null` when the cwd is not a git checkout). */
export const SessionMoveBranchSchema = z.object({
  /** The checked-out branch; null when HEAD is detached (the commit still travels). */
  branch: z.string().min(1).max(255).nullable(),
  head: COMMIT,
  /** The repo's default branch as the source sees it (origin/HEAD, else main or master). */
  defaultBranch: z.string().min(1).max(255).nullable(),
  /** The thread's cwd is a linked worktree of the project (else the project checkout itself). */
  worktree: z.boolean(),
  /** The main checkout the cwd belongs to, on the source (the receiver maps it to find its repo). */
  mainCheckout: z.string().min(1).max(1024),
  /** 'origin': pushed; the receiver fetches. 'bundle': the commits cross over the link after the receiver names what it has. 'none': nothing to carry (the receiver already holds the commit, or there is no branch). */
  transport: z.enum(['origin', 'bundle', 'none']),
  /** Why the push to origin did not happen or did not land (shown, never fatal). */
  pushError: z.string().max(400).nullable(),
  /** The uncommitted changes that travel as a patch: paths, capped. */
  dirty: z.array(z.string()).max(500),
  dirtyMore: z.number().int().min(0),
  /** The patch, when there are uncommitted changes and they fit under the cap. */
  patch: SessionMoveBlobSchema.nullable(),
  /** Changes left behind because the patch was over the cap. */
  patchSkipped: z.string().max(400).nullable()
})
export type SessionMoveBranch = z.infer<typeof SessionMoveBranchSchema>

/** What the receiver decided for the branch when the move began. */
export const SessionMoveBranchPlanSchema = z.object({
  /** 'checkout': the branch goes into the project itself. 'worktree': a worktree at `cwd`. 'reuse': `cwd` already has the branch checked out here. */
  mode: z.enum(['checkout', 'worktree', 'reuse']),
  cwd: z.string().min(1).max(1024),
  /** The project checkout the branch lands in or under. */
  project: z.string().min(1).max(1024),
  /** Commits this host already holds (the default branch's tip, the branch's own when it exists): a bundle leaves them out. */
  have: z.array(COMMIT).max(16),
  /** Why the thread lands in a worktree although the source was on the branch directly. */
  why: z.string().max(400).nullable()
})
export type SessionMoveBranchPlan = z.infer<typeof SessionMoveBranchPlanSchema>

/** One chunk of a branch blob (the bundle or the patch), whole-blob hash on every frame. */
export const SessionMoveBlobFrameSchema = z.object({
  moveId: ID,
  blob: z.enum(['bundle', 'patch']),
  chunk: z.number().int().min(0),
  chunks: z.number().int().min(1),
  size: z.number().int().min(0),
  sha256: SHA,
  dataBase64: z.string().max(MAX_CHUNK_B64)
})
export type SessionMoveBlobFrame = z.infer<typeof SessionMoveBlobFrameSchema>

/** Where the branch landed, as the receiver reports it after the branch step. */
export interface SessionMoveBranchLanding {
  branch: string | null
  head: string
  mode: 'checkout' | 'worktree' | 'reuse' | 'detached'
  cwd: string
  /** The worktree was made by this move (an abort removes it). */
  created: boolean
  /** 'applied': the patch is in the tree. 'kept': it did not apply and sits at `patchPath`. 'none': there was no patch. */
  patch: 'applied' | 'kept' | 'none'
  patchPath: string | null
  /** Something to tell: the branch here had other commits, the project was busy, and so on. */
  note: string | null
}

export const SessionMoveFileSchema = z.object({
  /** html: <userData>/html-renders/<sessionId>/<rel>; claude: <claude config>/projects/<slug(cwd)>/<rel>; codex: <codex home>/sessions/<rel>. */
  kind: z.enum(['html', 'claude', 'codex']),
  sessionId: ID,
  rel: z.string().min(1).max(1024),
  size: z.number().int().min(0),
  sha256: SHA
})
export type SessionMoveFile = z.infer<typeof SessionMoveFileSchema>

/** A sessions-table row as the sender stores it: column → value. */
const RowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]))

export const SessionMoveManifestSchema = z.object({
  moveId: ID,
  /** The sender's environment id and the destination's. */
  from: ID,
  to: ID,
  /** The sender's home and work root: what the receiver's path map translates from. */
  home: z.string().min(1).max(1024),
  workRoot: z.string().min(1).max(1024),
  rootId: ID,
  /** The root first, then its subagents (parent before child). */
  sessions: z.array(RowSchema).min(1).max(5_000),
  folds: z.array(RowSchema).max(5_000),
  /** The source project and workspace, for resolving their counterparts by path. */
  project: z.object({ id: ID, cwd: z.string(), workspaceId: z.string() }).nullable(),
  workspace: z.object({ id: ID, path: z.string(), name: z.string() }).nullable(),
  /** The source project's link facts: the receiver lands the thread in its linked copy (project.ensureLinked), never by folder alone. */
  projectLink: ProjectLinkFactsSchema.nullable().optional(),
  /** Event rows per session id. */
  events: z.record(z.string(), z.number().int().min(0)),
  files: z.array(SessionMoveFileSchema).max(100_000),
  /** Sessions whose native transcript the sender did not find: they land with no native id. */
  transcriptMissing: z.array(ID),
  parts: z.number().int().min(0),
  /** `git status --porcelain` of the source cwd (paths only, capped): changes that did NOT cross. */
  dirty: z.array(z.string()).max(500),
  dirtyMore: z.number().int().min(0),
  /** Undo checkpoints exist on the source for this subtree (they stay there). */
  checkpoints: z.boolean(),
  /** The working branch and its uncommitted changes (they travel); absent from an older sender, null when the cwd is not a git checkout. */
  branch: SessionMoveBranchSchema.nullish()
})
export type SessionMoveManifest = z.infer<typeof SessionMoveManifestSchema>

export const SessionMoveEventRowSchema = z.object({ seq: z.number().int(), ts: z.number(), payload: z.string() })

export const SessionMovePartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('events'), sessionId: ID, rows: z.array(SessionMoveEventRowSchema).max(1_000_000) }),
  z.object({
    kind: z.literal('file'),
    file: z.number().int().min(0),
    chunk: z.number().int().min(0),
    chunks: z.number().int().min(1),
    dataBase64: z.string().max(MAX_CHUNK_B64)
  })
])
export type SessionMovePart = z.infer<typeof SessionMovePartSchema>

/** One part, with the running digest of the bundle through it. */
export const SessionMoveFrameSchema = z.object({
  moveId: ID,
  index: z.number().int().min(0),
  sha: SHA,
  part: SessionMovePartSchema
})
export type SessionMoveFrame = z.infer<typeof SessionMoveFrameSchema>

/** Where a thread sits on one host, as the settle pass reads it. */
export type SessionMoveRowState =
  | { id: string; state: 'absent' }
  | { id: string; state: 'live' }
  /** Frozen on this host while it crosses to `peer`. */
  | { id: string; state: 'exporting'; peer: string; moveId: string | null }
  /** Landed here provisionally from `peer`, hidden until claimed. */
  | { id: string; state: 'provisional'; peer: string; moveId: string | null }
  /** Moved to `peer`; only the row is left. */
  | { id: string; state: 'tombstone'; peer: string }

/** What the receiver resolved on begin. */
export interface SessionImportBeginAnswer {
  cwd: string
  workspaceId: string
  projectId: string | null
  /** Where the branch will land; null when the manifest carried no branch or the receiver has no repo there. */
  branchPlan: SessionMoveBranchPlan | null
}

/** What `session.export.branch.begin` answers: the blobs the puller fetches with `session.export.branch.chunk`. */
export interface SessionExportBranchAnswer {
  transport: 'origin' | 'bundle' | 'none'
  bundle: SessionMoveBlob | null
  patch: SessionMoveBlob | null
  pushError: string | null
}

/** What `session.move.preview` answers: what the move confirm says about the branch. */
export interface SessionMovePreview {
  /** null: the cwd is not a git checkout. */
  branch: string | null
  detached: boolean
  worktree: boolean
  /** Uncommitted files (tracked changes plus untracked) that would travel. */
  dirty: number
  origin: boolean
}

/** What `session.move` answers once the destination owns the thread. */
export interface SessionMoveResult {
  sessionId: string
  sessionIds: string[]
  from: string
  to: string
  /** The thread's cwd on the destination. */
  cwd: string
  events: number
  files: number
  /** 'moved': the harness transcript crossed; 'missing': it was not found, the thread replays its dialogue on the next send; 'none': nothing to carry. */
  transcript: 'moved' | 'missing' | 'none'
  /** Uncommitted changes in the source cwd: they travelled as a patch (see `branch`), or stayed when there was no branch to carry. */
  dirty: string[]
  dirtyMore: number
  /** Undo history stayed on the source host. */
  checkpointsStayed: boolean
  /** The branch step: what the source found and where it landed; null when the cwd was not a git checkout. */
  branch: (SessionMoveBranch & { landing: SessionMoveBranchLanding }) | null
  /** The settle that finishes the move did not reach the destination yet; the next link-up does it. */
  pendingRelease?: boolean
}

const request = <M extends string, P extends z.ZodType>(
  method: M,
  params: P
): z.ZodObject<{ id: z.ZodString; method: z.ZodLiteral<M>; params: P }> => z.object({ id: z.string(), method: z.literal(method), params })

export const SessionMoveRequestSchemas = [
  /** The desktop's own server: move a thread from `from` (default this host) to `to`. → SessionMoveResult. */
  request('session.move', z.object({ sessionId: ID, to: ID, from: ID.optional() })),
  /** Peer RPCs, admin. The receiver of a push. → SessionImportBeginAnswer. */
  request('session.import.begin', z.object({ manifest: SessionMoveManifestSchema })),
  request('session.import.part', SessionMoveFrameSchema),
  /** → { digest }: the receiver's own digest of what it holds; the rows stay provisional. */
  /** After begin, before any part: the branch's blobs, then the step that fetches, checks out and applies. → SessionMoveBranchLanding. */
  request('session.import.branch.chunk', SessionMoveBlobFrameSchema),
  request('session.import.branch.commit', z.object({ moveId: ID, transport: z.enum(['origin', 'bundle', 'none']), bundle: SessionMoveBlobSchema.nullable(), patch: SessionMoveBlobSchema.nullable() })),
  request('session.import.commit', z.object({ moveId: ID, digest: SHA })),
  /** The sender stripped its copy: the landing becomes the thread. */
  request('session.import.release', z.object({ moveId: ID.optional(), sessionId: ID })),
  request('session.import.abort', z.object({ moveId: ID.optional(), sessionId: ID.optional() })),
  /** The source of a pull. → SessionMoveManifest (the thread is frozen here from now). */
  request('session.export.begin', z.object({ sessionId: ID, moveId: ID, to: ID })),
  /** The puller names the commits it holds; the source makes the bundle (when it needs one). → SessionExportBranchAnswer. */
  request('session.export.branch.begin', z.object({ moveId: ID, have: z.array(COMMIT).max(16) })),
  /** → SessionMoveBlobFrame. */
  request('session.export.branch.chunk', z.object({ moveId: ID, blob: z.enum(['bundle', 'patch']), chunk: z.number().int().min(0) })),
  /** → SessionMoveFrame. Parts go in order. */
  request('session.export.part', z.object({ moveId: ID, index: z.number().int().min(0) })),
  /** The caller holds it all and echoes the digest: this host keeps a tombstone. → { digest }. */
  request('session.export.commit', z.object({ moveId: ID, digest: SHA })),
  request('session.export.abort', z.object({ moveId: ID.optional(), sessionId: ID.optional() })),
  /** → { rows: SessionMoveRowState[] }: the asked ids, plus every row here moving to or from `environmentId`. */
  request('session.move.status', z.object({ environmentId: ID, ids: z.array(ID).max(10_000) })),
  /** What the move confirm says about the branch. The desktop answers for its own threads and asks the thread's host for the others. → SessionMovePreview. */
  request('session.move.preview', z.object({ sessionId: ID, from: ID.optional() }))
] as const
