import { afterEach, describe, expect, it } from 'vitest'
import { computerHarness, type ComputerHarness } from './runHarness'

const harnesses: ComputerHarness[] = []
const make = (permission: 'safe' | 'edits' | 'auto'): ComputerHarness => {
  const h = computerHarness()
  h.set('t1', { permission })
  harnesses.push(h)
  return h
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})
const until = async (pred: () => boolean): Promise<void> => {
  const end = Date.now() + 5_000
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const count = (h: ComputerHarness, method: string) => h.requests().filter((r) => r.method === method).length

describe('who asks', () => {
  it('full access never asks', async () => {
    const h = make('auto')
    await h.run('computer_observe', { app: 'TextEdit' })
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    expect(o.isError).toBe(false)
    expect(h.cards).toHaveLength(0)
  })

  for (const mode of ['safe', 'edits'] as const) {
    it(`${mode}: reads are free, every acting call asks once`, async () => {
      const h = make(mode)
      await h.run('computer_apps', {})
      await h.run('computer_observe', { app: 'TextEdit' })
      await h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'screenshot' }, { action: 'wait', duration: 1 }] })
      expect(h.cards).toHaveLength(0)
      const act = h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 21 }, { action: 'key', text: 'a' }] })
      await until(() => h.cards.length === 1)
      expect(count(h, 'action.batch')).toBe(1)
      h.cards[0].decide(true)
      expect((await act).isError).toBe(false)
      expect(h.cards).toHaveLength(1)
      expect(count(h, 'action.batch')).toBe(2)
    })
  }
})

describe('the card', () => {
  it('names the element from the book, the app and the bound window', async () => {
    const h = make('safe')
    await h.run('computer_observe', { app: 'TextEdit' })
    const act = h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 37 }, 't1', { callId: 'toolu_1' })
    await until(() => h.cards.length === 1)
    expect(h.cards[0].req).toMatchObject({
      toolName: 'mcp__app__computer_act',
      title: 'Click button "close" in TextEdit, window "Untitled"',
      callId: 'toolu_1',
      input: { app: 'TextEdit', window: 'Untitled', actions: ['click button "close"'] }
    })
    h.cards[0].decide(true)
    await act
  })

  it('a batch lists its acting steps alone; an unread app has neither book nor window', async () => {
    const h = make('edits')
    const act = h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'screenshot' }, { action: 'type', text: 'Lunch?' }, { action: 'key', text: 'super+Return' }] })
    await until(() => h.cards.length === 1)
    expect(h.cards[0].req.title).toBe('2 actions in TextEdit: type "Lunch?", press super+Return')
    h.cards[0].decide(true)
    await act
  })

  it("the model's window wins, and an element the book lacks reads as its index", async () => {
    const h = make('safe')
    await h.run('computer_observe', { app: 'TextEdit' })
    const act = h.run('computer_act', { app: 'TextEdit', window: 'Notes.rtf', action: 'left_click', element: 99 })
    await until(() => h.cards.length === 1)
    expect(h.cards[0].req.title).toBe('Click [99] in TextEdit, window "Notes.rtf"')
    h.cards[0].decide(false)
    await act
  })

  it('denied answers denied and sends nothing', async () => {
    const h = make('safe')
    const act = h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    await until(() => h.cards.length === 1)
    h.cards[0].decide(false)
    expect(await act).toMatchObject({ isError: true, body: 'denied: the person did not allow it' })
    expect(count(h, 'action.run')).toBe(0)
  })

  it('Away answers away', async () => {
    const h = make('safe')
    h.setAway(true)
    expect(await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })).toMatchObject({ isError: true, body: 'denied: the person is away' })
  })

  it("Stop denies a waiting card through its signal", async () => {
    const h = make('safe')
    const act = h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    await until(() => h.cards.length === 1)
    await h.sessions.stop('t1')
    expect(await act).toMatchObject({ isError: true, body: 'stopped by the person' })
    expect(h.cards[0].req.signal?.aborted).toBe(true)
    expect(count(h, 'action.run')).toBe(0)
  })
})
