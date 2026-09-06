import { ipcMain, webContents } from 'electron'
import { spawn as forkPty, type IPty } from 'node-pty'
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { harnessEnv } from './server/drivers/binaries'
import {
  FlowControl,
  PTY_COALESCE_MS,
  defaultShell,
  foregroundLabel,
  shouldFlush
} from './pty-core'

const execFileP = promisify(execFile)

interface Session {
  id: string
  owner: number
  pty: IPty
  shellPid: number
  tty: Promise<string | null>
  chunks: Buffer[]
  buffered: number
  lastFlush: number
  timer: NodeJS.Timeout | null
  flow: FlowControl
  /** A respawn on the same id kills this one; its output and its exit must
   *  never reach the replacement. */
  superseded: boolean
}

const sessions = new Map<string, Session>()

/** Printed once at startup: proves the N-API prebuild loaded inside
 *  Electron's ABI, not just under plain node. */
export function reportPtyAddon(): void {
  const req = createRequire(__filename)
  for (const candidate of [
    `node-pty/prebuilds/${process.platform}-${process.arch}/pty.node`,
    'node-pty/build/Release/pty.node'
  ]) {
    try {
      console.error(`[pty] node-pty addon: ${req.resolve(candidate)}`)
      return
    } catch {
      // try the next layout
    }
  }
  console.error('[pty] node-pty addon: path unresolved')
}
let pauses = 0
let resumes = 0

export function ptyFlowCounters(): { pauses: number; resumes: number } {
  return { pauses, resumes }
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function send(owner: number, channel: string, ...args: unknown[]): void {
  const wc = webContents.fromId(owner)
  if (!wc || wc.isDestroyed()) return
  wc.send(channel, ...args)
}

function clearTimer(session: Session): void {
  if (session.timer) {
    clearTimeout(session.timer)
    session.timer = null
  }
}

function flush(session: Session): void {
  clearTimer(session)
  session.lastFlush = Date.now()
  if (session.buffered === 0) return
  const data = session.chunks.length === 1 ? session.chunks[0] : Buffer.concat(session.chunks)
  session.chunks = []
  session.buffered = 0
  if (session.superseded) return
  send(session.owner, 'pty-data', session.id, data)
  if (session.flow.sent(data.length)) {
    pauses += 1
    console.error(`[pty] pause ${session.id} (unacked ${session.flow.pending})`)
    try {
      session.pty.pause()
    } catch {
      // the child is already gone
    }
  }
}

function onData(session: Session, data: string | Buffer): void {
  if (session.superseded) return
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  session.chunks.push(chunk)
  session.buffered += chunk.length
  const since = Date.now() - session.lastFlush
  if (shouldFlush(session.buffered, since)) {
    flush(session)
    return
  }
  if (!session.timer) {
    session.timer = setTimeout(() => flush(session), Math.max(1, PTY_COALESCE_MS - since))
  }
}

/** HUP/TERM the shell and its whole process group, then KILL a second later. */
function terminate(pid: number): void {
  if (!pid || pid <= 1) return
  for (const signal of ['SIGHUP', 'SIGTERM'] as const) {
    try {
      process.kill(pid, signal)
    } catch {
      // already reaped
    }
    try {
      process.kill(-pid, signal)
    } catch {
      // no process group left
    }
  }
  setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already reaped
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // no process group left
    }
  }, 1000).unref()
}

function discard(session: Session): void {
  session.superseded = true
  clearTimer(session)
  session.chunks = []
  session.buffered = 0
  terminate(session.shellPid)
}

async function ttyName(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'tty='])
    const name = stdout.trim()
    return name && name !== '??' ? name : null
  } catch {
    return null
  }
}

export interface SpawnArgs {
  id: string
  cwd: string
  cols: number
  rows: number
}

/** Returns the requested directory when it was missing and the shell opened
 *  in `$HOME` instead; null when it opened where it was asked to. */
async function spawn(owner: number, args: SpawnArgs): Promise<string | null> {
  const previous = sessions.get(args.id)
  if (previous) {
    sessions.delete(args.id)
    discard(previous)
  }

  const requested = expandHome(args.cwd ?? '')
  const missing = isDir(requested) ? null : args.cwd
  const cwd = missing === null ? requested : homedir()
  const cols = Math.max(2, Math.trunc(args.cols) || 0)
  const rows = Math.max(2, Math.trunc(args.rows) || 0)

  const { shell, args: shellArgs } = defaultShell(process.platform, process.env)
  const base = await harnessEnv()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.COLORFGBG = '15;0'
  env.TERM_PROGRAM = 'TempCode'
  env.HOME = homedir()
  env.PWD = cwd

  const pty = forkPty(shell, shellArgs, {
    name: 'xterm-256color',
    cwd,
    cols,
    rows,
    env,
    // Raw bytes: the renderer feeds xterm a Uint8Array, so decoding here and
    // re-encoding there would only cost work and mangle split code points.
    encoding: null
  })

  const session: Session = {
    id: args.id,
    owner,
    pty,
    shellPid: pty.pid,
    tty: ttyName(pty.pid),
    chunks: [],
    buffered: 0,
    lastFlush: Date.now(),
    timer: null,
    flow: new FlowControl(),
    superseded: false
  }
  sessions.set(args.id, session)

  pty.onData((data) => onData(session, data as unknown as string | Buffer))
  pty.onExit(({ exitCode }) => {
    if (session.superseded) return
    // Let node-pty deliver whatever the shell wrote on its way out, then
    // drain the batch before announcing the exit.
    setTimeout(() => {
      if (session.superseded) return
      flush(session)
      if (sessions.get(session.id) === session) sessions.delete(session.id)
      send(session.owner, 'pty-exit', session.id, exitCode ?? null)
    }, 20)
  })

  return missing
}

function require_(id: string): Session {
  const session = sessions.get(id)
  if (!session) throw new Error('Terminal is not running')
  return session
}

export function killPtysForOwner(owner: number): void {
  for (const [id, session] of [...sessions]) {
    if (session.owner !== owner) continue
    sessions.delete(id)
    discard(session)
  }
}

export function killAllPtys(): void {
  for (const [id, session] of [...sessions]) {
    sessions.delete(id)
    discard(session)
  }
}

export function registerPty(): void {
  reportPtyAddon()
  ipcMain.handle('pty-spawn', (e, args: SpawnArgs) => spawn(e.sender.id, args))

  ipcMain.handle('pty-write', (_e, id: string, data: string) => {
    require_(id).pty.write(data)
  })

  ipcMain.handle('pty-resize', (_e, id: string, cols: number, rows: number) => {
    require_(id).pty.resize(Math.max(2, Math.trunc(cols) || 0), Math.max(2, Math.trunc(rows) || 0))
  })

  ipcMain.handle('pty-status', async (_e, id: string): Promise<{ foreground: string | null }> => {
    const session = require_(id)
    const tty = await session.tty
    if (!tty) return { foreground: null }
    try {
      const { stdout } = await execFileP('ps', ['-t', tty, '-o', 'pid=,pgid=,stat=,args='])
      return { foreground: foregroundLabel(stdout, session.shellPid) }
    } catch {
      return { foreground: null }
    }
  })

  ipcMain.handle('pty-kill', (_e, id: string) => {
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    discard(session)
  })

  ipcMain.handle('pty-kill-all', () => killAllPtys())

  // Flow control: the renderer pays back bytes once xterm has written them.
  ipcMain.on('pty-ack', (_e, id: string, bytes: number) => {
    const session = sessions.get(id)
    if (!session) return
    if (!session.flow.acked(bytes)) return
    resumes += 1
    console.error(`[pty] resume ${session.id} (unacked ${session.flow.pending})`)
    try {
      session.pty.resume()
    } catch {
      // the child is already gone
    }
  })
}
