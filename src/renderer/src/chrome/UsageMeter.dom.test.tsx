import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
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
  listeners = new Set<(push: ServerPush) => void>()
  onPush(listener: (push: ServerPush) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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

/** The row's words after the bar: the refill or the limit. */
const trailing = (el: HTMLElement) => el.querySelector('[data-slot="progress"] ~ span')?.textContent ?? ''
const details = () => document.querySelector('[data-slot="popover-content"]') as HTMLElement | null

describe('UsageMeter', () => {
  it('draws one row per provider with accounts: the pooled share and the next refill, no account named', async () => {
    const { root } = await mount()
    expect(root.querySelectorAll('[data-provider]')).toHaveLength(3)
    // Claude: a 0.4, b 0.8, c 0 (d expired, out); the only binding reset is c's 5h, in 2.5 h.
    expect(bar(row(root, 'claude')).getAttribute('aria-valuenow')).toBe('40')
    expect(trailing(row(root, 'claude'))).toBe('in 2h')
    expect(row(root, 'claude').getAttribute('aria-label')).toBe('Claude usage, 40% left, refills in 2h')
    expect(root.textContent).not.toMatch(/@x\.com|Main|Max 20x/)
  })

  it('renders nothing before any provider has accounts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    probe = mountProbe(<UsageMeter />)
    await probe.act(flush)
    expect(probe.container.innerHTML).toBe('')
  })

  it('shows an empty track and no text before any account reported', async () => {
    const { root, link } = await mount()
    const s = snapshot()
    s.providers.claude.reports = []
    await probe!.act(async () => {
      for (const l of link.listeners) l({ push: 'accounts', snapshot: s } as ServerPush)
    })
    expect(bar(row(root, 'claude')).getAttribute('aria-valuenow')).toBeNull()
    expect(trailing(row(root, 'claude'))).toBe('')
    expect(row(root, 'claude').getAttribute('aria-label')).toBe('Claude usage, no report yet')
  })

  it('draws no row for a provider whose every account answered with no caps', async () => {
    const { root, link } = await mount()
    const s = snapshot()
    s.providers.cursor.reports = [{ profileName: 'cursor@x.com', windows: [], note: 'no usage caps on this plan' }]
    await probe!.act(async () => {
      for (const l of link.listeners) l({ push: 'accounts', snapshot: s } as ServerPush)
    })
    expect(root.querySelector('[data-provider="cursor"]')).toBeNull()
    expect(root.querySelectorAll('[data-provider]')).toHaveLength(2)
  })

  it('says Limited and the time in the warning tone when every account is throttled', async () => {
    const { root, link } = await mount()
    const s = snapshot()
    s.providers.codex.headroom = {
      'x@x.com': { room: 0, throttledUntil: now + 5 * 60_000, ratePerMin: 0, seenAt: now },
      'y@x.com': { room: 0, throttledUntil: now + 3 * 60_000, ratePerMin: 0, seenAt: now }
    }
    await probe!.act(async () => {
      for (const l of link.listeners) l({ push: 'accounts', snapshot: s } as ServerPush)
    })
    const limited = row(root, 'codex').querySelector('.text-warning') as HTMLElement
    expect(limited.textContent).toBe('Limited3m')
    expect(row(root, 'codex').getAttribute('aria-label')).toMatch(/limited for 3m$/)
    expect(bar(row(root, 'codex')).getAttribute('aria-valuenow')).not.toBeNull()
  })

  it('says <1m in the row under a minute, and the label keeps the words', async () => {
    const { root, link } = await mount()
    const s = snapshot()
    s.providers.codex.headroom = {
      'x@x.com': { room: 0, throttledUntil: now + 30_000, ratePerMin: 0, seenAt: now },
      'y@x.com': { room: 0, throttledUntil: now + 20_000, ratePerMin: 0, seenAt: now }
    }
    await probe!.act(async () => {
      for (const l of link.listeners) l({ push: 'accounts', snapshot: s } as ServerPush)
    })
    expect((row(root, 'codex').querySelector('.text-warning') as HTMLElement).textContent).toBe('Limited<1m')
    expect(row(root, 'codex').getAttribute('aria-label')).toMatch(/limited for under a minute$/)
  })

  it('opens the windows and the count of accounts with room on click, with no account named', async () => {
    const { root } = await mount()
    await probe!.act(async () => {
      fireEvent.click(row(root, 'claude'))
    })
    const body = details()!
    expect([...body.querySelectorAll('[data-window]')].map((w) => w.getAttribute('data-window'))).toEqual(['5h', 'Weekly'])
    expect(body.textContent).toContain('Week')
    expect(body.textContent).toContain('40% left')
    expect(body.textContent).toContain('2 accounts with room')
    expect(body.textContent).not.toMatch(/@x\.com|Main|Max 20x/)
  })

  it('opens on hover', async () => {
    const { root } = await mount()
    const trigger = row(root, 'claude')
    await probe!.act(async () => {
      fireEvent.pointerEnter(trigger)
      fireEvent.mouseEnter(trigger)
      fireEvent.mouseMove(trigger)
    })
    await waitFor(() => expect(details()?.textContent).toContain('2 accounts with room'), { timeout: 2000 })
  })

  it('moves the bar on a pushed snapshot without a remount and asks the host for nothing', async () => {
    const { root, link } = await mount()
    const before = row(root, 'claude')
    const s = snapshot()
    s.providers.claude.reports = s.providers.claude.reports.map((r) => ({
      ...r,
      windows: r.windows.map((w) => ({ ...w, usedPercent: 0 }))
    }))
    await probe!.act(async () => {
      for (const l of link.listeners) l({ push: 'accounts', snapshot: s } as ServerPush)
    })
    expect(row(root, 'claude')).toBe(before)
    expect(bar(before).getAttribute('aria-valuenow')).toBe('100')
    expect(link.calls.filter((c) => c.method.startsWith('accounts.')).map((c) => c.method)).toEqual(['accounts.list'])
  })
})
