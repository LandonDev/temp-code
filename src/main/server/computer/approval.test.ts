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
    const act = h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'screenshot' }, { action: 'key', text: 'a' }, { action: 'key', text: 'super+Return' }] })
    await until(() => h.cards.length === 1)
    expect(h.cards[0].req.title).toBe('2 actions in TextEdit: press a, press super+Return')
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
    expect(await act).toMatchObject({ isError: true, body: 'denied: the person did not allow it; do not reach the same effect another way' })
    expect(count(h, 'action.run')).toBe(0)
  })

  it('Away answers away', async () => {
    const h = make('safe')
    h.setAway(true)
    expect(await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })).toMatchObject({
      isError: true,
      body: 'denied: the person is away; finish around this act and name it in your report'
    })
  })

  it("Stop denies a waiting card through its signal", async () => {
    const h = make('safe')
    const act = h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    await until(() => h.cards.length === 1)
    await h.sessions.stop('t1')
    expect(await act).toMatchObject({ isError: true, body: 'stopped by the person; no more computer use this turn' })
    expect(h.cards[0].req.signal?.aborted).toBe(true)
    expect(count(h, 'action.run')).toBe(0)
  })
})

describe("the confirm flag and the host's own rules", () => {
  const send = { kind: 'send', what: 'Reply to Ana accepting Friday\'s lunch' }

  it('full access asks once for a flagged act, titled by its kind; Allow acts, Deny sends nothing', async () => {
    const h = make('auto')
    await h.run('computer_observe', { app: 'TextEdit' })
    const allowed = h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 37, confirm: send })
    await until(() => h.cards.length === 1)
    expect(h.cards[0].req.title).toBe('Send in TextEdit: Reply to Ana accepting Friday\'s lunch (click button "close")')
    expect(h.cards[0].req.input).toMatchObject({ confirm: { kind: 'send', label: 'Send', what: send.what } })
    expect(count(h, 'action.run')).toBe(0)
    h.cards[0].decide(true)
    expect((await allowed).isError).toBe(false)
    expect(count(h, 'action.run')).toBe(1)
    const denied = h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 37 }], confirm: send })
    await until(() => h.cards.length === 2)
    h.cards[1].decide(false)
    expect((await denied).body).toMatch(/^denied: the person did not allow it/)
    expect(count(h, 'action.batch')).toBe(0)
  })

  it('a flagged per-verb call raises the same one card', async () => {
    const h = make('auto')
    await h.run('computer_observe', { app: 'TextEdit' })
    const act = h.run('computer_left_click', { app: 'TextEdit', element: 37, confirm: { kind: 'delete', what: 'Delete the draft' } })
    await until(() => h.cards.length === 1)
    expect(h.cards[0].req.title).toBe('Delete in TextEdit: Delete the draft (click button "close")')
    h.cards[0].decide(true)
    expect((await act).isError).toBe(false)
    expect(h.cards).toHaveLength(1)
  })

  it('Away denies a flagged act in full access', async () => {
    const h = make('auto')
    await h.run('computer_observe', { app: 'TextEdit' })
    h.setAway(true)
    expect((await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 37, confirm: send })).body).toBe(
      'denied: the person is away; finish around this act and name it in your report'
    )
    expect(count(h, 'action.run')).toBe(0)
  })

  it('typing into a password field asks in full access, and the card never shows the text', async () => {
    const h = computerHarness({ env: { FAKE_PASSWORD: '1' } })
    harnesses.push(h)
    h.set('t1', { permission: 'auto' })
    await h.run('computer_observe', { app: 'TextEdit' })
    const act = h.run('computer_act', { app: 'TextEdit', action: 'type', text: 'hunter2' })
    await until(() => h.cards.length === 1)
    expect(h.cards[0].req.title).toBe('Type into a password field in TextEdit (type 7 characters)')
    expect(JSON.stringify(h.cards[0].req)).not.toContain('hunter2')
    h.cards[0].decide(true)
    expect((await act).isError).toBe(false)
    const flagged = h.run('computer_act', { app: 'TextEdit', action: 'type', text: 'hunter2', element: 3, confirm: { kind: 'sign_in', what: 'Sign in with hunter2' } })
    await until(() => h.cards.length === 2)
    expect(JSON.stringify(h.cards[1].req)).not.toContain('hunter2')
    h.cards[1].decide(false)
    await flagged
  })

  it('text with no element goes only to a window this thread read', async () => {
    const h = make('auto')
    await h.run('computer_observe', { app: 'TextEdit' })
    expect((await h.run('computer_act', { app: 'TextEdit', window: 'Notes', action: 'type', text: 'x' })).body).toBe(
      'read TextEdit\'s window "Notes" before typing into it'
    )
    expect(count(h, 'action.run')).toBe(0)
    expect((await h.run('computer_act', { app: 'TextEdit', window: 'Untitled', action: 'type', text: 'x' })).isError).toBe(false)
    expect(h.requests().filter((r) => r.method === 'action.run').at(-1)!.params.window).toEqual({ id: 1581 })
  })

  it('text into an app this thread has not read answers no_observation, nothing sent', async () => {
    const h = make('auto')
    expect((await h.run('computer_act', { app: 'TextEdit', action: 'type', text: 'hi' })).body).toBe("read TextEdit's window before typing into it")
    expect(h.requests().filter((r) => r.method !== 'initialize' && r.method !== 'permissions.get')).toHaveLength(0)
  })

  it('in a batch, a text step after another input names its element, refused before anything runs', async () => {
    const h = make('auto')
    await h.run('computer_observe', { app: 'TextEdit' })
    const o = await h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 21 }, { action: 'type', text: 'x' }] })
    expect(o.body).toBe("invalid arguments: in a batch, type and paste after another action name their element; see the tool's description")
    expect(count(h, 'action.batch')).toBe(0)
    expect((await h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'type', text: 'x' }, { action: 'key', text: 'Tab' }] })).isError).toBe(false)
  })

  it('every request carries the pinned pid, and TempCode itself is refused with no request', async () => {
    const h = make('auto')
    await h.run('computer_observe', { app: 'textedit' })
    expect(h.requests().find((r) => r.method === 'state.get')!.params.app).toEqual({ pid: 16800 })
    const before = h.requests().length
    expect((await h.run('computer_apps', { launch: 'TempCode' })).body).toBe("TempCode's own window is off limits to computer use")
    expect(h.requests().length).toBe(before)
  })
})

