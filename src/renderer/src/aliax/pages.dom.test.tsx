import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ServiceView, UsageReport } from 'aliax-core/shared/types'
import type { StatsBundle } from '@shared/aliaxStats'
import { emptyAccounts, type AccountsSnapshot } from '@server/shared/accounts'
import type { Link } from '@renderer/lib/tcserver/store'
import type { ServerPush } from '@renderer/lib/tcserver/types'
import { registry } from '@renderer/lib/connection'
import { accountsStore } from '@renderer/stores/accounts'
import { AccountsPage, StatsPage } from './pages'

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

// jsdom has no layout, so ResponsiveContainer would measure 0×0 and draw nothing.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    )
  }
})

const HOUR = 3_600_000
const now = Date.now()

const services = (): ServiceView[] => [
  {
    id: 'claude-code',
    name: 'Claude Code',
    installed: true,
    canAddAccount: true,
    canSaveCurrent: false,
    switchTargets: [],
    profiles: [{ name: 'a@x.com', email: 'a@x.com', nickname: 'Main', createdAt: 1, active: true }]
  },
  {
    id: 'codex',
    name: 'Codex',
    installed: true,
    canAddAccount: true,
    canSaveCurrent: false,
    switchTargets: [],
    profiles: []
  }
]

const report: UsageReport = {
  profileName: 'a@x.com',
  windows: [{ label: '5h', usedPercent: 30, resetsAt: now + 2.5 * HOUR, periodMs: 5 * HOUR }]
}

function snapshot(): AccountsSnapshot {
  const s = emptyAccounts()
  s.updatedAt = 1
  s.providers.claude = {
    pinned: 'a@x.com',
    owner: 'aliax',
    profiles: [{ name: 'a@x.com', createdAt: 1, active: true }],
    reports: [report]
  }
  return s
}

const emptyBundle = (): StatsBundle => ({
  generatedAt: now,
  totals: { turns: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, eph_1h: 0, eph_5m: 0 },
  pace: [],
  bySurface: [],
  byModel: [],
  byProject: [],
  byBranch: [],
  byTool: [],
  byEffort: [],
  stopReasons: [],
  daily: [],
  cacheDaily: [],
  worstCache: [],
  heatmap: [],
  sessionLengths: [],
  events: [],
  switchesDaily: [],
  utilisation: [],
  modelDaily: [],
  flow: []
})

class FakeLink implements Link {
  environmentId = 'local'
  profile = 'local' as const
  connected = true
  request<T>(method: string): Promise<T> {
    if (method === 'accounts.list') return Promise.resolve(snapshot() as T)
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

let aliax: { [K in keyof Window['aliax']]: ReturnType<typeof vi.fn> }

beforeEach(async () => {
  aliax = {
    listServices: vi.fn(async () => services()),
    capture: vi.fn(async () => ({ ok: true })),
    activate: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
    loginStart: vi.fn(async () => ({ ok: true })),
    loginCancel: vi.fn(async () => {}),
    updateProfile: vi.fn(async () => ({ ok: true })),
    openExternal: vi.fn(async () => {}),
    onAccountsChanged: vi.fn(() => () => {}),
    stats: vi.fn(async () => emptyBundle()),
    statsStatus: vi.fn(async () => ({ indexing: false, filesDone: 0, filesTotal: 0, rows: 0 })),
    statsReindex: vi.fn(async () => ({ ok: true }))
  }
  ;(window as unknown as { aliax: typeof aliax }).aliax = aliax
  const link = new FakeLink()
  vi.spyOn(registry, 'primary').mockReturnValue(link as unknown as ReturnType<typeof registry.primary>)
  accountsStore.attach(link)
  await flush()
})

afterEach(() => {
  cleanup()
  toasts.success.mockReset()
  toasts.error.mockReset()
  vi.unstubAllGlobals()
  accountsStore.reset()
  vi.restoreAllMocks()
})

describe('AccountsPage', () => {
  it('renders each service section with the live usage from the shared snapshot', async () => {
    render(<AccountsPage />)
    await act(flush)

    expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toBeTruthy()
    expect(screen.getByText('The Claude and Codex sign-ins threads route through.')).toBeTruthy()
    expect(screen.getByText('Claude Code')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText('Main')).toBeTruthy()

    const bar = screen.getByRole('progressbar', { name: '5h: 70 percent left' })
    expect(bar.getAttribute('data-fill')).toBe('muted')
    const fill = bar.querySelector('[data-slot="progress-indicator"]') as HTMLElement
    expect(fill.style.transform).toBe('scaleX(0.7)')

    // One read on mount; the snapshot and the mount do not both fire it.
    expect(aliax.listServices).toHaveBeenCalledTimes(1)
  })

  const addClaude = async () => {
    render(<AccountsPage />)
    await act(flush)
    const section = screen.getByRole('region', { name: 'Claude Code' })
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Add account' }))
    })
    await act(flush)
  }

  it('a cancelled sign-in closes the dialog and says nothing', async () => {
    aliax.loginStart.mockResolvedValue({ ok: false, error: 'cancelled' })
    await addClaude()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(toasts.error).not.toHaveBeenCalled()
    expect(toasts.success).not.toHaveBeenCalled()
  })

  it('a failed sign-in keeps the dialog with the error and Try again, never a toast', async () => {
    aliax.loginStart.mockResolvedValue({ ok: false, error: "Couldn't reach claude.ai" })
    await addClaude()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText("Couldn't reach claude.ai")).toBeTruthy()
    expect(toasts.error).not.toHaveBeenCalled()
    aliax.loginStart.mockReturnValue(new Promise(() => {}))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
    await act(flush)
    expect(aliax.loginStart).toHaveBeenCalledTimes(2)
    expect(aliax.loginStart).toHaveBeenLastCalledWith('claude-code', undefined)
    expect(within(screen.getByRole('dialog')).getByText('Waiting for sign-in')).toBeTruthy()
  })

  it('a refreshed sign-in says Updated, and a new one Added with Switch to it', async () => {
    aliax.loginStart.mockResolvedValue({ ok: true, name: 'Main', notes: ['Sign-in refreshed'] })
    await addClaude()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(toasts.success).toHaveBeenCalledWith('Updated Main', { description: undefined })
    cleanup()

    aliax.loginStart.mockResolvedValue({ ok: true, name: 'New', notes: ['Saved without its claude.ai session'] })
    await addClaude()
    const [text, options] = toasts.success.mock.calls.at(-1) as [string, { description?: string; action?: { label: string } }]
    expect(text).toBe('Added New')
    expect(options.description).toBe('Saved without its claude.ai session')
    expect(options.action?.label).toBe('Switch to it')
  })
})

describe('StatsPage', () => {
  it('says there is nothing to show for an empty bundle', async () => {
    render(<StatsPage />)
    await act(flush)
    await act(flush)
    expect(aliax.stats).toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 1, name: 'Stats' })).toBeTruthy()
    expect(screen.getByText('Nothing to show yet')).toBeTruthy()
    expect(screen.getByText('No Claude Code or Codex session logs on this machine.')).toBeTruthy()
  })

  it('says how far indexing has got, and Reindex reindexes', async () => {
    aliax.statsStatus.mockResolvedValue({ indexing: true, filesDone: 120, filesTotal: 3400, rows: 0 })
    render(<StatsPage />)
    await act(flush)
    await act(flush)
    expect(screen.getByText('Indexing 120 of 3,400 session logs', { selector: 'p' })).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reindex' }))
    })
    expect(aliax.statsReindex).toHaveBeenCalledTimes(1)
  })

  it('renders every chart from a populated bundle', async () => {
    const b = emptyBundle()
    b.totals = { turns: 40, input: 9000, output: 4000, cache_read: 80000, cache_write: 6000, eph_1h: 3000, eph_5m: 3000 }
    b.pace = [
      {
        service: 'claude-code',
        label: '5h',
        cycles: 4,
        nowFrac: 0.5,
        nowPercent: 30,
        normalPercent: 40,
        projectedPercent: 60,
        exhaustsAtFrac: null,
        periodMs: 5 * HOUR,
        points: [
          { frac: 0, hours: 0, p25: 0, median: 0, p75: 0, current: 0 },
          { frac: 0.5, hours: 2.5, p25: 20, median: 40, p75: 60, current: 30 }
        ]
      }
    ]
    b.bySurface = [{ name: 'CLI', value: 30 }, { name: 'App', value: 10 }]
    b.byModel = [{ name: 'claude-opus-5-5', value: 3000, turns: 30 }, { name: 'gpt-5-5', value: 1000, turns: 10 }]
    b.byProject = [{ name: 'temp-code', value: 4000, turns: 40 }]
    b.byBranch = [{ name: 'master', value: 4000 }]
    b.byTool = [{ name: 'Bash', value: 20, kind: 'builtin' }]
    b.byEffort = [{ name: 'high', value: 40 }]
    b.stopReasons = [{ name: 'tool_use', value: 30 }, { name: 'end_turn', value: 10 }]
    b.daily = [{ day: '2026-10-08', claude: 3000, codex: 1000 }, { day: '2026-10-09', claude: 2000, codex: 500 }]
    b.cacheDaily = [{ day: '2026-10-08', hit: 90 }, { day: '2026-10-09', hit: 85 }]
    b.worstCache = [{ session: 's1', project: 'temp-code', hit: 40, output: 500 }]
    b.heatmap = [{ dow: 1, hour: 10, value: 5 }]
    b.sessionLengths = [{ bucket: '<5m', value: 3 }]
    b.events = [{ kind: 'switch', value: 2 }]
    b.switchesDaily = [{ day: '2026-10-09', value: 2 }]
    b.utilisation = [{ account: 'a@x.com', label: 'Main', peak: 80, avg: 40 }]
    b.modelDaily = [{ day: '2026-10-09', model: 'claude-opus-5-5', value: 3000 }]
    b.flow = [{ surface: 'CLI', model: 'claude-opus-5-5', project: 'temp-code', value: 30 }]
    aliax.stats.mockResolvedValue(b)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Panels mount their chart once near the viewport; here every panel is.
    class SeenObserver {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(): void {
        this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', SeenObserver)

    const { container } = render(<StatsPage />)
    await act(flush)
    await act(flush)
    expect(screen.queryByText('Nothing to show yet')).toBeNull()
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual([
      'Claude Code 5-hour limit',
      'Daily output',
      'Model mix',
      'Top projects',
      'Cache hit rate',
      'When you burn limit',
      'Tools used'
    ])
    expect(screen.queryByText('Least headroom')).toBeNull()
    expect(screen.queryByText('Subscriptions')).toBeNull()
    expect(screen.getByText(/^From 40 turns in your local session logs, updated /)).toBeTruthy()
    expect(container.querySelectorAll('[data-chart]').length).toBe(6)
    expect(errors).not.toHaveBeenCalled()
  })
})
