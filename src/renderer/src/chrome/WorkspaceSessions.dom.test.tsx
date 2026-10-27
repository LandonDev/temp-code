// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { SESSION_LIST_PAGE } from '../lib/sessionListWindow'
import type { ProjectMeta, SessionMeta } from '../lib/tcserver/types'
import { mountProbe } from '../test/renderProbe'
import { threadRow, type ThreadRow } from '../lib/workspaceSessions'
import { nextPage } from '../lib/sidebarRows'
import { ProjectRow, ThreadList } from './WorkspaceSessions'
import { screen, within } from '@testing-library/react'
import { resetMenus } from './menuRows'
import { projectFolds } from '../lib/projectFolds'
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
  menu: {
    rowsFor: (id: string) => [{ kind: 'item' as const, id: 'rename', label: `Rename ${id}` }],
    onPick: () => {},
    onOpenChange: () => {}
  },
  renamingId: null as string | null,
  onStartRename: () => {}
}

const rowCount = (root: HTMLElement) => root.querySelectorAll('[role="button"]').length
const moreButton = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('button')).find((b) => /\bmore$/.test(b.textContent ?? ''))

const project = (id = 'p1') =>
  ({ environmentId: 'local', id, workspaceId: 'w1', name: `Project ${id}`, mode: 'local', branch: 'main', cwd: '/wt/p1', archived: false, createdAt: 1 }) as ProjectMeta

const projectRow = (threads: ThreadRow[]) => (
  <ProjectRow
    group={{ project: project(), threads, latest: 100, archivedCount: 0 }}
    selected={false}
    lastSeen={{}}
    seenFloor={0}
    rows={{ ...actions, focusedTree: new Set<string>() }}
    requested={SESSION_LIST_PAGE}
    onMore={() => {}}
    onSelect={() => {}}
    onNewChat={() => {}}
    onRename={() => {}}
    onSettings={() => {}}
    onPreamble={() => {}}
    onArchive={() => {}}
    onDelete={() => {}}
  />
)

const threadRows = (root: HTMLElement) => root.querySelectorAll('[role="button"]:not([data-project-row])').length
const headerOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-project-row]')!

describe('a project row', () => {
  beforeEach(() => {
    localStorage.clear()
    projectFolds.reload()
  })

  it("says the project's loudest state in one word, and nothing when it is quiet", () => {
    const word = (threads: ThreadRow[]) => {
      const probe = mountProbe(projectRow(threads))
      const mark = headerOf(probe.container).querySelector('[data-slot="status-word"]')?.textContent ?? null
      probe.unmount()
      return mark
    }
    expect(word([threadRow(meta('w', { status: 'waiting' }), {}), threadRow(meta('r', { status: 'running' }), {})])).toBe('Needs you')
    expect(word([threadRow(meta('f', { status: 'error' }), {}), threadRow(meta('r', { status: 'running' }), {})])).toBe('Failed')
    expect(word([threadRow(meta('r', { status: 'running' }), {})])).toBe('Working')
    expect(word([threadRow(meta('p', { status: 'paused' }), {})])).toBe('Paused')
    expect(word([threadRow(meta('d', { status: 'done' }), { d: 500 })])).toBeNull()
  })

  it('is open by default and lists its threads; closed, it holds none and stays closed across a remount', async () => {
    const threads = rows(3)
    const probe = mountProbe(projectRow(threads))
    expect(headerOf(probe.container).getAttribute('aria-expanded')).toBe('true')
    expect(threadRows(probe.container)).toBe(3)
    await act(async () => {
      fireEvent.click(headerOf(probe.container))
    })
    expect(headerOf(probe.container).getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(threadRows(probe.container)).toBe(0)
    probe.unmount()
    const again = mountProbe(projectRow(threads))
    expect(threadRows(again.container)).toBe(0)
    await act(async () => {
      fireEvent.click(headerOf(again.container))
    })
    expect(threadRows(again.container)).toBe(3)
    again.unmount()
  })

  it('reopening mid-close keeps its rows', async () => {
    const probe = mountProbe(projectRow(rows(2)))
    await act(async () => {
      fireEvent.click(headerOf(probe.container))
      fireEvent.click(headerOf(probe.container))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(headerOf(probe.container).getAttribute('aria-expanded')).toBe('true')
    expect(threadRows(probe.container)).toBe(2)
    probe.unmount()
  })

  it('has no border, and the column separates nothing with dots', () => {
    const probe = mountProbe(
      projectRow([
        threadRow(meta('r', { status: 'running', activity: 'Running bun', tasks: { done: 1, total: 3 } as SessionMeta['tasks'] }), {}),
        threadRow(meta('d', { status: 'done' }), {})
      ])
    )
    expect(probe.container.querySelector('[class*="border"]')).toBeNull()
    expect(probe.container.textContent).not.toMatch(/ · |•/)
    probe.unmount()
  })

  it('an unread thread makes the name heavier', () => {
    const probe = mountProbe(projectRow([threadRow(meta('d', { status: 'done', updatedAt: 200 }), { d: 100 })]))
    const name = Array.from(headerOf(probe.container).querySelectorAll('span')).find((s) => s.textContent === 'Project p1')!
    expect(name.className).toContain('font-medium')
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

  it("the row carries the word in its name, so hover or focus anywhere on it reads it (More covers the glyph)", () => {
    const { probe, row } = one({ status: 'waiting' })
    // The row is the tooltip's trigger: the word and its detail are in its accessible name.
    expect(row.getAttribute('role')).toBe('button')
    expect(row.querySelector('[aria-label="Needs you"]')).not.toBeNull()
    expect(row.querySelector('[data-slot="tooltip-trigger"]')).toBeNull()
    probe.unmount()
  })

  it('a focused row keeps its focus when its thread settles', () => {
    const list = (status: SessionMeta['status']) => (
      <ThreadList threads={[threadRow(meta('t', { status }), { t: 1000 })]} actions={actions} className="" />
    )
    const probe = mountProbe(list('running'))
    const row = probe.container.querySelector<HTMLElement>('[role="button"]')!
    act(() => row.focus())
    probe.rerender(list('idle'))
    expect(probe.container.querySelector('[role="button"]')).toBe(row)
    expect(document.activeElement).toBe(row)
    probe.unmount()
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

  it("its one hover action is More, opening the thread's menu", async () => {
    resetMenus()
    const onOpenChange = vi.fn()
    const onPick = vi.fn()
    const probe = mountProbe(
      <ThreadList threads={[threadRow(meta('t'), {})]} actions={{ ...actions, menu: { ...actions.menu, onOpenChange, onPick } }} className="" />
    )
    const more = probe.container.querySelector<HTMLButtonElement>('button[aria-label="More"]')!
    act(() => {
      fireEvent.click(more)
    })
    expect(onOpenChange).toHaveBeenCalledWith('t', true)
    const list = await screen.findByRole('menu', { name: 'Thread actions' })
    fireEvent.click(within(list).getByText('Rename t'))
    expect(onPick).toHaveBeenCalledWith('t', 'rename')
    probe.unmount()
  })

  it('a row carries its thread for the list\'s one right-click menu, and renames in place', () => {
    const probe = mountProbe(<ThreadList threads={[threadRow(meta('t0'), {})]} actions={{ ...actions, renamingId: 't0' }} className="" />)
    expect(probe.container.querySelector('[data-menu-id="t0"]')).toBeTruthy()
    expect(probe.container.querySelector('input')).toBeTruthy()
    probe.unmount()
  })

  describe('the rename field', () => {
    const renameProbe = () => {
      const onRename = vi.fn()
      const onStartRename = vi.fn()
      const probe = mountProbe(
        <ThreadList threads={[threadRow(meta('t0', { title: 'Old title' }), {})]} actions={{ ...actions, renamingId: 't0', onRename, onStartRename }} className="" />
      )
      const input = probe.container.querySelector('input')!
      return { probe, input, onRename, onStartRename }
    }

    it('opens focused with the whole title selected', () => {
      const { probe, input } = renameProbe()
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe('Old title')
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 9])
      probe.unmount()
    })

    it('commits on Enter', () => {
      const { probe, input, onRename, onStartRename } = renameProbe()
      fireEvent.change(input, { target: { value: 'New title' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onStartRename).toHaveBeenCalledWith(null)
      expect(onRename).toHaveBeenCalledWith('t0', 'New title')
      probe.unmount()
    })

    it('cancels on Escape, and the blur after it commits nothing', () => {
      const { probe, input, onRename, onStartRename } = renameProbe()
      fireEvent.change(input, { target: { value: 'New title' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      fireEvent.blur(input)
      expect(onStartRename).toHaveBeenCalledWith(null)
      expect(onRename).not.toHaveBeenCalled()
      probe.unmount()
    })

    it('commits on blur', () => {
      const { probe, input, onRename } = renameProbe()
      fireEvent.change(input, { target: { value: 'New title' } })
      fireEvent.blur(input)
      expect(onRename).toHaveBeenCalledWith('t0', 'New title')
      probe.unmount()
    })
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
    expect(root.querySelector('[data-host-glyph]')?.getAttribute('aria-label')).toBe('This Mac')
    expect(kid.querySelector('[data-host-glyph]')?.getAttribute('aria-label')).toBe('The box')
    expect(kid.querySelector('[data-host-glyph]')?.getAttribute('data-host-kind')).toBe('server')
    // The old name chip is gone: the glyph carries no text.
    expect(root.querySelector('[data-host-badge]')).toBeNull()
    expect(root.textContent).not.toContain('This Mac')
    probe.unmount()
  })
})

