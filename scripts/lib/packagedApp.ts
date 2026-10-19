/**
 * Build and drive an isolated packaged copy of the app. Shared by the
 * updater e2e (scripts/e2e-updater.ts) and the launch-timing harness
 * (scripts/e2e-launch-timing.ts): both pack the tree with electron-builder
 * under their own bundle id, product name and `tempcodeHarness` block
 * (src/main/harness.ts), launch the executable by hand and talk to the
 * renderer over CDP. Nothing here reads or writes the installed app's paths.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO = resolve(import.meta.dir, '..', '..')

export type Check = (name: string, ok: boolean, detail?: string) => boolean
export type Log = (msg: string) => void

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function sh(
  cmd: string[],
  opts: { cwd?: string; quiet?: boolean; env?: Record<string, string> } = {}
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}\n${out}\n${err}`)
  if (!opts.quiet && err.trim()) console.error(err.trim())
  return out
}

export async function tryRun(cmd: string[]): Promise<void> {
  await sh(cmd, { quiet: true }).catch(() => undefined)
}

/** The agent shell lacks bun and brew on PATH, and ELECTRON_RUN_AS_NODE
 *  leaks into it; both would break the build or the launch. */
export function prepareEnv(): void {
  process.env.PATH = `${homedir()}/.bun/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`
  delete process.env.ELECTRON_RUN_AS_NODE
}

/** package.json as text plus the N of its 1.0.N version. */
export function readPackage(): { path: string; text: string; n: number } {
  const path = join(REPO, 'package.json')
  const text = readFileSync(path, 'utf8')
  const match = text.match(/^ {2}"version": "1\.0\.(\d+)",$/m)
  if (!match) throw new Error('package.json version is not 1.0.N')
  return { path, text, n: Number(match[1]) }
}

/** The Developer ID Application identity in the login Keychain. */
export async function findIdentity(): Promise<string> {
  const line = (await sh(['security', 'find-identity', '-v', '-p', 'codesigning'], { quiet: true }))
    .split('\n')
    .find((l) => l.includes('"Developer ID Application: '))
  const identity = line?.match(/"Developer ID Application: ([^"]+)"/)?.[1]
  if (!identity) throw new Error('no Developer ID Application identity in the Keychain')
  return identity
}

/** The release train builds in this checkout after every commit; two builds
 *  in one `out/` would corrupt each other. */
export async function waitForReleaseTrain(log: Log): Promise<void> {
  for (let i = 0; existsSync(join(REPO, '.git', 'auto-release.lock')); i++) {
    if (i === 0) log('waiting for the release train to finish')
    if (i > 120) throw new Error('release train still running after 10 minutes')
    await sleep(5000)
  }
}

export interface PackOptions {
  /** The 1.0.N the bundle reports; package.json is patched for the build and restored byte for byte. */
  version: string
  outDir: string
  appId: string
  product: string
  /** The `tempcodeHarness` block baked into the bundle's package.json. */
  harness: Record<string, string | number>
  identity: string
  check: Check
  log: Log
  /** Prefix for the check lines ("old", "new", …). */
  which?: string
}

/** The bundle a pack lands at. */
export function builtApp(outDir: string, product: string): string {
  return join(outDir, 'mac-arm64', `${product}.app`)
}

/** Signed with the Developer ID identity, not notarized (Squirrel checks the
 *  signature, not the notarization). Expects `bun run build` to have run. */
export async function pack(opts: PackOptions): Promise<string> {
  const { version, outDir, appId, product, harness, identity, check, log } = opts
  const which = opts.which ?? product
  log(`packing ${version} → ${outDir}`)
  const pkg = readPackage()
  const patched = pkg.text.replace(/^ {2}"version": "1\.0\.\d+",$/m, `  "version": "${version}",`)
  writeFileSync(pkg.path, patched)
  try {
    await sh(
      [
        'bunx',
        'electron-builder',
        '--mac',
        'zip',
        '--arm64',
        '--publish',
        'never',
        `-c.appId=${appId}`,
        `-c.productName=${product}`,
        '-c.mac.notarize=false',
        `-c.mac.identity=${identity}`,
        `-c.directories.output=${outDir}`,
        ...Object.entries(harness).map(([k, v]) => `-c.extraMetadata.tempcodeHarness.${k}=${v}`)
      ],
      { quiet: true }
    )
  } finally {
    writeFileSync(pkg.path, pkg.text)
  }
  const app = builtApp(outDir, product)
  const built = JSON.parse(
    readFileSync(join(app, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')
  )
  check(
    `${which} bundle is ${version} with the harness block`,
    built.version === version &&
      built.tempcodeHarness?.TEMP_CODE_USER_DATA === harness.TEMP_CODE_USER_DATA,
    JSON.stringify(built.tempcodeHarness)
  )
  const plistVersion = await plistVersionOf(app)
  check(`${which} Info.plist says ${version}`, plistVersion === version, plistVersion)
  await sh(['codesign', '--verify', '--deep', '--strict', app], { quiet: true })
  check(`${which} bundle passes codesign --verify --deep --strict`, true)
  return app
}

export async function plistVersionOf(app: string): Promise<string> {
  return (
    await sh(
      [
        'plutil',
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        join(app, 'Contents', 'Info.plist')
      ],
      { quiet: true }
    ).catch(() => '')
  ).trim()
}

/** Main processes of the bundle at `path`, whichever of /tmp and /private/tmp
 *  LaunchServices spelled it with. */
export async function pidsAt(path: string): Promise<number[]> {
  const tail = path.replace(/^\/private/, '')
  const out = await sh(['pgrep', '-f', `${tail}/Contents/MacOS/`], { quiet: true }).catch(() => '')
  return out.split('\n').filter(Boolean).map(Number)
}

export async function killAt(path: string): Promise<void> {
  for (const pid of await pidsAt(path)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* gone */
    }
  }
  for (let i = 0; i < 50 && (await pidsAt(path)).length > 0; i++) await sleep(200)
  for (const pid of await pidsAt(path)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

export async function portFree(port: number): Promise<boolean> {
  const out = await sh(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { quiet: true }).catch(
    () => ''
  )
  return out.trim() === ''
}

/** The process environment minus ELECTRON_RUN_AS_NODE, for spawning the app. */
export function launchEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  return { ...env, ...extra }
}

// ── CDP ────────────────────────────────────────────────────────────────────

export type Target = { type: string; url: string; webSocketDebuggerUrl?: string }

/** The app's window: the only page whose URL is the renderer's index.html
 *  (file:// before the app scheme, tempcode-app://renderer/ after). */
export async function pageTarget(port: number, timeoutMs: number): Promise<Target> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[]
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.endsWith('/index.html')
      )
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`no CDP page on ${port} within ${timeoutMs}ms`)
}

type EventHandler = (params: Record<string, unknown>) => void

export class Cdp {
  private ws: WebSocket
  private next = 1
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  private handlers = new Map<string, EventHandler[]>()
  readonly url: string
  private constructor(ws: WebSocket, url: string) {
    this.ws = ws
    this.url = url
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id === undefined) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {})
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.rej(new Error(msg.error.message))
      else p.res(msg.result)
    })
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => res(new Cdp(ws, url)))
      ws.addEventListener('error', () => rej(new Error('CDP socket failed')))
    })
  }
  /** Protocol events (after the matching `X.enable`). */
  on(method: string, handler: EventHandler): void {
    const list = this.handlers.get(method) ?? []
    list.push(handler)
    this.handlers.set(method, list)
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { res, rej }))
  }
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })) as {
      result: { value?: T }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value as T
  }
  close(): void {
    this.ws.close()
  }
}

/** Connect to the app's page and wait until preload has exposed `window.api`. */
export async function attach(
  port: number,
  timeoutMs: number,
  onConnect?: (cdp: Cdp) => Promise<void>
): Promise<Cdp> {
  const page = await pageTarget(port, timeoutMs)
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl!)
  await onConnect?.(cdp)
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    if (
      await cdp.eval<boolean>('typeof window.api?.updates?.get === "function"').catch(() => false)
    )
      return cdp
    await sleep(500)
  }
  throw new Error('renderer never exposed window.api.updates')
}
