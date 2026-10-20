/**
 * Every Claude account a one-year token, held by every host (T1): two
 * isolated instances of the BUILT tree (electron-vite preview, fresh
 * userData each), their own vaults (TEMP_CODE_ALIAX_DATA_DIR, key-file mode),
 * a fake provider in place of Anthropic (TEMP_CODE_FAKE_PROVIDERS) and the
 * Claude CLI's credentials in a file inside each instance's data
 * (ALIAX_CREDENTIAL_BACKEND=file + CLAUDE_CONFIG_DIR), so nothing here reads
 * or writes the user's Keychain. A is the Mac: three accounts with refresh
 * grants and stored claude.ai sessions, plus `old`, a one-year token inside
 * its last 30 days whose session is still good. B is the box, paired as an
 * admin host. Then:
 *  - A's push makes `old` B's live Claude sign-in (nothing was live there)
 *  - Convert all on A: `one` and `two` mint through the refresh grant with
 *    user:profile and a year; the fake grants `three` only hours for that
 *    pair, so A asks again with user:inference alone and gets the year; every
 *    grant is dropped only after its token was filed; B receives the three
 *    static tokens over the existing sync, its live sign-in untouched
 *  - the usage poll: a token with user:profile reports windows, the
 *    inference-only one says so
 *  - a renewal pass: `old` is minted again through its stored session in a
 *    hidden window against the fake consent page (the code lands on the
 *    callback, the exchange carries expires_in for a year), B lands the new
 *    token and its live sign-in follows; `gone`, whose session has lapsed,
 *    is marked needs-sign-in and nothing of it changes
 * Run: bun scripts/e2e-static-tokens.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, its userData, the real
 * Aliax vault, ~/.claude's credentials, the gateway marker or the Keychain.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromiumDecrypt, chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'
import { Cdp, REPO, attach, prepareEnv, sh, sleep } from './lib/packagedApp'

prepareEnv()
const A = { debug: Number(process.env.TC_T1_A_DEBUG ?? 9254), remote: Number(process.env.TC_T1_A_REMOTE ?? 7693), data: join(homedir(), 'Library', 'Application Support', 'temp-code-dev-t1a'), log: join(tmpdir(), `tc-t1-a-${process.pid}.log`) }
const B = { debug: Number(process.env.TC_T1_B_DEBUG ?? 9256), remote: Number(process.env.TC_T1_B_REMOTE ?? 7694), data: join(homedir(), 'Library', 'Application Support', 'temp-code-dev-t1b'), log: join(tmpdir(), `tc-t1-b-${process.pid}.log`) }
const YEAR_S = 31_536_000
const DAY = 86_400_000

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
    console.error(`port ${port} is in use; pick another with TC_T1_*`)
    process.exit(2)
  }
}

// ── the fake provider: accounts with grants and sessions; a token endpoint that honours expires_in per account; a consent page that approves a known session ──
interface Account {
  uuid: string
  email: string
  refresh: string | null
  session: string | null
  /** What the refresh grant yields for `user:profile user:inference` with a one-year expires_in: the year, or hours. */
  yearWithProfile: boolean
  minted: { token: string; scopes: string[] }[]
}
const FULL = ['org:create_api_key', 'user:profile', 'user:inference']
const STATIC = ['user:profile', 'user:inference']
const accounts: Record<string, Account> = {
  one: { uuid: 'u-one', email: 'one@example.com', refresh: 'R-one-1', session: 'SID-one', yearWithProfile: true, minted: [{ token: 'A-one', scopes: FULL }] },
  two: { uuid: 'u-two', email: 'two@example.com', refresh: 'R-two-1', session: 'SID-two', yearWithProfile: true, minted: [{ token: 'A-two', scopes: FULL }] },
  three: { uuid: 'u-three', email: 'three@example.com', refresh: 'R-three-1', session: 'SID-three', yearWithProfile: false, minted: [{ token: 'A-three', scopes: FULL }] },
  old: { uuid: 'u-old', email: 'old@example.com', refresh: null, session: 'SID-old', yearWithProfile: true, minted: [{ token: 'OAT-old-1', scopes: STATIC }] },
  late: { uuid: 'u-late', email: 'late@example.com', refresh: null, session: 'SID-late', yearWithProfile: true, minted: [{ token: 'OAT-late-1', scopes: STATIC }] },
  gone: { uuid: 'u-gone', email: 'gone@example.com', refresh: null, session: null, yearWithProfile: true, minted: [{ token: 'OAT-gone-1', scopes: STATIC }] }
}
const byToken = (bearer: string): { name: string; scopes: string[] } | null => {
  for (const [name, a] of Object.entries(accounts)) {
    const hit = a.minted.find((m) => m.token === bearer)
    if (hit) return { name, scopes: hit.scopes }
  }
  return null
}
const fake = {
  tokenBodies: [] as Record<string, unknown>[],
  /** Every bearer the usage endpoint saw, in order. */
  usageBearers: [] as string[],
  authorizes: [] as { name: string | null; cookie: string | null; scope: string | null; state: string | null }[],
  codes: new Map<string, { name: string; scopes: string[] }>(),
  n: 0
}
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = ''
    req.on('data', (c: Buffer) => (text += c.toString()))
    req.on('end', () => resolve(text))
  })
let providerOrigin = ''
const provider = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const mint = (name: string, scopes: string[], expiresIn: number, refreshOut: string | null): Record<string, unknown> => {
    const a = accounts[name]
    const token = `OAT-${name}-${++fake.n}`
    a.minted.push({ token, scopes })
    return { token_type: 'Bearer', access_token: token, ...(refreshOut ? { refresh_token: refreshOut } : {}), expires_in: expiresIn, scope: scopes.join(' '), account: { uuid: a.uuid, email_address: a.email }, organization: { uuid: 'org-fake', name: 'Fake' } }
  }
  if (url.pathname === '/v1/oauth/token' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    fake.tokenBodies.push(body)
    const asked = typeof body.expires_in === 'number' ? body.expires_in : 3600
    if (body.grant_type === 'refresh_token') {
      const entry = Object.entries(accounts).find(([, a]) => a.refresh === body.refresh_token)
      if (!entry) return json(400, { error: 'invalid_grant' })
      const [name, a] = entry
      const scopes = String(body.scope ?? 'org:create_api_key user:profile user:inference').split(/\s+/).filter(Boolean)
      a.refresh = `R-${name}-${++fake.n}`
      const year = asked === YEAR_S && (a.yearWithProfile || !scopes.includes('user:profile'))
      return json(200, mint(name, scopes, year ? YEAR_S : 8 * 3600, a.refresh))
    }
    if (body.grant_type === 'authorization_code') {
      const issued = fake.codes.get(String(body.code))
      if (!issued) return json(400, { error: 'invalid_grant', error_description: 'unknown code' })
      fake.codes.delete(String(body.code))
      return json(200, mint(issued.name, issued.scopes, asked === YEAR_S ? YEAR_S : 8 * 3600, null))
    }
    return json(400, { error: 'unsupported_grant_type' })
  }
  if (url.pathname === '/oauth/authorize') {
    const cookie = req.headers.cookie ?? null
    const sid = /sessionKey=([^;]+)/.exec(cookie ?? '')?.[1] ?? null
    const entry = sid ? Object.entries(accounts).find(([, a]) => a.session === sid) : undefined
    const scope = url.searchParams.get('scope')
    const state = url.searchParams.get('state')
    fake.authorizes.push({ name: entry?.[0] ?? null, cookie: sid, scope, state })
    if (!entry) {
      res.writeHead(302, { location: `${providerOrigin}/login?returnTo=${encodeURIComponent(url.pathname + url.search)}` })
      return res.end()
    }
    const code = `CODE-${entry[0]}-${++fake.n}`
    fake.codes.set(code, { name: entry[0], scopes: (scope ?? 'user:inference').split(/\s+/).filter(Boolean) })
    // The landing page is matched by path, whatever the host (staticMint.ts codeFrom).
    res.writeHead(302, { location: `${providerOrigin}/oauth/code/callback?code=${code}&state=${encodeURIComponent(state ?? '')}` })
    return res.end()
  }
  if (url.pathname === '/login' || url.pathname === '/oauth/code/callback') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(`<!doctype html><title>${url.pathname === '/login' ? 'Sign in' : 'Done'}</title><p>${url.pathname}</p>`)
  }
  if (url.pathname === '/api/oauth/usage') {
    fake.usageBearers.push(bearer)
    const hit = byToken(bearer)
    if (!hit) return json(401, { error: 'expired' })
    return hit.scopes.includes('user:profile') ? json(200, { limits: [{ kind: 'session', group: 'session', percent: 12 }] }) : json(403, { error: 'insufficient_scope' })
  }
  if (url.pathname === '/api/oauth/profile') {
    const hit = byToken(bearer)
    if (!hit || !hit.scopes.includes('user:profile')) return json(401, {})
    const a = accounts[hit.name]
    return json(200, { account: { uuid: a.uuid, email: a.email }, organization: { uuid: 'org-fake', name: 'Fake', rate_limit_tier: 'default_claude_max_5x' } })
  }
  if (url.pathname === '/api/bootstrap') {
    const sid = /sessionKey=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    const entry = Object.values(accounts).find((a) => a.session === sid)
    return entry ? json(200, { account: { email_address: entry.email } }) : json(401, {})
  }
  json(404, { error: 'not here' })
})
await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok))
const providerPort = (provider.address() as { port: number }).port
providerOrigin = `http://127.0.0.1:${providerPort}`

// ── vaults and the CLI's credentials file, per instance ─────────────────
type Inst = typeof A
const vaultDir = (inst: Inst): string => join(inst.data, 'aliax')
const claudeConfigDir = (inst: Inst): string => join(inst.data, 'claude-config')
const credentialsFile = (inst: Inst): string => join(claudeConfigDir(inst), '.credentials.json')
const vaultKey = (inst: Inst): Buffer => deriveChromiumKey(readFileSync(join(vaultDir(inst), 'vault.key'), 'utf8').trim())
function seedVault(inst: Inst, profiles: Record<string, unknown>, secrets: Record<string, string>): void {
  const dir = vaultDir(inst)
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  writeFileSync(join(dir, 'vault.key'), `${password}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(profiles, null, 2))
  const key = deriveChromiumKey(password)
  for (const [file, blob] of Object.entries(secrets)) writeFileSync(join(dir, 'secrets', `${file}.bin`), chromiumEncrypt(key, blob))
}
/** Add a row and its secret to a running instance's vault (it reads the files on every call). */
function addProfile(inst: Inst, row: Record<string, unknown>, blob: string): void {
  const dir = vaultDir(inst)
  const meta = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8')) as Record<string, Record<string, unknown>[]>
  meta['claude-code'] = [...(meta['claude-code'] ?? []), row]
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(meta, null, 2))
  writeFileSync(join(dir, 'secrets', `claude-code__${encodeURIComponent(String(row.name))}.bin`), chromiumEncrypt(vaultKey(inst), blob))
}
const secretFile = (name: string): string => `claude-code__${encodeURIComponent(name)}`
function readBlob(inst: Inst, name: string): Record<string, any> | null {
  const path = join(vaultDir(inst), 'secrets', `${secretFile(name)}.bin`)
  if (!existsSync(path)) return null
  return JSON.parse(chromiumDecrypt(vaultKey(inst), readFileSync(path)))
}
function readTokens(inst: Inst, name: string): { accessToken?: string; refreshToken?: string; expiresAt?: number; scopes?: string[] } | null {
  const blob = readBlob(inst, name) as { keychain?: string } | null
  return blob?.keychain ? JSON.parse(blob.keychain).claudeAiOauth : null
}
const isStatic = (inst: Inst, name: string): boolean => readBlob(inst, name)?.tokenKind === 'static'
/** The Claude CLI's live sign-in on an instance: the token in its credentials file, if any. */
const liveToken = (inst: Inst): string | null => {
  if (!existsSync(credentialsFile(inst))) return null
  try {
    return JSON.parse(readFileSync(credentialsFile(inst), 'utf8'))?.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}
const session = (sid: string) => [{ name: 'sessionKey', value: sid, domain: '.claude.ai', path: '/', secure: true, httpOnly: true }]
const grantBlob = (name: string, access: string, exp: number): string =>
  JSON.stringify({
    keychain: JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: accounts[name].refresh, expiresAt: exp, scopes: ['org:create_api_key', 'user:profile', 'user:inference'] } }),
    oauthAccount: { accountUuid: accounts[name].uuid, emailAddress: accounts[name].email },
    appSession: accounts[name].session ? session(accounts[name].session!) : null
  })
const staticBlob = (name: string, token: string, exp: number, sid: string | null): string =>
  JSON.stringify({
    keychain: JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: exp, scopes: ['user:profile', 'user:inference'] } }),
    oauthAccount: { accountUuid: accounts[name].uuid, emailAddress: accounts[name].email },
    appSession: sid ? session(sid) : null,
    tokenKind: 'static'
  })
const row = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, accountId: accounts[name].uuid, email: accounts[name].email, color: '#5b8def', createdAt: Date.now(), ...extra })

for (const inst of [A, B]) {
  rmSync(inst.data, { recursive: true, force: true })
  mkdirSync(claudeConfigDir(inst), { recursive: true })
}
const now = Date.now()
// `old` first: it is the first account A pushes, so it becomes B's live sign-in.
seedVault(
  A,
  { 'claude-code': [row('old', { static: true }), row('one'), row('two'), row('three')] },
  {
    [secretFile('old')]: staticBlob('old', 'OAT-old-1', now + 10 * DAY, 'SID-old'),
    [secretFile('one')]: grantBlob('one', 'A-one', now + 3_600_000),
    [secretFile('two')]: grantBlob('two', 'A-two', now + 3_600_000),
    [secretFile('three')]: grantBlob('three', 'A-three', now + 3_600_000)
  }
)
seedVault(B, {}, {})

let procs: ReturnType<typeof Bun.spawn>[] = []
function launch(inst: Inst, extra: Record<string, string> = {}): ReturnType<typeof Bun.spawn> {
  const env = {
    ...process.env,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_DEBUG_PORT: String(inst.debug),
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_REMOTE_TRACE: '1',
    TEMP_CODE_ALIAX_DATA_DIR: vaultDir(inst),
    TEMP_CODE_FAKE_PROVIDERS: providerOrigin,
    TEMP_CODE_GATEWAY_ROLE: 'owner',
    // The Claude CLI's credentials live in a file inside this instance's data: never the Keychain.
    ALIAX_CREDENTIAL_BACKEND: 'file',
    CLAUDE_CONFIG_DIR: claudeConfigDir(inst),
    CODEX_HOME: join(inst.data, 'codex-home'),
    // The renewal pass runs when the script asks, not on the clock.
    TEMP_CODE_STATIC_RENEW_FIRST_MS: '3600000',
    TEMP_CODE_STATIC_RENEW_EVERY_MS: '3600000',
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
  active?: boolean
}
interface Snapshot {
  providers: {
    claude: {
      profiles: Profile[]
      reports: { profileName: string; expired?: boolean; note?: string; windows: { label: string; usedPercent: number }[] }[]
      mint?: { rows: Record<string, { state: string; detail?: string }>; run: { total: number; done: number } | null }
    }
  }
  peers?: Record<string, { name: string; connected: boolean }>
}
const snapshot = (cdp: Cdp): Promise<Snapshot> => rpc(cdp, 'accounts.list') as Promise<Snapshot>
const profileIn = (s: Snapshot, name: string) => s.providers.claude.profiles.find((p) => p.name === name)
const reportIn = (s: Snapshot, name: string) => s.providers.claude.reports.find((r) => r.profileName === name)
async function connectWindow(inst: Inst, label: string): Promise<{ cdp: Cdp; env: string }> {
  const cdp = await attach(inst.debug, 120_000)
  await until(`${label} local socket`, 60_000, () => cdp.eval<boolean>(`!!window.__monocode?.registry?.primary()?.connected`))
  await until(`${label} first list`, 60_000, () => cdp.eval<boolean>(`window.__monocode.registry.statusOf('local').fresh === true`))
  const env = (await cdp.eval(`window.__monocode.registry.statusOf('local').lastHello.environmentId`)) as string
  return { cdp, env }
}
const aboutAYear = (exp: number | undefined, from: number): boolean => exp !== undefined && Math.abs(exp - (from + YEAR_S * 1000)) < 10 * 60_000

launch(A)
launch(B)
try {
  const { cdp: a, env: aEnv } = await connectWindow(A, 'A')
  const { cdp: b, env: bEnv } = await connectWindow(B, 'B')
  log(`A ${aEnv} and B ${bEnv} up; logs ${A.log} ${B.log}; fake provider on :${providerPort}`)

  // ── 1. seeded state on A ─────────────────────────────────────────────
  const seeded = await snapshot(a)
  check('A: three accounts hold refresh grants here and `old` is a one-year token inside its last 30 days', ['one', 'two', 'three'].every((n) => profileIn(seeded, n)?.owner === undefined && !profileIn(seeded, n)?.static) && profileIn(seeded, 'old')?.static === true && (profileIn(seeded, 'old')?.expiresAt ?? 0) - now < 30 * DAY, JSON.stringify(seeded.providers.claude.profiles))
  check('A: the Claude CLI here has no live sign-in (its credentials file is this instance\'s own, and empty)', liveToken(A) === null)

  // ── 2. B pairs as an admin host; A pushes what it holds; `old`, first in the vault, becomes B's live sign-in ──
  const bKey = (await rpc(b, 'remote.keys.create', { name: 'A (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })) as { token: string }
  check('B: issued an admin key', typeof bKey?.token === 'string' && bKey.token.startsWith('tc_'))
  await rpc(a, 'remote.environments.add', { url: `http://127.0.0.1:${B.remote}`, key: bKey.token, name: 'B' })
  await until('A links to B', 30_000, async () => (await snapshot(a)).peers?.[bEnv]?.connected === true)
  await until('B receives the four accounts', 30_000, async () => {
    const s = await snapshot(b)
    return ['old', 'one', 'two', 'three'].every((n) => profileIn(s, n) !== undefined)
  })
  const onB = await snapshot(b)
  check('B: the three grants arrived as access copies refreshed by A; `old` as a static token with no owner', ['one', 'two', 'three'].every((n) => profileIn(onB, n)?.owner === aEnv && !profileIn(onB, n)?.static) && profileIn(onB, 'old')?.static === true && profileIn(onB, 'old')?.owner === undefined, JSON.stringify(onB.providers.claude.profiles))
  check('B: no copy carries a refresh token', ['one', 'two', 'three', 'old'].every((n) => readTokens(B, n)?.refreshToken === undefined))
  await until('B makes `old` its live sign-in', 30_000, () => liveToken(B) === 'OAT-old-1')
  check('B: `old` is the Claude CLI\'s live sign-in here, written to this instance\'s credentials file', liveToken(B) === 'OAT-old-1' && logHas(B, 'claude-code: old is the live sign-in here now'))
  await until('B names `old` active', 30_000, async () => profileIn(await snapshot(b), 'old')?.active === true)
  check('B: the row shows it as the active account (the token names itself through the profile endpoint)', true)

  // ── 3. Convert all on A: one/two/three through their grants, `old` (inside its last 30 days) through its stored session ──
  const bodiesBefore = fake.tokenBodies.length
  const authorizesBefore = fake.authorizes.length
  const result = (await a.eval(`window.aliax.convertStatic()`)) as { ok: boolean; notes?: string[]; error?: string }
  check('A: Convert all converted the three accounts with grants and renewed `old`', result.ok === true && result.notes?.[0] === '4 of 4 converted', JSON.stringify(result))
  const grants = fake.tokenBodies.slice(bodiesBefore).filter((g) => g.grant_type === 'refresh_token')
  check('fake: each grant was presented with a one-year expires_in and the static scopes first, and the initial grants were the ones presented', grants.every((g) => g.expires_in === YEAR_S) && grants.filter((g) => g.scope === 'user:profile user:inference').map((g) => g.refresh_token).sort().join(' ') === 'R-one-1 R-three-1 R-two-1', JSON.stringify(grants.map((g) => [g.refresh_token, g.scope])))
  check('fake: `three` was asked again with user:inference alone, presenting the ROTATED grant', grants.some((g) => String(g.refresh_token).startsWith('R-three-') && g.refresh_token !== 'R-three-1' && g.scope === 'user:inference') && grants.length === 4, JSON.stringify(grants.map((g) => [g.refresh_token, g.scope])))
  check('A: `one` and `two` hold one-year tokens with user:profile, `three` with user:inference alone, no refresh token anywhere', ['one', 'two', 'three'].every((n) => isStatic(A, n) && readTokens(A, n)?.refreshToken === undefined && aboutAYear(readTokens(A, n)?.expiresAt, Date.now())) && readTokens(A, 'one')?.scopes?.join(' ') === 'user:profile user:inference' && readTokens(A, 'three')?.scopes?.join(' ') === 'user:inference', JSON.stringify(['one', 'two', 'three'].map((n) => readTokens(A, n))))
  check('A: every row keeps its identity and its claude.ai session', ['one', 'two', 'three'].every((n) => readBlob(A, n)?.oauthAccount?.accountUuid === accounts[n].uuid && readBlob(A, n)?.appSession?.[0]?.value === accounts[n].session))
  const consents = fake.authorizes.slice(authorizesBefore)
  check('fake: `old` was renewed through the consent page with its stored session and the static scopes, in a hidden window', consents.length === 1 && consents[0].name === 'old' && consents[0].cookie === 'SID-old' && consents[0].scope === 'user:profile user:inference', JSON.stringify(consents))
  const exchange = fake.tokenBodies.slice(bodiesBefore).find((g) => g.grant_type === 'authorization_code')
  check('fake: its code was exchanged with a one-year expires_in, the ordinary body otherwise', exchange !== undefined && exchange.expires_in === YEAR_S && typeof exchange.code_verifier === 'string' && exchange.client_id === '9d1c250a-e61b-44d9-88ed-5944d1962f5e' && typeof exchange.state === 'string', JSON.stringify(exchange))
  const newOld = readTokens(A, 'old')?.accessToken
  check('A: `old` holds the new token for about a year, still static, its session kept', newOld !== undefined && newOld !== 'OAT-old-1' && isStatic(A, 'old') && aboutAYear(readTokens(A, 'old')?.expiresAt, Date.now()) && readBlob(A, 'old')?.appSession?.[0]?.value === 'SID-old', JSON.stringify(readTokens(A, 'old')))
  await until('A\'s snapshot settles', 30_000, async () => {
    const s = await snapshot(a)
    return ['one', 'two', 'three'].every((n) => profileIn(s, n)?.static === true) && (s.providers.claude.mint?.run ?? null) === null
  })
  const afterA = await snapshot(a)
  check('A: the rows say static with no owner, lapsing in about a year, and no mint is under way', ['one', 'two', 'three', 'old'].every((n) => profileIn(afterA, n)?.static === true && profileIn(afterA, n)?.owner === undefined && aboutAYear(profileIn(afterA, n)?.expiresAt, Date.now())) && Object.keys(afterA.providers.claude.mint?.rows ?? {}).length === 0, JSON.stringify(afterA.providers.claude.mint))
  check('A: said so, per account', ['old', 'one', 'two', 'three'].every((n) => logHas(A, `[static-tokens] ${n}: one-year token filed`)))

  // ── 4. the usage poll with static tokens ─────────────────────────────
  const refreshed = (await rpc(a, 'accounts.refresh', { provider: 'claude' })) as Snapshot
  const reportOne = reportIn(refreshed, 'one')
  const reportThree = reportIn(refreshed, 'three')
  check('A: a token with user:profile reports usage windows and is not expired', (reportOne?.windows[0]?.usedPercent ?? 0) === 12 && !reportOne?.expired, JSON.stringify(reportOne))
  check('A: the inference-only token says usage is not reported, and is not expired', reportThree?.note === 'one-year token without user:profile: usage is not reported' && !reportThree?.expired, `${JSON.stringify(reportThree)} usage bearers: ${fake.usageBearers.join(' ')}`)

  // ── 5. B receives the static tokens over the existing sync; its live sign-in follows `old`'s renewal ──
  await until('B lands the static tokens', 30_000, async () => ['one', 'two', 'three'].every((n) => isStatic(B, n)) && readTokens(B, 'old')?.accessToken === newOld)
  const bAfter = await snapshot(b)
  check('B: the former access copies are now the static tokens, no owner left, no refresh token', ['one', 'two', 'three'].every((n) => profileIn(bAfter, n)?.static === true && profileIn(bAfter, n)?.owner === undefined && readTokens(B, n)?.refreshToken === undefined && readTokens(B, n)?.accessToken === readTokens(A, n)?.accessToken), JSON.stringify(bAfter.providers.claude.profiles))
  await until('B re-installs its live sign-in', 30_000, () => liveToken(B) === newOld)
  check('B: the live Claude sign-in is the renewed `old` token, installed a second time; the other static tokens were filed, not made live', liveToken(B) === newOld && logCount(B, 'claude-code: old is the live sign-in here now') === 2 && logCount(B, 'is the live sign-in here now') === 2, `live=${liveToken(B)}`)
  check('B: said so for each token', ['one', 'two', 'three', 'old'].every((n) => logHas(B, `claude-code ${n}: static token from ${aEnv} landed`)))

  // ── 6. the renewal pass on A, the one the scheduler runs: `late` through its stored session, `gone` needs a sign-in ──
  addProfile(A, row('late', { static: true }), staticBlob('late', 'OAT-late-1', now + 12 * DAY, 'SID-late'))
  addProfile(A, row('gone', { static: true }), staticBlob('gone', 'OAT-gone-1', now + 5 * DAY, 'SID-dead'))
  const authorizesBeforePass = fake.authorizes.length
  const renewed = (await a.eval(`window.aliax.renewStaticNow()`)) as { ok: boolean; error?: string }
  check('A: the renewal pass ran', renewed.ok === true, JSON.stringify(renewed))
  const passConsents = fake.authorizes.slice(authorizesBeforePass)
  check('fake: the consent page was asked for `late` with its stored session, and for `gone` with a session it does not know', passConsents.some((c) => c.name === 'late' && c.cookie === 'SID-late' && c.scope === 'user:profile user:inference') && passConsents.some((c) => c.name === null && c.cookie === 'SID-dead') && passConsents.length === 2, JSON.stringify(passConsents))
  check('A: `late` holds a new token for about a year, still static, its session kept', readTokens(A, 'late')?.accessToken !== 'OAT-late-1' && isStatic(A, 'late') && aboutAYear(readTokens(A, 'late')?.expiresAt, Date.now()) && readBlob(A, 'late')?.appSession?.[0]?.value === 'SID-late', JSON.stringify(readTokens(A, 'late')))
  await until('A\'s snapshot carries the `gone` row state', 15_000, async () => (await snapshot(a)).providers.claude.mint?.rows.gone?.state === 'needs-sign-in')
  const afterRenew = await snapshot(a)
  check('A: `gone` is marked needs-sign-in with the reason, and its token is unchanged', afterRenew.providers.claude.mint?.rows.gone?.state === 'needs-sign-in' && afterRenew.providers.claude.mint?.rows.gone?.detail === 'the stored claude.ai session has lapsed' && readTokens(A, 'gone')?.accessToken === 'OAT-gone-1', JSON.stringify(afterRenew.providers.claude.mint))
  check('A: logged both', logHas(A, '[static-tokens] late: renewal done') && logHas(A, '[static-tokens] gone: renewal needs-sign-in (the stored claude.ai session has lapsed)'))

  // ── 7. B lands the renewed and the stranded token alike; nothing on B presents a refresh token; its live sign-in stays `old` ──
  await until('B lands `late` and `gone`', 30_000, () => readTokens(B, 'late')?.accessToken === readTokens(A, 'late')?.accessToken && isStatic(B, 'gone'))
  check('B: holds every static token, none with a refresh token, and its live sign-in is still `old`', ['old', 'one', 'two', 'three', 'late', 'gone'].every((n) => isStatic(B, n) && readTokens(B, n)?.refreshToken === undefined) && liveToken(B) === newOld)

  // ── 8. the renderer on A: the `gone` row says what to do ────────────
  const opened = (await a.eval(`(() => { const el = [...document.querySelectorAll('button,[role=menuitem],[role=button],a')].find((e) => (e.textContent ?? '').trim() === 'Accounts'); if (!el) return false; el.click(); return true })()`)) as boolean
  await sleep(2_000)
  const text = (await a.eval(`document.body.innerText`)) as string
  const line = /Sign in to renew its one-year token/.test(text)
  const quiet = /One-year token · lapses/.test(text)
  log(opened ? `Accounts page open: ${line ? 'the `gone` row says to sign in' : 'needs-sign-in line not on screen'}; ${quiet ? 'static rows name their lapse' : 'no lapse line on screen'}` : 'no Accounts entry found to click; UI check skipped')
  if (opened && (line || quiet)) {
    const shot = (await a.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync('/tmp/tc-static-tokens-a.png', Buffer.from(shot.data, 'base64'))
    log('screenshot of A: /tmp/tc-static-tokens-a.png')
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
