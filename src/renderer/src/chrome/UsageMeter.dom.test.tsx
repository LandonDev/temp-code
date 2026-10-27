import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { ProfileView, UsageReport } from 'aliax-core/shared/types'
import { emptyAccounts, type AccountsSnapshot } from '@server/shared/accounts'
import type { Link } from '../lib/tcserver/store'
import type { ServerPush, SessionMeta } from '../lib/tcserver/types'
import { registry } from '../lib/connection'
import { accountsStore } from '../stores/accounts'
import { sessionStore } from '../lib/tcserver/store'
import { workspaceStore } from '../lib/tcserver/workspaces'
import { mountProbe } from '../test/renderProbe'
import { UsageMeter } from './UsageMeter'

const HOUR = 3_600_000
const now = Date.now()

const profile = (name: string, extra: Partial<ProfileView> = {}): ProfileView => ({
  name,
  email: name,
  createdAt: 1,
  active: false,
  ...extra
})

/** Two windows: the 5h one refills in 2.5 h (an even burn leaves 50%), the weekly one has no clock. */
const report = (name: string, fiveHourUsed: number, weeklyUsed: number, extra: Partial<UsageReport> = {}): UsageReport => ({
  profileName: name,
  windows: [
    { label: '5h', usedPercent: fiveHourUsed, resetsAt: now + 2.5 * HOUR, periodMs: 5 * HOUR },
    { label: 'Weekly', usedPercent: weeklyUsed }
  ],
  ...extra
})

function snapshot(): AccountsSnapshot {
  const s = emptyAccounts()
  s.updatedAt = 1
  s.providers.claude = {
    pinned: 'a@x.com',
    owner: 'aliax',
    profiles: [profile('a@x.com', { active: true, nickname: 'Main' }), profile('b@x.com'), profile('c@x.com'), profile('d@x.com')],
    reports: [
      report('a@x.com', 30, 60, { plan: { name: 'Max 20x', monthlyUsd: 200 } }),
      report('b@x.com', 10, 20),
      report('c@x.com', 100, 50),
      report('d@x.com', 0, 0, { expired: true })
    ]
  }
  s.providers.codex = {
    pinned: null,
    owner: 'temp-code',
    profiles: [profile('x@x.com'), profile('y@x.com')],
    reports: [report('x@x.com', 80, 10), report('y@x.com', 5, 5)],
    headroom: { 'y@x.com': { room: 0, throttledUntil: now + 600_000, ratePerMin: 0, seenAt: now } }
  }
  s.providers.cursor = {
    pinned: 'cursor@x.com',
    owner: 'aliax',
    profiles: [profile('cursor@x.com', { active: true })],
    reports: [report('cursor@x.com', 50, 50)]
  }
  return s
}

class FakeLink implements Link {
  environmentId = 'local'
  profile = 'local' as const
  connected = true
  calls: { method: string; params: unknown }[] = []
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'accounts.list') return Promise.resolve(snapshot() as T)
    if (method === 'workspace.list') return Promise.resolve([{ id: 'w', name: 'Site', path: '/s', git: true, accountPins: { claude: 'c@x.com' }, createdAt: 1 }] as T)
    if (method === 'project.list') return Promise.resolve([] as T)
    if (method === 'defaults.get') return Promise.resolve(null as T)
    if (method === 'session.subscribe') return Promise.resolve(null as T)
    return Promise.reject(new Error(`unexpected ${method}`))
  }
  onPush(_listener: (push: ServerPush) => void): () => void {
    return () => {}
  }
  onOpen(): () => void {
    return () => {}
  }
  onClose() {
    return () => {}
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let probe: ReturnType<typeof mountProbe> | null = null
afterEach(() => {
  probe?.unmount()
  probe = null
  accountsStore.reset()
  sessionStore.reset()
  workspaceStore.reset()
  vi.restoreAllMocks()
})

const meta = (extra: Partial<SessionMeta> = {}): SessionMeta => ({
  environmentId: 'local',
  id: 'thread-1',
  parentId: null,
  projectId: null,
  workspaceId: null,
  threadType: 'chat',
  planPath: null,
  provider: 'claude',
  model: 'claude-opus-5-5',
  reasoning: 'medium',
  agentType: 'implementer',
  title: 't',
  cwd: '/tmp',
  status: 'idle',
  pinned: false,
  archived: false,
  permission: 'edits',
  fast: false,
  ultrafast: false,
  context1m: false,
  busySince: null,
  pausedAt: null,
  frozenActiveElapsed: null,
  nativeId: null,
  account: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra
})

async function mount(thread?: Partial<SessionMeta>) {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const link = new FakeLink()
  vi.spyOn(registry, 'primary').mockReturnValue(link as unknown as ReturnType<typeof registry.primary>)
  accountsStore.attach(link)
  sessionStore.attach(link)
  if (thread) sessionStore.adopt(meta(thread))
  await flush()
  probe = mountProbe(<UsageMeter sessionId={thread ? 'thread-1' : undefined} />)
  await probe.act(flush)
  return { link, root: probe.container }
}

const row = (root: HTMLElement, provider: string) => root.querySelector(`[data-provider="${provider}"]`) as HTMLButtonElement
const bar = (el: HTMLElement) => el.querySelector('[role="progressbar"]') as HTMLElement

describe('UsageMeter', () => {
  it('draws one row per provider with accounts: the best account’s room and its reset, no account name', async () => {
    const { root } = await mount()
    expect(root.querySelectorAll('[data-provider]')).toHaveLength(3)
    // Claude: b is best (10% and 20% used), its tightest window is the weekly one with no clock.
    expect(bar(row(root, 'claude')).getAttribute('aria-valuenow')).toBe('80')
    expect(row(root, 'claude').textContent).not.toContain('resets in')
    // Codex: y is throttled, so x counts: 20% left in the 5h window, refilling in 2h.
    expect(bar(row(root, 'codex')).getAttribute('aria-valuenow')).toBe('20')
    expect(row(root, 'codex').textContent).toContain('resets in 2h')
    expect(root.textContent).not.toMatch(/@x\.com|Main/)
  })

  it('renders nothing before any provider has accounts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    probe = mountProbe(<UsageMeter />)
    await probe.act(flush)
    expect(probe.container.innerHTML).toBe('')
  })

  it('opens the read-only account list with the check on the global pin', async () => {
    const { root, link } = await mount()
    await probe!.act(async () => {
      fireEvent.click(row(root, 'claude'))
    })
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false'])
    expect(rows.every((r) => r.getAttribute('aria-disabled') === 'true')).toBe(true)
    expect(link.calls.some((c) => c.method === 'session.account.pin')).toBe(false)
  })

  it("with a thread the list checks that thread's account", async () => {
    const { root } = await mount({ account: 'b@x.com' })
    await probe!.act(async () => {
      fireEvent.click(row(root, 'claude'))
    })
    const rows = screen.getAllByRole('option')
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false'])
    expect(screen.getByRole('listbox').textContent).toContain('Auto · picked by model')
  })
})
