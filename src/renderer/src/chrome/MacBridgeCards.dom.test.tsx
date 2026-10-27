// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'

/**
 * The Mac bridge's approval card above a thread's composer (Allow and Deny
 * with the remember choice), and the toasts for the threads not on screen:
 * one sonner toast per host with its id, updated as the queue moves,
 * dismissed when the request resolves, none for the thread on screen.
 */

let requests: MacBridgeRequest[] = []
const decided: unknown[][] = []
vi.mock('../lib/macBridge', async (original) => ({
  ...(await original<typeof import('../lib/macBridge')>()),
  startMacBridge: () => () => {},
  useMacBridgeRequests: () => requests,
  useAllMacBridgeRequests: () => requests,
  decideMacBridge: async (...args: unknown[]) => {
    decided.push(args)
  }
  }))
vi.mock('../lib/macBridgeRules', async (original) => ({
  ...(await original<typeof import('../lib/macBridgeRules')>()),
  loadMacBridgeRules: async () => {},
  startMacBridgeRules: () => () => {}
}))
let onScreen: string[] = []
vi.mock('../stores/workspace', () => ({
  useWorkspaceTabs: (pick: (s: unknown) => unknown) => pick({ tabs: [{ id: 't', layout: onScreen }], activeTabId: 't' })
}))
vi.mock('../lib/layout', () => ({ leafIds: (layout: string[]) => layout }))
const toasts = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { dismiss: vi.fn() })
  return { toast }
})
vi.mock('sonner', () => ({ toast: toasts.toast }))

const { MacBridgeThreadCards, MacBridgeToasts } = await import('./MacBridgeCards')

const req = (id: string, over: Partial<MacBridgeRequest> = {}): MacBridgeRequest => ({
  id,
  environmentId: 'env_box',
  hostName: 'box',
  sessionId: 's1',
  threadTitle: 'Fix the gate',
  kind: 'run',
  method: 'mac.run',
  argv: ['bun', 'test'],
  cwd: '/Users/me/app',
  createdAt: 1,
  expiresAt: 600_000,
  status: 'pending',
  ...over
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

afterEach(() => {
  cleanup()
  requests = []
  onScreen = []
  decided.length = 0
  toasts.toast.mockClear()
  toasts.toast.dismiss.mockClear()
})

describe('MacBridgeThreadCards', () => {
  it('Allow sends the remember choice, Deny never remembers', async () => {
    requests = [req('r1')]
    render(<MacBridgeThreadCards environmentId="env_box" sessionId="s1" />)
    expect(screen.getByText('box wants to run on this Mac')).toBeTruthy()
    expect(screen.getByText('bun test')).toBeTruthy()
    expect(screen.getByText('in /Users/me/app')).toBeTruthy()
    fireEvent.click(screen.getByText('Allow'))
    await flush()
    expect(decided).toEqual([['r1', true, 'exact']])
    fireEvent.click(screen.getByText('Deny'))
    await flush()
    expect(decided.at(-1)).toEqual(['r1', false, false])
  })

  it('a folder read offers its remember as a checkbox', async () => {
    requests = [req('r2', { kind: 'read', method: 'mac.readFile', argv: undefined, path: '/Users/me/docs/a.md', folder: '/Users/me/docs' })]
    render(<MacBridgeThreadCards environmentId="env_box" sessionId="s1" />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByText('Allow'))
    await flush()
    expect(decided).toEqual([['r2', true, true]])
  })
})

describe('MacBridgeToasts', () => {
  it('raises one toast per host with its id, updates it as the queue moves, and dismisses it when answered', () => {
    requests = [req('r1'), req('r2', { createdAt: 2, argv: ['git', 'status'] })]
    const view = render(<MacBridgeToasts />)
    expect(toasts.toast).toHaveBeenCalledTimes(1)
    const [title, options] = toasts.toast.mock.calls[0]!
    expect(title).toBe('box wants to run on this Mac')
    expect(options).toMatchObject({ id: 'mac-bridge:env_box', duration: Infinity, action: { label: 'Allow' }, cancel: { label: 'Deny' } })

    // The first is answered: the same toast now carries the second.
    requests = [req('r2', { createdAt: 2, argv: ['git', 'status'] })]
    view.rerender(<MacBridgeToasts />)
    expect(toasts.toast).toHaveBeenCalledTimes(2)
    expect(toasts.toast.mock.calls[1]![1]).toMatchObject({ id: 'mac-bridge:env_box' })
    expect(toasts.toast.dismiss).not.toHaveBeenCalled()

    requests = []
    view.rerender(<MacBridgeToasts />)
    expect(toasts.toast.dismiss).toHaveBeenCalledWith('mac-bridge:env_box')
  })

  it('a running command raises no toast and no card: it is an Activity row and a Hosts page row', () => {
    requests = [req('a', { status: 'running' }), req('b', { status: 'running', argv: ['ls'] })]
    render(<MacBridgeToasts />)
    expect(toasts.toast).not.toHaveBeenCalled()
    const card = render(<MacBridgeThreadCards environmentId="env_box" sessionId="s1" />)
    expect(card.container.innerHTML).toBe('')
  })

  it('raises no toast for a request of the thread on screen', () => {
    onScreen = ['s1']
    requests = [req('r1')]
    render(<MacBridgeToasts />)
    expect(toasts.toast).not.toHaveBeenCalled()
  })
})
