import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ThreadResource } from '@server/shared/contract-resources'
import { mountProbe } from '../test/renderProbe'
import { threadResourcesStore } from '../lib/threadResources'
import { ArchiveThreadDialog, ThreadResourceList } from './ThreadResourcesDialog'

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

  it('lists the live rows with host, kind and label, hides removed ones, and shows the empty line otherwise', () => {
    threadResourcesStore.setState({
      bySession: {
        s1: [
          row({}),
          row({ id: 'r2', kind: 'simulator', identifier: 'ABCDEF00-0000-4000-8000-000000000000', label: 'tc-ios-home', branch: null }),
          row({ id: 'r3', removedAt: 9, note: 'branch x deleted' })
        ]
      }
    })
    probe = mountProbe(<ThreadResourceList sessionId="s1" empty="Nothing recorded." />)
    const rows = [...probe.container.querySelectorAll('[data-resource]')]
    expect(rows.map((r) => r.getAttribute('data-resource'))).toEqual(['r1', 'r2'])
    expect(rows[0].textContent).toContain('worktree')
    expect(rows[0].textContent).toContain('ios/home')
    expect(rows[0].querySelector('[title]')?.getAttribute('title')).toBe('/Users/landon/IdeaProjects/tc-ios/home')
    expect(rows[1].textContent).toContain('simulator')
    expect(rows[1].textContent).toContain('tc-ios-home')
    expect(rows.every((r) => r.querySelector('button')?.textContent === 'Remove')).toBe(true)
    expect(probe.container.textContent).toContain('Remove all')

    probe.act(() => probe!.rerender(<ThreadResourceList sessionId="s2" empty="Nothing recorded." />))
    expect(probe.container.querySelectorAll('[data-resource]')).toHaveLength(0)
    expect(probe.container.textContent).toBe('Nothing recorded.')
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
    const box = document.body.querySelector('[data-remove-resources]') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(document.body.textContent).toContain('Archive iOS home?')
    expect(document.body.textContent).toMatch(/and remove 2 resources on /)
    expect(document.body.textContent).toContain('dev instance')
    expect(document.body.textContent).toContain('temp-code-dev2')
    expect([...document.body.querySelectorAll('button')].map((b) => b.textContent)).toContain('Archive')
  })
})
