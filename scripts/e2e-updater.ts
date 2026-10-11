#!/usr/bin/env bun
/**
 * The real Squirrel.Mac update path, end to end, against a copy of the app
 * that can never touch the installed one.
 *
 *   bun run script:e2e-updater            # build both copies, then drive
 *   bun run script:e2e-updater --reuse    # keep the builds under ROOT, redrive
 *   bun run script:e2e-updater --busy     # restart while a thread is running
 *
 * --busy starts a real short Claude turn (Haiku 5.5) in the old copy before
 * asking for the restart. The renderer then treats the window as busy: it
 * hides it instead of closing when Electron's quitAndInstall closes windows,
 * which is the stall the fix is for; the fixed app asks the quit-while-busy
 * question once (answered here through TEMP_CODE_DIALOG_ANSWER=yes) and
 * goes on to install.
 *
 * What it does:
 *   1. Builds the tree twice with electron-builder, signed with the Developer
 *      ID identity but not notarized (Squirrel checks the signature, not the
 *      notarization): once at package.json 1.0.N-1 ("old") and once at 1.0.N
 *      ("new"). package.json is patched for the first build and restored
 *      byte for byte. Both carry bundle id dev.landon.tempcode.e2e, product
 *      name TempCodeE2E, and a `tempcodeHarness` block (src/main/harness.ts)
 *      naming their userData, CDP port and feed, so the app ShipIt relaunches
 *      without our environment comes up isolated too.
 *   2. Serves latest-mac.yml and the new zip from 127.0.0.1:9231.
 *   3. Installs the old copy at /private/tmp/tc-updater-e2e/TempCodeE2E.app,
 *      launches it, and over CDP (9230) drives check → download → restart.
 *   4. Asserts: the process quit, ShipIt swapped the bundle (Info.plist says
 *      1.0.N), the relaunched app answers 1.0.N over CDP, and
 *      ~/Library/Caches/dev.landon.tempcode.e2e.ShipIt/ShipIt_stderr.log
 *      shows a clean install. A restart that leaves the process alive is
 *      reported as a stall.
 *
 * Everything it writes lives under ROOT, the e2e ShipIt cache, the
 * temp-code-harness-updater cache and the launchd label with the e2e bundle
 * id; the installed app's paths are never read or written.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createReadStream, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const ROOT = '/private/tmp/tc-updater-e2e'
const APP_ID = 'dev.landon.tempcode.e2e'
const PRODUCT = 'TempCodeE2E'
const DEBUG_PORT = 9230
const FEED_PORT = 9231
const FEED_URL = `http://127.0.0.1:${FEED_PORT}/`
const USER_DATA = join(ROOT, 'userData')
const APP = join(ROOT, `${PRODUCT}.app`)
const EXE = join(APP, 'Contents', 'MacOS', PRODUCT)
const FEED_DIR = join(ROOT, 'feed')
const SHIPIT_DIR = join(homedir(), 'Library', 'Caches', `${APP_ID}.ShipIt`)
const SHIPIT_LOG = join(SHIPIT_DIR, 'ShipIt_stderr.log')
const UPDATER_CACHE = join(homedir(), 'Library', 'Caches', 'temp-code-harness-updater')
const SHIPIT_LABEL = `${APP_ID}.ShipIt`
const reuse = process.argv.includes('--reuse')
const busy = process.argv.includes('--busy')

process.env.PATH = `${homedir()}/.bun/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`
delete process.env.ELECTRON_RUN_AS_NODE

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (msg: string): void => console.log(`[e2e-updater ${new Date().toISOString().slice(11, 19)}] ${msg}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function sh(cmd: string[], opts: { cwd?: string; quiet?: boolean; env?: Record<string, string> } = {}): Promise<string> {
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

async function tryRun(cmd: string[]): Promise<void> {
  await sh(cmd, { quiet: true }).catch(() => undefined)
}

// ── Preflight ──────────────────────────────────────────────────────────────

const pkgPath = join(REPO, 'package.json')
const pkgText = readFileSync(pkgPath, 'utf8')
const versionMatch = pkgText.match(/^  "version": "1\.0\.(\d+)",$/m)
if (!versionMatch) throw new Error('package.json version is not 1.0.N')
const N = Number(versionMatch[1])
const OLD = `1.0.${N - 1}`
const NEW = `1.0.${N}`

const identityLine = (await sh(['security', 'find-identity', '-v', '-p', 'codesigning'], { quiet: true }))
  .split('\n')
  .find((l) => l.includes('"Developer ID Application: '))
const identity = identityLine?.match(/"Developer ID Application: ([^"]+)"/)?.[1]
if (!identity) throw new Error('no Developer ID Application identity in the Keychain')

async function pidsAt(path: string): Promise<number[]> {
  const out = await sh(['pgrep', '-f', `${path}/Contents/MacOS/`], { quiet: true }).catch(() => '')
  return out.split('\n').filter(Boolean).map(Number)
}

async function killAt(path: string): Promise<void> {
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

async function portFree(port: number): Promise<boolean> {
  const out = await sh(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { quiet: true }).catch(() => '')
  return out.trim() === ''
}

log(`old ${OLD} → new ${NEW}, identity "${identity}", root ${ROOT}`)
await killAt(APP)
await tryRun(['launchctl', 'remove', SHIPIT_LABEL])
rmSync(SHIPIT_DIR, { recursive: true, force: true })
rmSync(UPDATER_CACHE, { recursive: true, force: true })
if (!reuse) rmSync(ROOT, { recursive: true, force: true })
else {
  rmSync(APP, { recursive: true, force: true })
  rmSync(USER_DATA, { recursive: true, force: true })
}
mkdirSync(ROOT, { recursive: true })
for (const port of [DEBUG_PORT, FEED_PORT]) {
  if (!(await portFree(port))) throw new Error(`port ${port} is in use`)
}

// The release train builds in this checkout after every commit; two builds
// in one `out/` would corrupt each other.
for (let i = 0; existsSync(join(REPO, '.git', 'auto-release.lock')); i++) {
  if (i === 0) log('waiting for the release train to finish')
  if (i > 120) throw new Error('release train still running after 10 minutes')
  await sleep(5000)
}

// ── Build ──────────────────────────────────────────────────────────────────

const outDir = (which: 'old' | 'new'): string => join(ROOT, `build-${which}`)
const builtApp = (which: 'old' | 'new'): string => join(outDir(which), 'mac-arm64', `${PRODUCT}.app`)
const zipName = `${PRODUCT}-${NEW}-arm64.zip`

async function pack(version: string, which: 'old' | 'new'): Promise<void> {
  log(`packing ${version} → ${outDir(which)}`)
  const patched = pkgText.replace(/^  "version": "1\.0\.\d+",$/m, `  "version": "${version}",`)
  writeFileSync(pkgPath, patched)
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
        `-c.appId=${APP_ID}`,
        `-c.productName=${PRODUCT}`,
        '-c.mac.notarize=false',
        `-c.mac.identity=${identity}`,
        `-c.directories.output=${outDir(which)}`,
        `-c.extraMetadata.tempcodeHarness.TEMP_CODE_USER_DATA=${USER_DATA}`,
        `-c.extraMetadata.tempcodeHarness.TEMP_CODE_DEBUG_PORT=${DEBUG_PORT}`,
        `-c.extraMetadata.tempcodeHarness.TEMP_CODE_UPDATE_FEED=${FEED_URL}`
      ],
      { quiet: true }
    )
  } finally {
    writeFileSync(pkgPath, pkgText)
  }
  const app = builtApp(which)
  const built = JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'app', 'package.json'), 'utf8'))
  check(`${which} bundle is ${version} with the harness block`, built.version === version && built.tempcodeHarness?.TEMP_CODE_USER_DATA === USER_DATA, JSON.stringify(built.tempcodeHarness))
  const plistVersion = (await sh(['plutil', '-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents', 'Info.plist')], { quiet: true })).trim()
  check(`${which} Info.plist says ${version}`, plistVersion === version, plistVersion)
  await sh(['codesign', '--verify', '--deep', '--strict', app], { quiet: true })
  check(`${which} bundle passes codesign --verify --deep --strict`, true)
}

if (!reuse) {
  log('bun run build (typecheck + electron-vite)')
  await sh(['bun', 'run', 'build'], { quiet: true })
  await pack(OLD, 'old')
  await pack(NEW, 'new')
} else {
  for (const which of ['old', 'new'] as const) {
    if (!existsSync(builtApp(which))) throw new Error(`--reuse: ${builtApp(which)} missing`)
  }
}

// ── Feed ───────────────────────────────────────────────────────────────────

const newZip = join(outDir('new'), zipName)
if (!existsSync(newZip)) throw new Error(`${newZip} missing`)
mkdirSync(FEED_DIR, { recursive: true })
const feedZip = join(FEED_DIR, zipName)
if (!existsSync(feedZip)) await sh(['cp', newZip, feedZip])

const sha512 = await new Promise<string>((res, rej) => {
  const h = createHash('sha512')
  createReadStream(feedZip).on('data', (d) => h.update(d)).on('end', () => res(h.digest('base64'))).on('error', rej)
})
const size = statSync(feedZip).size
writeFileSync(
  join(FEED_DIR, 'latest-mac.yml'),
  [
    `version: ${NEW}`,
    'files:',
    `  - url: ${zipName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${zipName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n')
)
const server = Bun.serve({
  port: FEED_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const name = decodeURIComponent(new URL(req.url).pathname).split('/').pop() ?? ''
    const file = Bun.file(join(FEED_DIR, name))
    if (!name || !(await file.exists())) return new Response('not found', { status: 404 })
    log(`feed: ${req.method} ${name}`)
    return new Response(file)
  }
})
log(`feed at ${FEED_URL} serving ${zipName} (${size} bytes)`)

// ── Install the old copy and launch it ─────────────────────────────────────

await sh(['ditto', builtApp('old'), APP])
mkdirSync(USER_DATA, { recursive: true })
const appLog = join(ROOT, 'old-app.log')
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
if (busy) env.TEMP_CODE_DIALOG_ANSWER = 'yes'
const oldProc = Bun.spawn([EXE], {
  env,
  stdout: Bun.file(appLog),
  stderr: Bun.file(appLog)
})
log(`launched ${OLD} as pid ${oldProc.pid}; log ${appLog}`)

// ── CDP ────────────────────────────────────────────────────────────────────

type Target = { type: string; url: string; webSocketDebuggerUrl?: string }

async function pageTarget(timeoutMs: number): Promise<Target> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()) as Target[]
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('/renderer/index.html'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`no CDP page on ${DEBUG_PORT} within ${timeoutMs}ms`)
}

class Cdp {
  private ws: WebSocket
  private next = 1
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.rej(new Error(msg.error.message))
      else p.res(msg.result)
    })
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => res(new Cdp(ws)))
      ws.addEventListener('error', () => rej(new Error('CDP socket failed')))
    })
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { res, rej }))
  }
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as {
      result: { value?: T }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value as T
  }
  close(): void {
    this.ws.close()
  }
}

type Status = { current: string; latest: string | null; phase: string; percent?: number; error?: string }

async function attach(timeoutMs: number): Promise<Cdp> {
  const page = await pageTarget(timeoutMs)
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl!)
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    if (await cdp.eval<boolean>('typeof window.api?.updates?.get === "function"').catch(() => false)) return cdp
    await sleep(500)
  }
  throw new Error('renderer never exposed window.api.updates')
}

let relaunched: Cdp | null = null
try {
  const cdp = await attach(90_000)
  const booted = await cdp.eval<Status>('window.api.updates.get()')
  check(`old app reports current ${OLD}`, booted.current === OLD, JSON.stringify(booted))

  const checked = await cdp.eval<Status>('window.api.updates.check()')
  check(`check sees ${NEW} on the feed`, checked.latest === NEW && checked.phase !== 'error', JSON.stringify(checked))

  const started = await cdp.eval<Status>('window.api.updates.apply()')
  check('apply starts the download', started.phase === 'downloading' || started.phase === 'ready', JSON.stringify(started))

  let status = started
  const downloadUntil = Date.now() + 300_000
  while (status.phase !== 'ready' && status.phase !== 'error' && Date.now() < downloadUntil) {
    await sleep(1000)
    status = await cdp.eval<Status>('window.api.updates.get()')
  }
  check(`download reaches ready`, status.phase === 'ready', JSON.stringify(status))
  if (status.phase !== 'ready') throw new Error('download did not reach ready')
  // Squirrel fetches the zip from electron-updater's proxy and stages it
  // before electron-updater reports ready; a staged update dir proves it.
  await sleep(2000)
  const staged = existsSync(SHIPIT_DIR) ? (await sh(['ls', SHIPIT_DIR], { quiet: true })).trim().split('\n') : []
  check('Squirrel staged the update', staged.some((n) => n.startsWith('update.')), staged.join(', '))

  if (busy) {
    const cwd = join(ROOT, 'busy-cwd')
    mkdirSync(cwd, { recursive: true })
    const created = await cdp.eval<{ id: string }>(
      `window.__monocode.server.request('session.create', ${JSON.stringify({ provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low', cwd, title: 'e2e busy' })})`
    )
    await cdp.eval(
      `window.__monocode.server.request('session.send', ${JSON.stringify({ sessionId: created.id, text: 'Write a 2500-word essay on the history of the typewriter. Do not stop early and do not ask questions.' })})`
    )
    let row: { status?: string } | undefined
    const busyUntil = Date.now() + 60_000
    while (Date.now() < busyUntil) {
      const rows = await cdp.eval<Array<{ id: string; status?: string }>>(`window.__monocode.server.request('session.list')`)
      row = rows.find((r) => r.id === created.id)
      if (row?.status === 'running') break
      await sleep(500)
    }
    check('a thread is running before the restart', row?.status === 'running', JSON.stringify(row))
    await sleep(1500)
  }

  log(`apply again: restart to update${busy ? ' (busy)' : ''}`)
  const restartAt = Date.now()
  await cdp.eval<Status>('window.api.updates.apply()').catch((e) => log(`apply (restart) threw: ${e.message}`))
  const exited = await Promise.race([oldProc.exited.then(() => true), sleep(60_000).then(() => false)])
  if (!exited) {
    const pages = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)
      .then((r) => r.json() as Promise<Target[]>)
      .catch(() => [] as Target[])
    const visible = await cdp.eval<string>('document.visibilityState').catch(() => 'unknown')
    check('restart quits the app', false, `pid ${oldProc.pid} still alive 60s after restart; renderer ${visible}; pages ${pages.length}; this is the stall`)
    cdp.close()
    oldProc.kill('SIGTERM')
    await Promise.race([oldProc.exited, sleep(10_000)])
    if (!(await pidsAt(APP)).length) log('old app killed')
    throw new Error('stall')
  }
  check('restart quits the app', true, `exited ${((Date.now() - restartAt) / 1000).toFixed(1)}s after apply`)

  // ShipIt copies the staged bundle, verifies the copy against the running
  // app's designated requirement, swaps Contents, and relaunches.
  const swapUntil = Date.now() + 180_000
  let plistVersion = ''
  while (Date.now() < swapUntil) {
    plistVersion = (await sh(['plutil', '-extract', 'CFBundleShortVersionString', 'raw', join(APP, 'Contents', 'Info.plist')], { quiet: true }).catch(() => '')).trim()
    if (plistVersion === NEW) break
    await sleep(1000)
  }
  check(`bundle on disk is ${NEW}`, plistVersion === NEW, `Info.plist says "${plistVersion}" ${((Date.now() - restartAt) / 1000).toFixed(0)}s after restart`)

  relaunched = await attach(120_000).catch((e) => {
    check('ShipIt relaunched the app', false, e.message)
    return null
  })
  if (relaunched) {
    const version = await relaunched.eval<string>('window.api.app.version()')
    check(`relaunched app answers ${NEW}`, version === NEW, version)
    const status2 = await relaunched.eval<Status>('window.api.updates.get()')
    check('relaunched app reports no pending update', status2.current === NEW && status2.phase !== 'error', JSON.stringify(status2))
  }

  const shipItLog = existsSync(SHIPIT_LOG) ? readFileSync(SHIPIT_LOG, 'utf8') : ''
  const bad = shipItLog.split('\n').filter((l) => /Installation error|did not pass validation|App Still Running|Installation cancelled|Too many attempts/.test(l))
  check('ShipIt log shows a clean install', shipItLog.length > 0 && bad.length === 0, bad.length ? bad.join(' | ').slice(0, 600) : `${shipItLog.split('\n').filter(Boolean).length} lines`)
  console.log('---- ShipIt_stderr.log')
  console.log(shipItLog.trim())
  console.log('----')
} catch (e) {
  if ((e as Error).message !== 'stall') check('e2e run', false, (e as Error).message)
} finally {
  relaunched?.close()
  await killAt(APP)
  await tryRun(['launchctl', 'remove', SHIPIT_LABEL])
  server.stop(true)
}

log(`artifacts under ${ROOT}; old app log ${appLog}; ShipIt log ${SHIPIT_LOG}`)
console.log(failures === 0 ? 'E2E UPDATER: PASS' : `E2E UPDATER: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
