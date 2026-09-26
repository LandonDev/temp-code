/**
 * Headless gateway failover: a fake upstream refuses account A with a
 * usage-limit 429 and answers account B. A request scoped to thread T under
 * A must be replayed under B with only T moved (the global pin untouched,
 * onRouted fired once), T's next request must go straight to B, and an
 * unscoped request must still move the pin as before.
 *
 * Nothing here touches the real Aliax data: core runs on a temp dir sealed
 * with a throwaway key, and its fetch is rewritten onto the fake upstream.
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, pinProfile, pinnedProfile, vault } from 'aliax-core'
import { AccountsService } from '../src/main/server/accounts'
import { Gateway } from '../src/main/server/gateway'
import { observeHooks } from '../src/main/server/gatewayObserve'
import { routeUrl } from '../src/main/server/endpoint'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}
const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timeout: ${label}`)
}

// --- the fake upstream -----------------------------------------------------
const RESET_AT = Math.floor(Date.now() / 1000) + 3600
const upstreamCalls: { auth: string; body: string; path: string }[] = []
const upstream = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const auth = req.headers.authorization ?? ''
    upstreamCalls.push({ auth, body: Buffer.concat(chunks).toString(), path: req.url ?? '' })
    if (req.url === '/usage') {
      // Codex usage poll: whoever asks has room.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 20, reset_at: RESET_AT, limit_window_seconds: 18000 }, secondary_window: { used_percent: 10, reset_at: RESET_AT, limit_window_seconds: 604800 } } }))
      return
    }
    if (auth === 'Bearer token-A') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'usage_limit_reached', rate_limit_reached_type: 'primary', resets_at: RESET_AT, message: "You've hit your usage limit." } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: response.completed\ndata: {"type":"response.completed","auth":"' + auth + '"}\n\n')
    res.end()
  })
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

// --- core on a throwaway vault, fetch pointed at the fake ------------------
const dataDir = mkdtempSync(join(tmpdir(), 'tc-gw-failover-'))
configure({
  dataDir,
  fetch: (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return fetch(url.replace(/^https:\/\/chatgpt\.com\/backend-api(\/codex)?/, upstreamUrl), init)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})
vault.useFixedChromiumKey('Test Safe Storage', vault.randomChromiumKey())
const jwt = (email: string): string =>
  ['e30', Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_account_id: `acct-${email}` }, exp: 4e9 })).toString('base64url'), 'x'].join('.')
for (const name of ['A', 'B']) {
  vault.upsertProfile('codex', { name, accountId: `acct-${name}`, email: `${name}@x.com`, createdAt: 1 })
  vault.saveSecret('codex', name, JSON.stringify({ tokens: { access_token: `token-${name}`, id_token: jwt(`${name}@x.com`), account_id: `acct-${name}` } }))
}
pinProfile('codex', 'A')

// --- temp-code's service and gateway, wired as the server does --------------
const pushes: string[] = []
const accounts = new AccountsService({ owner: () => 'temp-code', pollMs: 3_600_000 })
accounts.onChange((s) => pushes.push(`${s.providers.codex.pinned}:${s.providers.codex.note ?? ''}`))
await accounts.list()
const switched: string[] = []
const routed: string[] = []
const gateway = new Gateway({
  claimShim: false,
  hooks: {
    ...observeHooks({ logDir: join(dataDir, 'logs') }),
    pickNext: (info) => accounts.pickNext(info),
    onFailedOver: (info) => switched.push(`${info.from}->${info.to}`),
    onRouted: (info) => routed.push(`${info.thread}:${info.account}`)
  }
})
await gateway.start()
const base = gateway.url('codex')!
const scoped = routeUrl(base, 'T', { account: 'A', pin: false })

try {
  const body = JSON.stringify({ model: 'gpt-6-astra', input: [{ role: 'user', content: 'hi' }], stream: true })
  const res = await fetch(`${scoped}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer cli-token' }, body })
  const text = await res.text()
  check('client gets the replayed 200', res.status === 200, String(res.status))
  check('the answer came from account B', text.includes('"auth":"Bearer token-B"'), text.trim())
  const turns = upstreamCalls.filter((c) => c.path.endsWith('/v1/responses'))
  check('A was tried once, then B once', turns.map((c) => c.auth).join(',') === 'Bearer token-A,Bearer token-B', turns.map((c) => c.auth).join(','))
  check('the scope segment never reached upstream', turns.every((c) => c.path === '/v1/responses'), turns.map((c) => c.path).join(','))
  check('the replay carried the same body', turns[1]?.body === body)
  check('B was polled before the pick', upstreamCalls.some((c) => c.path === '/usage' && c.auth === 'Bearer token-B'))
  check('the pin stayed on A', pinnedProfile('codex') === 'A', String(pinnedProfile('codex')))
  check('onRouted reported T on B once, onFailedOver nothing', routed.join(',') === 'T:B' && switched.length === 0, `${routed.join(',')} / ${switched.join(',')}`)
  const cache = JSON.parse(readFileSync(join(dataDir, 'usage-cache.json'), 'utf8'))
  const aWindows = cache['codex:A']?.report?.windows ?? []
  check("A's 5h window reads full with the provider's reset", aWindows.some((w: { label: string; usedPercent: number; resetsAt?: number }) => w.label === '5h' && w.usedPercent === 100 && w.resetsAt === RESET_AT * 1000), JSON.stringify(aWindows))
  // The server's watcher would nudge on the cache write; here we nudge by hand.
  const pushesBefore = pushes.length
  accounts.nudge()
  await waitFor(() => pushes.length > pushesBefore, 'a snapshot push after the observed limit')
  const snap = accounts.snapshot()
  check("the snapshot shows A's window full and the pin on A", snap.providers.codex.pinned === 'A' && snap.providers.codex.reports.find((r) => r.profileName === 'A')?.windows.some((w) => w.label === '5h' && w.usedPercent === 100) === true)
  check('the next reset is A\'s, after the grace', accounts.nextReset()?.at === RESET_AT * 1000 + 15_000 && accounts.nextReset()?.stale[0]?.name === 'A')

  let before = upstreamCalls.length
  const res2 = await fetch(`${scoped}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer cli-token' }, body })
  await res2.text()
  let after = upstreamCalls.slice(before).filter((c) => c.path.endsWith('/v1/responses'))
  check("T's second request goes straight to B", res2.status === 200 && after.length === 1 && after[0].auth === 'Bearer token-B', after.map((c) => c.auth).join(','))
  check('no second onRouted', routed.length === 1)

  // A sibling thread on B is untouched by any of this.
  before = upstreamCalls.length
  const res3 = await fetch(`${routeUrl(base, 'U', { account: 'B', pin: true })}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  await res3.text()
  after = upstreamCalls.slice(before).filter((c) => c.path.endsWith('/v1/responses'))
  check('a pinned sibling on B spends from B in one try', res3.status === 200 && after.length === 1 && after[0].auth === 'Bearer token-B' && routed.length === 1)

  // Unscoped (terminal) traffic still follows the pin and still moves it.
  before = upstreamCalls.length
  const res4 = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer cli-token' }, body })
  await res4.text()
  after = upstreamCalls.slice(before).filter((c) => c.path.endsWith('/v1/responses'))
  check('an unscoped request tries the pin (A), then B, and moves the pin', res4.status === 200 && after.map((c) => c.auth).join(',') === 'Bearer token-A,Bearer token-B' && pinnedProfile('codex') === 'B', after.map((c) => c.auth).join(','))
  check('onFailedOver reported A->B once for it', switched.join(',') === 'A->B')
  check('gateway counted four routed codex requests', gateway.status().routed.codex === 4, JSON.stringify(gateway.status().routed))
} finally {
  accounts.stop()
  await gateway.stop()
  upstream.close()
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
