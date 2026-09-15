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
import { Fold, LiveLines, ThreadList } from './WorkspaceSessions'
import { subagentRowsStore } from '../stores/subagentRows'

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

  it('the open subagent keeps its row on screen', () => {
    const probe = mountProbe(
      <ThreadList threads={[withKids()]} actions={{ ...actions, activeSessionId: 'kid2' }} className="" />
    )
    expect(rowCount(probe.container)).toBe(3)
    expect(probe.container.querySelector('[aria-current="true"]')?.textContent).toContain('kid2')
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
