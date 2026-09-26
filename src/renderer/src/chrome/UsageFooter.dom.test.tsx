import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { ProfileView, UsageReport } from 'aliax-core/shared/types'
import { emptyAccounts, type AccountsSnapshot } from '@server/shared/accounts'
import type { Link } from '../lib/tcserver/store'
import type { ServerPush, SessionMeta } from '../lib/tcserver/types'
import { accountsStore } from '../stores/accounts'
import { client } from '../lib/tcserver/client'
import { sessionStore } from '../lib/tcserver/store'
import { workspaceStore } from '../lib/tcserver/workspaces'
import { mountProbe } from '../test/renderProbe'
import { UsageFooter } from './UsageFooter'

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
  s.providers.cursor = {
    pinned: 'cursor@x.com',
    owner: 'aliax',
    profiles: [profile('cursor@x.com', { active: true })],
    reports: [report('cursor@x.com', 50, 50)]
  }
  return s
}

class FakeLink implements Link {
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

async function mount(harness: 'claude' | 'cursor', thread?: Partial<SessionMeta>, withWorkspaces = false) {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const link = new FakeLink()
  accountsStore.connect(link)
  if (withWorkspaces) workspaceStore.connect(link)
  if (thread) sessionStore.adopt(meta(thread))
  await flush()
  probe = mountProbe(<UsageFooter harness={harness} sessionId={thread ? 'thread-1' : undefined} />)
  await probe.act(flush)
  return { link, root: probe.container }
}

describe('UsageFooter', () => {
  it('shows the pinned account and each window as percent left with the on-pace tick', async () => {
    const { root } = await mount('claude')
    expect(root.textContent).toContain('Main')
    const fiveHour = root.querySelector('[data-window="5h"]') as HTMLElement
    expect(fiveHour.textContent).toContain('70%')
    expect(fiveHour.textContent).toContain('resets in 2h 30m')
    const tick = fiveHour.querySelector('[data-tick]') as HTMLElement
    expect(tick.style.left).toBe('calc(50% - 1px)')
    const weekly = root.querySelector('[data-window="Weekly"]') as HTMLElement
    expect(weekly.textContent).toContain('40%')
    expect(weekly.querySelector('[data-tick]')).toBeNull()
  })

  it('counts the other signed-in accounts that still have room in that window', async () => {
    const { root } = await mount('claude')
    // b has room; c is at 100%; d is expired.
    expect(root.querySelector('[data-window="5h"]')?.textContent).toContain('1 more with room')
    // b and c have weekly room; d is expired.
    expect(root.querySelector('[data-window="Weekly"]')?.textContent).toContain('2 more with room')
  })

  it('without a thread the list is read-only and the check is the global pin', async () => {
    const { link, root } = await mount('claude')
    const name = root.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement
    await probe!.act(async () => {
      fireEvent.click(name)
    })
    const rows = screen.getAllByRole('option')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Main'),
      expect.stringContaining('b@x.com'),
      expect.stringContaining('c@x.com'),
      expect.stringContaining('sign in again in Aliax')
    ])
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false'])
    expect(rows.every((r) => r.getAttribute('aria-disabled') === 'true')).toBe(true)
    // Each row carries Aliax's cells: exact percent left, and when the window refills.
    expect(rows[0].textContent).toContain('Max 20x · $200/mo')
    const b = rows[1]
    expect(b.querySelector('[data-window="5h"]')?.textContent).toBe('5h90%')
    expect(b.querySelector('[data-cell="5h"]')?.textContent).toContain('in 2h 30m')
    expect(b.querySelector('[data-window="Weekly"]')?.textContent).toBe('Weekly80%')
    expect(b.querySelectorAll('[data-window="5h"] [role="progressbar"]')).toHaveLength(1)
    const listbox = screen.getByRole('listbox')
    expect(parseInt(listbox.style.width, 10)).toBeGreaterThanOrEqual(560)
    expect(link.calls.some((c) => c.method === 'session.account.pin')).toBe(false)
  })

  it("with a thread it shows that thread's account; the list is read-only with a check on it", async () => {
    const request = vi.spyOn(client, 'request').mockResolvedValue(null)
    const { root } = await mount('claude', { account: 'b@x.com' })
    // The thread spends from b, whatever the global pin says.
    expect(root.textContent).toContain('b@x.com')
    expect(root.textContent).not.toContain('Main')
    expect(root.querySelector('[data-window="5h"]')?.textContent).toContain('90%')
    const name = root.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement
    expect(name.title).toContain('Auto · picked by model')
    await probe!.act(async () => {
      fireEvent.click(name)
    })
    const rows = screen.getAllByRole('option')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Main'),
      expect.stringContaining('b@x.com'),
      expect.stringContaining('c@x.com'),
      expect.stringContaining('sign in again in Aliax')
    ])
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false'])
    expect(rows[1].querySelector('[aria-label="In use"]')).not.toBeNull()
    expect(screen.getByRole('listbox').textContent).toContain('Auto · picked by model')
    expect(screen.getByRole('listbox').textContent).not.toContain('Picked by model, moved')
    await probe!.act(async () => {
      fireEvent.click(rows[2])
      await flush()
    })
    expect(request).not.toHaveBeenCalledWith('session.account.pin', expect.anything())
    expect(rows[1].getAttribute('aria-selected')).toBe('true')
  })

  it('a thread under a workspace pin names the source and marks the pin; the account in use wins when the gateway moved it', async () => {
    const { root } = await mount('claude', { workspaceId: 'w', account: 'b@x.com' }, true)
    const name = root.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement
    expect(name.title).toContain('From workspace Site')
    await probe!.act(async () => {
      fireEvent.click(name)
    })
    const rows = screen.getAllByRole('option')
    expect(rows[2].querySelector('[aria-label="Pinned by the workspace"]')).not.toBeNull()
    expect(rows[1].querySelector('[aria-label="In use"]')).not.toBeNull()
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false'])
  })

  it('keeps Cursor to bars only: plain name, no popover', async () => {
    const { root } = await mount('cursor')
    expect(root.querySelector('button[aria-haspopup="listbox"]')).toBeNull()
    expect(root.textContent).toContain('cursor@x.com')
    expect(root.querySelectorAll('[data-window]')).toHaveLength(2)
  })
})
