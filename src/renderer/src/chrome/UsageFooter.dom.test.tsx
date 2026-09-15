import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { ProfileView, UsageReport } from 'aliax-core/shared/types'
import { emptyAccounts, type AccountsSnapshot } from '@server/shared/accounts'
import type { Link } from '../lib/tcserver/store'
import type { ServerPush } from '../lib/tcserver/types'
import { accountsStore } from '../stores/accounts'
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
    if (method === 'accounts.switch') return Promise.resolve({ ok: true, notes: [] } as T)
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
  vi.restoreAllMocks()
})

async function mount(harness: 'claude' | 'cursor') {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const link = new FakeLink()
  accountsStore.connect(link)
  await flush()
  probe = mountProbe(<UsageFooter harness={harness} />)
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

  it('opens the account list from the name and switches on a row click', async () => {
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
    expect((rows[0] as HTMLButtonElement).disabled).toBe(true)
    // Each row carries Aliax's cells: exact percent left, and when the window refills.
    expect(rows[0].textContent).toContain('Max 20x · $200/mo')
    const b = rows[1]
    expect(b.querySelector('[data-window="5h"]')?.textContent).toBe('5h90%')
    expect(b.querySelector('[data-cell="5h"]')?.textContent).toContain('in 2h 30m')
    expect(b.querySelector('[data-window="Weekly"]')?.textContent).toBe('Weekly80%')
    expect(b.querySelectorAll('[data-window="5h"] [role="progressbar"]')).toHaveLength(1)
    const listbox = screen.getByRole('listbox')
    expect(parseInt(listbox.style.width, 10)).toBeGreaterThanOrEqual(560)
    await probe!.act(async () => {
      fireEvent.click(rows[1])
      await flush()
    })
    expect(link.calls.at(-1)).toEqual({ method: 'accounts.switch', params: { provider: 'claude', name: 'b@x.com' } })
  })

  it('keeps Cursor to bars only: plain name, no popover', async () => {
    const { root } = await mount('cursor')
    expect(root.querySelector('button[aria-haspopup="listbox"]')).toBeNull()
    expect(root.textContent).toContain('cursor@x.com')
    expect(root.querySelectorAll('[data-window]')).toHaveLength(2)
  })
})
