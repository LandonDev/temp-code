import { z } from 'zod'
import type { MacMethod } from './contract-macbridge'

// Interactive commands over the Mac bridge (docs/box.md "The Mac bridge",
// "Interactive jobs"). `mac.run` with `background: true` starts the command
// as a job on the Mac and answers `{ jobId }` at once; the thread then
// writes to its stdin, reads its output and signals it by id. The box's
// contract methods are local, like every mac.*, and carry the thread's
// token; the box forwards each over the peer link as a `peer.call` of the
// same name (the start as `mac.jobStart`), and the Mac's job registry
// (src/main/server/remote/macJobs.ts) answers only for the thread that
// started the job.

/** Jobs one box thread may have running on the Mac at once. */
export const MAC_JOB_MAX_PER_THREAD = 4
/** A job with no read, write or signal for this long is killed. */
export const MAC_JOB_IDLE_MS = 30 * 60_000
/** Output a job keeps, rolling: older bytes fall off the front. */
export const MAC_JOB_OUTPUT_CAP = 4 * 1024 * 1024
/** One jobRead answers at most this much: the newest bytes past afterOffset. */
export const MAC_JOB_READ_MAX = 1024 * 1024
/** One jobWrite takes at most this much (decoded). */
export const MAC_JOB_WRITE_MAX = 256 * 1024
/** How long a jobRead may wait for new output or the exit. */
export const MAC_JOB_READ_WAIT_MAX_MS = 30_000

export const MAC_JOB_SIGNALS = ['TERM', 'KILL', 'INT'] as const
export type MacJobSignal = (typeof MAC_JOB_SIGNALS)[number]

/** The box thread's job methods (local; each carries the thread's token). */
export const MAC_JOB_METHODS = [
  'mac.jobWrite',
  'mac.jobRead',
  'mac.jobSignal',
  'mac.jobClose'
] as const
export type MacJobMethod = (typeof MAC_JOB_METHODS)[number]
/** What the box asks the Mac over `peer.call` for jobs: the four, the start, and a thread's end. */
export const MAC_JOB_PEER_METHODS = [...MAC_JOB_METHODS, 'mac.jobStart', 'mac.jobsEnd'] as const
export type MacJobPeerMethod = (typeof MAC_JOB_PEER_METHODS)[number]
/** Every method a `peer.call` may name. */
export type MacPeerMethod = MacMethod | MacJobPeerMethod

export const isMacJobPeerMethod = (m: string): m is MacJobPeerMethod =>
  (MAC_JOB_PEER_METHODS as readonly string[]).includes(m)

const jobId = z.string().min(1).max(100)

export const MacJobWriteArgsSchema = z.object({
  jobId,
  /** Bytes for the job's stdin, base64 (at most MAC_JOB_WRITE_MAX decoded). */
  dataBase64: z.string().max(Math.ceil((MAC_JOB_WRITE_MAX * 4) / 3) + 4)
})
export const MacJobReadArgsSchema = z.object({
  jobId,
  /** Output past this byte offset (the last read's nextOffset); default 0. */
  afterOffset: z.number().int().min(0).optional(),
  /** Wait up to this long for new output or the exit when there is none yet. */
  waitMs: z.number().int().min(0).max(MAC_JOB_READ_WAIT_MAX_MS).optional()
})
export const MacJobSignalArgsSchema = z.object({ jobId, signal: z.enum(MAC_JOB_SIGNALS) })
export const MacJobCloseArgsSchema = z.object({ jobId })
/** A thread ended on the box (archived, deleted, moved away): its jobs go. */
export const MacJobsEndArgsSchema = z.object({}).optional()
export type MacJobWriteArgs = z.infer<typeof MacJobWriteArgsSchema>
export type MacJobReadArgs = z.infer<typeof MacJobReadArgsSchema>
export type MacJobSignalArgs = z.infer<typeof MacJobSignalArgsSchema>
export type MacJobCloseArgs = z.infer<typeof MacJobCloseArgsSchema>

/** mac.run with background: true. */
export interface MacJobStartResult {
  jobId: string
  /** The job has a terminal (node-pty): it echoes input, and close sends end-of-file (^D). */
  pty: boolean
}
export interface MacJobWriteResult {
  jobId: string
  bytes: number
}
export type MacJobEnd = 'idle' | 'stopped' | 'thread-ended' | 'timeout' | 'closed'
export interface MacJobReadResult {
  jobId: string
  /** Byte offset of the first byte of `output` in everything the job wrote. */
  offset: number
  /** Pass this as afterOffset next time. */
  nextOffset: number
  /** stdout and stderr together (a terminal merges them), as utf8. */
  output: string
  /** Bytes past afterOffset that this read does not carry: rolled out of the buffer, or older than the newest MAC_JOB_READ_MAX. */
  skipped: number
  running: boolean
  stdinOpen: boolean
  exitCode: number | null
  signal: string | null
  /** Set when the app ended the job rather than the command itself. */
  ended?: MacJobEnd
}
export interface MacJobSignalResult {
  jobId: string
  signal: MacJobSignal
  running: boolean
}
export interface MacJobCloseResult {
  jobId: string
  stdinOpen: false
}
export interface MacJobsEndResult {
  ended: number
}

/**
 * The job tools' descriptions and params, shared by the Claude tools
 * (macTools.ts) and the codex bridge (scripts/app-mcp-bridge.mjs keeps a
 * copy; macJobs.test.ts holds them equal). `background` is mac_run's.
 */
export const MAC_JOB_TOOL_DESCRIPTIONS = {
  mac_job_write:
    'Write to the stdin of a job started with mac_run background: true (answer a prompt, feed input). Add a newline to send a line. close: true closes its stdin after the write (in a terminal that is end-of-file, ^D). No new approval: the user allowed the job when it started.',
  mac_job_read:
    'Read the output of a job started with mac_run background: true: what it wrote past afterOffset (pass the last nextOffset), at most the newest 1 MiB, plus whether it is still running and its exit code once done. waitMs waits for new output or the exit. A job with no read or write for 30 minutes is killed.',
  mac_job_signal:
    'Send a signal to a job started with mac_run background: true: INT (like Ctrl-C), TERM, or KILL. It goes to the whole process group.'
} as const
export const MAC_JOB_TOOL_PARAMS = {
  background:
    'Start it as an interactive job instead: it runs in a terminal on the Mac with stdin open, and this answers {jobId} at once. Then use mac_job_read, mac_job_write and mac_job_signal. The user still approves it first. At most 4 jobs per thread; a job ends with the thread or after 30 idle minutes.',
  jobId: 'The jobId mac_run background: true answered.',
  text: 'Text to write to the job\'s stdin, as UTF-8 (include "\\n" to end a line).',
  dataBase64: 'Raw bytes to write instead of text, base64.',
  close: "Close the job's stdin after this write.",
  afterOffset: "Read output past this byte offset: the last read's nextOffset (default 0).",
  waitMs:
    'Wait up to this many milliseconds for new output or the exit (default 0, at most 30000).',
  signal: 'INT, TERM or KILL.'
} as const

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })
const threadAuth = { sessionId: z.string().min(1).max(200), token: z.string().min(1).max(200) }

/** The box thread's job methods; `mac.run`'s `background` flag is in contract-macbridge's mac.run row. */
export const MacJobRequestSchemas = [
  request('mac.jobWrite', MacJobWriteArgsSchema.extend(threadAuth)),
  request('mac.jobRead', MacJobReadArgsSchema.extend(threadAuth)),
  request('mac.jobSignal', MacJobSignalArgsSchema.extend(threadAuth)),
  request('mac.jobClose', MacJobCloseArgsSchema.extend(threadAuth))
] as const

/** mac.run's extra field (contract-macbridge extends its row with it). */
export const MAC_RUN_BACKGROUND = { background: z.boolean().optional() }
