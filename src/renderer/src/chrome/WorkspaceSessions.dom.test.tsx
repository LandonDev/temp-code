// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { projectCardStatus } from '../lib/projectCardModel'
import { SESSION_LIST_PAGE } from '../lib/sessionListWindow'
import type { SessionMeta } from '../lib/tcserver/types'
import { mountProbe } from '../test/renderProbe'
import { threadRow, type ThreadRow } from '../lib/workspaceSessions'
import { nextPage } from '../lib/sidebarRows'
import { Fold, LiveLines, ThreadList, masterMenuItem } from './WorkspaceSessions'
import { subagentRowsStore } from '../stores/subagentRows'
import { registry } from '../lib/connection'

/** The hosts the window knows; none by default, two for the host glyph. */
const hosts = vi.hoisted(() => ({ environments: [] as { id: string; name: string; platform?: string }[] }))
vi.mock('../lib/connection/status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/connection/status')>()),
  useEnvironments: () => hosts.environments
}))

/** The root owns each list's page count; this stands in for it. */
function Paged({
  children
}: {
  children: (requested: number, onMore: () => void) => React.ReactNode
}) {
  const [requested, setRequested] = useState(SESSION_LIST_PAGE)
  return <>{children(requested, () => setRequested(nextPage))}</>
}

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: 'local',
    id,
    parentId: null,
    projectId: 'p1',
    workspaceId: null,
    threadType: 'chat',
    title: id,
    cwd: '/wt/p1',
    status: 'idle',
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 100,
    ...extra
  }) as SessionMeta

const rows = (n: number, extra: Partial<SessionMeta> = {}): ThreadRow[] =>
  Array.from({ length: n }, (_, i) => threadRow(meta(`t${i}`, extra), {}))

const actions = {
  activeSessionId: undefined as string | undefined,
  onOpen: () => {},
  onRename: () => {},
  onDelete: () => {},
  openMenu: () => {}
}

const rowCount = (root: HTMLElement) => root.querySelectorAll('[role="button"]').length
const moreButton = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('button')).find((b) => /\bmore$/.test(b.textContent ?? ''))

describe('Fold', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a collapsed project holds no rows', () => {
    const probe = mountProbe(
      <Fold open={false}>
        <ThreadList threads={rows(5)} actions={actions} className="" />
      </Fold>
    )
    expect(rowCount(probe.container)).toBe(0)
    expect(probe.container.querySelector('.ws-fold')?.getAttribute('data-open')).toBe('false')
    probe.unmount()
  })

  it('mounts its rows on open and drops them once the closing transition ends', () => {
    const list = <ThreadList threads={rows(5)} actions={actions} className="" />
    const probe = mountProbe(<Fold open={false}>{list}</Fold>)
    probe.rerender(<Fold open>{list}</Fold>)
    expect(rowCount(probe.container)).toBe(5)

    probe.rerender(<Fold open={false}>{list}</Fold>)
    // Still there while the grid collapses; the opacity transition ending first changes nothing.
    expect(rowCount(probe.container)).toBe(5)
    const fold = probe.container.querySelector('.ws-fold')!
    act(() => {
      fireEvent.transitionEnd(fold, { propertyName: 'opacity' })
    })
    expect(rowCount(probe.container)).toBe(5)
    act(() => {
      fireEvent.transitionEnd(fold, { propertyName: 'grid-template-rows' })
    })
    expect(rowCount(probe.container)).toBe(0)
    probe.unmount()
  })

  it('empties itself on a timer when no transition runs', () => {
    const list = <ThreadList threads={rows(3)} actions={actions} className="" />
    const probe = mountProbe(<Fold open>{list}</Fold>)
    probe.rerender(<Fold open={false}>{list}</Fold>)
    expect(rowCount(probe.container)).toBe(3)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(rowCount(probe.container)).toBe(0)
    // Reopening brings the rows straight back.
    probe.rerender(<Fold open>{list}</Fold>)
    expect(rowCount(probe.container)).toBe(3)
    probe.unmount()
  })
})

describe('Fold edge cases', () => {
  it('reopening mid-close keeps the rows', () => {
    vi.useFakeTimers()
    const list = <ThreadList threads={rows(3)} actions={actions} className="" />
    const probe = mountProbe(<Fold open>{list}</Fold>)
    probe.rerender(<Fold open={false}>{list}</Fold>)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    probe.rerender(<Fold open>{list}</Fold>)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(rowCount(probe.container)).toBe(3)
    fireEvent.transitionEnd(probe.container.firstElementChild!, { propertyName: 'grid-template-rows' })
    expect(rowCount(probe.container)).toBe(3)
    vi.useRealTimers()
    probe.unmount()
  })

  it("a nested fold's transitionend leaves its parent alone", () => {
    const probe = mountProbe(
      <Fold open>
        <Fold open={false}>
          <ThreadList threads={rows(2)} actions={actions} className="" />
        </Fold>
        <ThreadList threads={rows(3)} actions={actions} className="" />
      </Fold>
    )
    const outer = probe.container.firstElementChild!
    const inner = outer.querySelector('[data-open="false"]')!
    expect(rowCount(probe.container)).toBe(3)
    fireEvent.transitionEnd(inner, { propertyName: 'grid-template-rows' })
    expect(rowCount(probe.container)).toBe(3)
    probe.unmount()
  })

  it('a closed fold is inert while its rows linger', () => {
    const list = <ThreadList threads={rows(2)} actions={actions} className="" />
    const probe = mountProbe(<Fold open>{list}</Fold>)
    const inner = () => probe.container.firstElementChild!.firstElementChild as HTMLElement
    expect(inner().hasAttribute('inert')).toBe(false)
    probe.rerender(<Fold open={false}>{list}</Fold>)
    expect(inner().hasAttribute('inert')).toBe(true)
    expect(rowCount(probe.container)).toBe(2)
    probe.unmount()
  })
})

describe('ThreadList window', () => {
  it('an expanded list holds at most a page, and grows a page per click', () => {
    const threads = rows(100)
    const probe = mountProbe(
      <Paged>
        {(requested, onMore) => (
          <ThreadList threads={threads} actions={actions} requested={requested} onMore={onMore} className="" />
        )}
      </Paged>
    )
    expect(rowCount(probe.container)).toBe(SESSION_LIST_PAGE)
    const more = moreButton(probe.container)!
    expect(more.textContent).toBe(`${100 - SESSION_LIST_PAGE} more`)
    act(() => {
      fireEvent.click(more)
    })
    expect(rowCount(probe.container)).toBe(2 * SESSION_LIST_PAGE)
    probe.unmount()
  })

  it('reaches the active row past the first page', () => {
    const probe = mountProbe(
      <ThreadList
        threads={rows(100)}
        actions={{ ...actions, activeSessionId: 't60' }}
        className=""
      />
    )
    expect(rowCount(probe.container)).toBe(61)
    expect(probe.container.querySelector('[aria-current="true"]')?.textContent).toContain('t60')
    probe.unmount()
  })
})

describe('ThreadRows fold', () => {
  const withKids = (extra: Partial<SessionMeta> = {}, kidExtra: Partial<SessionMeta> = {}): ThreadRow => ({
    ...threadRow(meta('root', extra), {}),
    children: [
      threadRow(meta('kid1', { parentId: 'root', ...kidExtra }), {}),
      threadRow(meta('kid2', { parentId: 'root', ...kidExtra }), {})
    ]
  })
  const foldButton = (root: HTMLElement) =>
    root.querySelector<HTMLButtonElement>('button[aria-expanded]')!

  beforeEach(() => subagentRowsStore.setState({ pinned: {} }))

  it('a settled root folds its subagents behind a count, and a click unfolds them', () => {
    const probe = mountProbe(<ThreadList threads={[withKids()]} actions={actions} className="" />)
    expect(rowCount(probe.container)).toBe(1)
    expect(foldButton(probe.container).textContent).toBe('2')
    expect(foldButton(probe.container).getAttribute('aria-label')).toBe('Show 2 subagents')
    act(() => {
      fireEvent.click(foldButton(probe.container))
    })
    expect(rowCount(probe.container)).toBe(3)
    expect(foldButton(probe.container).getAttribute('aria-expanded')).toBe('true')
    expect(subagentRowsStore.getState().pinned).toEqual({ root: true })
    probe.unmount()
  })

  it('a working root or subagent shows the rows on its own', () => {
    const probe = mountProbe(
      <ThreadList threads={[withKids({ status: 'running', busySince: 5 })]} actions={actions} className="" />
    )
    expect(rowCount(probe.container)).toBe(3)
    probe.unmount()
    const kid = mountProbe(
      <ThreadList threads={[withKids({}, { status: 'running', busySince: 5 })]} actions={actions} className="" />
    )
    expect(rowCount(kid.container)).toBe(3)
    kid.unmount()
  })

  it("a master's batch threads sit under it the way subagents do: the type's glyph, what a running one does, its model otherwise", () => {
    const master: ThreadRow = {
      ...threadRow(meta('master', { isMaster: true }), {}),
      children: [threadRow(meta('own', { parentId: 'master', status: 'running' }), {})],
      batch: [
        threadRow(meta('b1', { masterId: 'master', threadType: 'implementation', status: 'running', busySince: 5, activity: 'Writing the view', provider: 'claude', model: 'claude-opus-5-5' }), {}),
        threadRow(meta('b2', { masterId: 'master', threadType: 'planning', provider: 'claude', model: 'claude-opus-5-5' }), {})
      ]
    }
    const probe = mountProbe(<ThreadList threads={[master]} actions={actions} className="" />)
    expect(rowCount(probe.container)).toBe(4)
    expect(foldButton(probe.container).getAttribute('aria-label')).toBe('Hide 3 threads')
    const kids = Array.from(probe.container.querySelectorAll('[role="button"]')).slice(1)
    // The batch first, the master's own subagent apart after it.
    expect(kids[2].textContent).toContain('own')
    expect(kids[0].querySelector('[data-activity]')?.textContent).toBe('Writing the view')
    expect(kids[0].textContent).toContain('b1')
    expect(kids[1].querySelector('[data-activity]')).toBeNull()
    expect(kids[1].textContent).toContain('Claude Opus 5.5')
    expect(kids[1].querySelector('svg')).not.toBeNull()
    probe.unmount()
  })

  it("a batch thread on a host whose link is down sits under the offline tint, its master's row does not", () => {
    const envs = [
      { id: 'local', name: 'This Mac', routes: [], credentialRef: null },
      { id: 'env_box', name: 'box', routes: [], credentialRef: null }
    ]
    vi.spyOn(registry, 'environmentsSnapshot').mockReturnValue(envs)
    vi.spyOn(registry, 'statusOf').mockImplementation((id) => ({
      transport: id === 'env_box' ? 'offline' : 'open',
      fresh: true,
      lastHello: null,
      lastError: null,
      nextRetryAt: null,
      route: null,
      attempts: 0
    }))
    const master: ThreadRow = {
      ...threadRow(meta('master', { isMaster: true }), {}),
      batch: [threadRow(meta('far', { masterId: 'master', environmentId: 'env_box', status: 'running', busySince: 5 }), {})]
    }
    const probe = mountProbe(<ThreadList threads={[master]} actions={actions} className="" />)
    const dim = Array.from(probe.container.querySelectorAll('[data-host-offline]'))
    expect(dim.map((row) => row.textContent?.includes('far'))).toEqual([true])
    expect(dim[0].className).toContain('opacity-50')
    probe.unmount()
    vi.restoreAllMocks()
  })

  it('the open subagent keeps its row on screen', () => {
    const probe = mountProbe(
      <ThreadList threads={[withKids()]} actions={{ ...actions, activeSessionId: 'kid2' }} className="" />
    )
    expect(rowCount(probe.container)).toBe(3)
    expect(probe.container.querySelector('[aria-current="true"]')?.textContent).toContain('kid2')
    probe.unmount()
  })
})

describe('a thread row ends in its mark', () => {
  const one = (extra: Partial<SessionMeta>, seen: Record<string, number> = {}) => {
    const probe = mountProbe(<ThreadList threads={[threadRow(meta('t', extra), seen)]} actions={actions} className="" />)
    const row = probe.container.querySelector<HTMLElement>('[role="button"]')!
    return { probe, row, mark: row.querySelector<HTMLElement>('[data-slot="status-mark"]') }
  }

  it('the glyph alone, its state on data-state, the word and what it is about as its label', () => {
    const { probe, mark } = one({ status: 'running', busySince: 5, activity: 'Running bun' })
    expect(mark?.getAttribute('data-state')).toBe('working')
    expect(mark?.getAttribute('aria-label')).toBe('Working  running bun')
    expect(mark?.querySelector('[data-slot="status-word"]')).toBeNull()
    probe.unmount()
    const waiting = one({ status: 'waiting' })
    expect(waiting.mark?.getAttribute('data-state')).toBe('waiting')
    expect(waiting.mark?.getAttribute('aria-label')).toBe('Needs you')
    waiting.probe.unmount()
    const failed = one({ status: 'error', failure: { kind: 'usage-cap', summary: 'Usage cap reached.' } as SessionMeta['failure'] })
    expect(failed.mark?.getAttribute('aria-label')).toBe('Failed  usage cap reached')
    failed.probe.unmount()
  })

  it('a settled row ends in nothing', () => {
    for (const status of ['idle', 'done'] as const) {
      const { probe, mark } = one({ status })
      expect(mark).toBeNull()
      probe.unmount()
    }
  })

  it('an unread title is heavier, with no dot', () => {
    const { probe, row } = one({ status: 'done', updatedAt: 200 }, { t: 100 })
    const title = Array.from(row.querySelectorAll('span')).find((s) => s.textContent === 't')!
    expect(title.className).toContain('font-medium')
    expect(row.querySelector('.rounded-full')).toBeNull()
    probe.unmount()
  })

  it('a paused row has its mark and no fill of its own', () => {
    const { probe, row, mark } = one({ status: 'paused' })
    expect(mark?.getAttribute('data-state')).toBe('paused')
    expect(row.className).not.toMatch(/warning/)
    probe.unmount()
  })

  it("its one hover action is More, opening the right-click's menu", () => {
    const opened: unknown[] = []
    const probe = mountProbe(
      <ThreadList threads={[threadRow(meta('t'), {})]} actions={{ ...actions, openMenu: (m) => opened.push(m) }} className="" />
    )
    const more = probe.container.querySelector<HTMLButtonElement>('button[aria-label="More"]')!
    act(() => {
      fireEvent.click(more)
    })
    expect(opened).toHaveLength(1)
    probe.unmount()
  })
})

describe('the host glyph on rail rows', () => {
  afterEach(() => {
    hosts.environments = []
  })
  const tree = (): ThreadRow => ({
    ...threadRow(meta('root', { status: 'running', busySince: 5 }), {}),
    children: [threadRow(meta('kid', { parentId: 'root', environmentId: 'env_box', status: 'running', busySince: 5 }), {})]
  })

  it('with one host no row draws it', () => {
    hosts.environments = [{ id: 'local', name: 'This Mac' }]
    const probe = mountProbe(<ThreadList threads={[tree()]} actions={actions} className="" />)
    expect(probe.container.querySelector('[data-host-glyph]')).toBeNull()
    probe.unmount()
  })

  it("with two, the root and its subagent each draw their own host's glyph, the name on hover", () => {
    hosts.environments = [
      { id: 'local', name: 'This Mac' },
      { id: 'env_box', name: 'The box', platform: 'linux' }
    ]
    const probe = mountProbe(<ThreadList threads={[tree()]} actions={actions} className="" />)
    const [root, kid] = Array.from(probe.container.querySelectorAll('[role="button"]'))
    expect(root.querySelector('[data-host-glyph]')?.getAttribute('title')).toBe('This Mac')
    expect(kid.querySelector('[data-host-glyph]')?.getAttribute('title')).toBe('The box')
    expect(kid.querySelector('[data-host-glyph]')?.getAttribute('data-host-kind')).toBe('server')
    // The old name chip is gone: the glyph carries no text.
    expect(root.querySelector('[data-host-badge]')).toBeNull()
    expect(root.textContent).not.toContain('This Mac')
    probe.unmount()
  })
})

describe('LiveLines window', () => {
  it('an expanded card holds at most a page of lines', () => {
    const status = projectCardStatus(rows(50, { status: 'done', updatedAt: 200 }), null, {})
    expect(status.unread).toHaveLength(50)
    const probe = mountProbe(<LiveLines status={status} activeId={null} onMore={() => {}} />)
    const lines = probe.container.firstElementChild!.children.length
    // One page of lines plus the "more" row.
    expect(lines).toBe(SESSION_LIST_PAGE + 1)
    expect(moreButton(probe.container)?.textContent).toBe(`${50 - SESSION_LIST_PAGE} more`)
    probe.unmount()
  })
})

describe('the rail row menu: the master pin', () => {
  const openOn = (masterIds?: ReadonlySet<string>, projectId: string | null = 'p1') => {
    const items: { kind: string; id?: string; label?: string }[][] = []
    const probe = mountProbe(
      <ThreadList
        threads={[threadRow(meta('t0', { projectId }), {})]}
        actions={{ ...actions, masterIds, openMenu: (state) => items.push(state.items) }}
        className=""
      />
    )
    fireEvent.contextMenu(probe.container.querySelector('[role="button"]')!)
    probe.unmount()
    return items[0]?.flatMap((i) => (i.kind === 'item' && i.id === 'master' ? [i.label] : [])) ?? []
  }

  it('offers Make master thread to a root in a project, Not a master to a master', () => {
    expect(openOn()).toEqual(['Make master thread'])
    expect(openOn(new Set(['t0']))).toEqual(['Not a master'])
    expect(openOn(new Set(['other']))).toEqual(['Make master thread'])
  })

  it('offers no pin to a thread outside a project', () => {
    expect(openOn(undefined, null)).toEqual([])
    expect(masterMenuItem({ id: 't0', projectId: null }, new Set(['t0']))).toBeNull()
  })
})
