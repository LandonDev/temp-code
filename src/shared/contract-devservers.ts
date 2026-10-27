import { z } from 'zod'
import type { PortForwardInfo } from './contract-ports'

// The Dev Server button (docs/box.md "Dev servers on the box"). A host reads
// a project's checkout for what it can serve (package.json dev scripts at the
// root and in its workspaces, an Expo app, an Xcode project) and runs one on
// request in its own process group, the log streamed to every client like the
// Build rail's. A run's ports are forwarded to the Mac like a thread's. The
// command only ever comes from the host's own detection: a client names a
// target id, never a command line.

export const DEV_TARGET_KINDS = ['web', 'expo', 'ios'] as const
export type DevTargetKind = (typeof DEV_TARGET_KINDS)[number]

export interface DevTarget {
  /** Stable across detections: `<dir>#<script>`, or `ios:<dir>/<project>`. */
  id: string
  /** The package's name or folder ("web", "docs"); the project's own name at the root. */
  name: string
  /** The script ("dev", "start"), or the scheme for an iOS app. */
  script: string
  kind: DevTargetKind
  /** vite, next, expo, astro, …; null when the command names none. */
  framework: string | null
  /** The folder it runs in, relative to the project ('' is the root). */
  dir: string
  /** What runs, for the console's first line. */
  command: string
  /** Runs only on a Mac (an iOS app needs Xcode and a simulator; an Expo app its phone and simulators). */
  macOnly: boolean
  /** What it starts, in a few words: "Vite dev server", "Expo app" (shared/devServerWords.ts). */
  what: string
}

export type DevRunStatus = 'running' | 'exited' | 'failed' | 'stopped'

export interface DevRunPort {
  port: number
  /** The URL the server announced, else http://localhost:<port>. */
  url: string
  forwards: PortForwardInfo[]
}

export interface DevRun {
  id: string
  projectId: string
  targetId: string
  name: string
  script: string
  kind: DevTargetKind
  command: string
  /** What it is, in a few words ("Vite dev server"); absent from an older host. */
  what?: string
  /** The thread it was started for; null when none was on screen (absent from an older host). */
  sessionId?: string | null
  /** Absolute, on the host. */
  cwd: string
  status: DevRunStatus
  pid: number | null
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  ports: DevRunPort[]
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })
const id = z.string().min(1).max(300)

export const DevServerRequestSchemas = [
  /** → { targets: DevTarget[], runs: DevRun[] }: what the project can serve here, and its runs (newest first). */
  request('devServer.targets', z.object({ projectId: id })),
  /** → { runs: DevRun[] }: every running run on this host, any project (the Dev servers pane's list). */
  request('devServer.runs', z.object({})),
  /**
   * → DevServerStartResult: start a target for a thread (`sessionId`, the one
   * on screen); a target may run several times at once (each run picks its
   * own port). One dev server per thread: a thread that already has a live
   * run or a `port` row on its ledger is answered `{ replace: true, existing }`
   * unless the request says `another` (start beside it) or `replace` (the
   * host stops the old ones first; a server that will not stop fails the start).
   */
  request('devServer.start', z.object({ projectId: id, targetId: id, sessionId: id.optional(), replace: z.boolean().optional(), another: z.boolean().optional() })),
  /** → { run: DevRun }: SIGTERM the run's process group, SIGKILL after 5 s. */
  request('devServer.stop', z.object({ runId: id })),
  /** → { run: DevRun }: stop it, then start the same target again (a new run id). */
  request('devServer.restart', z.object({ runId: id })),
  /** → { run: DevRun, lines: string[], end: number }: the run and its buffered log, for the console's replay; `end` counts every line the run wrote. */
  request('devServer.log', z.object({ runId: id })),
  /**
   * → DevPortLog: what a dev server a thread opened (a `port` row on the ledger)
   * wrote since `from`: its stdout file when it has one (Claude's background
   * shell writes one), else the shell call's output from the transcript.
   */
  request('devServer.portLog', z.object({ resourceId: id, from: z.number().int().min(0).optional() }))
] as const

/** A dev server the thread already has: a Dev Server run, or a `port` row its shell opened. */
export interface DevServerExisting {
  runId: string | null
  resourceId: string | null
  label: string
}

/** `devServer.start`'s answer: the run, or the question (the thread has one; say `replace` or `another`). */
export type DevServerStartResult = { run: DevRun } | { replace: true; existing: DevServerExisting[] }

/** A run's state and any new log lines (batched ~100 ms). A new run id means a fresh log. `end` counts every line the run wrote, these included. */
export type DevRunPush = { push: 'dev-run'; projectId: string; run: DevRun; lines: string[]; end?: number }

/** An agent's dev server's output from `from` on: raw text with its colours, and the offset to ask from next. */
export interface DevPortLog {
  /** file: the process's stdout/stderr file; transcript: the shell call's output; none: nothing to show yet. */
  source: 'file' | 'transcript' | 'none'
  path: string | null
  data: string
  next: number
  /** Set once the server stopped (the row left the ledger): when, and the ledger's note ("stopped listening"). */
  endedAt?: number
  note?: string | null
}

/** The short word for a run's state in the button and the console. */
export function devRunWord(run: Pick<DevRun, 'status' | 'exitCode'>): string {
  switch (run.status) {
    case 'running':
      return 'Running'
    case 'stopped':
      return 'Stopped'
    case 'exited':
      return 'Exited'
    case 'failed':
      return run.exitCode === null ? 'Failed to start' : `Exited with ${run.exitCode}`
  }
}
