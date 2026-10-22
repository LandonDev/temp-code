import { z } from 'zod'
import { MacDecideRememberSchema, type MacRunRememberOffer } from './contract-macbridge-rules'
import type { PublishCallParams } from './contract-publish'
import { MAC_RUN_BACKGROUND, type MacPeerMethod } from './contract-macjobs'
import type { CrossHostCallParams } from './contract-crosshost'
import type { HostDevicesCallParams } from './contract-hostdevices'

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

// ── the load guard (remote/macLoadGuard.ts) ───────────────────────────
/** Concurrent commands and jobs one host may run on the Mac, unless `macBridge.maxRunning.<envId>` says otherwise. */
export const MAC_BRIDGE_DEFAULT_MAX_RUNNING = 4
/** Concurrent Mac-local threads one host may have started here, unless `macBridge.maxThreads.<envId>` says otherwise. */
export const MAC_BRIDGE_DEFAULT_MAX_THREADS = 2
/** The one-minute load above which new commands and jobs are held: this many times the cores, unless `macBridge.loadLimit` is set. */
export const MAC_LOAD_LIMIT_PER_CORE = 2
/** Held calls resume once the load is under this fraction of the limit (1.5 × cores by default). */
export const MAC_LOAD_RESUME_FRACTION = 0.75
/** How often the Mac samples os.loadavg()[0]. */
export const MAC_LOAD_SAMPLE_MS = 15_000
export const MAC_BRIDGE_MAX_RUNNING_CAP = 64
export const MAC_BRIDGE_MAX_THREADS_CAP = 32

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
    "Read a file on the user's Mac (this thread runs on a remote host; the Mac is where the user and their files are). Paths are absolute Mac paths, or start with ~ for the Mac's home. Folders the user shared with this host read at once (with full access, any path but keys and credentials); any other path waits for the user to allow it on the Mac, and may be denied.",
  mac_list_dir:
    "List a folder on the user's Mac: name, kind, size and modification time of each entry. Paths are absolute Mac paths, or start with ~ for the Mac's home. Folders the user shared read at once (with full access, any path but keys and credentials); others wait for the user's approval on the Mac.",
  mac_fetch_file:
    "Copy a file from the user's Mac onto this host and get back the local path it landed at (inside this thread's .temp-code/attachments folder). Use it for files you need to work on here (up to 64 MiB). The same approval rules as mac_read_file.",
  mac_run:
    "Run a command on the user's Mac (for macOS-only tools: xcodebuild, osascript, open, security, …). Every command waits for the user to allow it on the Mac, showing them exactly the argv and cwd, and may be denied. Runs through the Mac's login shell with no stdin; the output streams into this call's row while it runs and comes back whole up to 4 MiB (past that, the first 1 MiB and the last 3 MiB). Prefer argv; use command only when you need shell syntax (pipes, globs).",
  mac_write_file:
    "Write a file on the user's Mac (up to 8 MiB). Give the contents as text (a UTF-8 string, for source, config and other text files) or as dataBase64 (any bytes), exactly one of them. Paths are absolute Mac paths. mode create (the default) refuses a file that exists, overwrite replaces it atomically, append adds to its end. Folders the user shared with this host take writes at once when the user allows commands too; any other path, anything under ~/Library and the dotfiles in the Mac's home wait for the user to allow it on the Mac, and may be denied."
} as const
export const MAC_TOOL_PARAMS = {
  path: "Absolute path on the Mac, or ~/… for the Mac's home, e.g. ~/Documents/report.pdf.",
  maxBytes: 'Read at most this many bytes (default 262144, at most 8388608).',
  argv: 'The command and its arguments, run as given with no shell parsing, e.g. ["xcrun", "simctl", "list"].',
  command: "A shell command line instead of argv, read by the Mac's login shell.",
  cwd: "Absolute working directory on the Mac, or ~/… (default: the Mac's home directory).",
  timeoutMs: 'Kill the command after this many milliseconds (default 120000, at most 1800000).',
  dataBase64: "The file's bytes, base64-encoded (at most 8 MiB decoded). Give this or text, not both.",
  text: "The file's contents as a UTF-8 string (at most 8 MiB once encoded). Give this or dataBase64, not both.",
  mode: 'create (default: fails if the file exists), overwrite, or append.',
  fileMode:
    'Unix permission bits as a decimal number, e.g. 420 for 0644 (default: 0644 for a new file, unchanged for an existing one).'
} as const

/** A Mac's home as `peer.register` carries it: absolute, one line. */
export const MacHomeSchema = z
  .string()
  .min(2)
  .max(1024)
  // eslint-disable-next-line no-control-regex -- the home lands in tool text: no control characters
  .regex(/^\/[^\u0000-\u001f\u007f]*$/)

/**
 * The four tools' descriptions for one thread: the shared text plus, when
 * the box has heard the Mac's home in `peer.register`, a sentence naming it,
 * so a thread never guesses the Mac's user name. scripts/app-mcp-bridge.mjs
 * keeps a copy (macTools.test.ts holds them equal, with and without a home).
 */
export function macToolDescriptions(
  home?: string | null
): Record<keyof typeof MAC_TOOL_DESCRIPTIONS, string> {
  const note = home ? ` The Mac's home is ${home} (~ means it: ~/Desktop is ${home}/Desktop).` : ''
  return {
    mac_read_file: MAC_TOOL_DESCRIPTIONS.mac_read_file + note,
    mac_list_dir: MAC_TOOL_DESCRIPTIONS.mac_list_dir + note,
    mac_fetch_file: MAC_TOOL_DESCRIPTIONS.mac_fetch_file + note,
    mac_run: MAC_TOOL_DESCRIPTIONS.mac_run + note,
    mac_write_file: MAC_TOOL_DESCRIPTIONS.mac_write_file + note
  }
}

/**
 * Per host: off | read (managed roots, shared folders, else ask) | read+run
 * (and commands, every one asked) | full (reads anywhere on the Mac without
 * asking except keys and credentials, macBridge.ts macDenied; commands as
 * read+run).
 */
export const MacBridgePolicySchema = z.enum(['off', 'read', 'read+run', 'full'])
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

export const MAC_METHODS = [
  'mac.readFile',
  'mac.listDir',
  'mac.fetchFile',
  'mac.run',
  'mac.writeFile'
] as const
export type MacMethod = (typeof MAC_METHODS)[number]

/** The thread a box names in a `peer.call`; the Mac shows it on the card and keys its remember rules by it. */
export interface MacCallThread {
  id: string
  title: string
  /** The thread's permission mode on its box (`safe` | `edits` | `auto`); absent from an older box. */
  permission?: string
  /**
   * The thread is paused on its box (macPause.ts): only reads reach the Mac
   * while it is, and one the Mac would have to ask about is refused instead
   * ("refused: the thread is paused"); commands, jobs and writes wait on the
   * box and never carry this.
   */
  paused?: true
}

/** A thread in full access on its box (`auto`) is never prompted on the Mac: the
 *  per-box policy still says what kind of call may happen, but every call it
 *  admits goes through as if remembered (a command shows on the Mac only when
 *  the host's "Show running commands" is on; macBridge.ts runPresentation). */
export function threadRunsUnattended(thread: Pick<MacCallThread, "permission">): boolean {
  return thread.permission === "auto"
}

/** `peer.call` params for a mac.* method: the args plus the calling thread. */
export type MacCallParams = {
  thread: MacCallThread
  args:
    | MacReadFileArgs
    | MacListDirArgs
    | MacFetchFileArgs
    | MacRunArgs
    | MacWriteFileWire
    | MacCancelArgs
    | MacHeldArgs
}

// ── pause (the box's macPause.ts; the Mac's macBridge.ts cancel/held) ────

/**
 * The box's `mac.cancel`: the thread paused or stopped, so every call of its
 * still open on the Mac (by `peer.call` id) gets what the Stop button sends
 * (a pending one is denied, a running one is killed), and with `jobs` its
 * interactive jobs end as well. The box has already answered those calls
 * "cancelled: the thread was paused"; the Mac's late reply is dropped.
 */
export interface MacCancelArgs {
  callIds: string[]
  /** End the thread's interactive jobs too (macJobs.ts endThread 'stopped'). */
  jobs?: boolean
  reason: 'paused' | 'stopped'
}
/** One call a paused thread holds on its box: shown on the Mac as a `paused` row, nothing runs for it. */
export interface MacHeldCall {
  /** The hold's own id on the box; the Mac's row for it is `mb_held_<id>`. */
  id: string
  method: MacMethod | 'mac.jobStart'
  argv?: string[]
  command?: string
  cwd?: string
  path?: string
  bytes?: number
  /** When the box put it on hold. */
  since: number
}
/** The box's `mac.held`: the whole set a thread holds right now (an empty list clears its rows). */
export interface MacHeldArgs {
  held: MacHeldCall[]
}
/** `mac.cancel` → { cancelled, jobsEnded }. */
export interface MacCancelResult {
  cancelled: number
  jobsEnded: number
}
/** The box's push to its own clients: how many Mac calls a thread's tree holds while paused (0 clears). */
export type MacHeldPush = { push: 'macBridge.held'; sessionId: string; held: number }

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
/** A run also carries what its card may remember beyond exact and thread (contract-macbridge-rules.ts). */
export interface MacBridgeRequest extends MacRunRememberOffer {
  id: string
  /** The box's environment id and saved name. */
  environmentId: string
  hostName: string
  sessionId: string
  threadTitle: string
  kind: 'read' | 'run' | 'write'
  method: MacMethod
  /** read: the real path asked for. */
  path?: string
  /** read: the folder "allow this folder for this thread" would admit; absent when it would be home or '/'. */
  folder?: string
  argv?: string[]
  command?: string
  cwd?: string
  timeoutMs?: number
  /** write: the bytes it would write, how, and whether it makes the missing folders above the file. */
  bytes?: number
  writeMode?: MacWriteMode
  createsFolders?: boolean
  createdAt: number
  expiresAt: number
  /**
   * pending: waits on the person. held: allowed, waiting its turn on the load
   * guard (`held` says why). running: started. paused: a call its thread
   * holds on the box while paused (mac.held); it waits there, nothing to stop here.
   */
  status: 'pending' | 'held' | 'running' | 'paused'
  /** While status is held: its place and the figure that holds it (remote/macLoadGuard.ts). */
  held?: MacBridgeHeld
  /** run: an interactive job (mac.run background: true; remote/macJobs.ts): stdin open, no timeout but the idle one. */
  interactive?: true
  /**
   * Admitted without a prompt and not shown: the renderer draws no card for
   * it (MacBridgeCards). It still counts, with Stop, in Settings → Remote
   * access → Mac bridge. Set when the host's "Show running commands" is off
   * (macBridge.ts runPresentation); never on a request that waits.
   */
  quiet?: true
}

export type MacBridgeOutcome = 'allowed' | 'denied' | 'expired' | 'stopped' | 'done'

/**
 * Why an allowed command or job waits on the Mac before it starts (the load
 * guard, remote/macLoadGuard.ts): the host is at its cap of concurrent
 * commands and jobs, or the Mac's one-minute load is over the limit. The
 * renderer draws it as "Waiting for the Mac · load 12.3 of 8 · 3rd in line".
 */
export interface MacBridgeHeld {
  reason: 'cap' | 'load'
  /** 1-based place in the host's queue; held calls start in order. */
  position: number
  /** The Mac's one-minute load average at the last sample, its limit and its cores. */
  load: number
  limit: number
  cores: number
  /** The host's cap on concurrent commands and jobs, and how many run now. */
  maxRunning: number
  running: number
}

/** 1 → 1st, 2 → 2nd, 3 → 3rd, 11 → 11th, 22 → 22nd. */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  const one = n % 10
  return `${n}${one === 1 ? 'st' : one === 2 ? 'nd' : one === 3 ? 'rd' : 'th'}`
}

/** What a held row says, on the Mac and in the log: "Waiting for the Mac · load 12.3 of 8 · 3rd in line". */
export function heldLine(held: MacBridgeHeld): string {
  const why =
    held.reason === 'load'
      ? `load ${held.load.toFixed(1)} of ${trimNumber(held.limit)}`
      : `${held.running} of ${held.maxRunning} running`
  return `Waiting for the Mac · ${why} · ${ordinal(held.position)} in line`
}

/** 16 → "16", 4.5 → "4.5". */
export const trimNumber = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** The Mac's load as the guard last sampled it (`macBridge.load.get`). */
export interface MacBridgeLoad {
  load: number
  cores: number
  /** `macBridge.loadLimit`, else MAC_LOAD_LIMIT_PER_CORE × cores. */
  limit: number
  /** The limit was set by hand (else it follows the cores). */
  pinned: boolean
  /** Held calls resume once the load is under this. */
  resumeBelow: number
  /** New commands and jobs are being held for load right now. */
  busy: boolean
  sampledAt: number
}

/** Whether another Mac-local thread from a host may start here now (`macBridge.admitThread`, crossHostThreads.ts asks before every start). */
export interface MacBridgeThreadAdmission {
  ok: boolean
  /** Threads that host started here and that are live now. */
  live: number
  max: number
  /** When not ok: the sentence the box thread's tool result carries. */
  reason?: string
}

/** One saved host, as Settings → Remote access shows its bridge row. */
export interface MacBridgeHostPolicy {
  environmentId: string
  name: string
  policy: MacBridgePolicy
  shared: string[]
  /**
   * Whether a command admitted without a prompt (remembered, or a full-access
   * thread) shows on this Mac as a running card. Off by default under `full`,
   * on otherwise; `macBridge.showRunning.set` pins it either way.
   */
  showRunning: boolean
  /** Whether that host has this Mac registered right now (the link is up and it took the offer). */
  registered: boolean
  /** The load guard's caps for this host (`macBridge.maxRunning.<envId>`, `macBridge.maxThreads.<envId>`, else the defaults)… */
  maxRunning: number
  maxThreads: number
  /** …and what it runs now: commands and jobs running, commands and jobs held, Mac-local threads live. */
  running: number
  held: number
  threads: number
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
  /** Mac calls the thread's tree holds while paused (macPause.ts); absent from an older host. */
  held?: number
}

export type MacBridgePush =
  | {
      push: 'peer.call'
      callId: string
      method: MacPeerMethod
      /** A mac.* call names its thread and args; a thread.* call (contract-crosshost.ts) its caller and args; a host.* call (contract-hostdevices.ts) its args; a publish.* call its caller and args. */
      params: MacCallParams | CrossHostCallParams | HostDevicesCallParams | PublishCallParams
      deadlineMs: number
    }
  | { push: 'macBridge.request'; request: MacBridgeRequest }
  | { push: 'macBridge.resolved'; id: string; outcome: MacBridgeOutcome }
  | MacHeldPush

// ── mac.writeFile (remote/macBridgeWrite.ts on the Mac, macWriteStage.ts on the box) ──

export const MAC_WRITE_MAX_BYTES = 8 * 1024 * 1024
/** base64 characters of MAC_WRITE_MAX_BYTES. */
export const MAC_WRITE_MAX_BASE64 = Math.ceil(MAC_WRITE_MAX_BYTES / 3) * 4
export const MacWriteModeSchema = z.enum(['create', 'overwrite', 'append'])
export type MacWriteMode = z.infer<typeof MacWriteModeSchema>
const fileModeArg = z.number().int().min(0).max(0o777)
/** What a thread names, before the one-of check (zod 4 refuses to extend a refined object). */
const MacWriteFileArgsBase = z.object({
  path: pathArg,
  dataBase64: z.string().max(MAC_WRITE_MAX_BASE64).optional(),
  /** UTF-8 text instead of base64; the box encodes it before staging, so the Mac sees bytes either way. */
  text: z.string().max(MAC_WRITE_MAX_BYTES).optional(),
  mode: MacWriteModeSchema.optional(),
  fileMode: fileModeArg.optional()
})
/** Exactly one of dataBase64 and text. */
const oneContent = <T extends z.ZodType<{ dataBase64?: string; text?: string }>>(schema: T): T =>
  schema.refine((a) => (a.dataBase64 === undefined) !== (a.text === undefined), {
    message: 'mac.writeFile takes dataBase64 or text, exactly one of them'
  }) as T
/** What a thread names. */
export const MacWriteFileArgsSchema = oneContent(MacWriteFileArgsBase)
export type MacWriteFileArgs = z.infer<typeof MacWriteFileArgsSchema>
/**
 * What the box sends the Mac in the `peer.call`: the bytes inline when their
 * base64 fits one PEER_CHUNK_CHARS frame, else staged on the box, and the Mac
 * pulls them with `peer.pull` once it has allowed the write.
 */
export const MacWriteFileWireSchema = z.object({
  path: pathArg,
  mode: MacWriteModeSchema,
  fileMode: fileModeArg.optional(),
  size: z.number().int().min(0).max(MAC_WRITE_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  dataBase64: z.string().max(PEER_CHUNK_CHARS).optional(),
  staged: z
    .object({
      id: z.string().min(1).max(100),
      chunks: z.number().int().min(1).max(PEER_MAX_CHUNKS)
    })
    .optional()
})
export type MacWriteFileWire = z.infer<typeof MacWriteFileWireSchema>
export interface MacWriteFileResult {
  /** The real path written on the Mac. */
  path: string
  bytes: number
  mode: MacWriteMode
  /** The file did not exist before. */
  created: boolean
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

const threadAuth = { sessionId: z.string().min(1).max(200), token: z.string().min(1).max(200) }
const envId = z.string().min(1).max(200)
/** mac.run only: the thread's tool-call row the live output belongs to, when the caller knows it. */
const macRunCallRef = { callId: z.string().min(1).max(200).optional() }

export const MacBridgeRequestSchemas = [
  // ── the Mac's main process → the box, over the peer link (admin) ──────
  /** → { environmentId } of the box. */
  request(
    'peer.register',
    z.object({
      from: envId,
      offers: z.array(z.string().max(64)).max(16),
      /** The Mac's home directory, for the box threads' tool text (absent from an older Mac). */
      home: MacHomeSchema.optional()
    })
  ),
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
  /** → { data }: one piece of a staged mac.writeFile, asked for by the Mac the call went to. */
  request(
    'peer.pull',
    z.object({
      stageId: z.string().min(1).max(100),
      index: z
        .number()
        .int()
        .min(0)
        .max(PEER_MAX_CHUNKS - 1)
    })
  ),
  // ── a box thread's tools (local; the token is the thread's own) ──────
  request('mac.readFile', MacReadFileArgsSchema.extend(threadAuth)),
  request('mac.listDir', MacListDirArgsSchema.extend(threadAuth)),
  request('mac.fetchFile', MacFetchFileArgsSchema.extend(threadAuth)),
  request('mac.run', MacRunArgsSchema.extend(threadAuth).extend(macRunCallRef).extend(MAC_RUN_BACKGROUND)),
  request('mac.writeFile', oneContent(MacWriteFileArgsBase.extend(threadAuth))),
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
  /** allow false on a running command stops it. remember: the folder (read; true or 'folder'), or for a run true ('exact') | 'exact' | 'folder' | 'program' | 'thread', for this thread. */
  request(
    'macBridge.decide',
    z.object({
      id: z.string().min(1).max(100),
      allow: z.boolean(),
      remember: MacDecideRememberSchema.optional()
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
  ),
  /** → MacBridgeHostPolicy[]. Whether commands admitted without a prompt show as running cards on this Mac. */
  request('macBridge.showRunning.set', z.object({ environmentId: envId, show: z.boolean() })),
  // ── the load guard (remote/macLoadGuard.ts) ──────────────────────────
  /** → MacBridgeHostPolicy[]. A host's caps; null puts one back to its default. */
  request(
    'macBridge.limits.set',
    z.object({
      environmentId: envId,
      maxRunning: z.number().int().min(1).max(MAC_BRIDGE_MAX_RUNNING_CAP).nullable().optional(),
      maxThreads: z.number().int().min(0).max(MAC_BRIDGE_MAX_THREADS_CAP).nullable().optional()
    })
  ),
  /** → MacBridgeLoad. The one-minute load over which new commands and jobs are held; null follows the cores again. */
  request('macBridge.loadLimit.set', z.object({ limit: z.number().positive().max(10_000).nullable() })),
  /** → MacBridgeLoad, as last sampled. */
  request('macBridge.load.get', z.object({}).optional()),
  /** → MacBridgeThreadAdmission: whether a host may start another Mac-local thread here now. */
  request('macBridge.admitThread', z.object({ environmentId: envId }))
] as const
