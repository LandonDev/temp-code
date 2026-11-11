import { afterEach, describe, expect, it } from 'vitest'
import { computerHarness, type ComputerHarness } from './runHarness'
import { computerUsedSetting } from './sessions'

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

describe('the used marker (§27.11)', () => {
  it('a thread’s first computer call writes computer.used.<threadId>, once, and later calls leave it', async () => {
    const h = make()
    expect(h.sessions.used('t1')).toBe(false)
    // a refused call is a computer call too
    await h.run('computer_act', { app: 'TextEdit', action: 'mouse_move' })
    const at = h.rows.get(computerUsedSetting('t1'))
    expect(at).toMatch(/^\d+$/)
    await h.run('computer_observe', { app: 'TextEdit' })
    expect(h.rows.get(computerUsedSetting('t1'))).toBe(at)
    expect(h.sessions.used('t1')).toBe(true)
    expect(h.sessions.used('t2')).toBe(false)
    // an earlier run of the host wrote it: read from the settings table
    h.rows.set(computerUsedSetting('t3'), '1')
    expect(h.sessions.used('t3')).toBe(true)
  })
})
