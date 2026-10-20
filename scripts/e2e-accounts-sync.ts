/**
 * Account sync for real (thread V, hardened by F2): two isolated instances of
 * the BUILT tree (electron-vite preview, fresh userData each) with their own
 * vaults (TEMP_CODE_ALIAX_DATA_DIR, key-file mode) and a fake provider in
 * place of Anthropic (TEMP_CODE_FAKE_PROVIDERS). A holds a Claude account
 * with a refresh token and the Codex grant its CLI is signed in with
 * (CODEX_HOME); B is paired as an admin host and holds one Claude account of
 * its own that A never had. A's main process links to B and pushes the
 * account as an access copy. Then the races, each against the fake:
 *  - an old-version handoff: B's copy is fresher than the grant A sends,
 *    B refuses it as stale and A keeps its only refresh token
 *  - a refresh in flight across a handoff: A's token endpoint call is slow
 *    while the home moves to B; the handoff waits and carries the rotated
 *    token, so B owns a live grant and the fake saw one refresh
 *  - B rotates and A receives the new access token over B's push; B's own
 *    account rotates too and A refuses that push (an account it never had)
 *  - a takeover with the response dropped: B swallows its answer to A's
 *    confirm (TEMP_CODE_DROP_ANSWERS); B has stripped, A's copy stays
 *    provisional until the next sync settles it, and A owns the grant
 *  - a Codex handoff on the live lineage: the grant A's CLI is signed in
 *    with goes to B as an access copy only; once the CLI rotates, the stored
 *    grant is no longer the live one and is handed off
 *  - the owner goes down and the copy on A runs out: A reports the state and
 *    never presents a refresh token
 * Run: bun scripts/e2e-accounts-sync.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, its userData, the real
 * Aliax vault, the real ~/.codex, the gateway marker or the Keychain.
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
const PLANTED = 'planted@example.com'
const PLANTED_ID = 'u-planted'
const CODEX_NAME = 'codex@example.com'
const CODEX_ID = 'acct-fake'

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

// ── the fake provider: two grant lineages, a token endpoint that rotates (and can be slowed), a usage endpoint that knows the current tokens ──
type Lineage = { access: string; refresh: string; n: number; prefix: string; account: { uuid: string; email: string } }
const lineages: Record<'main' | 'planted', Lineage> = {
  main: { access: 'T1', refresh: 'R1', n: 1, prefix: '', account: { uuid: ACCOUNT_ID, email: ACCOUNT } },
  planted: { access: 'PT1', refresh: 'PR1', n: 1, prefix: 'P', account: { uuid: PLANTED_ID, email: PLANTED } }
}
const fake = { minted: new Map<string, Lineage>([['T1', lineages.main], ['PT1', lineages.planted]]), dead: new Set<string>(), presented: [] as string[], slowMs: 0 }
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
    const lineage = Object.values(lineages).find((l) => l.refresh === body.refresh_token)
    if (body.grant_type !== 'refresh_token' || !lineage) return json(400, { error: 'invalid_grant' })
    if (fake.slowMs) {
      await sleep(fake.slowMs)
      fake.slowMs = 0
    }
    lineage.n++
    fake.dead.add(lineage.access)
    lineage.access = `${lineage.prefix}T${lineage.n}`
    lineage.refresh = `${lineage.prefix}R${lineage.n}`
    fake.minted.set(lineage.access, lineage)
    return json(200, { access_token: lineage.access, refresh_token: lineage.refresh, expires_in: 3600 })
  }
  if (url.pathname === '/__control/expire' && req.method === 'POST') {
    const which = (url.searchParams.get('lineage') ?? 'main') as 'main' | 'planted'
    fake.dead.add(lineages[which].access)
    return json(200, { ok: true })
  }
  if (url.pathname === '/__control/slow' && req.method === 'POST') {
    fake.slowMs = Number(url.searchParams.get('ms') ?? 3000)
    return json(200, { ok: true })
  }
  if (url.pathname === '/api/oauth/usage') {
    const lineage = fake.minted.get(bearer)
    return lineage && lineage.access === bearer && !fake.dead.has(bearer) ? json(200, { limits: [{ kind: 'session', group: 'session', percent: 10 }] }) : json(401, { error: 'expired' })
  }
  if (url.pathname === '/api/oauth/profile') {
    // Only tokens this fake minted belong to its accounts; anything else (a real token off this Mac) is a stranger.
    const lineage = fake.minted.get(bearer)
    return lineage ? json(200, { account: lineage.account, organization: { uuid: 'org-fake', name: 'Fake', rate_limit_tier: 'default_claude_max_5x' } }) : json(401, {})
  }
  json(404, { error: 'not here' })
})
await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok))
const providerPort = (provider.address() as { port: number }).port
const control = async (path: string): Promise<void> => {
  await fetch(`http://127.0.0.1:${providerPort}/__control/${path}`, { method: 'POST' })
}

// ── vaults: A seeded with the account and its live Codex grant, B with an account of its own; both sealed by a key file the script can read ──
type Inst = typeof A
const vaultDir = (inst: Inst): string => join(inst.data, 'aliax')
const codexHome = (inst: Inst): string => join(inst.data, 'codex-home')
function seedVault(inst: Inst, profiles: Record<string, unknown>, secrets: Record<string, string>): void {
  const dir = vaultDir(inst)
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  writeFileSync(join(dir, 'vault.key'), `${password}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(profiles, null, 2))
  const key = deriveChromiumKey(password)
  for (const [file, blob] of Object.entries(secrets)) writeFileSync(join(dir, 'secrets', `${file}.bin`), chromiumEncrypt(key, blob))
}
/** Overwrite one stored secret after boot (the vault reads from disk on every call). */
function writeSecret(inst: Inst, file: string, blob: string): void {
  const dir = vaultDir(inst)
  const key = deriveChromiumKey(readFileSync(join(dir, 'vault.key'), 'utf8').trim())
  writeFileSync(join(dir, 'secrets', `${file}.bin`), chromiumEncrypt(key, blob))
}
const secretFile = `claude-code__${encodeURIComponent(ACCOUNT)}`
const codexFile = `codex__${encodeURIComponent(CODEX_NAME)}`
function readBlob(inst: Inst, file: string): Record<string, any> | null {
  const dir = vaultDir(inst)
  const path = join(dir, 'secrets', `${file}.bin`)
  if (!existsSync(path) || !existsSync(join(dir, 'vault.key'))) return null
  const key = deriveChromiumKey(readFileSync(join(dir, 'vault.key'), 'utf8').trim())
  return JSON.parse(chromiumDecrypt(key, readFileSync(path)))
}
function readSecret(inst: Inst): { accessToken?: string; refreshToken?: string; expiresAt?: number } | null {
  const blob = readBlob(inst, secretFile) as { keychain?: string } | null
  return blob?.keychain ? JSON.parse(blob.keychain).claudeAiOauth : null
}
const readCodex = (inst: Inst): { access_token?: string; refresh_token?: string } | null => (readBlob(inst, codexFile)?.tokens as { access_token?: string; refresh_token?: string } | undefined) ?? null
const claudeBlob = (access: string, refresh: string | null, exp: number, account = { uuid: ACCOUNT_ID, email: ACCOUNT }): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: access, ...(refresh ? { refreshToken: refresh } : {}), expiresAt: exp, scopes: ['user:inference', 'user:profile'] } }), oauthAccount: { accountUuid: account.uuid, emailAddress: account.email } })
const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
const codexAuth = (refresh: string): string =>
  JSON.stringify({
    tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 10 * 86_400 }), refresh_token: refresh, id_token: jwt({ email: CODEX_NAME, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }), account_id: CODEX_ID },
    last_refresh: new Date().toISOString()
  })

for (const inst of [A, B]) {
  rmSync(inst.data, { recursive: true, force: true })
  mkdirSync(codexHome(inst), { recursive: true })
}
const now = Date.now()
seedVault(
  A,
  { 'claude-code': [{ name: ACCOUNT, accountId: ACCOUNT_ID, email: ACCOUNT, color: '#5b8def', createdAt: now }], codex: [{ name: CODEX_NAME, accountId: CODEX_ID, email: CODEX_NAME, color: '#5bdf8e', createdAt: now }] },
  { [secretFile]: claudeBlob('T1', 'R1', now + 3_600_000), [codexFile]: codexAuth('CX-LIVE') }
)
// The Codex CLI on A is signed in with the very grant the vault holds.
writeFileSync(join(codexHome(A), 'auth.json'), codexAuth('CX-LIVE'))
seedVault(B, { 'claude-code': [{ name: PLANTED, accountId: PLANTED_ID, email: PLANTED, color: '#df5b8e', createdAt: now }] }, { [`claude-code__${encodeURIComponent(PLANTED)}`]: claudeBlob('PT1', 'PR1', now + 3_600_000, { uuid: PLANTED_ID, email: PLANTED }) })

let procs: ReturnType<typeof Bun.spawn>[] = []
function launch(inst: Inst, extra: Record<string, string> = {}): ReturnType<typeof Bun.spawn> {
  const env = {
    ...process.env,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_DEBUG_PORT: String(inst.debug),
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_REMOTE_TRACE: '1',
    TEMP_CODE_ALIAX_DATA_DIR: vaultDir(inst),
    TEMP_CODE_FAKE_PROVIDERS: `http://127.0.0.1:${providerPort}`,
    TEMP_CODE_GATEWAY_ROLE: 'owner',
    CODEX_HOME: codexHome(inst),
    ...extra
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
const logHas = (inst: Inst, text: string): boolean => existsSync(inst.log) && readFileSync(inst.log, 'utf8').includes(text)
const logCount = (inst: Inst, text: string): number => (existsSync(inst.log) ? readFileSync(inst.log, 'utf8').split(text).length - 1 : 0)
const rpc = (cdp: Cdp, method: string, params?: unknown): Promise<unknown> =>
  cdp.eval(`window.__monocode.registry.linkOf('local').request(${JSON.stringify(method)}, ${JSON.stringify(params ?? null)})`)
interface Profile {
  name: string
  owner?: string
  static?: boolean
  expiresAt?: number
  syncedAt?: number
}
interface Snapshot {
  providers: { claude: { profiles: Profile[]; reports: { profileName: string; expired?: boolean; note?: string }[] }; codex: { profiles: Profile[] } }
  homes?: Record<string, string>
  peers?: Record<string, { name: string; connected: boolean; lastSyncAt: number | null; error: string | null }>
}
const snapshot = (cdp: Cdp): Promise<Snapshot> => rpc(cdp, 'accounts.list') as Promise<Snapshot>
const profileIn = (s: Snapshot, name = ACCOUNT) => s.providers.claude.profiles.find((p) => p.name === name)
const codexIn = (s: Snapshot) => s.providers.codex.profiles.find((p) => p.name === CODEX_NAME)
async function connectWindow(inst: Inst, label: string): Promise<{ cdp: Cdp; env: string }> {
  const cdp = await attach(inst.debug, 120_000)
  await until(`${label} local socket`, 60_000, () => cdp.eval<boolean>(`!!window.__monocode?.registry?.primary()?.connected`))
  await until(`${label} first list`, 60_000, () => cdp.eval<boolean>(`window.__monocode.registry.statusOf('local').fresh === true`))
  const env = (await cdp.eval(`window.__monocode.registry.statusOf('local').lastHello.environmentId`)) as string
  return { cdp, env }
}

launch(A)
// B swallows its first answer to accounts.confirm: the takeover race below.
launch(B, { TEMP_CODE_DROP_ANSWERS: 'accounts.confirm:1' })
try {
  const { cdp: a, env: aEnv } = await connectWindow(A, 'A')
  const { cdp: b, env: bEnv } = await connectWindow(B, 'B')
  log(`A ${aEnv} and B ${bEnv} up; logs ${A.log} ${B.log}; fake provider on :${providerPort}`)

  // ── 1. the seeded account on A is A's own ──────────────────────────
  const seeded = profileIn(await snapshot(a))
  check('A: the seeded account is refreshed here (no owner on file)', seeded !== undefined && seeded.owner === undefined && !seeded.static, JSON.stringify(seeded))
  check('A: its stored copy holds the refresh token', readSecret(A)?.refreshToken === 'R1')

  // ── 2. B pairs as an admin host; A's main process links to B and pushes an access copy; B's own account never lands on A ──
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
  await until('A refuses the account B offered on the pull', 30_000, () => logHas(A, `claude-code ${PLANTED} from B: refused (unknown-account)`))
  check('A: the account B shares that A never had is refused on the pull, and is not on file', profileIn(await snapshot(a), PLANTED) === undefined)

  // ── 3a. an old-version handoff: B's copy is fresher than the grant A sends; B says stale and A keeps its only refresh token ──
  const fresherCopy = claudeBlob('T1', null, now + 2 * 3_600_000)
  writeSecret(B, secretFile, fresherCopy)
  await rpc(a, 'accounts.setHome', { provider: 'claude', environmentId: bEnv })
  await until('A hears stale', 30_000, () => logHas(A, `claude-code ${ACCOUNT} → B: refused (stale)`))
  await until('A names B as the home', 10_000, async () => (await snapshot(a)).homes?.claude === bEnv)
  check('A: the home for Claude is B', true)
  check('A: the stale handoff was refused and A still owns the grant with its refresh token', profileIn(await snapshot(a))?.owner === undefined && readSecret(A)?.refreshToken === 'R1')
  check('B: still an access-only copy refreshed by A', profileIn(await snapshot(b))?.owner === aEnv && readSecret(B)?.refreshToken === undefined)
  check('B: said so', logHas(B, `claude-code ${ACCOUNT}: handoff from ${aEnv} refused (stale)`))
  writeSecret(B, secretFile, claudeBlob('T1', null, now + 3_600_000))

  // ── 3b. a refresh in flight across the handoff: the handoff waits for it and carries the rotated token ──
  await control('expire')
  await control('slow?ms=3000')
  const refreshing = rpc(a, 'accounts.refresh', { provider: 'claude' })
  await until('A presents its refresh token', 10_000, () => fake.presented.length === 1)
  await rpc(a, 'accounts.sync', { environmentId: bEnv })
  await refreshing
  await until('A hands off to B', 30_000, async () => profileIn(await snapshot(a))?.owner === bEnv)
  const afterA = await snapshot(a)
  check('A: the account is now refreshed by B, with a synced time', profileIn(afterA)?.owner === bEnv && (profileIn(afterA)?.syncedAt ?? 0) > 0)
  check('A: its own copy lost the refresh token and kept the rotated access token', readSecret(A)?.refreshToken === undefined && readSecret(A)?.accessToken === 'T2')
  await until('B owns the grant', 10_000, async () => profileIn(await snapshot(b))?.owner === bEnv)
  check('B: owns the grant and holds the ROTATED refresh token, not the one the refresh revoked', readSecret(B)?.refreshToken === 'R2' && readSecret(B)?.accessToken === 'T2', JSON.stringify(readSecret(B)))
  check('fake: exactly one refresh, before the handoff left A', fake.presented.length === 1 && fake.presented[0] === 'R1', JSON.stringify(fake.presented))
  check('B: landed it provisionally, then took it on A\'s word', logHas(B, `claude-code ${ACCOUNT}: handoff from ${aEnv} landed, waiting for its word`) && logHas(B, `claude-code ${ACCOUNT}: ${aEnv} released it; refreshed here now`))

  // ── 4. B rotates against the fake token endpoint; A receives the new access token over B's push. B's own account rotates too and A refuses that push ──
  await control('expire')
  await rpc(b, 'accounts.refresh', { provider: 'claude' })
  await until('B rotates', 30_000, () => readSecret(B)?.accessToken === 'T3')
  check('B: rotated with its refresh token, once', fake.presented.length === 2 && fake.presented[1] === 'R2' && readSecret(B)?.refreshToken === 'R3', JSON.stringify(fake.presented))
  await until('A receives the rotation', 30_000, () => readSecret(A)?.accessToken === 'T3')
  check('A: holds the new access token and still no refresh token', readSecret(A)?.accessToken === 'T3' && readSecret(A)?.refreshToken === undefined)
  const bReport = (await snapshot(b)).providers.claude.reports.find((r) => r.profileName === ACCOUNT)
  check('B: the usage poll after the rotation is healthy', bReport !== undefined && !bReport.expired, JSON.stringify(bReport))
  await control('expire?lineage=planted')
  await rpc(b, 'accounts.refresh', { provider: 'claude' })
  await until('A refuses the pushed stranger', 30_000, () => logHas(A, `claude-code ${PLANTED}: ${bEnv} pushed an account this host never had; refused`))
  check('fake: B rotated its own account', fake.presented.includes('PR1') && lineages.planted.refresh === 'PR2', JSON.stringify(fake.presented))
  check('A: the push of an account it never had was refused, and it is not on file', profileIn(await snapshot(a), PLANTED) === undefined)

  // ── 5. a takeover with the response dropped: B swallows its answer to A's confirm; B has stripped, A's copy stays provisional, the next sync settles it ──
  const presentedBefore = fake.presented.length
  await rpc(a, 'accounts.setHome', { provider: 'claude', environmentId: null })
  check('B: dropped exactly one answer, the confirm', logCount(B, 'dropped the answer to') === 1)
  check('A: the confirm went unanswered and the copy stayed provisional until the sync', logHas(A, `claude-code ${ACCOUNT}: B did not answer the confirm`) && logHas(A, `claude-code ${ACCOUNT}: refreshed here now`))
  check('B: handed the grant out, then stripped on the confirm it did answer to itself', logHas(B, `claude-code ${ACCOUNT}: handed out to ${aEnv}, waiting for its word`) && logHas(B, `claude-code ${ACCOUNT}: now refreshed by ${aEnv}, access-only here`))
  await until('A owns the grant again', 10_000, async () => {
    const p = profileIn(await snapshot(a))
    return p !== undefined && (p.owner === undefined || p.owner === aEnv)
  })
  check('A: owns the grant again with the refresh token B held', readSecret(A)?.refreshToken === 'R3' && readSecret(A)?.accessToken === 'T3', JSON.stringify(readSecret(A)))
  await until('B is access-only', 10_000, async () => profileIn(await snapshot(b))?.owner === aEnv)
  check('B: keeps an access-only copy refreshed by A', readSecret(B)?.refreshToken === undefined && readSecret(B)?.accessToken === 'T3')
  check('fake: no refresh happened during the takeover', fake.presented.length === presentedBefore, JSON.stringify(fake.presented))

  // ── 6. a Codex handoff on the live lineage: the grant A's CLI is signed in with goes as an access copy only; once the CLI rotates, it is handed off ──
  await rpc(a, 'accounts.setHome', { provider: 'codex', environmentId: bEnv })
  await until('B receives the codex copy', 30_000, async () => codexIn(await snapshot(b))?.owner === aEnv)
  check('A: the Codex grant its CLI is signed in with stayed here, with the refresh token', codexIn(await snapshot(a))?.owner === undefined && readCodex(A)?.refresh_token === 'CX-LIVE')
  check('A: said why', logHas(A, `codex ${CODEX_NAME}: the sign-in here, or one that cannot be told apart; access copy only`))
  check('B: holds an access-only Codex copy refreshed by A', readCodex(B)?.refresh_token === undefined && typeof readCodex(B)?.access_token === 'string')
  writeFileSync(join(codexHome(A), 'auth.json'), codexAuth('CX-ROTATED'))
  await rpc(a, 'accounts.sync', { environmentId: bEnv })
  await until('A hands the codex grant off', 30_000, async () => codexIn(await snapshot(a))?.owner === bEnv)
  await until('B owns the codex grant', 10_000, async () => codexIn(await snapshot(b))?.owner === bEnv)
  check('B: owns the Codex grant with its refresh token; A kept none', readCodex(B)?.refresh_token === 'CX-LIVE' && readCodex(A)?.refresh_token === undefined)

  // ── 7. the owner goes down and the copy on A runs out: A says so, and never presents a refresh token ──
  await rpc(a, 'accounts.setHome', { provider: 'claude', environmentId: bEnv })
  await until('A hands the grant back to B', 30_000, async () => profileIn(await snapshot(a))?.owner === bEnv && readSecret(A)?.refreshToken === undefined)
  await until('B owns it again', 10_000, async () => profileIn(await snapshot(b))?.owner === bEnv && readSecret(B)?.refreshToken === 'R3')
  await killInstance(B)
  await until('A notices B is gone', 30_000, async () => (await snapshot(a)).peers?.[bEnv]?.connected === false)
  await control('expire')
  const presentedAtDown = fake.presented.length
  await rpc(a, 'accounts.refresh', { provider: 'claude' })
  const down = await snapshot(a)
  const report = down.providers.claude.reports.find((r) => r.profileName === ACCOUNT)
  check('A: the copy reports expired, with B named as its owner and the link down', report?.expired === true && profileIn(down)?.owner === bEnv && down.peers?.[bEnv]?.connected === false, JSON.stringify({ report, peer: down.peers?.[bEnv] }))
  check('fake: A never called the token endpoint', fake.presented.length === presentedAtDown, JSON.stringify(fake.presented))
  check('A: its copy is unchanged and still carries no refresh token', readSecret(A)?.accessToken === 'T3' && readSecret(A)?.refreshToken === undefined)
  const peerState = down.peers?.[bEnv]
  check('A: the peer state names the failure', peerState !== undefined && peerState.lastSyncAt !== null, JSON.stringify(peerState))

  // ── 8. the renderer: the account row on A says it plainly ──────────
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
