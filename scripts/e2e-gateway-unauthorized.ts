/**
 * Headless gateway sign-in failover: a fake upstream answers account A with
 * 401 token_expired (its sign-in is dead) and account B with 200. A request
 * scoped to thread T under A must replay under B with T's row moved, T's
 * next request must go straight to B, the pin must stay on A, and once B is
 * dead too the 401 must pass through with one "needs sign-in" row on T
 * naming A, codex's own wording for the same 401 dropped. Wired the way
 * src/main/server/index.ts wires the server.
 *
 * Nothing here touches the real Aliax data: core runs on a temp dir sealed
 * with a throwaway key, and its fetch is rewritten onto the fake upstream.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, pinProfile, pinnedProfile, vault } from 'aliax-core'
import { PROVIDER_OF, SERVICE_OF, isRoutedProvider } from '../src/shared/accounts'
import { AccountsService } from '../src/main/server/accounts'
import { openDb, Store } from '../src/main/server/db'
import { Gateway } from '../src/main/server/gateway'
import { observeHooks } from '../src/main/server/gatewayObserve'
import { routeUrl } from '../src/main/server/endpoint'
import { SessionRegistry } from '../src/main/server/sessions'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

// --- the fake upstream -----------------------------------------------------
const dead = new Set(['Bearer token-A'])
const upstreamCalls: { auth: string; body: string; path: string }[] = []
const upstream = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const auth = req.headers.authorization ?? ''
    upstreamCalls.push({ auth, body: Buffer.concat(chunks).toString(), path: req.url ?? '' })
    if (req.url === '/usage') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 20, reset_at: Math.floor(Date.now() / 1000) + 3600, limit_window_seconds: 18000 } } }))
      return
    }
    if (dead.has(auth)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"detail":{"code":"token_expired","message":"token expired"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, auth }))
  })
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

// --- core on a throwaway vault, fetch pointed at the fake ------------------
const dataDir = mkdtempSync(join(tmpdir(), 'tc-gw-401-'))
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

// --- temp-code's service, registry and gateway, wired as the server does ---
const db = openDb(join(dataDir, 'test.db'))
const store = new Store(db)
const registry = new SessionRegistry(store)
const accounts = new AccountsService({ owner: () => 'temp-code', pollMs: 3_600_000, load: (p) => registry.liveLoad(p) })
registry.limits = accounts
await accounts.list()
const routed: string[] = []
const observed = observeHooks({ logDir: join(dataDir, 'logs') })
const gateway = new Gateway({
  claimShim: false,
  hooks: {
    ...observed,
    onResponse: (info) => {
      observed.onResponse?.(info)
      if (info.status < 400 && info.account && isRoutedProvider(info.service)) accounts.markAnswered(SERVICE_OF[info.service], info.account)
    },
    pickNext: (info) => accounts.pickNext(info),
    substitute: (info) => accounts.substitute(info.serviceId, info.account, info.model),
    onUnauthorized: (info) => {
      if (accounts.markOut(info.serviceId, info.account)) console.log(`[gateway] ${info.service}: ${info.account} answered 401; out of routing until it answers again`)
      const next = accounts.substitute(info.serviceId, info.account, info.model)
      // The thread's own account, when it is the dead one: a substitute
      // dying later adds nothing the user can act on beyond that.
      if (!next) registry.signInNeeded(info.thread, accounts.outFor(PROVIDER_OF[info.serviceId]).includes(info.own) ? info.own : info.account)
      return next
    },
    onRouted: (info) => {
      routed.push(`${info.thread}:${info.account}`)
      registry.setAccount(info.thread, info.account)
    }
  }
})
await gateway.start()
const thread = await registry.create({ cwd: dataDir, provider: 'codex', model: 'gpt-6-astra' })
const T = thread.id
const base = gateway.url('codex')!
const scoped = routeUrl(base, T, { account: 'A', pin: false })
const post = (url: string) =>
  fetch(`${url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer cli-token' }, body: JSON.stringify({ model: 'gpt-6-astra', input: 'hi' }) })
const rows = () => store.eventsAfter(T, 0).map((r) => r.event).filter((e) => e.type === 'error').map((e) => (e as { message: string }).message)

try {
  // 1. A is dead: the first request replays under B and the client sees B's 200.
  let res = await post(scoped)
  let text = await res.text()
  check('client gets the replayed 200', res.status === 200, String(res.status))
  check('the answer came from account B', text.includes('"auth":"Bearer token-B"'), text.trim())
  const turns = () => upstreamCalls.filter((c) => c.path.endsWith('/v1/responses')).map((c) => c.auth)
  check('A was tried once, then B once', turns().join(',') === 'Bearer token-A,Bearer token-B', turns().join(','))
  check('the thread moved to B, once', routed.join(',') === `${T}:B`, routed.join(','))
  check("the thread's row shows B", store.getSession(T)?.account === 'B', String(store.getSession(T)?.account))
  check('A is out of routing', accounts.outFor('codex').join(',') === 'A', accounts.outFor('codex').join(','))
  check('a new thread would not land on A', accounts.routeFor({ id: 'n', provider: 'codex', model: 'gpt-6-astra' } as never, null).current === 'B')
  // 2. The next request goes straight to B.
  res = await post(scoped)
  await res.text()
  check('the second request went straight to B', turns().slice(2).join(',') === 'Bearer token-B', turns().slice(2).join(','))
  check('the pin stayed on A', pinnedProfile('codex') === 'A', String(pinnedProfile('codex')))
  check('no rows yet', rows().length === 0, rows().join(' | '))
  // 3. B dies too and A is still dead: the 401 passes through, one row names A.
  dead.add('Bearer token-B')
  res = await post(scoped)
  text = await res.text()
  check('with nothing left the 401 passes through', res.status === 401, String(res.status))
  check('the 401 body is the upstream one', text.includes('token_expired'), text)
  check('one row names the thread\'s own account', rows().join(' | ') === 'Aliax account A needs sign-in', rows().join(' | '))
  registry.append(T, { type: 'error', message: 'workspace routing discovery unauthorized (401)' })
  check("codex's own 401 wording is dropped meanwhile", rows().join(' | ') === 'Aliax account A needs sign-in', rows().join(' | '))
  res = await post(scoped)
  await res.text()
  check('a second pass posts no second row', rows().length === 1, rows().join(' | '))
  // 4. A answers again: the thread returns to its own account and its row follows.
  dead.delete('Bearer token-A')
  res = await post(scoped)
  text = await res.text()
  check('A answering lifts its mark', res.status === 200 && text.includes('token-A') && accounts.outFor('codex').join(',') === 'B', `${res.status} ${accounts.outFor('codex').join(',')}`)
  check('the row is back on A', store.getSession(T)?.account === 'A' && routed.at(-1) === `${T}:A`, routed.join(','))
} finally {
  await gateway.stop()
  await registry.disposeAll()
  db.close()
  upstream.close()
  rmSync(dataDir, { recursive: true, force: true })
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
