/**
 * Add-on grants end to end (plan-8YMm3ynnFZYs.md §11; CLAUDE.md "Add-on
 * grants"). Two isolated headless instances of the BUILT tree, paired,
 * driven over their local sockets, with the fake MCP sign-in server
 * (scripts/lib/fakeOAuthServer.ts) on loopback:
 *
 *  "mac": TEMP_CODE_BUILD_PLATFORM=darwin, TEMP_CODE_OAUTH_BROWSER=follow
 *  (the authorize redirect followed to the callback, the browser it lacks);
 *  "box": linux, the settings home. Each its own vault
 *  (TEMP_CODE_ALIAX_DATA_DIR), a dead provider, its own remote port, no
 *  TEMP_CODE_ADDON_GRANTS (the grants are the vault's).
 *
 *   1. a person adds fakeoauth on the box; mac follows; both read needs-grant
 *   2. no browser on the box: its own sign-in is refused, and mac's key may not ask it
 *   3. mac signs in: every step pushed, one registration on the fixed
 *      redirect, the grant handed to the box, which refreshes it; mac keeps
 *      an access copy with the client and port; both ready, whoami equal
 *   4. the box refreshes ahead of the end; mac follows by the push, never
 *      presenting a refresh token
 *   5. a revoked token: the box refreshes on its own 401; mac's 401 asks the box
 *   6. three more rotations: mac follows each within 5 s, whoami never fails
 *   7. a sign-in again reuses the client and port; the port taken is named
 *   8. values: refused by the probe, saved static, landing on mac; mac's
 *      write forwarded to the box
 *   9. the box offline at a sign-in: mac owns and refreshes it, mac's
 *      values write refused; the box back, the grant is handed to it again
 *  10. tombstones: a cleared values grant and a removed add-on leave both vaults
 *  11. no token, code or key the fake saw in any log
 *  12. cleanup (TC_GRANTS_KEEP=1 keeps the temp dir)
 *
 * Run: bun run script:e2e-addon-grants   (after one `electron-vite build`)
 * --gate waits for the gate build; no app build runs here. All children
 * are killed on normal exit, signals and uncaught errors.
 * Nothing here touches /Applications/TempCode.app, the real Aliax vault, the
 * gateway marker or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// Bun on the Mac has no node:sqlite; the root export also loads usage storage.
import { configure } from 'aliax-core/config'
import * as vault from 'aliax-core/vault'
import { startFakeOAuthServer } from './lib/fakeOAuthServer'

import { proofElectron } from './lib/proofElectron'
import { waitForGateBuild } from './lib/gateBuild'
import { proofCleanup } from './lib/proofCleanup'

const REPO = resolve(import.meta.dir, '..')
const GATE = process.argv.includes('--gate')
const KEEP = process.env.TC_GRANTS_KEEP === '1'
const LIFETIME_SEC = 20
const out: string[] = []
let failures = 0
const say = (line: string): void => {
  out.push(line)
  console.log(line)
}
const check = (name: string, ok: boolean, detail = ''): boolean => {
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => say(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const started = Date.now()
const timings: string[] = []
let stepAt = Date.now()
const step = (name: string): void => {
  const now = Date.now()
  if (timings.length) timings[timings.length - 1] += ` ${((now - stepAt) / 1000).toFixed(1)} s`
  timings.push(name)
  stepAt = now
  say(`── ${name}`)
}

if (GATE) await waitForGateBuild({ tree: REPO, log })

if (!existsSync(join(REPO, 'out', 'main', 'index.js')) || !existsSync(join(REPO, 'out', 'main', 'addonHost.js'))) {
  console.error('out/main is missing or has no addonHost.js: run electron-vite build first')
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
  const d = mkdtempSync(join(tmpdir(), 'tc-grants-e2e-'))
  return realpathSync(d)
})()
const owned = proofCleanup(root)

type Inst = { name: string; home: string; data: string; tmp: string; work: string; remote: number; log: string; proc?: ChildProcess; platform: 'darwin' | 'linux' }
const mk = async (name: string, platform: 'darwin' | 'linux'): Promise<Inst> => {
  const inst: Inst = {
    name,
    platform,
    home: join(root, `${name}-home`),
    data: join(root, `${name}-data`),
    tmp: join(root, `${name}-tmp`),
    work: join(root, `${name}-work`),
    remote: await freePort(),
    log: join(root, `${name}.log`)
  }
  for (const d of [inst.data, inst.tmp, inst.work, inst.home]) mkdirSync(d, { recursive: true })
  return inst
}
const aliaxDir = (inst: Inst): string => join(inst.data, 'aliax')

const baseEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !k.startsWith('TEMP_CODE_') && !k.startsWith('CLAUDE') && k !== 'ANTHROPIC_BASE_URL'))

function launch(inst: Inst): void {
  const env: Record<string, string> = {
    ...baseEnv(),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WORK_ROOT: inst.work,
    TEMP_CODE_BUILD_PLATFORM: inst.platform,
    TEMP_CODE_ADDON_TRACE: '1',
    TEMP_CODE_ALIAX_DATA_DIR: aliaxDir(inst),
    TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ...(inst.platform === 'darwin' ? { TEMP_CODE_OAUTH_BROWSER: 'follow' } : {})
  }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = proofElectron(REPO)
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  rmSync(join(inst.data, 'server.json'), { force: true })
  const proc = spawn(argv[0]!, argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  owned.track(proc, true)
  inst.proc = proc
}
const logOf = (inst: Inst): string => (existsSync(inst.log) ? readFileSync(inst.log, 'utf8') : '')
const count = (text: string, needle: string): number => text.split(needle).length - 1
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(250)
  }
  log(`timed out: ${label}`)
  return false
}
const portOf = (inst: Inst): number => (JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }).port

async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
    }, timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(frame.error))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`${inst.name}: socket error on ${method}`))
    })
  })
}
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return '(answered)'
  } catch (err) {
    return (err as Error).message
  }
}

interface GrantView {
  addonId: string
  fields: { name: string; set: boolean }[]
  oauth: { signedIn: boolean; expiresAt: number | null; refreshedBy: string | null; refused: boolean } | null
  signIn: { state: string; port?: number; error?: string } | null
  gaps: string[]
}
/** A socket kept open on the instance: every addon-grants push it hears, in order. */
function grantPushes(inst: Inst): { seen: GrantView[][]; close(): void } {
  const seen: GrantView[][] = []
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as { push?: string; grants?: GrantView[] }
    if (frame.push === 'addon-grants' && frame.grants) seen.push(frame.grants)
  })
  return { seen, close: () => ws.close() }
}

interface AddonsList {
  addons: { id: string; name: string; workspaceId: string | null }[]
  status: Record<string, { state: string; tools: number; detail?: string }>
}
const list = (inst: Inst): Promise<AddonsList> => rpc<AddonsList>(inst, 'addons.list', {})
const statusOf = async (inst: Inst, name: string): Promise<{ state: string; tools: number; detail?: string } | null> => {
  const l = await list(inst)
  const row = l.addons.find((a) => a.name === name)
  return row ? (l.status[row.id] ?? null) : null
}
const text = (r: { content?: { type: string; text?: string }[] }): string => (r.content ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n')
const whoami = async (inst: Inst, sessionId: string): Promise<string> => {
  try {
    const r = await rpc<{ content: { type: string; text?: string }[]; isError?: boolean }>(inst, 'app.addonCall', { sessionId, tool: 'fakeoauth__whoami' }, 60_000)
    return r.isError ? `error: ${text(r)}` : text(r)
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

interface VaultGrant {
  owner?: string
  static?: boolean
  blob: { fields: Record<string, string>; oauth?: { clientId: string; redirectPort: number; accessToken?: string; refreshToken?: string } } | null
}
/** One add-on profile in an instance's vault, read with the vault's own key file. */
function vaultGrant(inst: Inst, addonId: string): VaultGrant | null {
  configure({ dataDir: aliaxDir(inst), fetch: async () => Promise.reject(new Error('no fetch here')), secrets: { mode: 'fileKey' } })
  const p = vault.profiles('addon').find((x) => x.name === addonId)
  if (!p) return null
  let blob: VaultGrant['blob'] = null
  try {
    const raw = vault.readSecret('addon', addonId)
    blob = raw ? JSON.parse(raw) : null
  } catch {
    blob = null
  }
  return { owner: p.owner, static: p.static, blob }
}
const accessOf = (inst: Inst, id: string): string | undefined => vaultGrant(inst, id)?.blob?.oauth?.accessToken

function kill(inst: Inst): void {
  if (!inst.proc?.pid) return
  try {
    process.kill(-inst.proc.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
}
async function down(inst: Inst): Promise<void> {
  kill(inst)
  await sleep(1500)
  try {
    if (inst.proc?.pid) process.kill(-inst.proc.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
  inst.proc = undefined
}
const bind = (port: number): Promise<Server> =>
  new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(port, '127.0.0.1', () => ok(s))
  })

const fake = await startFakeOAuthServer({ lifetimeSec: LIFETIME_SEC, oneGrantPerClient: true, logFile: join(root, 'fake.log') })
const mac = await mk('mac', 'darwin')
const box = await mk('box', 'linux')
const instances = [mac, box]
const cleanup = async (): Promise<void> => {
  for (const inst of instances) kill(inst)
  await sleep(1500)
  for (const inst of instances) await down(inst)
  await fake.close()
  owned.stop()
}
const tokenEvents = (grantType: string) => fake.events.filter((e) => e.kind === 'token' && e.grantType === grantType && e.ok)
const registrations = () => fake.events.filter((e) => e.kind === 'register')
const authorizes = () => fake.events.filter((e) => e.kind === 'authorize') as { redirectUri: string }[]
const oauthSpec = { transport: 'http', url: fake.mcpUrl, headers: [], auth: 'oauth' }

try {
  // ── the pair ─────────────────────────────────────────────────────────
  step('pair')
  const macProj = join(mac.work, 'proj')
  const boxProj = join(box.work, 'proj')
  for (const dir of [macProj, boxProj]) {
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'master', dir])
  }
  launch(mac)
  launch(box)
  const up = (await until('mac up', 90_000, () => existsSync(join(mac.data, 'server.json')))) && (await until('box up', 90_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both headless instances published their local socket', up)) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const macId = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxId = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  const boxWs = await rpc<{ id: string }>(box, 'workspace.create', { path: boxProj, name: 'proj' })
  const boxProject = await rpc<{ id: string }>(box, 'project.create', { workspaceId: boxWs.id, name: 'proj', mode: 'local' })
  const macWs = await rpc<{ id: string }>(mac, 'workspace.create', { path: macProj, name: 'proj' })
  const macProject = await rpc<{ id: string }>(mac, 'project.create', { workspaceId: macWs.id, name: 'proj', mode: 'local' })
  const key = await rpc<{ id: string; token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  check("box logged mac's registration", await until('mac registers on box', 60_000, () => logOf(box).includes(`[peer-calls] ${macId} registered`)))
  check('the two workspaces are linked', await until('linked', 60_000, async () => {
    const [m, b] = await Promise.all([rpc<{ id: string; linkId?: string | null }[]>(mac, 'workspace.list'), rpc<{ id: string; linkId?: string | null }[]>(box, 'workspace.list')])
    const mw = m.find((w) => w.id === macWs.id)
    return !!mw?.linkId && mw.linkId === b.find((w) => w.id === boxWs.id)?.linkId
  }))
  check("mac routes the linked workspace's add-ons to the box", await until('the home is the box', 60_000, async () => (await rpc<{ home: { name: string } | null }>(mac, 'addons.list', { workspaceId: macWs.id })).home?.name === 'box'))

  // ── 1. add fakeoauth on the box ─────────────────────────────────────
  step('1 add')
  const added = await rpc<{ addon: { id: string } }>(box, 'addons.set', { addon: { name: 'fakeoauth', workspaceId: boxWs.id, spec: oauthSpec } })
  const fakeId = added.addon.id
  check('mac follows the row', await until('mac follows', 30_000, async () => (await list(mac)).addons.some((a) => a.id === fakeId)))
  check(
    'both read needs-grant: Needs a sign-in on the Mac',
    await until('needs-grant', 30_000, async () => (await statusOf(mac, 'fakeoauth'))?.detail === 'Needs a sign-in on the Mac' && (await statusOf(box, 'fakeoauth'))?.detail === 'Needs a sign-in on the Mac')
  )
  const boxView = (await rpc<{ grants: GrantView[] }>(box, 'addons.grant.list')).grants.find((g) => g.addonId === fakeId)
  check('the box lists the grant with no sign-in and the sign-in as its gap', boxView?.oauth === null && JSON.stringify(boxView.gaps) === '["sign-in"]', JSON.stringify(boxView))

  // ── 2. no browser on the box ─────────────────────────────────────────
  step('2 no browser')
  check("the box's own sign-in is refused: no browser", (await refusal(rpc(box, 'addons.grant.signIn', { id: fakeId }))) === 'Sign in on the Mac: this host has no browser')
  const ticket = (await (await fetch(`http://127.0.0.1:${box.remote}/api/ticket`, { method: 'POST', headers: { authorization: `Bearer ${key.token}` } })).json()) as { ticket: string }
  const gated = await new Promise<string>((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${box.remote}/ws?ticket=${ticket.ticket}`)
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { push?: string; id?: string; ok?: boolean; error?: string }
      if (frame.push === 'hello') ws.send(JSON.stringify({ id: 'g', method: 'addons.grant.signIn', params: { id: fakeId } }))
      if (frame.id === 'g') {
        ws.close()
        ok(frame.ok ? 'answered' : (frame.error ?? ''))
      }
    })
    ws.addEventListener('error', () => ok('socket error'))
  })
  check("mac's remote key may not ask the box to sign in (local)", gated.startsWith('forbidden'), gated)

  // ── 3. sign in on mac ────────────────────────────────────────────────
  step('3 sign in')
  const macPushes = grantPushes(mac)
  await sleep(300)
  const signedIn = await rpc<{ started: boolean; port: number }>(mac, 'addons.grant.signIn', { id: fakeId })
  const port = signedIn.port
  check('the sign-in answers its port', signedIn.started && port >= 1024)
  check('it finishes: signIn back to null with a sign-in on file', await until('signed in', 30_000, () => macPushes.seen.some((g) => g.find((v) => v.addonId === fakeId)?.oauth?.signedIn && g.find((v) => v.addonId === fakeId)?.signIn === null)))
  const states = macPushes.seen.map((g) => g.find((v) => v.addonId === fakeId)?.signIn?.state ?? null).filter((s, i, all) => s !== all[i - 1])
  check('the pushes ran discovering, registering, waiting, exchanging, then none', JSON.stringify(states.slice(states.indexOf('discovering'))) === JSON.stringify(['discovering', 'registering', 'waiting', 'exchanging', null]), JSON.stringify(states))
  check('one registration, on http://127.0.0.1:<port>/callback', registrations().length === 1 && JSON.stringify((registrations()[0] as { redirectUris: string[] }).redirectUris) === JSON.stringify([`http://127.0.0.1:${port}/callback`]))
  const handedAt = Date.now()
  check(
    'within 10 s the box holds it provisionally, then refreshes it; mac says the box does',
    await until('the handoff', 10_000, () => logOf(box).includes(`addon ${fakeId}: handoff from ${macId} landed`) && logOf(box).includes(`addon ${fakeId}: ${macId} released it; refreshed here now`) && logOf(mac).includes(`addon ${fakeId}: now refreshed by box`))
  )
  log(`handoff landed in ${((Date.now() - handedAt) / 1000).toFixed(1)} s`)
  const macGrant = vaultGrant(mac, fakeId)
  const boxGrant = vaultGrant(box, fakeId)
  check("mac's copy keeps the client and port, no refresh token, owned by the box", !!macGrant?.blob?.oauth?.clientId && macGrant.blob.oauth.redirectPort === port && !macGrant.blob.oauth.refreshToken && macGrant.owner === boxId, JSON.stringify({ owner: macGrant?.owner, port: macGrant?.blob?.oauth?.redirectPort }))
  check("the box's grant has the refresh token and is its own", !!boxGrant?.blob?.oauth?.refreshToken && boxGrant.owner === boxId)
  check('both ready', await until('ready on both', 30_000, async () => (await statusOf(mac, 'fakeoauth'))?.state === 'ready' && (await statusOf(box, 'fakeoauth'))?.state === 'ready'))
  const boxThread = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', projectId: boxProject.id, title: 'Calls the add-on', threadType: 'chat', permission: 'auto' })
  const macThread = await rpc<{ id: string }>(mac, 'session.create', { provider: 'claude', projectId: macProject.id, title: 'Calls the add-on', threadType: 'chat', permission: 'auto' })
  const firstPrefix = fake.prefix(accessOf(box, fakeId) ?? '')
  check('whoami answers the same prefix on both hosts', (await whoami(box, boxThread.id)) === firstPrefix && (await whoami(mac, macThread.id)) === firstPrefix)

  // ── 4. the box refreshes; mac follows ────────────────────────────────
  step('4 box refreshes')
  const refreshesBefore = tokenEvents('refresh_token').length
  check('the fake logs a refresh_token grant within the token life', await until('a refresh', (LIFETIME_SEC + 10) * 1000, () => tokenEvents('refresh_token').length > refreshesBefore))
  const rotated = accessOf(box, fakeId)
  let macHeldRefresh = false
  check('within 5 s mac holds the same access token, by the push', await until('mac follows', 5_000, () => {
    if (vaultGrant(mac, fakeId)?.blob?.oauth?.refreshToken) macHeldRefresh = true
    return accessOf(mac, fakeId) === rotated
  }))
  check('mac never held a refresh token, and never refreshed', !macHeldRefresh && !logOf(mac).includes('refreshed now'))
  const rotatedPrefix = fake.prefix(rotated ?? '')
  check('whoami answers the new prefix on both', await until('new prefix', 15_000, async () => (await whoami(box, boxThread.id)) === rotatedPrefix && (await whoami(mac, macThread.id)) === rotatedPrefix))

  // ── 5. the 401 path ──────────────────────────────────────────────────
  step('5 401 on each host')
  const beforeBox = accessOf(box, fakeId)
  fake.revokeAccess()
  const firstBox = await whoami(box, boxThread.id)
  log(`the box's call after the revoke: ${firstBox.startsWith('error') ? 'refused' : firstBox}`)
  check('the box refreshes on its own 401 and answers again with a new token', await until('box recovers', 30_000, async () => {
    const now = accessOf(box, fakeId)
    return !!now && now !== beforeBox && (await whoami(box, boxThread.id)) === fake.prefix(now)
  }))
  check("the box's log says it refreshed after the refusal", logOf(box).includes('fakeoauth: refreshed now, after the server refused it'))
  check('its status is ready again', (await statusOf(box, 'fakeoauth'))?.state === 'ready')
  const forcedAt = Date.now()
  await sleep(Math.max(0, 31_000 - (Date.now() - forcedAt)))
  const forcedBefore = count(logOf(box), 'fakeoauth: refreshed now, after the server refused it')
  const beforeMac = accessOf(mac, fakeId)
  fake.revokeAccess()
  const firstMac = await whoami(mac, macThread.id)
  log(`mac's call after the revoke: ${firstMac.startsWith('error') ? 'refused' : firstMac}`)
  check('mac asks the box, the box refreshes, and mac answers again with the new token', await until('mac recovers', 30_000, async () => {
    const now = accessOf(mac, fakeId)
    return !!now && now !== beforeMac && (await whoami(mac, macThread.id)) === fake.prefix(now)
  }))
  check("mac's log names the ask and the box's names the refresh", logOf(mac).includes('fakeoauth: the server refused its copy; asking box to refresh it') && count(logOf(box), 'fakeoauth: refreshed now, after the server refused it') > forcedBefore)

  // ── 6. mac follows the box ───────────────────────────────────────────
  step('6 three rotations')
  let followed = 0
  let callFailures = 0
  let lastBox = accessOf(box, fakeId)
  const lags: number[] = []
  const end = Date.now() + (3 * LIFETIME_SEC + 20) * 1000
  while (followed < 3 && Date.now() < end) {
    const now = accessOf(box, fakeId)
    if (now && now !== lastBox) {
      const at = Date.now()
      const ok = await until('mac follows a rotation', 5_000, () => accessOf(mac, fakeId) === now)
      if (ok) {
        followed++
        lags.push(Date.now() - at)
      }
      lastBox = now
    }
    if ((await whoami(mac, macThread.id)).startsWith('error')) callFailures++
    await sleep(1_000)
  }
  check('over three rotations mac holds the box\'s token within 5 s of each', followed === 3, `${followed} followed`)
  check("whoami on mac never failed meanwhile", callFailures === 0, `${callFailures} failures`)
  log(`mac followed in ${lags.map((l) => `${l} ms`).join(', ')}`)

  // ── 7. sign in again ─────────────────────────────────────────────────
  step('7 sign in again')
  const releasedBefore = count(logOf(box), `addon ${fakeId}: ${macId} released it; refreshed here now`)
  const again = await rpc<{ port: number }>(mac, 'addons.grant.signIn', { id: fakeId })
  check('a sign-in again registers nothing and authorizes on the same port', again.port === port && registrations().length === 1 && authorizes().at(-1)?.redirectUri === `http://127.0.0.1:${port}/callback`)
  check('the newer grant goes to the box again', await until('handed again', 15_000, () => count(logOf(box), `addon ${fakeId}: ${macId} released it; refreshed here now`) > releasedBefore && vaultGrant(mac, fakeId)?.owner === boxId))
  await until('the sign-in settles', 10_000, async () => (await rpc<{ grants: GrantView[] }>(mac, 'addons.grant.list')).grants.find((g) => g.addonId === fakeId)?.signIn === null)
  const holder = await bind(port)
  const taken = await refusal(rpc(mac, 'addons.grant.signIn', { id: fakeId }))
  const takenView = (await rpc<{ grants: GrantView[] }>(mac, 'addons.grant.list')).grants.find((g) => g.addonId === fakeId)
  holder.close()
  const takenLine = `Port ${port} is in use on this Mac; close what holds it, then sign in again`
  check('the port held: the sign-in names it, and nothing registers', taken === takenLine && takenView?.signIn?.error === takenLine && registrations().length === 1, `${taken} / ${JSON.stringify(takenView?.signIn)}`)

  // ── 8. values ────────────────────────────────────────────────────────
  step('8 values')
  fake.set({ apiKey: 'grant-e2e-key-one' })
  const keyed = await rpc<{ addon: { id: string } }>(box, 'addons.set', { addon: { name: 'fakekey', workspaceId: boxWs.id, spec: { transport: 'http', url: fake.keyedUrl, headers: ['X-Api-Key'], auth: 'fields' } } })
  const keyId = keyed.addon.id
  await until('mac follows fakekey', 30_000, async () => (await list(mac)).addons.some((a) => a.id === keyId))
  check('a wrong value is refused by the probe and nothing is saved', (await refusal(rpc(box, 'addons.grant.setFields', { id: keyId, fields: { 'X-Api-Key': 'grant-e2e-wrong-key' } }))) === 'The server refused these values' && vaultGrant(box, keyId) === null)
  await rpc(box, 'addons.grant.setFields', { id: keyId, fields: { 'X-Api-Key': 'grant-e2e-key-one' } })
  check('the right value saves a static grant on the box', vaultGrant(box, keyId)?.static === true)
  check('mac lands it and both read ready', await until('values on mac', 30_000, async () => vaultGrant(mac, keyId)?.blob?.fields['X-Api-Key'] === 'grant-e2e-key-one' && (await statusOf(mac, 'fakekey'))?.state === 'ready' && (await statusOf(box, 'fakekey'))?.state === 'ready'))
  fake.set({ apiKey: 'grant-e2e-key-two' })
  const savedOnBox = count(logOf(box), 'fakekey: values X-Api-Key saved')
  const savedOnMac = count(logOf(mac), 'fakekey: values X-Api-Key saved')
  await rpc(mac, 'addons.grant.setFields', { id: keyId, fields: { 'X-Api-Key': 'grant-e2e-key-two' } })
  check("mac's write ran on the box, not here", count(logOf(box), 'fakekey: values X-Api-Key saved') === savedOnBox + 1 && count(logOf(mac), 'fakekey: values X-Api-Key saved') === savedOnMac)
  check('the new value reaches mac', await until('key two on mac', 15_000, () => vaultGrant(mac, keyId)?.blob?.fields['X-Api-Key'] === 'grant-e2e-key-two'))

  // ── 9. the box offline at a sign-in ──────────────────────────────────
  step('9 box offline')
  await down(box)
  // The link notices the close at once; give it a moment.
  await sleep(3_000)
  await rpc(mac, 'addons.grant.signIn', { id: fakeId })
  check('mac owns the grant it signed in with', await until('mac owns', 15_000, () => {
    const g = vaultGrant(mac, fakeId)
    return !!g && g.owner === undefined && !!g.blob?.oauth?.refreshToken
  }))
  const macRefreshAt = tokenEvents('refresh_token').length
  check("mac's keeper refreshes it", await until('mac refreshes', (LIFETIME_SEC + 10) * 1000, () => tokenEvents('refresh_token').length > macRefreshAt && !!vaultGrant(mac, fakeId)?.blob?.oauth?.refreshToken))
  check("mac's values write is refused while the box is offline", (await refusal(rpc(mac, 'addons.grant.setFields', { id: keyId, fields: { 'X-Api-Key': 'grant-e2e-key-three' } }))) === 'refused: grants of fakekey live on box; it is offline')
  const releasedBeforeRestart = count(logOf(box), `addon ${fakeId}: ${macId} released it; refreshed here now`)
  launch(box)
  check('the box is back', await until('box up again', 90_000, () => existsSync(join(box.data, 'server.json'))))
  check('at the link-up the grant is handed to the box again', await until('handed after restart', 60_000, () => count(logOf(box), `addon ${fakeId}: ${macId} released it; refreshed here now`) > releasedBeforeRestart && vaultGrant(mac, fakeId)?.owner === boxId))

  // ── 10. tombstones ───────────────────────────────────────────────────
  step('10 tombstones')
  check('clearing the values on the box answers true', (await rpc<{ cleared: boolean }>(box, 'addons.grant.clear', { id: keyId })).cleared === true)
  check("mac's copy is gone within 5 s and both read needs-grant", await until('values gone', 5_000, () => vaultGrant(mac, keyId) === null) && (await until('needs-grant again', 15_000, async () => (await statusOf(mac, 'fakekey'))?.state === 'needs-grant' && (await statusOf(box, 'fakekey'))?.state === 'needs-grant')))
  await rpc(box, 'addons.remove', { id: fakeId })
  check('the removed add-on takes its grant from the box at once', await until('grant gone on the box', 5_000, () => vaultGrant(box, fakeId) === null))
  check('and from mac', await until('grant gone on mac', 30_000, () => vaultGrant(mac, fakeId) === null))
  check('neither add-on host runs it', await until('gone from both', 30_000, async () => !(await list(mac)).addons.some((a) => a.id === fakeId) && !(await list(box)).addons.some((a) => a.id === fakeId)))

  // ── 11. no value in any log ──────────────────────────────────────────
  step('11 logs')
  const secrets = [...fake.issued(), 'grant-e2e-key-one', 'grant-e2e-key-two', 'grant-e2e-key-three', 'grant-e2e-wrong-key']
  const stalls = (inst: Inst): string => {
    const p = join(inst.data, 'logs', 'stalls.log')
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }
  const texts: [string, string][] = [
    ['mac.log', logOf(mac)],
    ['box.log', logOf(box)],
    ['mac stalls.log', stalls(mac)],
    ['box stalls.log', stalls(box)],
    ['this run', out.join('\n')]
  ]
  const leaks = texts.flatMap(([where, body]) => secrets.filter((s) => s.length >= 8 && body.includes(s)).map((s) => `${where} holds ${s.slice(0, 6)}…`))
  check(`none of the ${secrets.length} tokens, codes and keys appears in a log`, leaks.length === 0, leaks.join('; '))

  // ── 12. cleanup ──────────────────────────────────────────────────────
  step('12 cleanup')
  for (const [inst, ids] of [
    [box, [boxThread.id]],
    [mac, [macThread.id]]
  ] as const) {
    for (const id of ids) await rpc(inst, 'session.archive', { sessionId: id, archived: true }).catch(() => {})
  }
  await rpc(box, 'remote.keys.revoke', { id: key.id }).catch(() => {})
  macPushes.close()
} catch (err) {
  check('the run finished', false, (err as Error).stack ?? String(err))
} finally {
  step('done')
  await cleanup()
  say(`timings: ${timings.slice(0, -1).join(', ')}`)
  say(`total ${((Date.now() - started) / 1000).toFixed(0)} s; logs ${KEEP ? root : '(removed)'}`)
  if (!KEEP) rmSync(root, { recursive: true, force: true })
  say(failures ? `${failures} FAILED` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
}
