// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ComputerSessionRow } from '@server/shared/contract-computer'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'

/**
 * A box thread's computer card waiting on its Mac: one toast per asking row,
 * titled with the card's question and naming the Mac, no buttons; none while
 * this window holds that card itself; gone when the row stops asking.
 */

const toasts = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: toasts.toast }))
vi.mock('../lib/connection/registry', () => ({ registry: { onLink: () => () => {} } }))

const { computerSessionsStore } = await import('../lib/computerSessions')
const { macBridgeStore } = await import('../lib/macBridge')
const { ComputerAskToasts } = await import('./ComputerAskToasts')

const row = (over: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({
  threadId: 't1',
  since: 1,
  lastCallAt: 1,
  apps: [{ name: 'TextEdit', bundleId: null, window: 'Untitled' }],
  running: { tool: 'computer_act', words: 'Waiting for approval on Studio', startedAt: 1 },
  tier: null,
  macPeer: 'env_mac',
  macName: 'Studio',
  asking: { line: 'Click button "Save" in TextEdit, window "Untitled"?' },
  ...over
})

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

afterEach(() => {
  cleanup()
  computerSessionsStore.setState({ byHost: {} })
  macBridgeStore.setState({ requests: {} })
  toasts.toast.mockClear()
  toasts.toast.dismiss.mockClear()
})

describe('ComputerAskToasts', () => {
  it('raises one toast naming the Mac for an asking row, and dismisses it when the row stops asking', async () => {
    computerSessionsStore.setState({ byHost: { env_box: [row(), row({ threadId: 't2', asking: undefined })] } })
    render(<ComputerAskToasts />)
    await flush()
    expect(toasts.toast).toHaveBeenCalledTimes(1)
    const [title, opts] = toasts.toast.mock.calls[0] as [string, { id: string; duration: number; description: { props: { children: string } }; action?: unknown; cancel?: unknown }]
    expect(title).toBe('Click button "Save" in TextEdit, window "Untitled"?')
    expect(opts.id).toBe('computer-ask:env_box:t1')
    expect(opts.duration).toBe(Infinity)
    expect(opts.description.props.children).toBe('Allow or deny it on Studio')
    expect(opts.action).toBeUndefined()
    expect(opts.cancel).toBeUndefined()
    act(() => computerSessionsStore.setState({ byHost: { env_box: [row({ asking: undefined })] } }))
    await flush()
    expect(toasts.toast.dismiss).toHaveBeenCalledWith('computer-ask:env_box:t1')
  })

  it('raises none while this window holds the Mac card for that thread', async () => {
    const card = { id: 'mb_1', environmentId: 'env_box', sessionId: 't1', kind: 'computer', status: 'pending' } as unknown as MacBridgeRequest
    macBridgeStore.setState({ requests: { mb_1: card } })
    computerSessionsStore.setState({ byHost: { env_box: [row()] } })
    render(<ComputerAskToasts />)
    await flush()
    expect(toasts.toast).not.toHaveBeenCalled()
  })

  it('a row of this host with no Mac named is no ask', async () => {
    computerSessionsStore.setState({ byHost: { env_box: [row({ macPeer: undefined })] } })
    render(<ComputerAskToasts />)
    await flush()
    expect(toasts.toast).not.toHaveBeenCalled()
  })
})
