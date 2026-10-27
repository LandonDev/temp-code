import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ThreadResource } from '@server/shared/contract-resources'
import { mountProbe } from '../test/renderProbe'
import { threadResourcesStore } from '../lib/threadResources'
import { macBridgeStore } from '../lib/macBridge'
import { sessionStore } from '../lib/tcserver/store'

const archive = vi.hoisted(() => ({ fn: null as null | ((id: string, opts: unknown) => Promise<void>) }))
vi.mock('../lib/threadResources', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/threadResources')>()
  return { ...real, archiveThread: (id: string, opts: { removeResources: boolean }) => (archive.fn ? archive.fn(id, opts) : real.archiveThread(id, opts)) }
})
import { ArchiveThreadDialog, ThreadResourceList } from './ThreadResourcesDialog'

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

describe('ThreadResourceList', () => {
  let probe: ReturnType<typeof mountProbe> | null = null
  beforeEach(() => threadResourcesStore.setState({ bySession: {} }))
  afterEach(() => {
    probe?.unmount()
    probe = null
  })

  it('lists the live rows with host, kind and label (the identifier on its tooltip), hides removed ones, and shows the empty line otherwise', async () => {
    threadResourcesStore.setState({
      bySession: {
        s1: [
          row({}),
          row({ id: 'r2', kind: 'simulator', identifier: 'ABCDEF00-0000-4000-8000-000000000000', label: 'tc-ios-home', branch: null }),
          row({ id: 'r3', removedAt: 9, note: 'branch x deleted' })
        ]
      }
    })
    probe = mountProbe(<ThreadResourceList sessionId="s1" empty />)
    const rows = [...probe.container.querySelectorAll('[data-resource]')]
    expect(rows.map((r) => r.getAttribute('data-resource'))).toEqual(['r1', 'r2'])
    expect(rows[0].textContent).toContain('worktree')
    expect(rows[0].textContent).toContain('ios/home')
    // The identifier is the label's tooltip, not a title attribute.
    expect(probe.container.querySelector('[title]')).toBeNull()
    expect(rows[0].querySelector('[data-slot=tooltip-trigger]')?.textContent).toBe('ios/home')
    expect(rows[0].querySelector('[data-slot=item-description]')?.textContent).toBe('macworktree')
    const trigger = rows[0].querySelector('[data-slot=tooltip-trigger]') as HTMLElement
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseMove(trigger)
    await waitFor(() => expect(screen.getByText('/Users/landon/IdeaProjects/tc-ios/home')).toBeTruthy(), { timeout: 1500 })
    expect(rows[1].textContent).toContain('simulator')
    expect(rows[1].textContent).toContain('tc-ios-home')
    expect(rows.every((r) => r.querySelector('button')?.textContent === 'Remove')).toBe(true)
    expect(probe.container.textContent).toContain('Remove all')

    probe.act(() => probe!.rerender(<ThreadResourceList sessionId="s2" empty />))
    expect(probe.container.querySelectorAll('[data-resource]')).toHaveLength(0)
    expect(probe.container.querySelector('[data-slot=empty-title]')?.textContent).toBe('Nothing recorded')

    probe.act(() => probe!.rerender(<ThreadResourceList sessionId="s2" />))
    expect(probe.container.textContent).toBe('')
  })

  it('lists the thread’s live dev servers as the Dev servers pane does, and none the host dropped', () => {
    macBridgeStore.setState({ localId: 'env_mac' })
    const env = vi.spyOn(sessionStore, 'environmentOf').mockReturnValue('env_box')
    const port = (over: Partial<ThreadResource>) =>
      row({
        kind: 'port',
        environmentId: 'env_box',
        identifier: '5173',
        label: 'npx vite',
        branch: null,
        pid: 42,
        callId: 'c1',
        forwards: [{ environmentId: 'env_mac', hostName: 'Mac', macPort: 5174, error: null }],
        ...over
      })
    threadResourcesStore.setState({ bySession: { s1: [port({}), port({ id: 'gone', identifier: '3000', removedAt: 9 })] } })
    probe = mountProbe(<ThreadResourceList sessionId="s1" />)
    const servers = [...probe.container.querySelectorAll('[data-dev-server]')] as HTMLElement[]
    expect(servers.map((r) => r.getAttribute('data-dev-server'))).toEqual(['env_box/r1'])
    expect(servers[0].textContent).toContain('Vite dev server')
    expect(servers[0].textContent).toContain('localhost:5173')
    expect([...servers[0].querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['Open on the Mac :5174', 'Stop'])
    expect(probe.container.querySelector('[data-resource]')).toBeNull()
    macBridgeStore.setState({ localId: null })
    env.mockRestore()
  })

  it('a row waiting on its host shows Waiting and the reason, with Remove held; a note from the last attempt shows under the row', () => {
    threadResourcesStore.setState({
      bySession: {
        s1: [
          row({ removeRequestedAt: 5, note: 'host offline, waiting for its link' }),
          row({ id: 'r2', note: 'branch ios/home kept: 2 commits ahead of its upstream' })
        ]
      }
    })
    probe = mountProbe(<ThreadResourceList sessionId="s1" />)
    const [waiting, noted] = [...probe.container.querySelectorAll('[data-resource]')]
    const button = waiting.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toBe('Waiting')
    expect(button.disabled).toBe(true)
    expect(waiting.textContent).toContain('host offline, waiting for its link')
    expect((noted.querySelector('button') as HTMLButtonElement).disabled).toBe(false)
    expect(noted.textContent).toContain('branch ios/home kept: 2 commits ahead of its upstream')
  })

  it('Remove goes to the host; without a link for the thread the error shows inline and the row stays', async () => {
    threadResourcesStore.setState({ bySession: { s1: [row({})] } })
    probe = mountProbe(<ThreadResourceList sessionId="s1" />)
    const button = probe.container.querySelector('[data-resource] button') as HTMLButtonElement
    await probe.act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(probe.container.textContent).toContain('unknown session: s1')
    expect(probe.container.querySelectorAll('[data-resource]')).toHaveLength(1)
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
