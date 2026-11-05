// @vitest-environment jsdom
// Its own file: a tooltip an earlier test left in the shared delay group holds this one back.
import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { groupMark } from '../lib/sidebarRows'
import type { SessionMeta } from '../lib/tcserver/types'
import { threadRow, type ThreadRow } from '../lib/workspaceSessions'

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ environmentId: 'local', id, parentId: null, projectId: null, workspaceId: null, threadType: 'chat', title: `Thread ${id}`, cwd: '/a', status: 'idle', archived: false, pinned: false, busySince: null, createdAt: 1, updatedAt: 100, ...extra }) as SessionMeta

const rows = (...list: [string, Partial<SessionMeta>][]): ThreadRow[] => list.map(([id, extra]) => threadRow(meta(id, extra), {}))

describe("the workspace row's state trigger", () => {
  it('is named on hover with the words its button is named by', async () => {
    const { WorkspaceMarkTrigger } = await import('./WorkspaceRowMarks')
    const { tooltipChunk, warmTooltips } = await import('../components/ui/tooltip')
    await act(async () => {
      await tooltipChunk.load()
      warmTooltips()
    })
    const m = groupMark(rows(['a', { status: 'waiting' }], ['b', { status: 'waiting' }]))!
    const probe = render(<WorkspaceMarkTrigger mark={m} workspaceIds={['w1']} activeSessionId={null} />)
    const button = probe.container.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Needs you, 2 threads')
    fireEvent.pointerEnter(button)
    fireEvent.mouseEnter(button)
    fireEvent.focus(button)
    await waitFor(
      () => expect([...document.querySelectorAll('[data-slot="tooltip-content"]')].map((t) => t.textContent)).toContain('Needs you, 2 threads'),
      { timeout: 2000 }
    )
    // The Tooltip's trigger is the popover's trigger: one button, both roles.
    expect(probe.container.querySelectorAll('button')).toHaveLength(1)
    expect(button.hasAttribute('data-no-drag')).toBe(true)
    probe.unmount()
  })
})
