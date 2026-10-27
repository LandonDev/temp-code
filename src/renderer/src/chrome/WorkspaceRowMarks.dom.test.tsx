// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { mountProbe } from '../test/renderProbe'
import { groupMark } from '../lib/sidebarRows'
import type { SessionMeta } from '../lib/tcserver/types'
import { threadRow, type ThreadRow } from '../lib/workspaceSessions'
import { RailRow } from './RailRow'
import { WorkspaceGlyph, WorkspaceLineView, WorkspaceMarkView } from './WorkspaceRowMarks'

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

describe("a workspace row's glyph", () => {
  it('is the same element whether the workspace works, waits or rests, and never hops', () => {
    const glyph = () => (
      <WorkspaceGlyph showLogo={false} logoPath={null} workspaceId={null} projectKey="temp-code" color="var(--chart-1)" mascotName={null} />
    )
    const probe = mountProbe(glyph())
    const svg = probe.container.querySelector('svg')!
    expect(svg.getAttribute('class')).toContain('size-4')
    expect(svg.getAttribute('class')).not.toContain('mascot-active')
    expect((svg as SVGElement).style.color).toBe('var(--chart-1)')
    probe.unmount()
  })
})

describe("a workspace row's word", () => {
  const word = (list: ThreadRow[]) => {
    const mark = groupMark(list)
    if (!mark) return null
    const probe = mountProbe(<WorkspaceMarkView mark={mark} />)
    const button = probe.container.querySelector('button')!
    const out = {
      text: button.querySelector('[data-slot="status-word"]')?.textContent,
      label: button.getAttribute('aria-label'),
      noDrag: button.hasAttribute('data-no-drag')
    }
    probe.unmount()
    return out
  }

  it('says the loudest state, named with its count', () => {
    expect(word(rows(['a', { status: 'waiting' }], ['b', { status: 'waiting' }], ['c', { status: 'running' }]))).toEqual({
      text: 'Needs you',
      label: 'Needs you, 2 threads',
      noDrag: true
    })
    expect(word(rows(['a', { status: 'error' }], ['b', { status: 'running' }]))?.text).toBe('Failed')
    expect(word(rows(['a', { status: 'running' }]))).toMatchObject({ text: 'Working', label: 'Working, 1 thread' })
    expect(word(rows(['a', { status: 'paused' }]))?.text).toBe('Paused')
  })

  it('says nothing at all for a quiet workspace', () => {
    expect(word(rows(['a', {}], ['b', { status: 'done' }]))).toBeNull()
  })

  it("a pointer-down on the word never reaches the row's drag", () => {
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

describe('the line under a workspace row', () => {
  it('names the waiting thread for Needs you, and opens it on click', () => {
    const onSelect = vi.fn()
    const mark = groupMark(rows(['run', { status: 'running', updatedAt: 300 }], ['wait', { status: 'waiting', updatedAt: 10 }]))!
    const probe = mountProbe(<WorkspaceLineView mark={mark} onSelect={onSelect} />)
    const line = probe.container.querySelector<HTMLButtonElement>('[data-workspace-line]')!
    expect(line.textContent).toBe('Thread wait')
    act(() => {
      fireEvent.click(line)
    })
    expect(onSelect).toHaveBeenCalledWith('wait')
    probe.unmount()
  })

  it('names the newest running thread for Working, and counts the others', () => {
    const mark = groupMark(
      rows(['old', { status: 'running', updatedAt: 10 }], ['new', { status: 'running', updatedAt: 90 }], ['mid', { status: 'starting', updatedAt: 50 }])
    )!
    const probe = mountProbe(<WorkspaceLineView mark={mark} />)
    const line = probe.container.querySelector('[data-workspace-line]')!
    expect(line.textContent).toBe('Thread new+2')
    expect(line.textContent).not.toMatch(/ · /)
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
