#!/usr/bin/env bun
/**
 * Launch timing of a built tree on Linux, under a virtual X server: the
 * box's counterpart of scripts/e2e-launch-timing.ts (which packs a Mac app).
 * Nothing is packed; `electron .` runs the tree's out/ (package.json main →
 * out/main/boot.js) and the renderer loads from tempcode-app://, so the
 * chunk split and the V8 code cache are measured as the packaged app has
 * them; Node's compile cache stays off (packaged apps only).
 *
 *   bun scripts/launch-timing-linux.ts --tree <checkout> [--launches 5] [--port 9242] [--label after]
 *
 * Every launch: a fresh userData for launch 1 only (so launch 2 produces the
 * renderer's code cache and 3+ consume it), `xvfb-run -a` + a private D-Bus,
 * CDP on --port, then over Runtime.evaluate: `tc:ready` (main.tsx, the UI
 * on screen) as ms since the renderer's navigation and since the spawn,
 * the module scripts fetched before it (count, bytes) and the index chunk's
 * size. The result lands as one `TIMING {...}` line and under
 * /tmp/tc-launch-linux/<label>.json. Nothing of the user's data is touched.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const TREE = resolve(opt('tree', '.'))
const LAUNCHES = Number(opt('launches', '5'))
const PORT = Number(opt('port', '9242'))
const LABEL = opt('label', 'run')
const ROOT = '/tmp/tc-launch-linux'
const USER_DATA = join(ROOT, LABEL, 'userData')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Target = { type: string; url: string; webSocketDebuggerUrl?: string }
async function pageTarget(timeoutMs: number): Promise<Target> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Target[]
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('/index.html'))
      if (page) return page
    } catch {
      // not up yet
    }
    await sleep(100)
  }
  throw new Error('no renderer page target on the debug port')
}

class Cdp {
  private ws: WebSocket
  private next = 1
  private pending = new Map<number, (v: unknown) => void>()
  constructor(url: string) {
    this.ws = new WebSocket(url)
    // A socket that closes under a pending call must fail it: a promise left
    // hanging with nothing else on the loop would end the script silently.
    this.ws.onclose = (e) => {
      for (const resolve of this.pending.values()) resolve({ error: `cdp socket closed (${e.code})` })
      this.pending.clear()
    }
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown }
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m.error ? { error: m.error } : m.result)
        this.pending.delete(m.id)
      }
    }
  }
  open(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('cdp socket'))
    })
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res) => this.pending.set(id, res))
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: T }
      error?: unknown
    }
    if (r.error) throw new Error(JSON.stringify(r.error))
    return r.result?.value as T
  }
  close(): void {
    this.ws.close()
  }
}

type Launch = {
  n: number
  spawnToNavigationMs: number
  readyMs: number
  readyFromSpawnMs: number
  bootLine: string | null
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size
  }
  return n
}

async function launch(n: number): Promise<Launch> {
  const env = { ...process.env } as Record<string, string | undefined>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  // The isolated instance's own home, vault and a dead provider origin, as
  // the e2e scripts give theirs; a window is forced (the box's service is
  // headless, this measurement is not).
  Object.assign(env, {
    HOME: join(ROOT, LABEL, 'home'),
    NODE_ENV: 'production',
    TEMP_CODE_USER_DATA: USER_DATA,
    TEMP_CODE_DEBUG_PORT: String(PORT),
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_HEADLESS: '0',
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_ALIAX_DATA_DIR: join(USER_DATA, 'aliax'),
    TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
    TEMP_CODE_UPDATE_FEED: 'http://127.0.0.1:1/'
  })
  // The file:// localStorage migration (originMigration.ts) opens and closes
  // a hidden window before the first real one; on Linux with a display that
  // close is window-all-closed and the app quits. A migrated profile skips
  // it, as every installed app's does after its first boot on the scheme.
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(join(ROOT, LABEL, 'home'), { recursive: true })
  writeFileSync(join(USER_DATA, 'localstorage-migrated'), '')
  const spawnedAt = Date.now()
  const child: ChildProcess = spawn(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', join(TREE, 'node_modules/electron/dist/electron'), '.'],
    { cwd: TREE, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let bootLine: string | null = null
  let out = ''
  child.stdout!.on('data', (d) => {
    out += String(d)
    const m = /\[boot\] index [^\n]*/.exec(out)
    if (m && !bootLine) bootLine = m[0]
  })
  child.stderr!.on('data', (d) => {
    out += String(d)
  })
  let exited: string | null = null
  child.on('exit', (code, signal) => {
    exited = `electron exited (${code ?? signal})`
  })
  try {
    const target = await pageTarget(60_000).catch((e: Error) => {
      throw new Error(`${e.message}${exited ? `; ${exited}` : ''}\n${out.slice(-3000)}`)
    })
    const cdp = new Cdp(target.webSocketDebuggerUrl!)
    await cdp.open()
    const until = Date.now() + 60_000
    let ready: number | null = null
    while (Date.now() < until) {
      ready = await cdp.evaluate<number | null>(`performance.getEntriesByName('tc:ready')[0]?.startTime ?? null`)
      if (ready !== null) break
      if (exited) throw new Error(`${exited} before tc:ready\n${out.slice(-2000)}`)
      await sleep(50)
    }
    if (ready === null) throw new Error(`tc:ready never fired\n${out.slice(-2000)}`)
    const timeOrigin = await cdp.evaluate<number>('performance.timeOrigin')
    cdp.close()
    return {
      n,
      spawnToNavigationMs: Math.round(timeOrigin - spawnedAt),
      readyMs: Math.round(ready),
      readyFromSpawnMs: Math.round(timeOrigin - spawnedAt + ready),
      bootLine
    }
  } finally {
    try {
      process.kill(-child.pid!, 'SIGTERM')
    } catch {
      // already gone
    }
    const gone = new Promise<void>((r) => child.once('exit', () => r()))
    await Promise.race([gone, sleep(10_000)])
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // exited
    }
    await sleep(500)
  }
}

function indexChunkBytes(): number {
  const dir = join(TREE, 'out/renderer/assets')
  const names = readdirSync(dir).filter((f) => /^index-[^.]+\.js$/.test(f))
  return Math.max(0, ...names.map((f) => statSync(join(dir, f)).size))
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

async function main(): Promise<void> {
  if (!existsSync(join(TREE, 'out/renderer/index.html'))) throw new Error(`${TREE}: build the renderer first (electron-vite build)`)
  mkdirSync(join(ROOT, LABEL), { recursive: true })
  rmSync(USER_DATA, { recursive: true, force: true })
  const launches: Launch[] = []
  for (let n = 1; n <= LAUNCHES; n++) {
    const l = await launch(n)
    launches.push(l)
    console.log(
      `launch ${n}: tc:ready ${l.readyMs} ms after navigation (${l.readyFromSpawnMs} ms after spawn)` +
        (l.bootLine ? `; ${l.bootLine}` : '')
    )
  }
  const warm = launches.slice(2)
  const summary = {
    label: LABEL,
    tree: TREE,
    launches,
    coldReadyMs: launches[0]?.readyMs ?? null,
    warmReadyMedianMs: median(warm.map((l) => l.readyMs)),
    warmReadyFromSpawnMedianMs: median(warm.map((l) => l.readyFromSpawnMs)),
    // The index chunk on disk: a custom scheme's fetches leave no resource timing entries to read it from.
    indexBytes: indexChunkBytes(),
    codeCacheBytes: dirBytes(join(USER_DATA, 'Code Cache'))
  }
  writeFileSync(join(ROOT, `${LABEL}.json`), JSON.stringify(summary, null, 2))
  console.log(`TIMING ${JSON.stringify(summary)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
