/**
 * Quota-aware routing for real: one in-process server (as scripts/e2e-remote.ts
 * boots it) over a throwaway vault of eleven static Claude accounts and a
 * fake Anthropic in place of the real one. One account answers 429 with a
 * two-second retry-after; the gateway sees it, the headroom store keeps the
 * account out, and ten new turns picked through the same routeFor the
 * registry calls at spawn land on ten different other accounts, each turn's
 * one answer tipping the next pick away from it. Once the cooldown lifts
 * the throttled account is a pick again, the rows' snapshot carries every
 * account's headroom, and the picture survives in headroom.json after close.
 *
 * Run: bun run script:e2e-quota-routing
 * Nothing here touches /Applications/TempCode.app, its userData, the real
 * Aliax vault, the real ~/.claude or ~/.codex, the gateway marker or the
 * Keychain: the CLI credential seams point into the temp dir.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'
import type { SessionMeta } from '../src/shared/events'

const root = mkdtempSync(join(tmpdir(), 'tc-quota-'))
const vaultDir = join(root, 'aliax')
// The CLI's own sign-in lives in these, which stay empty: no live account, nothing of the user's.
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config')
process.env.ALIAX_CREDENTIAL_BACKEND = 'file'
process.env.CODEX_HOME = join(root, 'codex-home')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.CODEX_HOME, { recursive: true })

const THROTTLED = 'a00-throttled@x.com'
const OTHERS = Array.from({ length: 10 }, (_, i) => `b${String(i + 1).padStart(2, '0')}@x.com`)
const ACCOUNTS = [THROTTLED, ...OTHERS]
const tokenOf = (name: string): string => `TOK-${name}`
const RETRY_AFTER_S = 2

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── the vault: eleven one-year-token accounts, sealed by a key file ──────────
mkdirSync(join(vaultDir, 'secrets'), { recursive: true, mode: 0o700 })
const password = randomBytes(32).toString('hex')
writeFileSync(join(vaultDir, 'vault.key'), `${password}\n`, { mode: 0o600 })
const now = Date.now()
writeFileSync(
  join(vaultDir, 'profiles.json'),
  JSON.stringify({ 'claude-code': ACCOUNTS.map((name, i) => ({ name, accountId: `u-${i}`, email: name, color: '#5b8def', createdAt: now, static: true })) }, null, 2)
)
const key = deriveChromiumKey(password)
for (const name of ACCOUNTS) {
  const blob = JSON.stringify({
    keychain: JSON.stringify({ claudeAiOauth: { accessToken: tokenOf(name), expiresAt: now + 365 * 86_400_000, scopes: ['user:inference', 'user:profile'] } }),
    oauthAccount: { accountUuid: `u-${ACCOUNTS.indexOf(name)}`, emailAddress: name }
  })
  writeFileSync(join(vaultDir, 'secrets', `claude-code__${encodeURIComponent(name)}.bin`), chromiumEncrypt(key, blob))
}

// ── the fake Anthropic: usage and profile for every token, messages with limit headers, one account throttled ──
const fake = { throttle: true, answers: new Map<string, number>(), refused: 0 }
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = ''
    req.on('data', (c: Buffer) => (text += c.toString()))
    req.on('end', () => resolve(text))
  })
const provider = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const account = ACCOUNTS.find((a) => tokenOf(a) === bearer) ?? null
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  if (!account) return json(401, { error: { type: 'authentication_error', message: 'unknown token' } })
  if (url.pathname === '/api/oauth/usage') return json(200, { five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() } })
  if (url.pathname === '/api/oauth/profile') return json(200, { account: { uuid: `u-${ACCOUNTS.indexOf(account)}`, email: account }, organization: { uuid: 'org-fake', name: 'Fake', rate_limit_tier: 'default_claude_max_5x' } })
  if (url.pathname === '/v1/messages') {
    await readBody(req)
    if (account === THROTTLED && fake.throttle) {
      fake.refused++
      return json(
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your rate limit.' } },
        {
          'retry-after': String(RETRY_AFTER_S),
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-requests-limit': '50',
          'anthropic-ratelimit-requests-remaining': '0',
          'anthropic-ratelimit-requests-reset': new Date(Date.now() + RETRY_AFTER_S * 1000).toISOString()
        }
      )
    }
    const n = (fake.answers.get(account) ?? 0) + 1
    fake.answers.set(account, n)
    return json(
      200,
      { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      {
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': String(50 - n),
        'anthropic-ratelimit-requests-reset': new Date(Date.now() + 60_000).toISOString(),
        'anthropic-ratelimit-unified-status': 'allowed'
      }
    )
  }
  json(404, { error: 'not here' })
})
await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok))
const FAKE = `http://127.0.0.1:${(provider.address() as { port: number }).port}`

configure({
  dataDir: vaultDir,
  fetch: (input, init) => fetch(String(input).replace(/^https:\/\/(api\.anthropic\.com|platform\.claude\.com|claude\.ai)/, FAKE), init),
  secrets: { mode: 'fileKey' },
  appName: 'temp-code-e2e'
})
const { startServer } = await import('../src/main/server/index')
const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0, dataDir: root })
const gateway = `http://127.0.0.1:${server.gateway.status().port}`

// ── the accounts service knows all eleven ──
let snapshot = await server.accounts.list()
for (let i = 0; i < 50 && snapshot.providers.claude.profiles.length < ACCOUNTS.length; i++) {
  await sleep(200)
  snapshot = await server.accounts.list()
}
check('the vault\'s eleven accounts are in the snapshot', snapshot.providers.claude.profiles.length === ACCOUNTS.length, `${snapshot.providers.claude.profiles.length} profiles`)

/** One answer as a thread's child would get it: through the gateway, scoped to the thread and its account. */
const turn = async (thread: string, account: string): Promise<number> => {
  const res = await fetch(`${gateway}/claude/~t=${encodeURIComponent(thread)};a=${encodeURIComponent(account)}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer child-placeholder' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
  })
  await res.text()
  return res.status
}
const meta = (id: string, account: string | null = null): SessionMeta =>
  ({ id, provider: 'claude', model: 'claude-opus-5-5', account, updatedAt: Date.now(), status: 'idle', archived: false }) as unknown as SessionMeta
const headroomOf = async (account: string) => (await server.accounts.list()).providers.claude.headroom?.[account]

// ── a thread on the throttled account gets refused: the gateway sees it and the store keeps the account out ──
const refusedStatus = await turn('t-throttled', THROTTLED)
check('the fake refused the throttled account once', fake.refused === 1, `status back to the child ${refusedStatus}, refused ${fake.refused}`)
// The gateway's own failover replayed that request under another account: one answer there already.
const replayedTo = OTHERS.find((a) => fake.answers.get(a) === 1) ?? null
check('the refused request was replayed under another account', refusedStatus === 200 && replayedTo !== null, `${replayedTo}`)
await sleep(400)
const throttled = await headroomOf(THROTTLED)
check('the snapshot shows the account rate limited until its retry-after', (throttled?.throttledUntil ?? 0) > Date.now() && (throttled?.throttledUntil ?? 0) <= Date.now() + RETRY_AFTER_S * 1000, JSON.stringify(throttled))

// ── ten turns: none on the throttled account, and spread one per account ──
const picks: string[] = []
for (let i = 1; i <= 10; i++) {
  const { current } = server.accounts.routeFor(meta(`t${i}`), null)
  if (!current) {
    check(`turn ${i} picked an account`, false)
    break
  }
  picks.push(current)
  const status = await turn(`t${i}`, current)
  if (status !== 200) check(`turn ${i} answered`, false, `status ${status} on ${current}`)
}
check('no turn landed on the throttled account', !picks.includes(THROTTLED), picks.join(', '))
check('the ten turns spread over ten different accounts', new Set(picks).size === 10 && picks.every((p) => OTHERS.includes(p)), picks.join(', '))
check(
  'every other account answered once, the replay target twice, and the replay target was picked last',
  OTHERS.every((a) => fake.answers.get(a) === (a === replayedTo ? 2 : 1)) && picks[9] === replayedTo,
  OTHERS.map((a) => `${a}:${fake.answers.get(a) ?? 0}`).join(' ')
)

// ── a sticky thread with a warm cache stays where it is; the picture reaches the rows ──
const sticky = server.accounts.routeFor(meta('t1', picks[0]), null)
check('a thread that just answered stays on its account', sticky.current === picks[0], `${sticky.current}`)
await sleep(5_500)
const rows = (await server.accounts.list()).providers.claude.headroom ?? {}
check(
  'the rows carry every account\'s headroom from the limit headers',
  OTHERS.every((a) => rows[a]?.room !== null && rows[a]?.room !== undefined && rows[a]!.room! < 1 && rows[a]!.ratePerMin === (a === replayedTo ? 2 : 1)),
  OTHERS.map((a) => `${a}:${rows[a]?.room}/${rows[a]?.ratePerMin}`).join(' ')
)

// ── the cooldown lifts: the throttled account is a pick again ──
await sleep(Math.max(0, (throttled?.throttledUntil ?? 0) - Date.now()) + 300)
fake.throttle = false
const lifted = await headroomOf(THROTTLED)
check('after its reset the account is no longer rate limited', !lifted?.throttledUntil || lifted.throttledUntil <= Date.now(), JSON.stringify(lifted))
// aliax-core charged the account's 5h window on the 429 and keeps it charged until a usage poll says otherwise: that poll.
const refreshed = await server.accounts.refresh('claude')
const report = refreshed.providers.claude.reports.find((r) => r.profileName === THROTTLED)
const next = server.accounts.routeFor(meta('t11'), null)
check('an eleventh turn goes to the account that was rate limited, now the emptiest', next.current === THROTTLED, `${next.current}; its report ${JSON.stringify(report?.windows)} ${report?.rateLimit ? 'rateLimit ' + JSON.stringify(report.rateLimit) : ''}`)
check('that turn answers', (await turn('t11', next.current ?? THROTTLED)) === 200)

// ── the picture survives a close ──
await server.close()
provider.close()
const file = join(root, 'headroom.json')
const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { version: number; hosts: Record<string, Record<string, { throttles: unknown[] }>> }) : null
const own = saved?.hosts?.[server.environmentId]
check('headroom.json holds this host\'s picture with the 429', !!own && own[`claude-code:${THROTTLED}`]?.throttles.length === 1 && Object.keys(own).length === ACCOUNTS.length, own ? `${Object.keys(own).length} accounts` : 'no file')

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
