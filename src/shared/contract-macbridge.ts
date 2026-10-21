import { z } from 'zod'

// The Mac bridge (docs/box.md "The Mac bridge: what a box thread may touch
// on the Mac"). Threads run on the box; the user's files and macOS-only
// tools live on the Mac. The box cannot dial the Mac, so every call rides
// the peer link the Mac's main process already holds open to the box:
//
//  - `peer.register`, `peer.reply`, `peer.chunk` (admin) are what the Mac's
//    main process sends the box over that link. The box asks the Mac with a
//    `peer.call` push and the Mac answers by `peer.reply` (results over
//    PEER_CHUNK_CHARS arrive first as `peer.chunk` frames).
//  - `mac.*` (local) are the box threads' own tools, reached from the box's
//    loopback socket by the codex bridge and in-process by Claude; each call
//    carries the thread's token.
//  - `macBridge.thread.*` turn the bridge on for one box thread.
//  - `macBridge.decide`, `.pending`, `.policy.*`, `.shared.set` (local) are
//    the Mac's own renderer's: only the person at the Mac decides.

/** The offer a Mac makes in `peer.register`. */
export const MAC_BRIDGE_OFFER = 'mac-bridge'
/** Characters of a reply per `peer.chunk` frame; a reply longer than this is chunked. */
export const PEER_CHUNK_CHARS = 2 * 1024 * 1024
/** Chunks per reply, at most (a 64 MiB file as base64 inside JSON fits in 44). */
export const PEER_MAX_CHUNKS = 64

export const MAC_READ_DEFAULT_BYTES = 256 * 1024
export const MAC_READ_MAX_BYTES = 8 * 1024 * 1024
export const MAC_FETCH_MAX_BYTES = 64 * 1024 * 1024
export const MAC_LIST_MAX_ENTRIES = 2_000
export const MAC_RUN_DEFAULT_TIMEOUT_MS = 120_000
export const MAC_RUN_MAX_TIMEOUT_MS = 30 * 60_000
/** stdout and stderr together; past it the middle is dropped (MAC_RUN_HEAD_BYTES first, MAC_RUN_TAIL_BYTES last) and the result says truncated. */
export const MAC_RUN_OUTPUT_CAP = 4 * 1024 * 1024
/** How long a request waits on the person at the Mac before it counts as denied. */
export const MAC_APPROVAL_WAIT_MS = 10 * 60_000

// ── mac_run streaming (remote/peerStreams.ts, macRunLive.ts) ──────────
/** Past MAC_RUN_OUTPUT_CAP, the first this many bytes of output are kept… */
export const MAC_RUN_HEAD_BYTES = 1024 * 1024
/** …and the last this many; a marker line says how many bytes went between. */
export const MAC_RUN_TAIL_BYTES = MAC_RUN_OUTPUT_CAP - MAC_RUN_HEAD_BYTES
/** A running command's output leaves the Mac as `peer.progress` frames, at most one per this many ms… */
export const MAC_RUN_PROGRESS_MS = 100
/** …of at most this many bytes of whole lines (a backlog past it keeps its newest lines and counts the rest as skipped). */
export const MAC_RUN_PROGRESS_FRAME_BYTES = 64 * 1024
/** Characters a `peer.progress` chunk may carry (the frame's bytes, decoded, with room to spare). */
export const PEER_PROGRESS_MAX_CHARS = 2 * MAC_RUN_PROGRESS_FRAME_BYTES
/** On the box, the thread's mac_run row is redrawn with the output so far at most this often… */
export const MAC_RUN_LIVE_MS = 250
/** …showing its last this many bytes (under STREAMING_BODY_OMIT_BYTES, so a remote card grows too). */
export const MAC_RUN_LIVE_TAIL_BYTES = 24 * 1024

/**
 * The four tools' descriptions and params, shared by the Claude tools
 * (macTools.ts) and the codex bridge (scripts/app-mcp-bridge.mjs keeps a
 * copy; macTools.test.ts holds them equal).
 */
export const MAC_TOOL_DESCRIPTIONS = {
  mac_read_file:
    "Read a file on the user's Mac (this thread runs on a remote host; the Mac is where the user and their files are). Paths are absolute Mac paths. Folders the user shared with this host read at once; any other path waits for the user to allow it on the Mac, and may be denied.",
  mac_list_dir:
    "List a folder on the user's Mac: name, kind, size and modification time of each entry. Paths are absolute Mac paths. Folders the user shared read at once; others wait for the user's approval on the Mac.",
  mac_fetch_file:
    "Copy a file from the user's Mac onto this host and get back the local path it landed at (inside this thread's .temp-code/attachments folder). Use it for files you need to work on here (up to 64 MiB). The same approval rules as mac_read_file.",
  mac_run:
    "Run a command on the user's Mac (for macOS-only tools: xcodebuild, osascript, open, security, …). Every command waits for the user to allow it on the Mac, showing them exactly the argv and cwd, and may be denied. Runs through the Mac's login shell with no stdin; the output streams into this call's row while it runs and comes back whole up to 4 MiB (past that, the first 1 MiB and the last 3 MiB). Prefer argv; use command only when you need shell syntax (pipes, globs)."
} as const
export const MAC_TOOL_PARAMS = {
  path: 'Absolute path on the Mac, e.g. /Users/name/Documents/report.pdf (no ~).',
  maxBytes: 'Read at most this many bytes (default 262144, at most 8388608).',
  argv: 'The command and its arguments, run as given with no shell parsing, e.g. ["xcrun", "simctl", "list"].',
  command: "A shell command line instead of argv, read by the Mac's login shell.",
  cwd: 'Absolute working directory on the Mac (default: the home directory).',
  timeoutMs: 'Kill the command after this many milliseconds (default 120000, at most 1800000).'
} as const

export const MacBridgePolicySchema = z.enum(['off', 'read', 'read+run'])
export type MacBridgePolicy = z.infer<typeof MacBridgePolicySchema>

const pathArg = z.string().min(1).max(4096)

/** What a thread names, after its sessionId and token. */
export const MacReadFileArgsSchema = z.object({
  path: pathArg,
  maxBytes: z.number().int().min(1).max(MAC_READ_MAX_BYTES).optional()
})
export const MacListDirArgsSchema = z.object({ path: pathArg })
export const MacFetchFileArgsSchema = z.object({ path: pathArg })
export const MacRunArgsSchema = z.object({
  argv: z.array(z.string().max(32_768)).min(1).max(256).optional(),
  command: z.string().min(1).max(32_768).optional(),
  cwd: pathArg.optional(),
  timeoutMs: z.number().int().min(1_000).max(MAC_RUN_MAX_TIMEOUT_MS).optional()
})
export type MacReadFileArgs = z.infer<typeof MacReadFileArgsSchema>
export type MacListDirArgs = z.infer<typeof MacListDirArgsSchema>
export type MacFetchFileArgs = z.infer<typeof MacFetchFileArgsSchema>
export type MacRunArgs = z.infer<typeof MacRunArgsSchema>

export const MAC_METHODS = ['mac.readFile', 'mac.listDir', 'mac.fetchFile', 'mac.run'] as const
export type MacMethod = (typeof MAC_METHODS)[number]

/** The thread a box names in a `peer.call`; the Mac shows it on the card and keys its remember rules by it. */
export interface MacCallThread {
  id: string
  title: string
}

/** `peer.call` params for a mac.* method: the args plus the calling thread. */
export type MacCallParams = {
  thread: MacCallThread
  args: MacReadFileArgs | MacListDirArgs | MacFetchFileArgs | MacRunArgs
}

export interface MacReadFileResult {
  path: string
  size: number
  /** Bytes returned (≤ maxBytes). */
  bytes: number
  truncated: boolean
  /** utf8 when the bytes decode as text, else base64. */
  encoding: 'utf8' | 'base64'
  content: string
}
export interface MacDirEntry {
  name: string
  kind: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtime: number
}
export interface MacListDirResult {
  path: string
  entries: MacDirEntry[]
  truncated: boolean
}
/** The Mac's answer to mac.fetchFile; the box writes it into the landing dir. */
export interface MacFetchFileWire {
  name: string
  size: number
  mtime: number
  dataBase64: string
}
/** What the thread gets back from mac.fetchFile. */
export interface MacFetchFileResult {
  /** Where the file landed on the box. */
  path: string
  size: number
  macPath: string
}
export interface MacRunResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** Output passed MAC_RUN_OUTPUT_CAP: the middle was dropped (droppedBytes) and a marker line stands in for it. */
  truncated: boolean
  timedOut: boolean
  durationMs: number
  /** Bytes of output dropped from the middle, when truncated. */
  droppedBytes?: number
}

/** One request waiting on the person at the Mac (or a command it allowed, still running). */
export interface MacBridgeRequest {
  id: string
  /** The box's environment id and saved name. */
  environmentId: string
  hostName: string
  sessionId: string
  threadTitle: string
  kind: 'read' | 'run'
  method: MacMethod
  /** read: the real path asked for. */
  path?: string
  /** read: the folder "allow this folder for this thread" would admit; absent when it would be home or '/'. */
  folder?: string
  argv?: string[]
  command?: string
  cwd?: string
  timeoutMs?: number
  createdAt: number
  expiresAt: number
  status: 'pending' | 'running'
}

export type MacBridgeOutcome = 'allowed' | 'denied' | 'expired' | 'stopped' | 'done'

/** One saved host, as Settings → Remote access shows its bridge row. */
export interface MacBridgeHostPolicy {
  environmentId: string
  name: string
  policy: MacBridgePolicy
  shared: string[]
  /** Whether that host has this Mac registered right now (the link is up and it took the offer). */
  registered: boolean
}

/** A box thread's bridge state, as its header shows it. */
export interface MacBridgeThreadState {
  sessionId: string
  /** The Mac the thread may reach, or null for off. Set on the thread or on an ancestor. */
  macPeer: string | null
  /** Set on an ancestor rather than this thread. */
  inherited: boolean
  /** A Mac with a live link to this host has registered under macPeer. */
  online: boolean
  /** The environment ids of the Macs registered right now. */
  registered: string[]
}

export type MacBridgePush =
  | {
      push: 'peer.call'
      callId: string
      method: MacMethod
      params: MacCallParams
      deadlineMs: number
    }
  | { push: 'macBridge.request'; request: MacBridgeRequest }
  | { push: 'macBridge.resolved'; id: string; outcome: MacBridgeOutcome }

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

const threadAuth = { sessionId: z.string().min(1).max(200), token: z.string().min(1).max(200) }
const envId = z.string().min(1).max(200)
/** mac.run only: the thread's tool-call row the live output belongs to, when the caller knows it. */
const macRunCallRef = { callId: z.string().min(1).max(200).optional() }

export const MacBridgeRequestSchemas = [
  // ── the Mac's main process → the box, over the peer link (admin) ──────
  /** → { environmentId } of the box. */
  request('peer.register', z.object({ from: envId, offers: z.array(z.string().max(64)).max(16) })),
  request(
    'peer.reply',
    z.object({
      callId: z.string().min(1).max(100),
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z.string().max(4_000).optional(),
      /** The result arrived as this many `peer.chunk` frames (its JSON, split). */
      chunks: z.number().int().min(1).max(PEER_MAX_CHUNKS).optional()
    })
  ),
  request(
    'peer.chunk',
    z.object({
      callId: z.string().min(1).max(100),
      index: z
        .number()
        .int()
        .min(0)
        .max(PEER_MAX_CHUNKS - 1),
      data: z.string().max(PEER_CHUNK_CHARS)
    })
  ),
  /** A running call's output so far, in order by seq (mac.run); the box takes it only from the call's socket. */
  request(
    'peer.progress',
    z.object({
      callId: z.string().min(1).max(100),
      seq: z.number().int().min(0),
      chunk: z.string().max(PEER_PROGRESS_MAX_CHARS),
      /** Bytes of output the Mac left out of the live view before this chunk (the full output still comes in the reply). */
      skipped: z.number().int().min(0).optional()
    })
  ),
  // ── a box thread's tools (local; the token is the thread's own) ──────
  request('mac.readFile', MacReadFileArgsSchema.extend(threadAuth)),
  request('mac.listDir', MacListDirArgsSchema.extend(threadAuth)),
  request('mac.fetchFile', MacFetchFileArgsSchema.extend(threadAuth)),
  request('mac.run', MacRunArgsSchema.extend(threadAuth).extend(macRunCallRef)),
  // ── a box thread's switch ────────────────────────────────────────────
  /** → MacBridgeThreadState. */
  request('macBridge.thread.get', z.object({ sessionId: z.string().min(1).max(200) })),
  /** → MacBridgeThreadState. null turns it off. */
  request(
    'macBridge.thread.set',
    z.object({ sessionId: z.string().min(1).max(200), macPeer: envId.nullable() })
  ),
  // ── the Mac's own renderer (local) ───────────────────────────────────
  /** → MacBridgeRequest[]. */
  request('macBridge.pending', z.object({}).optional()),
  /** allow false on a running command stops it. remember: the folder (read) or the exact command (run), for this thread. */
  request(
    'macBridge.decide',
    z.object({
      id: z.string().min(1).max(100),
      allow: z.boolean(),
      remember: z.boolean().optional()
    })
  ),
  /** → MacBridgeHostPolicy[], one per saved host. */
  request('macBridge.policy.get', z.object({}).optional()),
  /** → MacBridgeHostPolicy[]. */
  request(
    'macBridge.policy.set',
    z.object({ environmentId: envId, policy: MacBridgePolicySchema })
  ),
  /** → MacBridgeHostPolicy[]. Absolute dirs; never '/', never the home directory. */
  request(
    'macBridge.shared.set',
    z.object({ environmentId: envId, folders: z.array(pathArg).max(64) })
  )
] as const
