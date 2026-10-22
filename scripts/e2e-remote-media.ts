/**
 * A box thread's image opens on the Mac, for real: two isolated headless
 * instances of the BUILT tree (out/main), launched the way
 * scripts/e2e-harness-sync.ts launches them (own HOME, userData, TMPDIR and
 * fixed port; on Linux under xvfb-run and a private D-Bus). "box" holds a
 * PNG in a workspace of its own and mints its media URL; "mac" is paired to
 * box with an admin key, the way the desktop's link to the box is. The
 * desktop's <img> loads a tempcode-asset://file/… URL through the asset
 * handler (src/main/assets.ts); here the same handler answers on mac's
 * fixed port as /asset/file/… under a client key, so the proof reads what
 * the desktop would:
 *  - box's URL names box (`&host=<its environment id>`)
 *  - mac serves that URL byte for byte over the peer link, a Range as 206
 *    with those bytes, a suffix range too, HEAD with no body
 *  - the same token without the host (what every URL carried before) is
 *    404 on mac: its own table never had it
 *  - a token box never minted is 404, and once box is gone the URL is 503
 *    with the reason
 *  - box serves its own URL from its own table (the `/ui` web mode case)
 * Run: bun scripts/e2e-remote-media.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_MEDIA_KEEP === '1'
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run electron-vite build first')
  process.exit(2)
}
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

const root = (() => {
  const d = mkdtempSync(join(tmpdir(), 'tc-media-e2e-'))
  return Bun.spawnSync(['realpath', d]).stdout.toString().trim() || d
})()
type Inst = { name: string; home: string; data: string; tmp: string; remote: number; log: string; proc?: ChildProcess }
const mk = async (name: string): Promise<Inst> => {
  const inst = { name, home: join(root, `${name}-home`), data: join(root, `${name}-data`), tmp: join(root, `${name}-tmp`), remote: await freePort(), log: join(root, `${name}.log`) }
  for (const d of [inst.home, inst.data, inst.tmp]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac')
const box = await mk('box')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(3 * 1024 * 1024 + 123)])
const work = join(root, 'box-work')
mkdirSync(join(work, 'shots'), { recursive: true })
writeFileSync(join(work, 'shots', 'screen.png'), PNG)

function launch(inst: Inst): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WARM_HARNESS: '0',
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  const proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc
}
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(300)
  }
  log(`timed out: ${label}`)
  return false
}

/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}): Promise<T> {
  const { port } = JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
    }, 120_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(`${inst.name}: ${method}: ${frame.error}`))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`${inst.name}: socket error on ${method}`))
    })
  })
}

function kill(inst: Inst): void {
  if (!inst.proc?.pid) return
  try {
    process.kill(-inst.proc.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
}
const cleanup = async (): Promise<void> => {
  kill(mac)
  kill(box)
  await sleep(1500)
  for (const inst of [mac, box]) {
    try {
      if (inst.proc?.pid) process.kill(-inst.proc.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

/** `/asset/<rest>` on an instance's fixed port under a client key: what the desktop's <img> gets through the asset scheme. */
const asset = (inst: Inst, key: string, rest: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${inst.remote}/asset/${rest}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${key}` } })

try {
  launch(mac)
  launch(box)
  const up = (await until('mac up', 90_000, () => existsSync(join(mac.data, 'server.json')))) && (await until('box up', 90_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both headless instances published their local socket', up)) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const boxEnv = (JSON.parse(readFileSync(join(box.data, 'environment.json'), 'utf8')) as { id: string }).id

  // ── 1. box: a workspace holding the image, and its media URL ──
  await rpc(box, 'workspace.create', { path: work, name: 'work' })
  const media = await rpc<{ kind: string; mime: string; url: string; size: number } | null>(box, 'fs.media', { path: join(work, 'shots', 'screen.png') })
  check('box describes the PNG as media with a token URL', media?.kind === 'image' && media.mime === 'image/png' && media.size === PNG.length, media?.url)
  const url = new URL(media!.url)
  check('the URL names box as the host', url.searchParams.get('host') === boxEnv, `${url.searchParams.get('host')} vs ${boxEnv}`)
  const rest = `file${url.pathname}${url.search}`
  const restNoHost = `file${url.pathname}?v=${url.searchParams.get('v')}`

  // ── 2. pair: box issues an admin key, mac saves box ──
  const admin = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: admin.token, name: 'The box' })
  type Status = { environments: { id: string; connected: boolean }[] }
  const linked = await until('mac links to box', 60_000, async () => (await rpc<Status>(mac, 'harness.status')).environments.some((e) => e.id === boxEnv && e.connected))
  check('mac holds a live peer link to box', linked)
  const macKey = (await rpc<{ token: string }>(mac, 'remote.keys.create', { name: 'phone (e2e)', audience: 'client', caps: ['read'] })).token
  const boxKey = (await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'phone (e2e)', audience: 'client', caps: ['read'] })).token

  // ── 3. mac serves box's URL over the peer link ──
  const whole = await asset(mac, macKey, rest)
  const body = Buffer.from(await whole.arrayBuffer())
  check('mac streams the whole PNG from box, byte for byte', whole.status === 200 && body.equals(PNG), `${whole.status} ${whole.headers.get('Content-Type')} ${body.length} bytes`)
  check('with the headers a viewer needs', whole.headers.get('Content-Type') === 'image/png' && whole.headers.get('Content-Length') === String(PNG.length) && whole.headers.get('Accept-Ranges') === 'bytes')
  const part = await asset(mac, macKey, rest, { headers: { Range: 'bytes=4-7' } })
  check('a Range answers 206 with exactly those bytes', part.status === 206 && Buffer.from(await part.arrayBuffer()).equals(PNG.subarray(4, 8)), part.headers.get('Content-Range') ?? '')
  const tail = await asset(mac, macKey, rest, { headers: { Range: 'bytes=-5' } })
  check('a suffix range answers the last bytes', tail.status === 206 && Buffer.from(await tail.arrayBuffer()).equals(PNG.subarray(-5)))
  const head = await asset(mac, macKey, rest, { method: 'HEAD' })
  check('HEAD carries the size and no body', head.status === 200 && head.headers.get('Content-Length') === String(PNG.length) && (await head.arrayBuffer()).byteLength === 0)

  // ── 4. the failures, named ──
  const bare = await asset(mac, macKey, restNoHost)
  check('the same token without the host is not found on mac (the old URL shape)', bare.status === 404, String(bare.status))
  const fake = await asset(mac, macKey, `file/${'0'.repeat(32)}/screen.png?v=1&host=${boxEnv}`)
  check('a token box never minted is not found', fake.status === 404, String(fake.status))
  const own = await asset(box, boxKey, rest)
  check('box serves its own URL from its own table', own.status === 200 && Buffer.from(await own.arrayBuffer()).equals(PNG), String(own.status))

  kill(box)
  await until('box gone', 30_000, async () => !(await rpc<Status>(mac, 'harness.status')).environments.some((e) => e.id === boxEnv && e.connected))
  const down = await asset(mac, macKey, rest)
  check('with box out of reach the URL answers 503 with the reason', down.status === 503 && /not reachable/.test(await down.clone().text()), `${down.status} ${(await down.text()).slice(0, 80)}`)
} catch (err) {
  check('the proof ran to the end', false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
