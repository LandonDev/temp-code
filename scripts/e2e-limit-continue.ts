/**
 * Headless limit failover: a thread's error names a usage limit the gateway
 * did not replay. The registry must ask AccountsService for the next account
 * for that thread alone: it charges the thread's account, picks the account
 * with room for its model, and the thread's row moves while its siblings and
 * the global pin stay put; once the thread settles, its tree continues by
 * itself with a <continue-run> that names the switch. No room leaves the
 * error and the Continue button alone; transient limits ask for nothing.
 *
 * Core runs on a temp dir sealed with a throwaway key; the harness is a
 * controlled in-memory driver, so nothing here touches real data or CLIs.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, pinProfile, pinnedProfile, vault, type ServiceView, type UsageReport } from 'aliax-core'
import { AccountsService } from '../src/main/server/accounts'
import { BUILT_IN_DRIVERS } from '../src/main/server/drivers'
import type { HarnessDriver } from '../src/main/server/drivers/types'
import { openDb, Store } from '../src/main/server/db'
import { LIMIT_CONTINUE_DELAY_MS, SessionRegistry } from '../src/main/server/sessions'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`timeout: ${label}`)
}

// --- the controlled harness ------------------------------------------------
const sends: { sessionId: string; text: string }[] = []
const spawns: { sessionId: string; route: unknown }[] = []
const continues = (): { sessionId: string; text: string }[] => sends.filter((s) => s.text.startsWith('<continue-run>'))
const driver: HarnessDriver = {
  id: 'claude',
  async start({ session, route, emit, setNativeId }) {
    setNativeId(session.nativeId ?? `native-${session.id}`)
    spawns.push({ sessionId: session.id, route })
    return {
      async send(text) {
        sends.push({ sessionId: session.id, text })
        emit({ type: 'status', status: 'running' })
      },
      interrupt() {},
      async dispose() {}
    }
  }
}
BUILT_IN_DRIVERS.claude = driver

// --- core on a throwaway vault ---------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'tc-limit-continue-'))
configure({
  dataDir,
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})
vault.useFixedChromiumKey('Test Safe Storage', vault.randomChromiumKey())
vault.upsertProfile('claude-code', { name: 'a@x.com', accountId: '1', email: 'a@x.com', createdAt: 1 })
vault.upsertProfile('claude-code', { name: 'b@x.com', accountId: '2', email: 'b@x.com', createdAt: 2 })
vault.saveSecret('claude-code', 'a@x.com', '{}')
vault.saveSecret('claude-code', 'b@x.com', '{}')
pinProfile('claude-code', 'a@x.com')

// --- temp-code's service and registry, wired as the server does -------------
let bFull = false
const NOW = Date.now()
// a resets sooner, so an automatic pick lands on a first.
const reports = (): UsageReport[] => [
  { profileName: 'a@x.com', windows: [{ label: '5h', usedPercent: 40 }, { label: 'Weekly', usedPercent: 40, resetsAt: NOW + 3_600_000 }] },
  { profileName: 'b@x.com', windows: [{ label: '5h', usedPercent: bFull ? 100 : 30, resetsAt: NOW + 3_600_000 }, { label: 'Weekly', usedPercent: 30, resetsAt: NOW + 7_200_000 }] }
]
const listServices = async (): Promise<ServiceView[]> =>
  (['claude-code', 'codex', 'cursor'] as const).map((id) => ({
    id,
    name: id,
    installed: true,
    canAddAccount: true,
    canSaveCurrent: false,
    switchTargets: [],
    profiles: vault.profiles(id).map((p) => ({ name: p.name, email: p.email, createdAt: p.createdAt, active: pinnedProfile(id) === p.name }))
  }))
const store = new Store(openDb(join(dataDir, 'e2e.db')))
const registry = new SessionRegistry(store)
const polled: string[] = []
const accounts = new AccountsService({
  listServices,
  usage: async (id) => (id === 'claude-code' ? reports() : []),
  // The forced poll that confirms a pick sees the account as it is now.
  usageOf: async (_id, name) => {
    polled.push(name)
    return reports().find((r) => r.profileName === name) ?? null
  },
  owner: () => 'temp-code',
  live: async () => null,
  dataDir: () => join(dataDir, 'none'),
  pollMs: 3_600_000
})
registry.limits = accounts
await accounts.list()

const base = { provider: 'claude' as const, model: 'claude-sonnet-5', reasoning: 'low' as const, permission: 'edits' as const, cwd: '/tmp', parentId: null }
const status = (id: string): string | undefined => store.getSession(id)?.status
const canContinue = (id: string): boolean | undefined => registry.get(id)?.canContinue

const account = (id: string): string | null => registry.get(id)?.account ?? null

try {
  // 1. An orchestrator and its subagent both hit the 5h limit mid-turn; a bystander on the same account does not.
  const orch = await registry.create({ ...base, title: 'orchestrator', agentType: 'orchestrator' })
  const child = await registry.create({ ...base, title: 'child', agentType: 'implementer', parentId: orch.id })
  const bystander = await registry.create({ ...base, title: 'bystander' })
  await registry.send(orch.id, 'go')
  await registry.send(child.id, 'go')
  await registry.send(bystander.id, 'go')
  check('all three threads run', [orch, child, bystander].every((s) => status(s.id) === 'running'))
  check('every spawn named a (the soonest reset), unpinned', spawns.every((s) => JSON.stringify(s.route) === '{"account":"a@x.com","pin":false}'), JSON.stringify(spawns.map((s) => s.route)))
  check('every row shows a', [orch, child, bystander].every((s) => account(s.id) === 'a@x.com'))

  registry.append(child.id, { type: 'error', message: "You've hit your session limit", limit: { window: '5h' } })
  registry.append(orch.id, { type: 'error', message: "You've hit your session limit", limit: { window: '5h' } })
  registry.append(child.id, { type: 'status', status: 'idle' })
  registry.append(orch.id, { type: 'status', status: 'error' })
  check('the settled threads show the error until the switch lands', canContinue(orch.id) === true && canContinue(child.id) === true)

  await waitFor(() => continues().length === 2, 'both threads continue')
  await sleep(LIMIT_CONTINUE_DELAY_MS * 2)
  check('each limited thread got its own pick, confirmed by a poll of b', polled.filter((n) => n === 'b@x.com').length === 2, polled.join(','))
  check('the limited threads moved to b', account(orch.id) === 'b@x.com' && account(child.id) === 'b@x.com', `${account(orch.id)} / ${account(child.id)}`)
  check('the bystander stayed on a', account(bystander.id) === 'a@x.com', String(account(bystander.id)))
  check('the global pin never moved', pinnedProfile('claude-code') === 'a@x.com')
  const order = continues().map((c) => c.sessionId)
  check('the subagent continues before its orchestrator', order[0] === child.id && order[1] === orch.id, order.join(' > '))
  check('the continue names the switch', continues().every((c) => c.text.includes('a usage limit on a@x.com; the app switched to b@x.com')))
  check('each thread continues once', continues().length === 2)
  check('the errors clear once the threads move again', canContinue(orch.id) === false && canContinue(child.id) === false)
  const respawned = spawns.slice(3)
  check('the continue boots the errored harnesses fresh under b', respawned.length === 2 && respawned.every((s) => JSON.stringify(s.route) === '{"account":"b@x.com","pin":false}'), JSON.stringify(respawned))
  const snap = await accounts.list()
  check('the footer shows no failover note', snap.providers.claude.note === undefined)

  // 2. The next limit finds no account with room: the error stays for the user.
  bFull = true
  const lone = await registry.create({ ...base, title: 'lone' })
  await registry.send(lone.id, 'go')
  sends.length = 0
  registry.append(lone.id, { type: 'error', message: 'weekly limit reached', limit: { window: 'weekly' } })
  registry.append(lone.id, { type: 'status', status: 'idle' })
  await sleep(LIMIT_CONTINUE_DELAY_MS * 3)
  check('no room: the thread does not continue', continues().length === 0)
  check('no room: the Continue button stays', canContinue(lone.id) === true)
  check('no room: the thread stays on its account, the pin stays', account(lone.id) === 'a@x.com' && pinnedProfile('claude-code') === 'a@x.com')

  // 3. A transient refusal is not a limit to switch on.
  bFull = false
  const brief = await registry.create({ ...base, title: 'brief' })
  await registry.send(brief.id, 'go')
  sends.length = 0
  const polls = polled.length
  registry.append(brief.id, { type: 'error', message: 'overloaded', limit: { window: 'transient' } })
  registry.append(brief.id, { type: 'status', status: 'idle' })
  await sleep(LIMIT_CONTINUE_DELAY_MS * 3)
  check('transient: no switch, no continue', continues().length === 0 && polled.length === polls && canContinue(brief.id) === true)

  // 4. A workspace pin: the spawn names it as a pin; a pin change respawns on the next send.
  mkdirSync(join(dataDir, 'ws'))
  const ws = await registry.createWorkspace(join(dataDir, 'ws'))
  registry.setWorkspaceAccounts(ws.id, { claude: 'b@x.com' })
  const pinned = await registry.create({ ...base, title: 'pinned', workspaceId: ws.id, cwd: join(dataDir, 'ws') })
  await registry.send(pinned.id, 'go')
  check('a workspace pin is named as a pin', JSON.stringify(spawns.at(-1)?.route) === '{"account":"b@x.com","pin":true}' && account(pinned.id) === 'b@x.com', JSON.stringify(spawns.at(-1)?.route))
  registry.setWorkspaceAccounts(ws.id, { claude: 'a@x.com' })
  const spawnsBefore = spawns.length
  await registry.send(pinned.id, 'again')
  check('a workspace pin change respawns under the new pin on the next send', spawns.length === spawnsBefore + 1 && JSON.stringify(spawns.at(-1)?.route) === '{"account":"a@x.com","pin":true}', JSON.stringify(spawns.at(-1)?.route))
} finally {
  await registry.disposeAll()
  rmSync(dataDir, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
