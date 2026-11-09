/**
 * The benchmark's dev instance (computerTasks.ts devapp-form; plan §2.1): a
 * fresh isolated preview of the built tree with its own userData, Aliax vault
 * and debug port, its window inactive (TEMP_CODE_SOAK_WINDOW, so it never
 * takes the person's focus and keeps painting behind their windows), ready
 * once its socket is connected, in its own process group so a stop takes all
 * of it.
 */
import { execFileSync, spawn } from 'node:child_process'
import { openSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

export interface DevLaunch {
  userData: string
  /** the window's title */
  window: string
  /** the Electron main process, the one computer use pins */
  pid: number
  port: number
  stop(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolvePort(port))
    })
  })

export function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig)
  } catch {
    /* gone */
  }
}

/** One expression in the instance's page, over CDP, on the global WebSocket. */
export async function cdpEval<T>(port: number, expression: string): Promise<T> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[]
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.endsWith('index.html'))
  if (!page) throw new Error('no page yet')
  const ws = new WebSocket(page.webSocketDebuggerUrl!)
  try {
    await new Promise<void>((ok, fail) => {
      ws.addEventListener('open', () => ok(), { once: true })
      ws.addEventListener('error', () => fail(new Error('CDP socket failed')), { once: true })
    })
    type Answer = { result?: { result: { value?: T } }; error?: { message: string } }
    const answer = new Promise<Answer>((ok) =>
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data)) as { id?: number }
        if (msg.id === 1) ok(msg as never)
      })
    )
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    const r: Answer = await Promise.race([answer, sleep(10_000).then((): Answer => ({ error: { message: 'CDP timed out' } }))])
    if (r.error) throw new Error(r.error.message)
    return r.result!.result.value as T
  } finally {
    ws.close()
  }
}

/** The Electron binary's process in the group: `ps` names it by its path inside the bundle. */
export function electronMainIn(psOutput: string, pgid: number): number | null {
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m && Number(m[2]) === pgid && /\/MacOS\/Electron$/.test(m[3].trim())) return Number(m[1])
  }
  return null
}

export function electronMain(pgid: number): number | null {
  try {
    return electronMainIn(execFileSync('ps', ['-Ao', 'pid=,pgid=,comm='], { encoding: 'utf8' }), pgid)
  } catch {
    return null
  }
}

/** The environment it runs with: the gate's plain one (no hook's GIT_*), isolated, never Electron as node. */
export function devEnv(base: NodeJS.ProcessEnv, dir: string, port: number): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('GIT_'))),
    TEMP_CODE_USER_DATA: join(dir, 'dev'),
    TEMP_CODE_SOAK_WINDOW: '1',
    TEMP_CODE_ALIAX_DATA_DIR: join(dir, 'aliax'),
    TEMP_CODE_WARM_HARNESS: '0',
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_DEBUG_PORT: String(port)
  }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** Starts the instance from the checkout's built out/; `groups` holds its process group while it lives. */
export async function startDevInstance(opts: { root: string; dir: string; groups?: Set<number> }): Promise<DevLaunch> {
  const port = await freePort()
  const env = devEnv(process.env, opts.dir, port)
  const out = openSync(join(opts.dir, 'dev.log'), 'a')
  const child = spawn(join(opts.root, 'node_modules', '.bin', 'electron-vite'), ['preview', '--skipBuild'], { cwd: opts.root, env, detached: true, stdio: ['ignore', out, out] })
  const pgid = child.pid!
  opts.groups?.add(pgid)
  const stop = async (): Promise<void> => {
    killGroup(pgid, 'SIGTERM')
    for (let i = 0; i < 20 && electronMain(pgid); i++) await sleep(250)
    killGroup(pgid, 'SIGKILL')
    opts.groups?.delete(pgid)
    rmSync(env.TEMP_CODE_USER_DATA, { recursive: true, force: true })
  }
  try {
    let connected = false
    for (let i = 0; i < 240 && !connected; i++) {
      connected = await cdpEval<boolean>(port, '!!window.__monocode?.registry?.primary()?.connected').catch(() => false)
      if (!connected) await sleep(500)
    }
    if (!connected) throw new Error('the dev instance never connected within 2 minutes')
    const pid = electronMain(pgid)
    if (!pid) throw new Error("no Electron main process in the dev instance's group")
    return { userData: env.TEMP_CODE_USER_DATA, window: (await cdpEval<string>(port, 'document.title')) || 'TempCode', pid, port, stop }
  } catch (e) {
    await stop()
    throw e
  }
}
