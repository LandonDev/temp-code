// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { mountProbe } from '../test/renderProbe'
import { groupMark } from '../lib/sidebarRows'
import type { SessionMeta } from '../lib/tcserver/types'
import { threadRow, type ThreadRow } from '../lib/workspaceSessions'
import { RailRow } from './RailRow'
import { WorkspaceMarkView } from './WorkspaceRowMarks'

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: 'local',
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: 'chat',
    title: `Thread ${id}`,
    cwd: '/a',
    status: 'idle',
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 100,
    ...extra
  }) as SessionMeta

const rows = (...list: [string, Partial<SessionMeta>][]): ThreadRow[] => list.map(([id, extra]) => threadRow(meta(id, extra), {}))

describe("a workspace row's state", () => {
  const mark = (list: ThreadRow[]) => {
    const m = groupMark(list)
    if (!m) return null
    const probe = mountProbe(<WorkspaceMarkView mark={m} />)
    const button = probe.container.querySelector('button')!
    const out = {
      state: button.querySelector('[data-slot="status-mark"]')?.getAttribute('data-state'),
      text: button.textContent,
      label: button.getAttribute('aria-label'),
      noDrag: button.hasAttribute('data-no-drag'),
      size: button.className.includes('size-6')
    }
    probe.unmount()
    return out
  }

  it('is the loudest state\'s glyph alone in a 24px button, named with its word and count', () => {
    expect(mark(rows(['a', { status: 'waiting' }], ['b', { status: 'waiting' }], ['c', { status: 'running' }]))).toEqual({
      state: 'waiting',
      text: '',
      label: 'Needs you, 2 threads',
      noDrag: true,
      size: true
    })
    expect(mark(rows(['a', { status: 'error' }], ['b', { status: 'running' }]))?.label).toBe('Failed, 1 thread')
    expect(mark(rows(['a', { status: 'running' }]))).toMatchObject({ state: 'working', label: 'Working, 1 thread', text: '' })
    expect(mark(rows(['a', { status: 'paused' }]))?.state).toBe('paused')
  })

  it('says nothing at all for a quiet workspace', () => {
    expect(mark(rows(['a', {}], ['b', { status: 'done' }]))).toBeNull()
  })

  it("a pointer-down on the glyph never reaches the row's drag", () => {
    const onRowDown = vi.fn()
    const mark = groupMark(rows(['a', { status: 'running' }]))!
    const probe = mountProbe(
      <RailRow
        label="temp-code"
        onPointerDown={onRowDown}
        trailingInteractive
        trailing={<WorkspaceMarkView mark={mark} onPointerDown={(e) => e.stopPropagation()} />}
      />
    )
    fireEvent.pointerDown(probe.container.querySelector('[data-no-drag]')!)
    expect(onRowDown).not.toHaveBeenCalled()
    probe.unmount()
  })
})

describe('an unread workspace', () => {
  it('is weight on the row, no dot', () => {
    const probe = mountProbe(<RailRow label="aliax" emphasis />)
    const row = probe.container.querySelector('[data-rail-row]')!
    expect(row.querySelector('button')!.className).toContain('font-medium')
    expect(row.querySelector('.rounded-full')).toBeNull()
    probe.unmount()
  })
})
