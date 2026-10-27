import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ThreadResource } from '@server/shared/contract-resources'
import { mountProbe } from '../test/renderProbe'
import { threadResourcesStore } from '../lib/threadResources'

const archive = vi.hoisted(() => ({ fn: null as null | ((id: string, opts: unknown) => Promise<void>) }))
const removal = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../lib/threadResources', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/threadResources')>()
  return {
    ...real,
    archiveThread: (id: string, opts: { removeResources: boolean }) => (archive.fn ? archive.fn(id, opts) : real.archiveThread(id, opts)),
    removeThreadResources: (...args: unknown[]) => removal.fn(...args)
  }
})
import { ArchiveThreadDialog, ThreadResourcesDialog } from './ThreadResourcesDialog'

vi.mock('../lib/tcserver/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/tcserver/store')>()
  return {
    ...real,
    useServerSessions: () => [{ id: 's1', projectId: null, title: 'Coins page' }]
  }
})

const row = (over: Partial<ThreadResource>): ThreadResource => ({
  id: 'r1',
  sessionId: 's1',
  environmentId: 'env_mac',
  kind: 'worktree',
  identifier: '/Users/landon/IdeaProjects/tc-ios/home',
  label: 'ios/home',
  branch: 'ios/home',
  createdAt: 1,
  removeRequestedAt: null,
  removedAt: null,
  note: null,
  ...over
})

describe('ThreadResourcesDialog', () => {
  let probe: ReturnType<typeof mountProbe> | null = null
  beforeEach(() => {
    threadResourcesStore.setState({ bySession: {} })
    removal.fn.mockReset()
  })
  afterEach(() => {
    probe?.unmount()
    probe = null
  })
  const flush = () => probe!.act(async () => void (await new Promise((r) => setTimeout(r, 0))))
  const checkbox = (name: RegExp) => screen.getByRole('checkbox', { name })
  const removeButton = () => screen.getByRole('button', { name: /^Remove/ }) as HTMLButtonElement
  const open = (onClose = vi.fn()) => {
    probe = mountProbe(<ThreadResourcesDialog sessionId="s1" title="Coins page" onClose={onClose} />)
    return onClose
  }

  it('is a removal form: one unchecked box per live row, no dev servers, Remove N counting the picks', async () => {
    threadResourcesStore.setState({
      bySession: {
        s1: [
          row({}),
          row({ id: 'r2', kind: 'simulator', identifier: 'ABCDEF00-0000-4000-8000-000000000000', label: 'tc-ios-home', branch: null }),
          row({ id: 'r3', removedAt: 9, note: 'branch x deleted' }),
          row({ id: 'p1', kind: 'port', identifier: '5173', label: 'npx vite', branch: null })
        ]
      }
    })
    open()
    await flush()
    expect(document.body.textContent).toContain('Resources')
    expect(document.body.textContent).toContain('Coins page')
    const rows = [...document.body.querySelectorAll('[data-resource]')]
    expect(rows.map((r) => r.getAttribute('data-resource'))).toEqual(['r1', 'r2'])
    expect(document.body.textContent).not.toContain('npx vite')
    expect(document.body.textContent).not.toContain('Remove all')
    expect(document.body.querySelector('[title]')).toBeNull()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    expect(removeButton().textContent).toBe('Remove')
    expect(removeButton().disabled).toBe(true)
    expect(removeButton().getAttribute('data-variant')).toBe('destructive')
    fireEvent.click(checkbox(/ios\/home/))
    expect(removeButton().textContent).toBe('Remove 1')
    fireEvent.click(checkbox(/tc-ios-home/))
    expect(removeButton().textContent).toBe('Remove 2')
    expect(removeButton().disabled).toBe(false)
  })

  it('shows a loading line until the ledger answers, never an empty state', async () => {
    open()
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    await flush()
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.body.textContent).toContain('Nothing left to remove.')
  })

  it('removes the picked rows on their host and closes once the push leaves nothing', async () => {
    threadResourcesStore.setState({ bySession: { s1: [row({}), row({ id: 'r2', label: 'ios/other' })] } })
    removal.fn.mockResolvedValue([
      { id: 'r1', outcome: 'removed' },
      { id: 'r2', outcome: 'removed' }
    ])
    const onClose = open()
    await flush()
    fireEvent.click(checkbox(/ios\/home/))
    fireEvent.click(checkbox(/ios\/other/))
    await probe!.act(async () => {
      fireEvent.click(removeButton())
      await Promise.resolve()
    })
    expect(removal.fn).toHaveBeenCalledWith('s1', ['r1', 'r2'])
    expect(onClose).not.toHaveBeenCalled()
    await probe!.act(async () => {
      threadResourcesStore.setState({ bySession: { s1: [row({ removedAt: 9 }), row({ id: 'r2', removedAt: 9 })] } })
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('a failure shows inline and keeps its row picked; a row its host is still removing cannot be picked', async () => {
    threadResourcesStore.setState({
      bySession: { s1: [row({}), row({ id: 'r2', label: 'ios/other', removeRequestedAt: 5, note: 'host offline, waiting for its link' })] }
    })
    removal.fn.mockResolvedValue([{ id: 'r1', outcome: 'failed', note: 'worktree is dirty' }])
    open()
    await flush()
    const waiting = checkbox(/ios\/other/)
    expect(waiting.getAttribute('aria-disabled') ?? (waiting as HTMLButtonElement).disabled.toString()).toBe('true')
    expect(document.body.textContent).toContain('host offline, waiting for its link')
    fireEvent.click(checkbox(/ios\/home/))
    await probe!.act(async () => {
      fireEvent.click(removeButton())
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('worktree is dirty')
    expect(checkbox(/ios\/home/).getAttribute('aria-checked')).toBe('true')
    expect(removeButton().textContent).toBe('Remove 1')
  })
})

describe('ArchiveThreadDialog', () => {
  let probe: ReturnType<typeof mountProbe> | null = null
  afterEach(() => {
    probe?.unmount()
    probe = null
  })
  it('offers the removal with the box on by default, the clause counting the rows, and lists what goes', () => {
    const resources = [row({}), row({ id: 'r2', kind: 'devInstance', identifier: '/Users/landon/Library/Application Support/temp-code-dev2', label: 'temp-code-dev2', branch: null })]
    probe = mountProbe(<ArchiveThreadDialog sessionId="s1" title="iOS home" resources={resources} onCancel={() => {}} onArchived={() => {}} />)
    const box = screen.getByRole('checkbox', { name: /and remove 2 resources on / })
    expect(box.getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain('Archive iOS home?')
    expect(document.body.textContent).toMatch(/and remove 2 resources on /)
    expect(document.body.textContent).toContain('dev instance')
    expect(document.body.textContent).toContain('temp-code-dev2')
    expect([...document.body.querySelectorAll('button')].map((b) => b.textContent)).toContain('Archive')
    // The resources sit as plain lines under the choice: no list markers.
    expect(document.body.querySelector('ul, li')).toBeNull()
    expect(document.body.querySelector('[data-archive-resources]')?.children).toHaveLength(2)
  })

  it('archives with the choice as ticked and closes after its exit; unticked, the resources stay', async () => {
    const calls: unknown[] = []
    const archived = vi.fn()
    archive.fn = async (id, opts) => void calls.push([id, opts])
    probe = mountProbe(<ArchiveThreadDialog sessionId="s1" title="iOS home" resources={[row({})]} onCancel={() => {}} onArchived={archived} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /and remove 1 resource on / }))
    await probe.act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
      await Promise.resolve()
    })
    await waitFor(() => expect(archived).toHaveBeenCalledTimes(1))
    expect(calls).toEqual([['s1', { removeResources: false }]])
    archive.fn = null
  })
})
