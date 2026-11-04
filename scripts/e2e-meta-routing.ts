/**
 * The Meta Model API through the gateway, for real: one in-process server
 * (as scripts/e2e-quota-routing.ts boots it) over a throwaway vault holding
 * two Meta keys and nothing else, and a fake api.meta.ai in place of the real
 * one. A Meta row under the claude harness and one under codex each route
 * to a key (the route carries `service: 'meta'`), the request leaves on the
 * lane's own wire shape with the key as the bearer and neither x-api-key nor
 * chatgpt-account-id, the fake's four x-ratelimit headers land in the
 * headroom store, one key's 429 with Retry-After goes back to the child
 * unreplayed (two keys of one team share the bucket) and moves the NEXT
 * turn to the other key until the cooldown lifts, and a claude thread on an Anthropic
 * model finds no account at all (the vault has no Anthropic sign-in).
 *
 * Run: bun run script:e2e-meta-routing
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

const root = mkdtempSync(join(tmpdir(), 'tc-meta-'))
const vaultDir = join(root, 'aliax')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config')
process.env.ALIAX_CREDENTIAL_BACKEND = 'file'
process.env.CODEX_HOME = join(root, 'codex-home')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.CODEX_HOME, { recursive: true })

const KEYS: Record<string, string> = { 'Meta key …aaaa': 'LLM_1607_secretaaaa', 'Team key': 'LLM_99_secretbbbb' }
const NAMES = Object.keys(KEYS)
const RETRY_AFTER_S = 2

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── the vault: two Meta keys, sealed by a key file; no Anthropic or OpenAI account at all ──
mkdirSync(join(vaultDir, 'secrets'), { recursive: true, mode: 0o700 })
const password = randomBytes(32).toString('hex')
writeFileSync(join(vaultDir, 'vault.key'), `${password}\n`, { mode: 0o600 })
const now = Date.now()
writeFileSync(
  join(vaultDir, 'profiles.json'),
  JSON.stringify({ meta: NAMES.map((name) => ({ name, accountId: KEYS[name].split('_')[1], createdAt: now, static: true })) }, null, 2)
)
const vaultKey = deriveChromiumKey(password)
for (const name of NAMES) writeFileSync(join(vaultDir, 'secrets', `meta__${encodeURIComponent(name)}.bin`), chromiumEncrypt(vaultKey, JSON.stringify({ key: KEYS[name] })))

// ── the fake Meta Model API: /v1/models for the probe, /v1/messages and /v1/responses with the documented headers ──
interface Seen {
  path: string
  authorization: string | null
  xApiKey: string | null
  chatgptAccount: string | null
  model: string | null
}
const fake = { throttle: true, seen: [] as Seen[], refused: 0 }
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = ''
    req.on('data', (c: Buffer) => (text += c.toString()))
    req.on('end', () => resolve(text))
  })
const provider = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const name = NAMES.find((n) => KEYS[n] === bearer) ?? null
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  if (!name) return json(401, { error: { message: 'Invalid API key', type: 'authentication_error' } })
  if (url.pathname === '/v1/models') return json(200, { data: [{ id: 'muse-wonder-1.0', created: 1 }, { id: 'muse-spark-1.3', created: 1 }] })
  if (url.pathname === '/v1/messages' || url.pathname === '/v1/responses') {
    const body = await readBody(req)
    let model: string | null = null
    try {
      model = (JSON.parse(body) as { model?: string }).model ?? null
    } catch {
      model = null
    }
    fake.seen.push({
      path: url.pathname,
      authorization: req.headers.authorization ?? null,
      xApiKey: (req.headers['x-api-key'] as string | undefined) ?? null,
      chatgptAccount: (req.headers['chatgpt-account-id'] as string | undefined) ?? null,
      model
    })
    const limits = { 'x-ratelimit-limit-requests': '3000', 'x-ratelimit-limit-tokens': '4000000', 'x-ratelimit-remaining-tokens': '3999000' }
    if (name === NAMES[0] && fake.throttle) {
      fake.refused++
      return json(429, { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }, { ...limits, 'x-ratelimit-remaining-requests': '0', 'retry-after': String(RETRY_AFTER_S) })
    }
    const answered = fake.seen.filter((s) => s.authorization === req.headers.authorization).length
    const headers = { ...limits, 'x-ratelimit-remaining-requests': String(3000 - answered) }
    if (url.pathname === '/v1/messages') {
      return json(200, { id: `msg_${answered}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, headers)
    }
    return json(200, { id: `resp_${answered}`, object: 'response', model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }, headers)
  }
  json(404, { error: 'not here' })
})
await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok))
const FAKE = `http://127.0.0.1:${(provider.address() as { port: number }).port}`

configure({
  dataDir: vaultDir,
  fetch: (input, init) => fetch(String(input).replace(/^https:\/\/(api\.meta\.ai|api\.anthropic\.com|chatgpt\.com)/, FAKE), init),
  secrets: { mode: 'fileKey' },
  appName: 'temp-code-e2e'
})
const { startServer } = await import('../src/main/server/index')
const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0, dataDir: root })
const gateway = `http://127.0.0.1:${server.gateway.status().port}`

// ── the accounts service lists the two keys as pay as you go ──
let snapshot = await server.accounts.list()
for (let i = 0; i < 50 && snapshot.providers.meta.profiles.length < NAMES.length; i++) {
  await sleep(200)
  snapshot = await server.accounts.list()
}
check('the two Meta keys are in the snapshot under meta', snapshot.providers.meta.profiles.length === NAMES.length, `${snapshot.providers.meta.profiles.length} profiles`)
check('their reports say pay as you go from the /v1/models probe', snapshot.providers.meta.reports.every((r) => r.note === 'pay as you go' && !r.expired), JSON.stringify(snapshot.providers.meta.reports.map((r) => r.note)))
check('no Anthropic or OpenAI account is on file', snapshot.providers.claude.profiles.length === 0 && snapshot.providers.codex.profiles.length === 0)

const meta = (id: string, provider: 'claude' | 'codex', model: string, account: string | null = null): SessionMeta =>
  ({ id, provider, model, account, updatedAt: Date.now(), status: 'idle', archived: false }) as unknown as SessionMeta

/** One answer as a thread's child would send it: the lane's wire shape under the thread's scope. */
const turn = async (lane: 'claude' | 'codex', thread: string, account: string, model: string): Promise<number> => {
  const scope = `~t=${encodeURIComponent(thread)};a=${encodeURIComponent(account)};m=${encodeURIComponent(model)};s=meta`
  const path = lane === 'claude' ? '/v1/messages' : '/v1/responses'
  const body = lane === 'claude' ? { model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] } : { model, input: 'hi', reasoning: { effort: 'high' } }
  const res = await fetch(`${gateway}/${lane}/${scope}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer child-placeholder', 'x-api-key': 'cli-key', 'chatgpt-account-id': 'cli-acct' },
    body: JSON.stringify(body)
  })
  await res.text()
  return res.status
}

// ── a Meta row under either harness routes to a key; an Anthropic row finds nothing ──
const claudeRoute = server.accounts.routeFor(meta('t-claude', 'claude', 'muse-wonder-1.0'), null)
const codexRoute = server.accounts.routeFor(meta('t-codex', 'codex', 'muse-spark-1.3'), null)
check('a Meta row under claude routes to a key with service meta', claudeRoute.route?.service === 'meta' && NAMES.includes(claudeRoute.route.account), JSON.stringify(claudeRoute))
check('a Meta row under codex routes to a key with service meta', codexRoute.route?.service === 'meta' && NAMES.includes(codexRoute.route.account), JSON.stringify(codexRoute))
const anthropic = server.accounts.routeFor(meta('t-opus', 'claude', 'claude-opus-5-5'), null)
check('an Anthropic row on this host has no account to route to', anthropic.route === null && anthropic.current === null, JSON.stringify(anthropic))

// ── the turns leave on the lane's shape with the key as the bearer; the second key takes the throttled one's work ──
const first = claudeRoute.route!.account
const other = NAMES.find((n) => n !== first)!
// The first key is the throttled one in the fake: route the throttled turn to it explicitly.
const throttledStatus = await turn('claude', 't-claude', NAMES[0], 'muse-wonder-1.0')
check('the fake refused the first key once with Retry-After', fake.refused === 1, `status back to the child ${throttledStatus}, refused ${fake.refused}`)
// A Meta 429 is transient (a per-team per-minute limit, Retry-After): core never replays it onto another key, since two keys of one team share the bucket; the child's CLI retries, and the host's cooldown moves the NEXT turn.
check('the 429 went back to the child unreplayed, on the claude lane with the key as the bearer', throttledStatus === 429 && fake.seen.length === 1 && fake.seen[0].authorization === `Bearer ${KEYS[NAMES[0]]}` && fake.seen[0].path === '/v1/messages' && fake.seen[0].model === 'muse-wonder-1.0', JSON.stringify(fake.seen.at(-1)))
const codexStatus = await turn('codex', 't-codex', NAMES[1], 'muse-spark-1.3')
check('a codex-lane turn reaches /v1/responses with the key as the bearer', codexStatus === 200 && fake.seen.at(-1)?.path === '/v1/responses' && fake.seen.at(-1)?.authorization === `Bearer ${KEYS[NAMES[1]]}` && fake.seen.at(-1)?.model === 'muse-spark-1.3', JSON.stringify(fake.seen.at(-1)))
check("neither lane carried the CLI's x-api-key or chatgpt-account-id", fake.seen.every((s) => s.xApiKey === null && s.chatgptAccount === null), JSON.stringify(fake.seen.map((s) => [s.xApiKey, s.chatgptAccount])))
void first
void other

await sleep(400)
const headroom = (await server.accounts.list()).providers.meta.headroom ?? {}
check('the throttled key is out until its Retry-After', (headroom[NAMES[0]]?.throttledUntil ?? 0) > Date.now() && (headroom[NAMES[0]]?.throttledUntil ?? 0) <= Date.now() + RETRY_AFTER_S * 1000, JSON.stringify(headroom[NAMES[0]]))
check("the other key's headroom carries Meta's four headers", headroom[NAMES[1]]?.room !== null && (headroom[NAMES[1]]?.room ?? 0) < 1 && (headroom[NAMES[1]]?.ratePerMin ?? 0) >= 1, JSON.stringify(headroom[NAMES[1]]))
const next = server.accounts.routeFor(meta('t-next', 'claude', 'muse-wonder-1.0'), null)
check('the next Meta turn is picked onto the other key while the cooldown holds', next.current === NAMES[1], JSON.stringify(next))

// ── the cooldown lifts: the first key is a pick again ──
await sleep(Math.max(0, (headroom[NAMES[0]]?.throttledUntil ?? 0) - Date.now()) + 300)
fake.throttle = false
const lifted = (await server.accounts.list()).providers.meta.headroom?.[NAMES[0]]
check('after Retry-After the first key is no longer out', !lifted?.throttledUntil || lifted.throttledUntil <= Date.now(), JSON.stringify(lifted))
const again = server.accounts.routeFor(meta('t-again', 'codex', 'muse-wonder-1.0'), null)
check('a fresh Meta turn may land on the first key again', NAMES.includes(again.current ?? ''), JSON.stringify(again))
check('that turn answers', (await turn('codex', 't-again', again.current ?? NAMES[0], 'muse-wonder-1.0')) === 200)

// ── the picture survives a close ──
await server.close()
provider.close()
const file = join(root, 'headroom.json')
const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { hosts: Record<string, Record<string, { throttles: unknown[] }>> }) : null
const own = saved?.hosts?.[server.environmentId]
check('headroom.json keeps the keys under meta with the 429', !!own && own[`meta:${NAMES[0]}`]?.throttles.length === 1 && Object.keys(own).length === NAMES.length, own ? Object.keys(own).join(', ') : 'no file')

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
