import { afterEach, describe, expect, it } from 'vitest'
import { computerHarness, type ComputerHarness } from './runHarness'

const harnesses: ComputerHarness[] = []
const make = () => {
  const h = computerHarness()
  harnesses.push(h)
  return h
}
afterEach(async () => { for (const h of harnesses.splice(0)) await h.close() })
const last = (h: ComputerHarness, method: string) => h.requests().filter((r) => r.method === method).at(-1)!.params

describe('each thread’s observed focus and window', () => {
  it('keeps each app’s focus apart and binds a selected tab by its window id', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    await h.run('computer_observe', { app: 'Webby', window: 'Web report' })
    expect(h.sessions.previewTarget('t1')?.window).toEqual({ id: 171000, title: 'Web report - Webby' })
    await h.run('computer_act', { app: 'Webby', action: 'key', text: 'super+l' })
    await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'Tab' })
    expect(last(h, 'action.run')).toMatchObject({ expectFocus: 3, window: { id: 1581 } })
    await h.run('computer_act', { app: 'Webby', action: 'key', text: 'Tab', element: 3 })
    expect(last(h, 'action.run')).toMatchObject({ expectFocus: 9, window: { id: 171000 } })
    // Another thread has seen no focus in Webby.
    await h.run('computer_act', { app: 'Webby', action: 'key', text: 'Tab' }, 't2')
    expect(last(h, 'action.run').expectFocus).toBeUndefined()
  })
})
