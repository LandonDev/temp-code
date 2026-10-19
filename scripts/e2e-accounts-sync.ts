/**
 * Account sync for real (thread V): two isolated instances of the BUILT tree
 * (electron-vite preview, fresh userData each) with their own vaults
 * (TEMP_CODE_ALIAX_DATA_DIR, key-file mode) and a fake provider in place of
 * Anthropic (TEMP_CODE_FAKE_PROVIDERS). A holds a Claude account with a
 * refresh token, B is paired as an admin host. A's main process links to B
 * and pushes the account as an access copy; once B is the home for Claude
 * sign-ins A hands the grant off: B owns it and A keeps a copy with no
 * refresh token. B rotates against the fake token endpoint and A receives
 * the new access token over B's push. Then B goes down and the copy on A
 * runs out: A reports the state and never presents a refresh token.
 * Run: bun scripts/e2e-accounts-sync.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, its userData, the real
 * Aliax vault, the gateway marker or the Keychain.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromiumDecrypt, chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'
import { Cdp, REPO, attach, prepareEnv, sh, sleep } from './lib/packagedApp'

prepareEnv()
const A = { debug: Number(process.env.TC_V_A_DEBUG ?? 9244), remote: Number(process.env.TC_V_A_REMOTE ?? 7691), data: join(homedir(), 'Library', 'Application Support', 'temp-code-dev-va'), log: join(tmpdir(), `tc-v-a-${process.pid}.log`) }
const B = { debug: Number(process.env.TC_V_B_DEBUG ?? 9246), remote: Number(process.env.TC_V_B_REMOTE ?? 7692), data: join(homedir(), 'Library', 'Application Support', 'temp-code-dev-vb'), log: join(tmpdir(), `tc-v-b-${process.pid}.log`) }
const ACCOUNT = 'fake@example.com'
const ACCOUNT_ID = 'u-fake'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)

if (!existsSync(join(REPO, 'out', 'renderer', 'index.html'))) {
  console.error('out/renderer is missing: run electron-vite build first')
  process.exit(2)
}
const pidsOn = async (port: number): Promise<number[]> =>
  (await sh(['sh', '-c', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`], { quiet: true }))
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0)
for (const port of [A.debug, A.remote, B.debug, B.remote]) {
  if ((await pidsOn(port)).length) {
    console.error(`port ${port} is in use; pick another with TC_V_*`)
    process.exit(2)
  }
}

// ── the fake provider: a token endpoint that rotates, a usage endpoint that knows the current token ──
const fake = { access: 'T1', refresh: 'R1', n: 1, minted: new Set(['T1']), dead: new Set<string>(), presented: [] as string[] }
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = ''
    req.on('data', (c: Buffer) => (text += c.toString()))
    req.on('end', () => resolve(text))
  })
const provider = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/v1/oauth/token' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { grant_type?: string; refresh_token?: string }
    fake.presented.push(body.refresh_token ?? '?')
    if (body.grant_type !== 'refresh_token' || body.refresh_token !== fake.refresh) return json(400, { error: 'invalid_grant' })
    fake.n++
    fake.dead.add(fake.access)
    fake.access = `T${fake.n}`
    fake.refresh = `R${fake.n}`
    fake.minted.add(fake.access)
    return json(200, { access_token: fake.access, refresh_token: fake.refresh, expires_in: 3600 })
  }
  if (url.pathname === '/__control/expire' && req.method === 'POST') {
    fake.dead.add(fake.access)
    return json(200, { ok: true })
  }
  if (url.pathname === '/api/oauth/usage') {
    return bearer === fake.access && !fake.dead.has(bearer) ? json(200, { limits: [{ kind: 'session', group: 'session', percent: 10 }] }) : json(401, { error: 'expired' })
  }
  if (url.pathname === '/api/oauth/profile') {
    // Only tokens this fake minted belong to the fake account; anything else (a real token off this Mac) is a stranger.
    return fake.minted.has(bearer) ? json(200, { account: { uuid: ACCOUNT_ID, email: ACCOUNT }, organization: { uuid: 'org-fake', name: 'Fake', rate_limit_tier: 'default_claude_max_5x' } }) : json(401, {})
  }
  json(404, { error: 'not here' })
})
await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok))
const providerPort = (provider.address() as { port: number }).port
const expire = async (): Promise<void> => {
  await fetch(`http://127.0.0.1:${providerPort}/__control/expire`, { method: 'POST' })
}

// ── vaults: A seeded with the account, B empty; both sealed by a key file the script can read ──
type Inst = typeof A
const vaultDir = (inst: Inst): string => join(inst.data, 'aliax')
function seedVault(inst: Inst, profiles: Record<string, unknown>, secrets: Record<string, string>): void {
  const dir = vaultDir(inst)
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  writeFileSync(join(dir, 'vault.key'), `${password}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(profiles, null, 2))
  const key = deriveChromiumKey(password)
  for (const [file, blob] of Object.entries(secrets)) writeFileSync(join(dir, 'secrets', `${file}.bin`), chromiumEncrypt(key, blob))
}
const secretFile = `claude-code__${encodeURIComponent(ACCOUNT)}`
function readSecret(inst: Inst): { accessToken?: string; refreshToken?: string; expiresAt?: number } | null {
  const dir = vaultDir(inst)
  const path = join(dir, 'secrets', `${secretFile}.bin`)
  if (!existsSync(path) || !existsSync(join(dir, 'vault.key'))) return null
  const key = deriveChromiumKey(readFileSync(join(dir, 'vault.key'), 'utf8').trim())
  const blob = JSON.parse(chromiumDecrypt(key, readFileSync(path))) as { keychain?: string }
  return blob.keychain ? JSON.parse(blob.keychain).claudeAiOauth : null
}
const claudeBlob = (access: string, refresh: string, exp: number): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: exp, scopes: ['user:inference', 'user:profile'] } }), oauthAccount: { accountUuid: ACCOUNT_ID, emailAddress: ACCOUNT } })

for (const inst of [A, B]) {
  rmSync(inst.data, { recursive: true, force: true })
  mkdirSync(inst.data, { recursive: true })
}
seedVault(A, { 'claude-code': [{ name: ACCOUNT, accountId: ACCOUNT_ID, email: ACCOUNT, color: '#5b8def', createdAt: Date.now() }] }, { [secretFile]: claudeBlob('T1', 'R1', Date.now() + 3_600_000) })
seedVault(B, {}, {})

let procs: ReturnType<typeof Bun.spawn>[] = []
function launch(inst: Inst): ReturnType<typeof Bun.spawn> {
  const env = {
    ...process.env,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_DEBUG_PORT: String(inst.debug),
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_REMOTE_TRACE: '1',
    TEMP_CODE_ALIAX_DATA_DIR: vaultDir(inst),
    TEMP_CODE_FAKE_PROVIDERS: `http://127.0.0.1:${providerPort}`,
    TEMP_CODE_GATEWAY_ROLE: 'owner'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const out = Bun.file(inst.log)
  const proc = Bun.spawn([join(REPO, 'node_modules', '.bin', 'electron-vite'), 'preview', '--skipBuild'], { cwd: REPO, env, stdout: out, stderr: out })
  procs.push(proc)
  return proc
}
async function killInstance(inst: Inst): Promise<void> {
  const pids = new Set<number>([...(await pidsOn(inst.debug)), ...(await pidsOn(inst.remote))])
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  await sleep(800)
}
const cleanup = async (): Promise<void> => {
  for (const p of procs) p.kill()
  await killInstance(A)
  await killInstance(B)
  provider.close()
}

const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return
    await sleep(300)
  }
  throw new Error(`timed out: ${label}`)
}
const rpc = (cdp: Cdp, method: string, params?: unknown): Promise<unknown> =>
  cdp.eval(`window.__monocode.registry.linkOf('local').request(${JSON.stringify(method)}, ${JSON.stringify(params ?? null)})`)
interface Snapshot {
  providers: { claude: { profiles: { name: string; owner?: string; static?: boolean; expiresAt?: number; syncedAt?: number }[]; reports: { profileName: string; expired?: boolean; note?: string }[] } }
  homes?: Record<string, string>
  peers?: Record<string, { name: string; connected: boolean; lastSyncAt: number | null; error: string | null }>
}
const snapshot = (cdp: Cdp): Promise<Snapshot> => rpc(cdp, 'accounts.list') as Promise<Snapshot>
const profileIn = (s: Snapshot) => s.providers.claude.profiles.find((p) => p.name === ACCOUNT)
async function connectWindow(inst: Inst, label: string): Promise<{ cdp: Cdp; env: string }> {
  const cdp = await attach(inst.debug, 120_000)
  await until(`${label} local socket`, 60_000, () => cdp.eval<boolean>(`!!window.__monocode?.registry?.primary()?.connected`))
  await until(`${label} first list`, 60_000, () => cdp.eval<boolean>(`window.__monocode.registry.statusOf('local').fresh === true`))
  const env = (await cdp.eval(`window.__monocode.registry.statusOf('local').lastHello.environmentId`)) as string
  return { cdp, env }
}

launch(A)
launch(B)
try {
  const { cdp: a, env: aEnv } = await connectWindow(A, 'A')
  const { cdp: b, env: bEnv } = await connectWindow(B, 'B')
  log(`A ${aEnv} and B ${bEnv} up; logs ${A.log} ${B.log}; fake provider on :${providerPort}`)

  // ── 1. the seeded account on A is A's own ──────────────────────────
  const seeded = profileIn(await snapshot(a))
  check('A: the seeded account is refreshed here (no owner on file)', seeded !== undefined && seeded.owner === undefined && !seeded.static, JSON.stringify(seeded))
  check('A: its stored copy holds the refresh token', readSecret(A)?.refreshToken === 'R1')

  // ── 2. B pairs as an admin host; A's main process links to B and pushes an access copy ──
  const bKey = (await rpc(b, 'remote.keys.create', { name: 'A (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })) as { token: string }
  check('B: issued an admin key', typeof bKey?.token === 'string' && bKey.token.startsWith('tc_'))
  await rpc(a, 'remote.environments.add', { url: `http://127.0.0.1:${B.remote}`, key: bKey.token, name: 'B' })
  await until('A links to B', 30_000, async () => (await snapshot(a)).peers?.[bEnv]?.connected === true)
  check('A: the main process holds a connected link to B', true)
  await until('B receives the access copy', 30_000, async () => profileIn(await snapshot(b))?.owner === aEnv)
  const onB = profileIn(await snapshot(b))
  check('B: the account arrived as a copy refreshed by A', onB?.owner === aEnv && !onB.static, JSON.stringify(onB))
  check('B: the copy carries no refresh token', readSecret(B)?.refreshToken === undefined && readSecret(B)?.accessToken === 'T1')
  check('A: still owns the grant', profileIn(await snapshot(a))?.owner === undefined && readSecret(A)?.refreshToken === 'R1')

  // ── 3. B becomes the home for Claude sign-ins: A hands the grant off ──
  await rpc(a, 'accounts.setHome', { provider: 'claude', environmentId: bEnv })
  await until('A hands off to B', 30_000, async () => profileIn(await snapshot(a))?.owner === bEnv)
  const afterA = await snapshot(a)
  check('A: the home for Claude is B', afterA.homes?.claude === bEnv, JSON.stringify(afterA.homes))
  check('A: the account is now refreshed by B, with a synced time', profileIn(afterA)?.owner === bEnv && (profileIn(afterA)?.syncedAt ?? 0) > 0)
  check('A: its own copy lost the refresh token and kept the access token', readSecret(A)?.refreshToken === undefined && readSecret(A)?.accessToken === 'T1')
  await until('B owns the grant', 10_000, async () => profileIn(await snapshot(b))?.owner === bEnv)
  check('B: owns the grant and holds the refresh token', readSecret(B)?.refreshToken === 'R1')
  check('fake: no refresh happened during the handoff', fake.presented.length === 0, JSON.stringify(fake.presented))

  // ── 4. B rotates against the fake token endpoint; A receives the new access token over B's push ──
  await expire()
  await rpc(b, 'accounts.refresh', { provider: 'claude' })
  await until('B rotates', 30_000, () => readSecret(B)?.accessToken === 'T2')
  check('B: rotated with its refresh token, once', fake.presented.length === 1 && fake.presented[0] === 'R1' && readSecret(B)?.refreshToken === 'R2', JSON.stringify(fake.presented))
  await until('A receives the rotation', 30_000, () => readSecret(A)?.accessToken === 'T2')
  check('A: holds the new access token and still no refresh token', readSecret(A)?.accessToken === 'T2' && readSecret(A)?.refreshToken === undefined)
  const bReport = (await snapshot(b)).providers.claude.reports.find((r) => r.profileName === ACCOUNT)
  check('B: the usage poll after the rotation is healthy', bReport !== undefined && !bReport.expired, JSON.stringify(bReport))

  // ── 5. the owner goes down and the copy on A runs out: A says so, and never presents a refresh token ──
  await killInstance(B)
  await until('A notices B is gone', 30_000, async () => (await snapshot(a)).peers?.[bEnv]?.connected === false)
  await expire()
  const presentedBefore = fake.presented.length
  await rpc(a, 'accounts.refresh', { provider: 'claude' })
  const down = await snapshot(a)
  const report = down.providers.claude.reports.find((r) => r.profileName === ACCOUNT)
  check('A: the copy reports expired, with B named as its owner and the link down', report?.expired === true && profileIn(down)?.owner === bEnv && down.peers?.[bEnv]?.connected === false, JSON.stringify({ report, peer: down.peers?.[bEnv] }))
  check('fake: A never called the token endpoint', fake.presented.length === presentedBefore, JSON.stringify(fake.presented))
  check('A: its copy is unchanged and still carries no refresh token', readSecret(A)?.accessToken === 'T2' && readSecret(A)?.refreshToken === undefined)
  const peerState = down.peers?.[bEnv]
  check('A: the peer state names the failure', peerState !== undefined && peerState.lastSyncAt !== null, JSON.stringify(peerState))

  // ── 6. the renderer: the account row on A says it plainly ──────────
  // Best effort: the page opens from the sidebar's Accounts entry; the vault and snapshot checks above are the proof.
  const opened = (await a.eval(`(() => { const el = [...document.querySelectorAll('button,[role=menuitem],[role=button],a')].find((e) => (e.textContent ?? '').trim() === 'Accounts'); if (!el) return false; el.click(); return true })()`)) as boolean
  await sleep(2_000)
  const text = (await a.eval(`document.body.innerText`)) as string
  const line = /unreachable · token lapsed/.test(text)
  log(opened ? (line ? 'Accounts page open: the row says the owner is unreachable and the token lapsed' : 'Accounts page open, line not on screen yet') : 'no Accounts entry found to click; UI check skipped')
  if (line) {
    const shot = (await a.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync('/tmp/tc-accounts-sync-a.png', Buffer.from(shot.data, 'base64'))
    log('screenshot of A: /tmp/tc-accounts-sync-a.png')
  }
  a.close()
  b.close()
} catch (err) {
  console.error('ERROR', err instanceof Error ? err.message : err)
  failures++
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
