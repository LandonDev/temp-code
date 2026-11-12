import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPUTER_WAIT, type Observation } from '@shared/computer/protocol'
import { tierVerdictSetting } from '@shared/computer/tools'
import { hostErrorLine } from '@shared/computer/hostErrors'
import { LOCAL_CARD_WORDS, READER_WAIT_WORDS, UNREAD_WORDS } from '@shared/computer/heldCalls'
import { PERMISSION_SWITCH, remember, waitedIn, type ThreadComputer } from './run'
import { CallTiming, parseTimingLine } from '@shared/computer/bridgeTiming'
import { ComputerHostError, ComputerRpcError } from './connection'
import { computerHarness, type ComputerHarness } from './runHarness'
import { IDLE_CLOSE_MS } from './sessions'
import { ManualClock, settle } from './testFake'
import type { SessionTierGate, TierGateContext } from './tierGate'
import { PersonIdle } from '../../personIdle'
import { staticPresence } from '../../presence'
import { SessionScheduler, type SessionSchedulerOptions } from './schedule'

const harnesses: ComputerHarness[] = []
const make = (opts: Parameters<typeof computerHarness>[0] = {}): ComputerHarness => {
  const h = computerHarness(opts)
  harnesses.push(h)
  return h
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})
const last = (h: ComputerHarness, method: string) => h.requests().filter((r) => r.method === method).at(-1)!
const count = (h: ComputerHarness, method: string) => h.requests().filter((r) => r.method === method).length
const until = async (pred: () => boolean, label: string): Promise<void> => {
  const end = Date.now() + 5_000
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('observe', () => {
  it("sends the observe wait, launch, and maps full, screenshot and menus", async () => {
    const h = make()
    const o = await h.run('computer_observe', { app: 'TextEdit', screenshot: true, menus: true })
    expect(o.isError).toBe(false)
    expect(last(h, 'state.get').params).toMatchObject({ session: 't1', app: { pid: 16800 }, launch: false, mode: 'auto', screenshot: 'always', menus: true, wait: COMPUTER_WAIT.observe })
    await h.run('computer_observe', { app: 'TextEdit', full: true, screenshot: false })
    expect(last(h, 'state.get').params).toMatchObject({ mode: 'full', screenshot: 'never', window: { id: 1581 } })
    await h.run('computer_observe', { app: 'TextEdit', window: 'Notes' })
    expect(last(h, 'state.get').params).toMatchObject({ window: { title: 'Notes' }, screenshot: 'auto' })
  })

  it('opens the session once per epoch', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    await h.run('computer_observe', { app: 'TextEdit' })
    expect(count(h, 'session.open')).toBe(1)
  })
})

describe('act', () => {
  it('fills the epoch and the bound window after an observe', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    const p = last(h, 'action.run').params
    expect(p.epoch).toBe(h.service.state().epoch)
    expect(p.window).toEqual({ id: 1581 })
    expect(p.tiers).toEqual(['ax', 'process'])
    expect(p.wait).toEqual(COMPUTER_WAIT.action)
    expect(o.steps[0]).toBe('left_click [21] checkbox "bold" · ax · changed')
  })

  it('an element of an unread app answers no_observation with no request', async () => {
    const h = make()
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 5 })
    expect(o).toMatchObject({ isError: true, body: '[5] comes from no read of TextEdit in this thread; read the window first' })
    expect(count(h, 'action.run')).toBe(0)
  })

  it('a per-verb name runs as computer_act', async () => {
    const h = make()
    const o = await h.run('computer_key', { app: 'TextEdit', text: 'Tab' })
    expect(last(h, 'action.run').params.action).toEqual({ action: 'key', text: 'Tab' })
    expect(o.steps[0]).toBe('key Tab · process · changed')
  })

  it('refuses arguments the schema refuses', async () => {
    const h = make()
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'mouse_move' })
    expect(o.isError).toBe(true)
    expect(o.body).toMatch(/^invalid arguments: element: mouse_move needs one of element, coordinate/)
    expect(count(h, 'action.run')).toBe(0)
  })

  it('resolveApp pins the target', async () => {
    const h = make({ resolveApp: (q) => (q === 'TextEdit' ? { pid: 16800 } : null) })
    await h.run('computer_observe', { app: 'TextEdit' })
    expect(last(h, 'state.get').params.app).toEqual({ pid: 16800 })
  })
})

describe('the result', () => {
  it('reads step lines, shot lines, a blank line, then the observation, in spec §9 order', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    const o = await h.run('computer_batch', { app: 'TextEdit', screenshot: true, actions: [{ action: 'left_click', element: 21 }, { action: 'screenshot' }] })
    const lines = h.text(o).split('\n')
    expect(lines[0]).toBe('left_click [21] checkbox "bold" · ax · changed')
    expect(lines[1]).toBe('screenshot')
    expect(lines[2]).toBe(`screenshot 1 (step 2): ${join(h.landingRoot, 't1', '0001.jpg')} (1280×1072)`)
    expect(lines[3]).toBe(`screenshot 2 (observation): ${join(h.landingRoot, 't1', '0002.jpg')} (1280×1072)`)
    expect(lines[4]).toBe('')
    expect(lines[5]).toMatch(/^app "TextEdit" · window "Untitled" · 1280×1072 .*changes since your last read$/)
    expect(o.shots.map((s) => [s.label, s.mimeType])).toEqual([
      ['step 2', 'image/jpeg'],
      ['observation', 'image/jpeg']
    ])
    expect(readdirSync(join(h.landingRoot, 't1'))).toEqual(['0001.jpg', '0002.jpg'])
  })

  it('the fifth picture is named but not attached', async () => {
    const h = make()
    const o = await h.run('computer_batch', { app: 'TextEdit', screenshot: false, actions: Array.from({ length: 5 }, () => ({ action: 'screenshot' })) })
    const shotLines = h.text(o).split('\n').filter((l) => l.startsWith('screenshot '))
    expect(shotLines).toHaveLength(5)
    expect(shotLines[3]).not.toMatch(/not attached/)
    expect(shotLines[4]).toMatch(/ \(not attached\)$/)
  })
})

describe('the queue', () => {
  it("runs one thread's calls in order and two threads at once", async () => {
    const h = make()
    const slow = h.run('computer_observe', { app: 'Slow' })
    let second = false
    const next = h.run('computer_observe', { app: 'TextEdit' }).then((o) => ((second = true), o))
    await h.run('computer_observe', { app: 'TextEdit' }, 't2')
    await settle()
    expect(second).toBe(false)
    h.sessions.cancel('t1', 'interrupt')
    expect((await slow).body).toBe('cancelled: the turn was stopped')
    expect((await next).isError).toBe(false)
    const name: Record<number, string> = { 16800: 'TextEdit', 16805: 'Slow' }
    const gets = h.requests().filter((r) => r.method === 'state.get').map((r) => `${r.params.session}:${name[(r.params.app as { pid: number }).pid]}`)
    expect(gets).toEqual(['t1:Slow', 't2:TextEdit', 't1:TextEdit'])
  })

  it('a call queued behind another reads the permission when its turn comes', async () => {
    const h = make()
    const slow = h.run('computer_observe', { app: 'Slow' })
    const act = h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    await settle()
    h.set('t1', { permission: 'safe' })
    h.sessions.cancel('t1', 'interrupt')
    await slow
    await until(() => h.cards.length === 1, 'the card')
    h.cards[0].decide(true)
    expect((await act).isError).toBe(false)
  })

  it('a call cancelled while it waits in the queue raises no card and sends nothing', async () => {
    const h = make()
    h.set('t1', { permission: 'safe' })
    const slow = h.run('computer_observe', { app: 'Slow' })
    const abort = new AbortController()
    const act = h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' }, 't1', { signal: abort.signal })
    await settle()
    abort.abort()
    h.sessions.cancel('t1', 'interrupt')
    await slow
    expect((await act).body).toBe('cancelled: the call was given up')
    expect(h.cards).toHaveLength(0)
    expect(count(h, 'action.run')).toBe(0)
  })
})

describe('tiers', () => {
  it('KeyWin retries type at ax, and a key goes to the gate, which refuses it', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'KeyWin' })
    const typed = await h.run('computer_act', { app: 'KeyWin', action: 'type', text: 'hi' })
    expect(typed.steps).toEqual(['type "hi" · ax-insert · changed'])
    const runs = h.requests().filter((r) => r.method === 'action.run')
    expect(runs.map((r) => r.params.tiers)).toEqual([['ax', 'process'], ['ax']])
    expect((runs[1].params.observe as { mode: string }).mode).toBe('full')
    const key = await h.run('computer_act', { app: 'KeyWin', action: 'key', text: 'a' })
    expect(key.steps[0]).toBe(
      'key a · failed: needs the session tier (the real pointer and keyboard), which is not available now: nothing schedules it yet'
    )
    expect(count(h, 'action.run')).toBe(3)
    expect(JSON.parse(h.rows.get(tierVerdictSetting('dev.fake.keywin'))!).needsKeyWindow).toBe(true)
  })

  it('Sessiony is refused no-scheduler, the later steps not run', async () => {
    const h = make()
    const o = await h.run('computer_batch', { app: 'Sessiony', actions: [{ action: 'hold_key', text: 'shift', duration: 1 }, { action: 'key', text: 'a' }] })
    expect(o.steps[0]).toMatch(/^hold_key shift for 1 s · failed: needs the session tier .*nothing schedules it yet$/)
    expect(o.steps[1]).toBe('Not executed: an earlier action in this batch failed.')
    expect(o.isError).toBe(false)
  })

  it('a gate that admits re-runs from the step with session allowed, and hears what ran', async () => {
    const ran: unknown[] = []
    const asked: number[] = []
    const gate: SessionTierGate = {
      admitted: () => false,
      request: async (c) => (asked.push(c.step), { admit: true }),
      ran: (_c: TierGateContext, change) => ran.push(change),
      run: (c, send) => send(c.tiers)
    }
    const h = make({ gate })
    const o = await h.run('computer_batch', { app: 'Sessiony', actions: [{ action: 'hold_key', text: 'shift', duration: 1 }, { action: 'key', text: 'a' }] })
    expect(asked).toEqual([0])
    expect(o.steps).toEqual(['hold_key shift for 1 s · session · changed', 'key a · process · changed'])
    expect(ran).toHaveLength(1)
    const batches = h.requests().filter((r) => r.method === 'action.batch').map((r) => [r.params.tiers, (r.params.observe as { mode: string }).mode])
    expect(batches).toEqual([
      [['ax', 'process'], 'auto'],
      [['ax', 'process', 'session'], 'none'],
      [['ax', 'process'], 'full']
    ])
  })

  it('a key-window retry of a key that the gate admits leaves ax and process out (§24.2: the menu route refuses it too)', async () => {
    const gate: SessionTierGate = { admitted: () => false, request: async () => ({ admit: true }), run: (c, send) => send(c.tiers) }
    const h = make({ gate })
    const o = await h.run('computer_act', { app: 'KeyWin', action: 'key', text: 'a' })
    // front first (§26, decision 10): it makes the window key; KeyWin still wants the session tier
    expect(h.requests().filter((r) => r.method === 'action.run').map((r) => r.params.tiers)).toEqual([['ax', 'process'], ['front'], ['session']])
    expect(o.steps).toEqual(['key a · session · changed'])
  })

  it("the gate hears the call's own root and card when the caller names them, else the host's root and card", async () => {
    const seen: TierGateContext[] = []
    const gate: SessionTierGate = {
      admitted: () => false,
      request: async (c) => (seen.push(c), { admit: false, reason: 'skipped', message: 'no' }),
      run: (c, send) => send(c.tiers)
    }
    const h = make({ gate })
    let asked = 0
    const approve = async (): Promise<boolean> => (asked++, true)
    const batch = { app: 'Sessiony', actions: [{ action: 'hold_key', text: 'shift', duration: 1 }] }
    await h.sessions.run({ threadId: 'env_abcdefghijklmnopqrstuv:t9', rootId: 'env_abcdefghijklmnopqrstuv:root', approve }, 'computer_batch', batch)
    await h.run('computer_batch', batch, 't2')
    expect(seen.map((c) => c.rootId)).toEqual(['env_abcdefghijklmnopqrstuv:root', 't2'])
    // the caller's card path, behind the row's held line while it waits
    expect(await seen[0].approve!({ toolName: 'x', input: {}, title: 'x' })).toBe(true)
    expect(asked).toBe(1)
    // the host's own threads ask through the registry: the gate always gets a card path (tier scheduling plan §9)
    expect(typeof seen[1].approve).toBe('function')
  })

  it("a close button's click runs at ax under a session click verdict, as every plain click does (§22.3, §24.1)", async () => {
    const asked: number[] = []
    const gate: SessionTierGate = {
      admitted: () => false,
      request: async (c) => (asked.push(c.step), { admit: false, reason: 'skipped', message: 'no' }),
      run: (c, send) => send(c.tiers)
    }
    const h = make({ gate })
    h.rows.set(tierVerdictSetting('dev.fake.closey'), JSON.stringify({ bundleId: 'dev.fake.closey', classes: { click: 'session' }, misses: {}, updatedAt: Date.now() }))
    await h.run('computer_observe', { app: 'Closey' })
    const close = await h.run('computer_act', { app: 'Closey', action: 'left_click', element: 37 })
    expect(asked).toEqual([])
    expect(last(h, 'action.run').params.tiers).toEqual(['ax'])
    expect(close.steps[0]).toBe('left_click [37] button "close" · ax · changed')
  })

  it("a closed window's observation binds the next window, and window_not_found forgets the bound one (§22.6)", async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Closey' })
    expect(last(h, 'state.get').params.window).toBeUndefined()
    const first = await h.run('computer_act', { app: 'Closey', action: 'left_click', element: 37 })
    expect(last(h, 'action.run').params.window).toEqual({ id: 169000 })
    expect(h.text(first)).toMatch(/^app "Closey" · window "Closey Plain"/m)
    const second = await h.run('computer_act', { app: 'Closey', action: 'left_click', element: 37 })
    expect(last(h, 'action.run').params.window).toEqual({ id: 169001 })
    expect(h.text(second)).toContain('Closey has no window open.')
    await h.run('computer_observe', { app: 'Closey' })
    expect(last(h, 'state.get').params.window).toBeUndefined()
  })

  it('Stubborn raises its click verdict to session through a gate that admits', async () => {
    const gate: SessionTierGate = { admitted: () => true, request: async () => ({ admit: true }), run: (c, send) => send(c.tiers) }
    const h = make({ gate })
    await h.run('computer_observe', { app: 'Stubborn' })
    await h.run('computer_act', { app: 'Stubborn', action: 'left_click', coordinate: [5, 5] })
    const verdict = JSON.parse(h.rows.get(tierVerdictSetting('dev.fake.stubborn'))!)
    expect(verdict.classes.click).toBe('session')
    expect(verdict.name).toBe('Stubborn')
    expect(last(h, 'action.run').params.tiers).toEqual(['ax', 'session'])
  })

  it('probes an app once, before its first process step, never for an ax-only call', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    await h.run('computer_act', { app: 'TextEdit', action: 'set_value', element: 3, value: 'x' })
    expect(count(h, 'input.probe')).toBe(0)
    await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'b' })
    const methods = h.requests().map((r) => r.method)
    expect(methods.filter((m) => m === 'input.probe')).toHaveLength(1)
    expect(methods.indexOf('input.probe')).toBeLessThan(methods.lastIndexOf('action.run'))
    expect(last(h, 'input.probe').params).toMatchObject({ app: { pid: 16800 }, window: { id: 1581 } })
    expect(JSON.parse(h.rows.get(tierVerdictSetting('com.apple.TextEdit'))!)).toMatchObject({ name: 'TextEdit', probedAt: expect.any(Number) })
  })
})

describe('background fallbacks (§24)', () => {
  const refusing = (asked: number[]): SessionTierGate => ({
    admitted: () => false,
    request: async (c) => (asked.push(c.step), { admit: false, reason: 'skipped', message: 'no' }),
    run: (c, send) => send(c.tiers)
  })
  const verdict = (h: ComputerHarness, bundleId: string, extra: Record<string, unknown> = {}): void => {
    h.rows.set(tierVerdictSetting(bundleId), JSON.stringify({ bundleId, classes: { click: 'session' }, misses: {}, updatedAt: Date.now(), ...extra }))
  }

  it('under a session click verdict a coordinate click runs at ax alone through the hit, the gate never asked', async () => {
    const asked: number[] = []
    const h = make({ gate: refusing(asked) })
    verdict(h, 'dev.fake.hitty')
    await h.run('computer_observe', { app: 'Hitty' })
    const o = await h.run('computer_act', { app: 'Hitty', action: 'left_click', coordinate: [5, 5] })
    expect(asked).toEqual([])
    expect(last(h, 'action.run').params).toMatchObject({ tiers: ['ax'], ignored: { skip: true } })
    expect(o.steps[0]).toBe('left_click 5,5 · hit button "Save" · no change seen')
  })

  it('a step with no ax route still goes to the gate first', async () => {
    const asked: number[] = []
    const h = make({ gate: refusing(asked) })
    verdict(h, 'dev.fake.hitty')
    await h.run('computer_observe', { app: 'Hitty' })
    const runs = count(h, 'action.run')
    const o = await h.run('computer_act', { app: 'Hitty', action: 'middle_click', coordinate: [5, 5] })
    expect(asked).toEqual([0])
    expect(count(h, 'action.run')).toBe(runs)
    expect(o.steps[0]).toMatch(/^middle_click 5,5 · failed: needs the session tier/)
  })

  it("a shortcut runs its menu item at ax; a disabled item asks the gate, whose refusal names it", async () => {
    const asked: number[] = []
    const h = make({ gate: refusing(asked) })
    await h.run('computer_observe', { app: 'Menuey' })
    const ping = await h.run('computer_act', { app: 'Menuey', action: 'key', text: 'super+shift+p' })
    expect(ping.steps[0]).toBe('key super+shift+p · menu Probe › Ping App · changed')
    const close = await h.run('computer_act', { app: 'Menuey', action: 'key', text: 'super+w' })
    expect(asked).toEqual([0])
    expect(close.steps[0]).toBe(
      'key super+w · failed: File › Close is disabled while Menuey is in the background; needs the session tier (the real pointer and keyboard), which is not available now: the person did not choose Run now'
    )
  })

  it('after two hits that changed nothing the app is sent its ignored route, which runs after the process click', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Hitty' })
    for (let i = 0; i < 2; i++) await h.run('computer_act', { app: 'Hitty', action: 'left_click', coordinate: [5, 5] })
    expect(last(h, 'action.run').params.ignored).toBeUndefined()
    expect(JSON.parse(h.rows.get(tierVerdictSetting('dev.fake.hitty'))!).viaMisses).toEqual({ hit: 2 })
    const third = await h.run('computer_act', { app: 'Hitty', action: 'left_click', coordinate: [5, 5] })
    expect(last(h, 'action.run').params.ignored).toEqual({ via: ['hit'] })
    expect(third.steps[0]).toBe('left_click 5,5 · process · changed')
  })

  it('an ignored hit under a saved session verdict is skipped at ax and reaches the gate', async () => {
    const asked: number[] = []
    const h = make({ gate: refusing(asked) })
    verdict(h, 'dev.fake.hitty', { viaMisses: { hit: 2 } })
    await h.run('computer_observe', { app: 'Hitty' })
    const o = await h.run('computer_act', { app: 'Hitty', action: 'left_click', coordinate: [5, 5] })
    expect(last(h, 'action.run').params).toMatchObject({ tiers: ['ax'], ignored: { via: ['hit'], skip: true } })
    expect(asked).toEqual([0])
    expect(o.steps[0]).toMatch(/^left_click 5,5 · failed: needs the session tier/)
  })

  it('a scroll under a session verdict moves the bar at ax', async () => {
    const asked: number[] = []
    const h = make({ gate: refusing(asked) })
    h.rows.set(tierVerdictSetting('dev.fake.hitty'), JSON.stringify({ bundleId: 'dev.fake.hitty', classes: { scroll: 'session' }, misses: {}, updatedAt: Date.now() }))
    await h.run('computer_observe', { app: 'Hitty' })
    const o = await h.run('computer_act', { app: 'Hitty', action: 'scroll', coordinate: [5, 5], scroll_direction: 'down', scroll_amount: 3 })
    expect(asked).toEqual([])
    expect(o.steps[0]).toMatch(/ · scroll-bar · changed$/)
  })
})

describe('the service going and coming', () => {
  it('a crash answers service_restarted, then the new epoch reopens and an old element is stale', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    const crashed = await h.run('computer_act', { app: 'Crashy', action: 'key', text: 'a' })
    expect(crashed).toMatchObject({ isError: true })
    expect(crashed.body).toMatch(/^the computer service restarted during this call/)
    const stale = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    expect(stale.isError).toBe(true)
    expect(stale.body).toBe('the computer service restarted, so every index is stale; read the window again')
    expect(count(h, 'session.open')).toBe(2)
    expect((await h.run('computer_observe', { app: 'TextEdit' })).isError).toBe(false)
  })

  it('a session the service forgot opens again and the call runs once more', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    await h.service.request('session.close', { session: 't1' })
    const o = await h.run('computer_observe', { app: 'TextEdit' })
    expect(o.isError).toBe(false)
    expect(count(h, 'session.open')).toBe(2)
  })

  it('a missing Accessibility grant asks the system once per install and says where the switch is', async () => {
    const h = make()
    const first = await h.run('computer_observe', { app: 'NoAX' })
    expect(first.body).toBe('TempCode lacks the Accessibility permission; the person turns it on under System Settings → Privacy & Security → Accessibility')
    await h.run('computer_observe', { app: 'NoAX' })
    await settle()
    expect(count(h, 'permissions.request')).toBe(1)
    expect(h.rows.get('computer.prompted.accessibility')).toBeTruthy()
  })

  it('a screenshot step without Screen Recording and an observation shotError ask once and keep what ran', async () => {
    const h = make()
    const obs = await h.run('computer_observe', { app: 'NoShot', screenshot: true })
    expect(obs.isError).toBe(false)
    expect(obs.steps).toEqual([`Screen Recording is off: ${PERMISSION_SWITCH.screenRecording}`])
    expect(obs.body).toMatch(/^app "NoShot"/)
    const shot = await h.run('computer_batch', { app: 'NoShot', actions: [{ action: 'screenshot' }] })
    expect(shot.steps[0]).toBe(
      'screenshot · failed: TempCode lacks the Screen Recording permission; the person turns it on under System Settings → Privacy & Security → Screen & System Audio Recording'
    )
    await settle()
    expect(count(h, 'permissions.request')).toBe(1)
  })
})

describe('pause and Stop', () => {
  it('a paused thread is refused, and a pause cancels the call in flight', async () => {
    const h = make()
    h.set('t1', { status: 'paused' })
    expect((await h.run('computer_observe', { app: 'TextEdit' })).body).toBe('refused: the thread is paused')
    expect(count(h, 'state.get')).toBe(0)
    h.set('t1', { status: 'running' })
    const slow = h.run('computer_act', { app: 'Slow', action: 'key', text: 'a' })
    await until(() => count(h, 'action.run') === 1, 'the action')
    h.set('t1', { status: 'paused' })
    const o = await slow
    expect(o.steps[0]).toBe('key a · failed: cancelled before it finished')
    expect(o.body).toBe('cancelled: the thread was paused')
  })

  it('Stop answers the steps so far and stopped, refuses the rest of the turn, and the next turn runs', async () => {
    const h = make()
    const slow = h.run('computer_batch', { app: 'Slow', actions: [{ action: 'key', text: 'a' }, { action: 'key', text: 'b' }] })
    await until(() => count(h, 'action.batch') === 1, 'the batch')
    expect(h.sessions.rows().map((r) => r.threadId)).toEqual(['t1'])
    expect(await h.sessions.stop('t1')).toBe(true)
    const o = await slow
    expect(o.steps).toEqual(['key a · failed: cancelled before it finished', 'Not executed: an earlier action in this batch failed.'])
    expect(o).toMatchObject({ body: 'stopped by the person; no more computer use this turn', isError: true })
    expect(count(h, 'session.close')).toBe(1)
    expect((await h.run('computer_observe', { app: 'TextEdit' })).body).toBe('stopped by the person; no more computer use this turn')
    h.set('t1', { status: 'watching' })
    h.set('t1', { status: 'running' })
    expect((await h.run('computer_observe', { app: 'TextEdit' })).isError).toBe(false)
  })
})

describe('a call given up late', () => {
  it('a read stopped after the service answered says stopped, and the next read is full', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    const abort = new AbortController()
    const request = h.service.request.bind(h.service)
    h.service.request = (async (method: string, params: never, opts?: object) => {
      const answer = await request(method as never, params, opts)
      if (method === 'state.get') abort.abort()
      return answer
    }) as typeof h.service.request
    const o = await h.run('computer_observe', { app: 'TextEdit' }, 't1', { signal: abort.signal })
    expect(o).toMatchObject({ isError: true, body: 'cancelled: the call was given up' })
    h.service.request = request
    await h.run('computer_observe', { app: 'TextEdit' })
    expect(last(h, 'state.get').params.mode).toBe('full')
  })

  it("the thread's end refuses the calls still queued, and they send nothing", async () => {
    const h = make()
    const slow = h.run('computer_observe', { app: 'Slow' })
    const queued = h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    await until(() => count(h, 'state.get') === 1, 'the slow read')
    await h.sessions.end(['t1'])
    expect((await slow).body).toBe('cancelled: the thread ended')
    expect((await queued).body).toBe('cancelled: the thread ended')
    expect(count(h, 'action.run')).toBe(0)
  })
})

describe('turns another host drives', () => {
  it('rowOf reads one live session; beginTurn clears a Stop; settleTurn ends the row', async () => {
    const h = make()
    const key = 'env_abcdefghijklmnopqrstuv:t9'
    expect(h.sessions.rowOf(key)).toBeNull()
    await h.run('computer_observe', { app: 'TextEdit' }, key)
    expect(h.sessions.rowOf(key)).toMatchObject({ threadId: key, apps: [{ name: 'TextEdit' }], running: null })
    await h.sessions.stop(key)
    expect((await h.run('computer_observe', { app: 'TextEdit' }, key)).body).toBe('stopped by the person; no more computer use this turn')
    h.sessions.beginTurn(key)
    expect((await h.run('computer_observe', { app: 'TextEdit' }, key)).isError).toBe(false)
    expect(h.sessions.rows().map((r) => r.threadId)).toEqual([key])
    h.sessions.settleTurn(key)
    expect(h.sessions.rowOf(key)).toBeNull()
    expect(h.sessions.rows()).toEqual([])
  })
})

describe('closing', () => {
  it("the thread's end closes the session and removes the service's shots", async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit', screenshot: true })
    const shots = join(h.dataDir, 'shots', 't1')
    expect(existsSync(shots)).toBe(true)
    await h.sessions.end(['t1'])
    expect(count(h, 'session.close')).toBe(1)
    expect(existsSync(shots)).toBe(false)
  })

  it('closes after ten idle minutes; the next shot lands under a new name', async () => {
    const clock = new ManualClock()
    const h = make({ clock })
    await h.run('computer_observe', { app: 'TextEdit', screenshot: true })
    await clock.advance(IDLE_CLOSE_MS)
    await until(() => count(h, 'session.close') === 1 && !existsSync(join(h.dataDir, 'shots', 't1')), 'the idle close and its prune')
    const o = await h.run('computer_observe', { app: 'TextEdit', screenshot: true })
    expect(o.shots[0].path).toBe(join(h.landingRoot, 't1', '0002.jpg'))
    expect(count(h, 'session.open')).toBe(2)
    expect(last(h, 'state.get').params.window).toBeUndefined()
  })
})

describe('needsFull', () => {
  const t = (): ThreadComputer => ({
    threadId: 't',
    serviceSession: 't',
    openedIn: null,
    apps: new Map(),
    aliases: new Map(),
    used: [],
    queue: Promise.resolve(),
    live: null,
    stopped: false,
    inflight: null,
    idleTimer: null,
    nextShot: null,
    ended: false,
    pendingFront: []
  })
  const obs = (kind: Observation['kind'], text: string): Observation =>
    ({
      epoch: 'e1',
      session: 't',
      app: { pid: 1, bundleId: 'b', name: 'App' },
      window: { id: 2, title: 'W', frame: { x: 0, y: 0, w: 1, h: 1 } },
      kind,
      seq: 1,
      text,
      space: { width: 1, height: 1, scale: 1 },
      stats: { elements: 1, lines: 1, bytes: 1, omitted: 0, thin: false, partial: false, readMs: 1 }
    }) as Observation
  it('survives a subtree read and clears only on a full one the model got', () => {
    const th = t()
    remember(th, 'App', obs('full', 'app "App" · window "W" · 1×1\n[1] window "W"'))
    th.apps.get('b')!.needsFull = true
    remember(th, 'App', obs('subtree', 'app "App" · window "W" · 1×1\n[1] window "W"'))
    expect(th.apps.get('b')!.needsFull).toBe(true)
    remember(th, 'App', obs('full', 'app "App" · window "W" · 1×1\n[1] window "W"'))
    expect(th.apps.get('b')!.needsFull).toBe(false)
  })
})

/**
 * The tier scheduler as the server wires it, over the fake service: a real
 * PersonIdle over a raw idle the test moves (`away` puts the person's last
 * input five minutes back, `present` keeps it now), shortened numbers.
 */
function scheduled(
  env: Record<string, string> = {},
  numbers: Partial<SessionSchedulerOptions> = { pollMs: 50, recentCopyMs: 1_600, pasteWaitMaxMs: 4_000, clipboardPollMs: 50 },
  more: Parameters<typeof make>[0] = {}
) {
  let rawLast = Date.now() - 300_000
  let present = false
  const raw = { getSystemIdleTime: () => (present ? 0 : Math.floor((Date.now() - rawLast) / 1000)) }
  const idle = new PersonIdle(raw)
  const lines: (string | null)[] = []
  let sched!: SessionScheduler
  const h = make({
    env,
    ...more,
    makeGate: ({ service, sessions }) =>
      (sched = new SessionScheduler({
        service,
        idle,
        presence: staticPresence({ screen: 'unlocked', power: 'awake' }),
        awayOn: () => false,
        getSetting: () => null,
        held: (t, l) => {
          lines.push(l)
          sessions.setHeld(t, l)
        },
        threadOf: (s) => sessions.threadOfServiceSession(s),
        log: () => undefined,
        ...numbers
      }))
  })
  return {
    h,
    idle,
    raw,
    lines,
    sched: () => sched,
    setPresent: (on: boolean) => (present = on),
    /** the raw idle source sees input now */
    key: () => (rawLast = Date.now())
  }
}

describe('tier scheduling', () => {
  it.each(['computer_act', 'computer_batch'] as const)('sends person-only idle on consecutive session calls through %s (S15)', async (tool) => {
    const s = scheduled({ FAKE_CLOSING_WAIT_MS: '500' })
    const action = { action: 'hold_key', text: 'shift', duration: 1 }
    const args = { app: 'Sessiony', ...(tool === 'computer_act' ? action : { actions: [action] }) }
    const method = tool === 'computer_act' ? 'action.run' : 'action.batch'
    const first = s.h.run(tool, args)
    await until(() => count(s.h, method) === 2, 'the first session step')
    s.key() // the service's own input, with no human input between the calls
    await first
    expect(s.raw.getSystemIdleTime()).toBeLessThanOrEqual(1)
    expect(s.idle.getSystemIdleTime()).toBeGreaterThan(5)
    await s.h.run(tool, args)
    const calls = s.h.requests().filter((r) => r.method === method)
    const sessionCalls = calls.filter((r) => (r.params.tiers as string[]).includes('session'))
    expect(sessionCalls).toHaveLength(2)
    for (const r of sessionCalls) {
      expect(r.params.personIdleMs).toBeGreaterThan(5_000)
      expect(r.params.pasteQuietMs).toBe(1_600)
    }
    for (const r of calls.filter((r) => !(r.params.tiers as string[]).includes('session'))) expect(r.params.personIdleMs).toBeUndefined()
  })

  it('holds a session step while the person is present, says so on the row, and runs it once they go, its wait before its line, then restores', async () => {
    const s = scheduled()
    s.setPresent(true)
    const call = s.h.run('computer_act', { app: 'Sessiony', action: 'hold_key', text: 'shift', duration: 1 })
    await until(() => s.lines.includes('Waiting for the Mac to be free'), 'the held line')
    expect(s.h.sessions.rows()[0].running?.words).toBe('Waiting for the Mac to be free')
    expect(s.h.sessions.rows()[0].running?.held).toBe(true)
    await new Promise((r) => setTimeout(r, 1_100))
    s.setPresent(false)
    const o = await call
    expect(o.steps[0]).toMatch(/^waited 1s for the Mac to be free\nhold_key shift for 1 s · session · changed$/)
    expect(s.lines.at(-1)).toBeNull()
    const methods = s.h.requests().map((r) => r.method)
    expect(methods.lastIndexOf('input.restoreSession')).toBeGreaterThan(methods.lastIndexOf('action.run'))
    expect(last(s.h, 'input.restoreSession').params).toEqual({})
  })

  it("restores after the person's touch before the step's reply", async () => {
    const s = scheduled({ FAKE_CLOSING_WAIT_MS: '1500' })
    let done = false
    const call = s.h.run('computer_act', { app: 'Touchy', action: 'key', text: 'a' }).then((o) => ((done = true), o))
    await until(() => count(s.h, 'input.restoreSession') === 1, 'the restore')
    expect(done).toBe(false)
    expect(last(s.h, 'input.restoreSession').params).toEqual({ afterInterrupt: true })
    const o = await call
    expect(o.steps[0]).toMatch(/^key a · failed: the person used the Mac, so this step stopped/)
    expect(count(s.h, 'input.restoreSession')).toBe(1)
  })

  it("takes the step's own input out of the idle time, and keeps the person's key after it", async () => {
    const s = scheduled({ FAKE_CLOSING_WAIT_MS: '1500' })
    const own = s.h.run('computer_act', { app: 'Sessiony', action: 'hold_key', text: 'shift', duration: 1 })
    await until(() => count(s.h, 'action.run') === 2, 'the session step')
    await new Promise((r) => setTimeout(r, 200))
    s.key() // the step's own key, inside its span
    expect(s.idle.getSystemIdleTime()).toBeGreaterThanOrEqual(299)
    await own
    expect(s.idle.getSystemIdleTime()).toBeGreaterThanOrEqual(129)
    const person = s.h.run('computer_act', { app: 'Sessiony', action: 'hold_key', text: 'shift', duration: 1 })
    await until(() => count(s.h, 'action.run') === 4, 'the second session step')
    await new Promise((r) => setTimeout(r, 1_200))
    s.key() // the person, during the closing wait
    await person
    expect(s.idle.getSystemIdleTime()).toBeLessThanOrEqual(1)
  })

  it('a pause while held answers cancelled: the thread was paused and sends no session action; Stop answers stopped', async () => {
    const s = scheduled()
    s.setPresent(true)
    const paused = s.h.run('computer_act', { app: 'Sessiony', action: 'hold_key', text: 'shift', duration: 1 })
    await until(() => s.lines.includes('Waiting for the Mac to be free'), 'the held line')
    s.h.set('t1', { status: 'paused' })
    const o = await paused
    expect(o).toMatchObject({ body: 'cancelled: the thread was paused', isError: true })
    expect(o.steps[0]).toBe('hold_key shift for 1 s · failed: cancelled: the thread was paused')
    expect(count(s.h, 'action.run')).toBe(1)
    s.h.set('t1', { status: 'running' })
    const stopped = s.h.run('computer_act', { app: 'Sessiony', action: 'hold_key', text: 'shift', duration: 1 })
    await until(() => s.lines.filter((l) => l !== null).length === 2, 'held again')
    await s.h.sessions.stop('t1')
    expect((await stopped).body).toBe(hostErrorLine('stopped'))
    expect(count(s.h, 'action.run')).toBe(2)
  })

  it('Stop during a session step restores the Mac', async () => {
    const s = scheduled({ FAKE_CLOSING_WAIT_MS: '10000' })
    const call = s.h.run('computer_act', { app: 'Sessiony', action: 'hold_key', text: 'shift', duration: 1 })
    await until(() => count(s.h, 'action.run') === 2, 'the session step')
    expect(last(s.h, 'action.run').params.tiers).toContain('session')
    await s.h.sessions.stop('t1')
    expect((await call).body).toBe(hostErrorLine('stopped'))
    expect(count(s.h, 'input.restoreSession')).toBe(1)
  })

  it('sends pasteQuietMs with every acting call; the default gate sends none', async () => {
    const s = scheduled({}, {})
    await s.h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    expect(last(s.h, 'action.run').params.pasteQuietMs).toBe(5_000)
    const plain = make()
    await plain.run('computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    expect(last(plain, 'action.run').params.pasteQuietMs).toBeUndefined()
  })

  it("a paste the service held off for the person's copy waits for a quiet clipboard and runs again from the paste alone", async () => {
    const s = scheduled({ FAKE_CLIPBOARD_COPY_AT_MS: '0' })
    await s.h.run('computer_observe', { app: 'TextEdit' })
    const o = await s.h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', coordinate: [5, 5] }, { action: 'paste', text: 'from the thread', element: 3 }] })
    const batches = s.h.requests().filter((r) => r.method === 'action.batch')
    expect(batches.map((b) => (b.params.actions as { action: string }[]).map((a) => a.action))).toEqual([['left_click', 'paste'], ['paste']])
    expect(count(s.h, 'clipboard.state')).toBeGreaterThan(0)
    expect(s.lines).toContain('Waiting for the clipboard')
    expect(o.steps[0]).toBe('left_click 5,5 · process · changed')
    expect(o.steps[1]).toMatch(/^waited [12]s for the clipboard, the person had just copied\npaste .* · changed$/)
  })

  it('a person who keeps copying ends the paste with clipboard_recent', async () => {
    const s = scheduled({ FAKE_CLIPBOARD_COPY_EVERY_MS: '100' }, { pollMs: 50, recentCopyMs: 400, pasteWaitMaxMs: 1_000, clipboardPollMs: 50 })
    await s.h.run('computer_observe', { app: 'TextEdit' })
    const o = await s.h.run('computer_act', { app: 'TextEdit', action: 'paste', text: 'x', element: 3 })
    expect(o.steps[0]).toMatch(/· failed: the person copied something just now and a paste would swap their clipboard; try again in a minute$/)
    expect(count(s.h, 'action.run')).toBeGreaterThanOrEqual(1)
  })
})

describe('launch and open without taking the screen (§23)', () => {
  const refuseList = ['dev.landon.tempcode', 'com.apple.SecurityAgent', 'com.apple.LocalAuthentication.UIAgent']

  for (const mode of ['safe', 'edits'] as const) {
    it(`${mode}: an open asks one card naming the item and the app; a bare launch asks none`, async () => {
      const h = make()
      h.set('t1', { permission: mode })
      await h.run('computer_apps', { launch: 'Preview' })
      expect(h.cards).toHaveLength(0)
      const o = h.run('computer_apps', { launch: 'Preview', open: ['/tmp/report.pdf'] }, 't1', { callId: 'toolu_9' })
      await until(() => h.cards.length === 1, 'the card')
      expect(h.cards[0].req).toMatchObject({
        toolName: 'mcp__app__computer_apps',
        title: 'Open report.pdf in Preview',
        callId: 'toolu_9',
        input: { app: 'Preview', window: null, actions: ['open report.pdf'], open: ['/tmp/report.pdf'] }
      })
      expect(count(h, 'apps.launch')).toBe(1)
      h.cards[0].decide(true)
      expect((await o).body).toContain('Opened report.pdf in window "report.pdf"')
      expect(last(h, 'apps.launch').params).toEqual({ app: 'Preview', open: ['/tmp/report.pdf'], session: 't1', refuse: refuseList })
    })
  }

  it('full access opens with no card; a flagged open asks there too, and a denial sends nothing', async () => {
    const h = make()
    await h.run('computer_apps', { launch: 'Preview', open: ['/tmp/a.pdf'] })
    expect(h.cards).toHaveLength(0)
    expect(count(h, 'apps.launch')).toBe(1)
    const confirm = { kind: 'personal_data', what: 'Opens the form with the person\'s address filled in' }
    const o = h.run('computer_apps', { launch: 'Preview', open: ['https://forms.test/a'], confirm })
    await until(() => h.cards.length === 1, 'the flagged card')
    expect(h.cards[0].req.title).toBe(`Share personal data in Preview: ${confirm.what} (open forms.test/a)`)
    h.cards[0].decide(false)
    expect((await o).isError).toBe(true)
    expect(count(h, 'apps.launch')).toBe(1)
  })

  it('refuses another scheme before the card or the service', async () => {
    const h = make()
    h.set('t1', { permission: 'safe' })
    const o = await h.run('computer_apps', { launch: 'Preview', open: ['ftp://files.test/a.pdf'] })
    expect(o).toMatchObject({ isError: true, body: 'only http, https and file items open; give a web page, a file or a folder' })
    expect(h.cards).toHaveLength(0)
    expect(count(h, 'apps.launch')).toBe(0)
  })

  it("words the service's refusals: a program, a missing file, an app no call may touch", async () => {
    const h = make()
    expect((await h.run('computer_apps', { launch: 'Preview', open: ['/Users/me/deploy.command'] })).body).toBe(
      'deploy.command is a program; open only opens documents, folders and web pages'
    )
    expect((await h.run('computer_apps', { launch: 'Preview', open: ['/missing/a.pdf'] })).body).toBe('no file at "/missing/a.pdf" on the Mac; check the path')
    const refused = make({ env: { FAKE_LAUNCH_REFUSE_APP: '1' } })
    expect((await refused.run('computer_apps', { launch: '/Applications/TempCode.app', open: ['/tmp/a.txt'] })).body).toBe(
      "TempCode's own window is off limits to computer use"
    )
  })

  it("says when a launch came forward and the person's app went back", async () => {
    const h = make({ env: { FAKE_LAUNCH_STEAL: '1', FAKE_LAUNCH_OTHERS: '1' } })
    const o = await h.run('computer_apps', { launch: 'Preview', open: ['/tmp/report.pdf'] })
    expect(o.body!.split('\n').slice(0, 4)).toEqual([
      'Launched Preview',
      'Opened report.pdf in window "report.pdf"',
      'Its other windows changed: "Untitled — iCloud"',
      'Preview came to the front; TextEdit was put back in 120 ms'
    ])
  })

  it('an implicit launch carries the session and the refused bundles, and its front line is a note', async () => {
    const h = make({ env: { FAKE_LAUNCH_STEAL: '1' } })
    const o = await h.run('computer_observe', { app: 'Preview' })
    expect(last(h, 'apps.launch').params).toEqual({ app: 'Preview', session: 't1', refuse: refuseList })
    expect(o.steps).toContain('Preview came to the front; TextEdit was put back in 120 ms')
  })

  it("closes an action call with the guard's line, and leaves it out of a perform raise", async () => {
    const h = make({ env: { FAKE_ACT_STEAL: '1' } })
    await h.run('computer_observe', { app: 'TextEdit' })
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    expect(o.steps.at(-1)).toBe("TextEdit came to the front; the person's app was put back in 60 ms")
    const raised = await h.run('computer_act', { app: 'TextEdit', action: 'perform', element: 21, name: 'raise' })
    expect(raised.steps.some((l) => l.includes('came to the front'))).toBe(false)
  })

  it("tells a late steal once, in the next result of the thread whose session armed the watch", async () => {
    const h = make({ env: { FAKE_LATE_STEAL_MS: '20' } })
    await h.run('computer_apps', { launch: 'Preview' }, 't1')
    await h.run('computer_observe', { app: 'TextEdit' }, 't2')
    await new Promise((r) => setTimeout(r, 120))
    const other = await h.run('computer_observe', { app: 'TextEdit' }, 't2')
    expect(other.steps.some((l) => l.includes('after the call'))).toBe(false)
    const next = await h.run('computer_observe', { app: 'TextEdit' }, 't1')
    expect(next.steps).toContain('Preview came to the front 12 s after the call; TextEdit was put back in 90 ms')
    const again = await h.run('computer_observe', { app: 'TextEdit' }, 't1')
    expect(again.steps.some((l) => l.includes('after the call'))).toBe(false)
  })
})

describe('a reader (pending.ts): nothing runs unread', () => {
  /** A reader the test opens and shuts; it counts the requests that waited on it. */
  function reader(present = false) {
    let on = present
    const waiters = new Set<() => void>()
    const r = {
      gated: 0,
      present: () => on,
      whenPresent: (signal: AbortSignal) =>
        on || signal.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiters.add(resolve)
              signal.addEventListener('abort', () => resolve(), { once: true })
            }),
      request: async <T,>(signal: AbortSignal, send: () => Promise<T>): Promise<T> => {
        r.gated++
        while (!on) {
          if (signal.aborted) throw new Error('cancelled')
          await r.whenPresent(signal)
        }
        return await send()
      },
      open: () => {
        on = true
        for (const w of [...waiters]) w()
        waiters.clear()
      }
    }
    return r
  }

  it('every service request waits for a reader, reads included, the row saying so; Claude pays nothing', async () => {
    const h = make()
    const r = reader()
    const read = h.sessions.run({ threadId: 't1', reader: r }, 'computer_observe', { app: 'TextEdit' })
    await until(() => h.sessions.rowOf('t1')?.running?.words === READER_WAIT_WORDS, 'the row to wait for the thread')
    expect(h.sessions.rowOf('t1')?.running?.held).toBe(true)
    expect(count(h, 'state.get')).toBe(0)
    r.open()
    expect((await read).isError).toBe(false)
    expect(count(h, 'state.get')).toBe(1)
    expect(r.gated).toBeGreaterThanOrEqual(2)
    // with no reader in the context (a Claude call) nothing waits
    expect((await h.run('computer_observe', { app: 'TextEdit' })).isError).toBe(false)
  })

  it('a card is a hold the row says; the act after it waits for a reader', async () => {
    const h = make()
    h.set('t1', { permission: 'safe' })
    await h.run('computer_observe', { app: 'TextEdit' })
    const r = reader()
    const act = h.sessions.run({ threadId: 't1', reader: r }, 'computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    await until(() => h.cards.length === 1, 'the card')
    expect(h.sessions.rowOf('t1')?.running).toMatchObject({ words: LOCAL_CARD_WORDS, held: true })
    h.cards[0].decide(true)
    await until(() => h.sessions.rowOf('t1')?.running?.words === READER_WAIT_WORDS, 'the act to wait for the thread')
    expect(count(h, 'action.run')).toBe(0)
    r.open()
    expect((await act).steps[0]).toMatch(/^key a · /)
    expect(count(h, 'action.run')).toBe(1)
  })

  it('a call cancelled while it waits for a reader answers the unread line and sends nothing', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    const own = new AbortController()
    const act = h.sessions.run({ threadId: 't1', reader: reader(), signal: own.signal }, 'computer_act', { app: 'TextEdit', action: 'key', text: 'a' })
    await until(() => h.sessions.rowOf('t1')?.running?.words === READER_WAIT_WORDS, 'the wait')
    own.abort('unread')
    expect(await act).toMatchObject({ isError: true, body: hostErrorLine('cancelled', UNREAD_WORDS) })
    expect(count(h, 'action.run')).toBe(0)
  })
})

describe('steps that need the app active (§26)', () => {
  const frontGate = (asked: { step: number; needed?: string }[], frontAdmitted: boolean, admits = true): SessionTierGate => ({
    admitted: () => false,
    frontAdmitted: () => frontAdmitted,
    request: async (c) => (
      asked.push({ step: c.step, ...(c.needed ? { needed: c.needed } : {}) }),
      admits && c.needed === 'front' ? { admit: true } : { admit: false, reason: 'skipped', message: 'no' }
    ),
    run: (c, send) => send(c.tiers)
  })

  it('brings the app forward for a command it runs only in front, and names the disk', async () => {
    const h = make({ gate: frontGate([], true) })
    await h.run('computer_observe', { app: 'Fronty' })
    const o = await h.run('computer_act', { app: 'Fronty', action: 'key', text: 'super+s' })
    expect(last(h, 'action.run').params.tiers).toEqual(['ax', 'process', 'front'])
    expect(o.steps[0]).toBe('key super+s · front menu File › Save · changed · on disk: saved ~/run/Total.txt')
  })

  it('under wait-until-away a step that needs front asks the gate for front, and runs once admitted', async () => {
    const asked: { step: number; needed?: string }[] = []
    const h = make({ gate: frontGate(asked, false) })
    await h.run('computer_observe', { app: 'Fronty' })
    const o = await h.run('computer_act', { app: 'Fronty', action: 'key', text: 'super+s' })
    expect(asked).toEqual([{ step: 0, needed: 'front' }])
    expect(last(h, 'action.run').params.tiers).toEqual(['ax', 'process', 'front'])
    expect(o.steps[0]).toMatch(/^key super\+s · front menu File › Save · changed/)
  })

  it('a retry that fails whole is the step’s end in the journal, not the first try’s refusal', async () => {
    const h = make({ gate: frontGate([], false), history: { pictures: () => false } })
    await h.run('computer_observe', { app: 'Fronty' })
    // the first try says it needs the app in front; the gate admits that; the retry's request finds the window minimized
    const send = h.service.request.bind(h.service) as (...a: unknown[]) => Promise<unknown>
    let sent = 0
    h.service.request = ((method: string, ...rest: unknown[]) =>
      method === 'action.run' && ++sent === 2
        ? Promise.reject(new ComputerRpcError(-32000, 'gone', { kind: 'window_minimized', message: 'gone' }))
        : send(method, ...rest)) as typeof h.service.request
    expect((await h.run('computer_act', { app: 'Fronty', action: 'key', text: 'super+s' })).isError).toBe(true)
    expect(sent).toBe(2)
    await h.sessions.drained('t1')
    const call = (await h.history!.read(['t1']))[0].calls.at(-1)!
    expect(call.steps.map((s) => [s.verb, s.state, s.reason])).toEqual([['Press', 'failed', 'The window was minimized']])
  })

  it('a refused front step says the app must come forward and that the person chose to wait', async () => {
    const h = make({ gate: frontGate([], false, false) })
    await h.run('computer_observe', { app: 'Fronty' })
    const o = await h.run('computer_act', { app: 'Fronty', action: 'key', text: 'super+s' })
    expect(o.steps[0]).toBe(
      'key super+s · failed: File › Save is disabled while Fronty is in the background; needs Fronty in front for a moment, which the person set to wait until they are away: the person did not choose Run now'
    )
  })

  it('an older service hears no front: its tiers stay ax and process, and the session gate is asked', async () => {
    const asked: { step: number; needed?: string }[] = []
    const h = make({ gate: frontGate(asked, true), env: { FAKE_NO_FEATURES: '1' } })
    await h.run('computer_observe', { app: 'Fronty' })
    const o = await h.run('computer_act', { app: 'Fronty', action: 'key', text: 'super+s' })
    expect(h.requests().filter((r) => r.method === 'action.run').every((r) => !(r.params.tiers as string[]).includes('front'))).toBe(true)
    expect(asked).toEqual([{ step: 0 }])
    expect(o.steps[0]).toMatch(/needs the session tier/)
  })

  it('a rename on screen only says so with its hint, counts a miss, and the third goes straight to front', async () => {
    const h = make({ gate: frontGate([], false) })
    await h.run('computer_observe', { app: 'Committy' })
    for (let i = 0; i < 2; i++) {
      const o = await h.run('computer_act', { app: 'Committy', action: 'key', text: 'Return' })
      expect(o.steps[0]).toBe('key Return · process · on screen only, not on disk; commit it with key Return in the field')
    }
    expect(JSON.parse(h.rows.get(tierVerdictSetting('dev.fake.committy'))!).misses).toEqual({ key: 2 })
    const h2 = make({ gate: frontGate([], true) })
    h2.rows.set(tierVerdictSetting('dev.fake.committy'), h.rows.get(tierVerdictSetting('dev.fake.committy'))!)
    await h2.run('computer_observe', { app: 'Committy' })
    const o = await h2.run('computer_act', { app: 'Committy', action: 'key', text: 'Return' })
    expect(last(h2, 'action.run').params.tiers).toEqual(['ax', 'front'])
    expect(o.steps[0]).toBe('key Return · front · changed · on disk: renamed ~/run/a.txt to ~/run/b.txt')
    expect(JSON.parse(h2.rows.get(tierVerdictSetting('dev.fake.committy'))!).classes.key).toBe('front')
  })

  it('save_as names the panel and the file, and an existing file asks for replace', async () => {
    const h = make({ gate: frontGate([], true) })
    await h.run('computer_observe', { app: 'Panely' })
    const saved = await h.run('computer_act', { app: 'Panely', action: 'save_as', path: '~/run/note.rtf' })
    expect(saved.steps[0]).toBe('save_as ~/run/note.rtf · panel · changed · on disk: saved ~/run/note.rtf')
    const exists = await h.run('computer_act', { app: 'Panely', action: 'save_as', path: '~/run/exists.txt' })
    expect(exists.steps[0]).toBe('save_as ~/run/exists.txt · failed: "~/run/exists.txt" exists; pass replace to overwrite it, or pick another name')
  })

  it('names a menu the call could not close', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Menuy' })
    const o = await h.run('computer_act', { app: 'Menuy', action: 'perform', element: 4, name: 'show menu' })
    expect(o.steps).toContain('menu left open: Action')
  })
})

describe('web content (§25)', () => {
  it('a read refuses an active tab switch with its error line and no card or gate', async () => {
    let asked = 0
    const gate: SessionTierGate = { admitted: () => false, request: async () => (asked++, { admit: true }), run: (c, send) => send(c.tiers) }
    const h = make({ gate, env: { FAKE_WEB_ACTIVE: '1' } })
    h.set('t1', { permission: 'safe' })
    const o = await h.run('computer_observe', { app: 'Webby', window: 'Web report' })
    expect(o).toMatchObject({ isError: true, body: "the person has Webby's window in front on another tab, so a read won't switch it; switch tabs with an act, which waits for the Mac to be free" })
    expect(last(h, 'state.get').params.tabs).toBe('background')
    expect(h.cards).toHaveLength(0)
    expect(asked).toBe(0)
    // A screenshot-only call is a read too.
    expect((await h.run('computer_act', { app: 'Webby', window: 'Web report', action: 'screenshot' })).isError).toBe(true)
    expect(asked).toBe(0)
  })

  it('an act takes tab_in_use through the tier gate and reruns under its hold with tabs any', async () => {
    const asked: unknown[] = []
    const holds: unknown[] = []
    const gate: SessionTierGate = {
      admitted: () => false,
      request: async (c) => (asked.push(c), { admit: true }),
      run: (c, send) => (holds.push(c.tiers), send(c.tiers))
    }
    const h = make({ gate, env: { FAKE_WEB_ACTIVE: '1' } })
    await h.run('computer_apps', {})
    await h.run('computer_observe', { app: 'Webby' })
    const o = await h.run('computer_act', { app: 'Webby', window: 'Web report', action: 'key', text: 'Tab' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ app: { pid: 17100, name: 'Webby' }, window: { id: 171000 }, step: 0, words: 'select tab "Web report" and press Tab' })
    expect(holds).toEqual([['ax', 'process'], ['ax', 'process', 'session']])
    const calls = h.requests().filter((r) => r.method === 'action.run')
    expect(calls.map((r) => [r.params.tabs, r.params.expectFocus])).toEqual([['background', 3], ['any', 3]])
    expect(o.steps[0]).toBe('Selected tab "Web report" in window "Web report - Webby"')
    expect(o.body).toContain('still loading')
    expect((await h.run('computer_observe', { app: 'Webby' })).body).not.toContain('still loading')
    expect(last(h, 'state.get').params.window).toEqual({ id: 171000 })
  })

  it('a refused tab switch answers the gate’s own line', async () => {
    const gate: SessionTierGate = { admitted: () => false, request: async () => ({ admit: false, reason: 'skipped', message: 'the gate refused this tab switch' }), run: (c, send) => send(c.tiers) }
    const h = make({ gate, env: { FAKE_WEB_ACTIVE: '1' } })
    expect(await h.run('computer_act', { app: 'Webby', window: 'Web report', action: 'key', text: 'Tab' })).toMatchObject({ isError: true, body: 'the gate refused this tab switch' })
    expect(count(h, 'action.run')).toBe(1)
  })

  it('the journal says a refused tab switch as what it was: Skip is the person’s own no, a locked screen is a locked screen', async () => {
    for (const [reason, state, words] of [['skipped', 'stopped', 'Run now was not chosen'], ['screen-locked', 'failed', 'The screen was locked'], ['asleep', 'failed', 'The Mac was asleep']] as const) {
      const gate: SessionTierGate = { admitted: () => false, request: async () => ({ admit: false, reason, message: 'the gate refused this tab switch' }), run: (c, send) => send(c.tiers) }
      const h = make({ gate, env: { FAKE_WEB_ACTIVE: '1' }, history: { pictures: () => false } })
      // the tool's answer is as it was
      expect(await h.run('computer_act', { app: 'Webby', window: 'Web report', action: 'key', text: 'Tab' })).toMatchObject({ isError: true, body: 'the gate refused this tab switch' })
      await h.sessions.drained('t1')
      const call = (await h.history!.read(['t1']))[0].calls.at(-1)!
      expect(call.steps.map((s) => [s.verb, s.state, s.reason]), reason).toEqual([['Press', state, words]])
    }
  })

  it('a lost gate admission never sends tabs any', async () => {
    const gate: SessionTierGate = { admitted: () => false, request: async () => ({ admit: true }), run: (c, send) => send(c.tiers.filter((tier) => tier !== 'session')) }
    const h = make({ gate, env: { FAKE_WEB_ACTIVE: '1' } })
    expect((await h.run('computer_act', { app: 'Webby', window: 'Web report', action: 'key', text: 'Tab' })).isError).toBe(true)
    expect(h.requests().filter((r) => r.method === 'action.run').map((r) => r.params.tabs)).toEqual(['background', 'background'])
  })

  it('the call’s card names a known tab and its window; an unknown title keeps the window wording', async () => {
    const h = make()
    await h.run('computer_apps', {})
    h.set('t1', { permission: 'safe' })
    const o = h.run('computer_batch', { app: 'Webby', window: 'Web report', actions: [{ action: 'key', text: 'Tab' }, { action: 'key', text: 'Return' }] })
    await until(() => h.cards.length === 1, 'the tab card')
    expect(h.cards[0].req.title).toBe('Select tab "Web report" and 2 actions in Webby, window "Web front - Webby": press Tab, press Return')
    expect(h.cards[0].req.input).toMatchObject({ window: 'Web front - Webby', actions: ['select tab "Web report"', 'press Tab', 'press Return'] })
    h.cards[0].decide(true)
    expect((await o).isError).toBe(false)
    const next = h.run('computer_act', { app: 'Webby', window: 'Unknown tab', action: 'key', text: 'Tab' })
    await until(() => h.cards.length === 2, 'the unknown window card')
    expect(h.cards[1].req.title).toBe('Press Tab in Webby, window "Unknown tab"')
    h.cards[1].decide(false)
    await next
  })

  it('expectFocus is on the first split segment alone and gone on a retry after a completed step', async () => {
    const gate: SessionTierGate = { admitted: () => false, request: async () => ({ admit: true }), run: (c, send) => send(c.tiers) }
    const h = make({ gate })
    await h.run('computer_observe', { app: 'Sessiony' })
    await h.run('computer_batch', { app: 'Sessiony', actions: [{ action: 'key', text: 'Tab' }, { action: 'hold_key', text: 'shift', duration: 1 }, { action: 'key', text: 'Return' }] })
    const calls = h.requests().filter((r) => r.method === 'action.batch')
    expect(calls.map((r) => r.params.expectFocus)).toEqual([3, undefined, undefined])
    expect(calls.map((r) => r.params.epoch)).toEqual([h.service.state().epoch, h.service.state().epoch, h.service.state().epoch])
  })

  it('expectFocus is kept on a retry when no step ran, with the epoch of the model’s read', async () => {
    const gate: SessionTierGate = { admitted: () => false, request: async () => ({ admit: true }), run: (c, send) => send(c.tiers) }
    const h = make({ gate })
    await h.run('computer_observe', { app: 'Sessiony' })
    await h.run('computer_batch', { app: 'Sessiony', actions: [{ action: 'hold_key', text: 'shift', duration: 1 }, { action: 'key', text: 'Return' }] })
    expect(h.requests().filter((r) => r.method === 'action.batch').map((r) => r.params.expectFocus)).toEqual([3, 3, undefined])
  })

  it('an unnamed key’s focus expectation is stale after a service restart', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    const epoch = h.service.state().epoch
    await h.run('computer_act', { app: 'Crashy', action: 'key', text: 'a' })
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'Tab' })
    expect(last(h, 'action.run').params).toMatchObject({ epoch, expectFocus: 3 })
    expect(o).toMatchObject({ isError: true, body: 'the computer service restarted, so every index is stale; read the window again' })
    await h.run('computer_observe', { app: 'TextEdit' })
    expect((await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'Tab' })).isError).toBe(false)
  })

  it('passes page not drawn through, picks a pop up, stops on read-back failure and words a moved focus', async () => {
    const h = make({ env: { FAKE_WEB_NOT_DRAWN: '1', FAKE_WEB_FOCUS_MOVED: '1' } })
    expect((await h.run('computer_observe', { app: 'Webby' })).body).toContain(' · page not drawn')
    const pick = await h.run('computer_act', { app: 'Webby', action: 'set_value', element: 19, value: 'Team' })
    expect(pick.steps[0]).toContain(' · pick Team · changed')
    expect(pick.body).toContain('pop up "Plan" = "Team"')
    const blocked = await h.run('computer_batch', { app: 'Webby', actions: [{ action: 'set_value', element: 4, value: 'New' }, { action: 'key', text: 'Return' }] })
    expect(blocked.steps[0]).toContain('[4] still reads "Original"; nothing after it ran')
    expect(blocked.steps[1]).toBe('Not executed: an earlier action in this batch failed.')
    const key = await h.run('computer_act', { app: 'Webby', action: 'key', text: 'Tab' })
    expect(key.steps[0]).toContain('the keys would go to [9] input "Address and search bar", not the page')
    const aimed = await h.run('computer_act', { app: 'Webby', action: 'key', text: 'Tab', element: 3 })
    expect(last(h, 'action.run').params.action).toMatchObject({ action: 'key', element: 3 })
    expect(aimed.steps[0]).not.toContain('failed')
  })
})

describe('the call timing (shared/computer/bridgeTiming.ts)', () => {
  /** every request the call sends moves the clock 10 ms, so the tally is exact */
  const timed = (): { h: ComputerHarness; sent: () => number } => {
    const clock = new ManualClock()
    const h = make({ clock })
    const request = h.service.request.bind(h.service)
    let sent = 0
    h.service.request = ((method: string, params: unknown, opts?: unknown) => {
      if (method !== 'permissions.request') {
        sent++
        clock.t += 10
      }
      return (request as (m: string, p: unknown, o?: unknown) => Promise<unknown>)(method, params, opts)
    }) as typeof h.service.request
    return { h, sent: () => sent }
  }

  it("sums each service request's round trip and the observation's wait", async () => {
    const { h, sent } = timed()
    const timing = new CallTiming()
    expect((await h.run('computer_observe', { app: 'TextEdit' }, 't1', { timing })).isError).toBe(false)
    expect(sent()).toBeGreaterThan(1)
    expect(timing.serviceMs).toBe(10 * sent())
    expect(timing.waitedMs).toBe(12)
  })

  it('counts the request a forgotten session made it send again', async () => {
    const { h, sent } = timed()
    await h.run('computer_observe', { app: 'TextEdit' })
    await h.service.request('session.close', { session: 't1' })
    const before = sent()
    const gets = count(h, 'state.get')
    const timing = new CallTiming()
    expect((await h.run('computer_observe', { app: 'TextEdit' }, 't1', { timing })).isError).toBe(false)
    // the refused state.get, session.open, the state.get again
    expect(count(h, 'state.get') - gets).toBe(2)
    expect(timing.serviceMs).toBe(10 * (sent() - before))
    expect(timing.serviceMs).toBeGreaterThanOrEqual(30)
  })

  it("sums the waits over a batch's observations", async () => {
    const { h } = timed()
    await h.run('computer_observe', { app: 'TextEdit' })
    const timing = new CallTiming()
    const o = await h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 21 }, { action: 'key', text: 'a' }] }, 't1', { timing })
    expect(o.isError).toBe(false)
    expect(timing.waitedMs).toBe(12 * (count(h, 'action.batch') + count(h, 'action.run')))
  })

  it('reads the wait of an observation and of an action or batch result, nothing else', () => {
    const wait = { waitedMs: 30, settled: true, busy: false, reason: 'quiet' }
    expect(waitedIn({ text: 'app', waited: wait })).toBe(30)
    expect(waitedIn({ step: {}, observation: { waited: wait } })).toBe(30)
    expect(waitedIn({ steps: [], waited: wait, observation: { waited: wait } })).toBe(30)
    expect(waitedIn({ apps: [] })).toBe(0)
    expect(waitedIn(null)).toBe(0)
  })

  it("traces a call of this host's own thread as one [computer] timing line, and a bridged call never", async () => {
    const clock = new ManualClock()
    const lines: string[] = []
    const h = make({ clock, trace: true, log: (l) => void lines.push(l) })
    const request = h.service.request.bind(h.service)
    h.service.request = ((method: string, params: unknown, opts?: unknown) => {
      clock.t += 10
      return (request as (m: string, p: unknown, o?: unknown) => Promise<unknown>)(method, params, opts)
    }) as typeof h.service.request
    await h.run('computer_observe', { app: 'TextEdit' })
    const timing = lines.filter((l) => l.includes(' timing '))
    expect(timing).toHaveLength(1)
    expect(timing[0]).toMatch(/^\[computer\] thread=t1 timing total=\d+ queue=0 run=\d+ tool=computer_observe service=\d+ waited=12$/)
    const fields = parseTimingLine(timing[0])!
    expect(fields.total).toBe(fields.service)
    // a bridged call (remote/macComputer.ts) brings its own tally and its line is the box's
    await h.run('computer_observe', { app: 'TextEdit' }, 't1', { timing: new CallTiming() })
    expect(lines.filter((l) => l.includes(' timing '))).toHaveLength(1)
  })

  it('a call without a tally sends the same requests', async () => {
    const h = make()
    expect((await h.run('computer_observe', { app: 'TextEdit' })).isError).toBe(false)
  })
})

describe('fewer calls (§27)', () => {
  const admitAll = (): SessionTierGate => ({ admitted: () => false, request: async () => ({ admit: true }), run: (c, send) => send(c.tiers) })
  const verdict = (h: ComputerHarness, bundleId: string, classes: Record<string, string>): void =>
    void h.rows.set(tierVerdictSetting(bundleId), JSON.stringify({ bundleId, classes, misses: {}, updatedAt: Date.now() }))
  const batches = (h: ComputerHarness) => h.requests().filter((r) => r.method === 'action.batch')
  const acting = (h: ComputerHarness) => h.requests().filter((r) => r.method === 'action.batch' || r.method === 'action.run')

  it('sends the ax wait rows with every acting request: axAction after a last segment, axStep after one that is not', async () => {
    const h = make({ gate: admitAll() })
    await h.run('computer_observe', { app: 'TextEdit' })
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    expect(last(h, 'action.run').params).toMatchObject({ axWait: COMPUTER_WAIT.axAction, axStepWait: COMPUTER_WAIT.axStep })
    await h.run('computer_batch', { app: 'Sessiony', actions: [{ action: 'hold_key', text: 'shift', duration: 1 }, { action: 'key', text: 'a' }] })
    const split = batches(h).map((r) => [(r.params.observe as { mode: string }).mode, r.params.axWait, r.params.axStepWait])
    expect(split.slice(1)).toEqual([
      ['none', COMPUTER_WAIT.axStep, COMPUTER_WAIT.axStep],
      ['full', COMPUTER_WAIT.axAction, COMPUTER_WAIT.axStep]
    ])
  })

  it('takes the A/B arm from TEMP_CODE_COMPUTER_WAIT_AX on an isolated instance alone', async () => {
    const row = { minMs: 100, quietMs: 200, maxMs: 900, busyMaxMs: 2_000 }
    const saved = { ax: process.env.TEMP_CODE_COMPUTER_WAIT_AX, data: process.env.TEMP_CODE_USER_DATA }
    process.env.TEMP_CODE_COMPUTER_WAIT_AX = JSON.stringify({ axAction: row })
    try {
      const h = make()
      await h.run('computer_observe', { app: 'TextEdit' })
      process.env.TEMP_CODE_USER_DATA = '/tmp/tc-isolated'
      await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
      expect(last(h, 'action.run').params).toMatchObject({ axWait: row, axStepWait: COMPUTER_WAIT.axStep })
      delete process.env.TEMP_CODE_USER_DATA
      await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
      expect(last(h, 'action.run').params.axWait).toEqual(COMPUTER_WAIT.axAction)
    } finally {
      for (const [k, v] of [['TEMP_CODE_COMPUTER_WAIT_AX', saved.ax], ['TEMP_CODE_USER_DATA', saved.data]] as const)
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
  })

  it('Menuful: a step that opens a menu returns its block; a later step picks from it by named, and the book learns the item', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Menuful' })
    const opened = await h.run('computer_act', { app: 'Menuful', action: 'left_click', element: 5 })
    expect(opened.body).toContain('+ menu opened by step 1: [50] menu "Sort"\n  [51] menu item "Name"\n  [52] menu item "Date"')
    const picked = await h.run('computer_batch', { app: 'Menuful', actions: [{ action: 'left_click', element: 5 }, { action: 'left_click', named: 'Date' }] })
    expect(picked.steps).toEqual(['left_click [5] menu button "Sort" · ax · changed', 'left_click "Date" [52] menu item · ax · changed'])
    expect(picked.body).not.toContain('menu opened')
    // the closing read no longer lists [52], and the card still names it
    h.set('t1', { permission: 'safe' })
    const again = h.run('computer_act', { app: 'Menuful', action: 'left_click', element: 52 })
    await until(() => h.cards.length === 1, 'the card')
    expect(h.cards[0].req.title).toContain('menu item "Date"')
    h.cards[0].decide(false)
    await again
  })

  it('Menuful: a name that matches several, or none, fails named_target with the candidates and is never retried', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Menuful' })
    const several = await h.run('computer_batch', { app: 'Menuful', actions: [{ action: 'left_click', named: 'Team' }, { action: 'key', text: 'Return' }] })
    expect(several.steps).toEqual([
      'left_click "Team" · failed: several elements are named "Team"; use element: [6] button "Team", [7] button "Team"',
      'Not executed: an earlier action in this batch failed.'
    ])
    const none = await h.run('computer_act', { app: 'Menuful', action: 'left_click', named: 'Nope' })
    expect(none.steps[0]).toBe('left_click "Nope" · failed: nothing named "Nope" in the window or what this call opened; read the window and use an element')
    expect(acting(h)).toHaveLength(2)
  })

  it('Newdoc: super+n opens a window, and every target of the call moves there and binds, a later segment included', async () => {
    const h = make()
    verdict(h, 'dev.fake.newdoc', { type: 'session' })
    await h.run('computer_observe', { app: 'Newdoc' })
    const o = await h.run('computer_batch', { app: 'Newdoc', actions: [{ action: 'key', text: 'super+n' }, { action: 'type', text: 'hello' }] })
    expect(o.steps[0]).toMatch(/ · opened window "Untitled 2"$/)
    expect(o.steps[1]).toBe('type "hello" · ax-insert · changed')
    const sent = batches(h)
    // the text was pinned to the window the thread read; after the step opened one, the next segment goes there
    expect(sent.map((r) => r.params.window)).toEqual([{ id: 168210 }, { id: 168211 }])
    expect(sent[1].params.prior).toEqual({ effect: 'changed', focusTo: 8, targeted: [], windows: [168211] })
    expect(o.body).toMatch(/^app "Newdoc" · window "Untitled 2"/)
    await h.run('computer_observe', { app: 'Newdoc' })
    expect(last(h, 'state.get').params.window).toEqual({ id: 168211 })
  })

  it('Newdoc: a followed window that closed falls back to the call’s own window, once', async () => {
    const h = make()
    verdict(h, 'dev.fake.newdoc', { type: 'session' })
    await h.run('computer_observe', { app: 'Newdoc' })
    const o = await h.run('computer_batch', {
      app: 'Newdoc',
      actions: [{ action: 'key', text: 'super+n' }, { action: 'key', text: 'super+w' }, { action: 'type', text: 'back' }]
    })
    expect(o.steps[2]).toBe('type "back" · ax-insert · changed')
    // the segment after went to the opened window, which was gone, then once more to the window the call began in
    expect(batches(h).map((r) => r.params.window)).toEqual([{ id: 168210 }, { id: 168211 }, { id: 168210 }])
    expect(o.body).toMatch(/^app "Newdoc" · window "Newdoc"/)
  })

  it('blind text into a named window when the thread has no window read (it closed) is refused before the card', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Closey' })
    await h.run('computer_act', { app: 'Closey', action: 'left_click', element: 37 })
    const gone = await h.run('computer_act', { app: 'Closey', action: 'left_click', element: 37 })
    expect(gone.body).toMatch(/^observation failed: /)
    const sent = acting(h).length
    const o = await h.run('computer_act', { app: 'Closey', window: 'Secret', action: 'type', text: 'x' })
    expect(o).toMatchObject({ isError: true, body: 'read Closey\'s window "Secret" before typing into it' })
    expect(acting(h)).toHaveLength(sent)
  })

  it('before any step sent input there is no prior, and the read’s focus rides on the segment of the first input step', async () => {
    const h = make({ gate: admitAll() })
    await h.run('computer_observe', { app: 'Sessiony' })
    await h.run('computer_batch', { app: 'Sessiony', actions: [{ action: 'screenshot' }, { action: 'hold_key', text: 'shift', duration: 1 }, { action: 'key', text: 'a' }] })
    const sent = batches(h)
    expect(sent.map((r) => r.params.expectFocus)).toEqual([3, 3, undefined])
    expect(sent.map((r) => r.params.prior === undefined)).toEqual([true, true, false])
    expect(sent[2].params.prior).toMatchObject({ effect: 'changed' })
  })

  it('Newdoc: a single act that opens a window binds it for the next call', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Newdoc' })
    expect((await h.run('computer_act', { app: 'Newdoc', action: 'key', text: 'super+n' })).steps[0]).toMatch(/opened window "Untitled 2"$/)
    await h.run('computer_act', { app: 'Newdoc', action: 'left_click', element: 4 })
    expect(last(h, 'action.run').params.window).toEqual({ id: 168211 })
  })

  it('Renamey: a window named by a title autosave replaced goes to the service as given, with the id the thread read (§27.6)', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Renamey' })
    const typed = await h.run('computer_act', { app: 'Renamey', action: 'type', text: 'a' })
    expect(typed.body).toMatch(/^app "Renamey" · window "Draft.txt"/)
    const again = await h.run('computer_act', { app: 'Renamey', window: 'Untitled', action: 'type', text: 'b' })
    expect(again.steps[0]).toBe('type "b" · ax-insert · changed')
    expect(last(h, 'action.run').params).toMatchObject({ window: { title: 'Untitled' }, textWindowId: 168220 })
    // text into a live window the thread never read is refused, now on the service's answer
    const other = await h.run('computer_act', { app: 'Renamey', window: 'Other', action: 'type', text: 'c' })
    expect(other.steps[0]).toBe('type "c" · failed: read Renamey\'s window "Other" before typing into it')
    expect(last(h, 'action.run').params).toMatchObject({ window: { title: 'Other' }, textWindowId: 168220 })
  })

  it('Blindy: keys after a click that changed nothing do not run, and the call ends with its closing read', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Blindy' })
    const o = await h.run('computer_batch', { app: 'Blindy', actions: [{ action: 'left_click', element: 5 }, { action: 'key', text: 'Return' }, { action: 'type', text: 'x' }] })
    const stopLine = 'Not executed: step 1 changed nothing, so these keys had no planned place.'
    expect(o.steps).toEqual(['left_click [5] button "Refresh" · ax · no change seen', stopLine, stopLine])
    expect(o.body).toMatch(/^app "Blindy"/)
    expect(acting(h)).toHaveLength(1)
  })

  it('Unplanned: text after a Tab that walked onto a field is refused and not retried; a click that names the field licenses it', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Unplanned' })
    const o = await h.run('computer_batch', { app: 'Unplanned', actions: [{ action: 'key', text: 'Tab' }, { action: 'type', text: 'x' }] })
    expect(o.steps[1]).toBe('type "x" · failed: [6] text field "Name" has the focus, which no step of this batch aimed at; name the element the text is for')
    expect(acting(h)).toHaveLength(1)
    const named = await h.run('computer_batch', { app: 'Unplanned', actions: [{ action: 'left_click', element: 6 }, { action: 'type', text: 'x' }] })
    expect(named.steps[1]).not.toContain('failed')
  })

  it('Unplanned in a browser: the address bar is the browser-field rule, which runs first', async () => {
    const h = make({ env: { FAKE_WEB_FOCUS_MOVED: '1' } })
    await h.run('computer_observe', { app: 'Webby' })
    const o = await h.run('computer_batch', { app: 'Webby', actions: [{ action: 'left_click', element: 3 }, { action: 'type', text: 'x' }] })
    expect(o.steps[1]).toContain('the keys would go to [9] input "Address and search bar", not the page')
  })

  for (const noObservation of [false, true])
    it(`Secret: a password field by name or by focus is refused secure; the resend by element asks the password card${noObservation ? ', the closing read failed' : ''}`, async () => {
      const h = make(noObservation ? { env: { FAKE_SECRET_NO_OBS: '1' } } : {})
      await h.run('computer_observe', { app: 'Secret' })
      const byName = await h.run('computer_act', { app: 'Secret', action: 'type', named: 'Password', text: 'hunter2' })
      expect(byName.steps[0]).toBe(
        'type "hunter2" into "Password" · failed: [12] password "Password" can only be typed into by its element, so the person can be asked; send the step again with element 12'
      )
      if (noObservation) expect(byName.body).toMatch(/^observation failed: /)
      else expect(byName.body).not.toContain('[12]')
      const byFocus = await h.run('computer_batch', { app: 'Secret', actions: [{ action: 'left_click', element: 12 }, { action: 'type', text: 'hunter2' }] })
      expect(byFocus.steps[1]).toMatch(/^type "hunter2" · failed: \[12\] password "Password" can only be typed into by its element/)
      expect(h.cards).toHaveLength(0)
      expect(acting(h)).toHaveLength(2)
      const resend = h.run('computer_act', { app: 'Secret', action: 'type', element: 12, text: 'hunter2' })
      await until(() => h.cards.length === 1, 'the password card')
      expect(h.cards[0].req.title).toBe('Type into a password field in Secret (type 7 characters into password "Password")')
      h.cards[0].decide(true)
      expect((await resend).steps[0]).not.toContain('failed')
    })

  describe('beside a front step (§26)', () => {
    /** front waits for the gate (the person chose wait-until-away), which admits it: the step runs again as its own front segment */
    const frontOnAsk = (asked: string[] = []): SessionTierGate => ({
      admitted: () => false,
      frontAdmitted: () => false,
      request: async (c) => (asked.push(c.needed ?? 'session'), c.needed === 'front' ? { admit: true } : { admit: false, reason: 'skipped', message: 'no' }),
      run: (c, send) => send(c.tiers)
    })
    const tiersSent = (h: ComputerHarness) => batches(h).map((r) => r.params.tiers)

    it('a window a front step opened on its retry takes the next segment, with the prior, and both carry the ax rows', async () => {
      const h = make({ gate: frontOnAsk() })
      await h.run('computer_observe', { app: 'Splitty' })
      const o = await h.run('computer_batch', { app: 'Splitty', actions: [{ action: 'key', text: 'super+o' }, { action: 'type', text: 'notes' }] })
      expect(o.steps).toEqual(['key super+o · front menu File › Open… · changed · opened window "Opened"', 'type "notes" · ax-insert · changed'])
      const sent = batches(h)
      expect(tiersSent(h)).toEqual([['ax', 'process'], ['ax', 'process', 'front'], ['ax', 'process']])
      expect(sent.map((r) => r.params.window)).toEqual([{ id: 168260 }, { id: 168260 }, { id: 168261 }])
      expect(sent[2].params.prior).toEqual({ effect: 'changed', focusTo: 8, targeted: [], windows: [168261] })
      // the service picks the ax rows only for steps that went in at ax, so a front segment gets them too
      for (const r of sent) expect(r.params).toMatchObject({ axWait: expect.any(Object), axStepWait: COMPUTER_WAIT.axStep })
      expect(o.body).toMatch(/^app "Splitty" · window "Opened"/)
    })

    it('a front step that changed nothing stops the blind keys after it at the boundary, and the host reads the window', async () => {
      const h = make({ gate: frontOnAsk() })
      await h.run('computer_observe', { app: 'Splitty' })
      const reads = count(h, 'state.get')
      const o = await h.run('computer_batch', { app: 'Splitty', actions: [{ action: 'key', text: 'super+s' }, { action: 'key', text: 'Return' }] })
      expect(o.steps).toEqual([
        'key super+s · front menu File › Save · no change seen',
        'Not executed: step 1 changed nothing, so these keys had no planned place.'
      ])
      expect(tiersSent(h)).toEqual([['ax', 'process'], ['ax', 'process', 'front']])
      expect(count(h, 'state.get')).toBe(reads + 1)
    })

    it('blind keys after a click that changed nothing never bring the app forward: no gate, no front request', async () => {
      const asked: string[] = []
      const h = make({ gate: frontOnAsk(asked) })
      await h.run('computer_observe', { app: 'Splitty' })
      const o = await h.run('computer_batch', { app: 'Splitty', actions: [{ action: 'left_click', element: 5 }, { action: 'key', text: 'super+s' }] })
      expect(o.steps[1]).toBe('Not executed: step 1 changed nothing, so these keys had no planned place.')
      expect(asked).toEqual([])
      expect(tiersSent(h)).toEqual([['ax', 'process']])
    })
  })

  describe('Splitty: one call across the segments the host splits it into (§27.7b)', () => {
    const split = (env: Record<string, string> = {}): ComputerHarness => {
      const h = make({ gate: admitAll(), env })
      verdict(h, 'dev.fake.splitty', { key: 'session', type: 'session' })
      return h
    }
    const stopLine = 'Not executed: step 1 changed nothing, so these keys had no planned place.'

    it('a click that changed nothing at the boundary stops the next segment before it goes out, and the host reads the window', async () => {
      const h = split()
      await h.run('computer_observe', { app: 'Splitty' })
      const reads = count(h, 'state.get')
      const o = await h.run('computer_batch', { app: 'Splitty', actions: [{ action: 'left_click', element: 5 }, { action: 'key', text: 'Return' }] })
      expect(o.steps).toEqual(['left_click [5] button "Refresh" · ax · no change seen', stopLine])
      expect(batches(h)).toHaveLength(1)
      expect(count(h, 'state.get')).toBe(reads + 1)
      expect(o.body).toMatch(/^app "Splitty"/)
    })

    it('a stop the service answers in an earlier segment ends the call: no later segment, the closing read', async () => {
      const h = make({ gate: admitAll() })
      verdict(h, 'dev.fake.splitty', { key: 'session' })
      await h.run('computer_observe', { app: 'Splitty' })
      const o = await h.run('computer_batch', { app: 'Splitty', actions: [{ action: 'left_click', element: 5 }, { action: 'type', text: 'x' }, { action: 'key', text: 'Return' }] })
      expect(o.steps.slice(1)).toEqual([stopLine, stopLine])
      expect(batches(h)).toHaveLength(1)
      expect(last(h, 'state.get').params.mode).toBe('auto')
    })

    /** the nth acting request of the harness is refused whole with `error`, as the service or the connection would */
    const failRequest = (h: ComputerHarness, nth: number, error: Error): void => {
      const send = h.service.request.bind(h.service) as (...a: unknown[]) => Promise<unknown>
      let sent = 0
      h.service.request = ((method: string, ...rest: unknown[]) =>
        (method === 'action.batch' || method === 'action.run') && ++sent === nth ? Promise.reject(error) : send(method, ...rest)) as typeof h.service.request
    }
    const minimized = (): Error => new ComputerRpcError(-32000, 'gone', { kind: 'window_minimized', message: 'gone' })
    const journal = async (h: ComputerHarness): Promise<(string | undefined)[][]> => {
      await h.sessions.drained('t1')
      return (await h.history!.read(['t1']))[0].calls.at(-1)!.steps.map((s) => [s.verb, s.state, s.reason])
    }
    const twoRequests = [{ action: 'left_click', named: 'Search' }, { action: 'type', text: 'hello' }]

    it('a later request that fails leaves the journal the steps the service already answered, as they ran', async () => {
      const h = make({ gate: admitAll(), history: { pictures: () => false } })
      verdict(h, 'dev.fake.splitty', { key: 'session', type: 'session' })
      await h.run('computer_observe', { app: 'Splitty' })
      // the click's request answers; the text is its own request, and the service refuses that one whole
      failRequest(h, 2, minimized())
      expect((await h.run('computer_batch', { app: 'Splitty', actions: twoRequests })).isError).toBe(true)
      expect(await journal(h)).toEqual([
        ['Clicked', 'ok', undefined],
        ['Type', 'failed', 'The window was minimized']
      ])
    })

    it('a service that goes during a later request ends the step that request held, with the host’s reason', async () => {
      const h = make({ gate: admitAll(), history: { pictures: () => false } })
      verdict(h, 'dev.fake.splitty', { key: 'session', type: 'session' })
      await h.run('computer_observe', { app: 'Splitty' })
      // no service error to word: the connection's own refusal is the call's end, on the first step with no answer
      failRequest(h, 2, new ComputerHostError('service_restarted'))
      expect((await h.run('computer_batch', { app: 'Splitty', actions: twoRequests })).isError).toBe(true)
      expect(await journal(h)).toEqual([
        ['Clicked', 'ok', undefined],
        ['Type', 'failed', 'The computer service restarted']
      ])
    })

    it('a step the gate refused up front keeps its place and its reason when a request before it fails', async () => {
      const gate: SessionTierGate = { admitted: () => false, request: async () => ({ admit: false, reason: 'skipped', message: 'no' }), run: (c, send) => send(c.tiers) }
      const h = make({ gate, history: { pictures: () => false } })
      verdict(h, 'dev.fake.splitty', { key: 'session', type: 'session' })
      await h.run('computer_observe', { app: 'Splitty' })
      // the key needs the session tier and the card says no before anything runs; the click answers; the text's request fails
      failRequest(h, 2, minimized())
      await h.run('computer_batch', { app: 'Splitty', actions: [...twoRequests, { action: 'key', text: 'Return' }] })
      expect(batches(h).map((r) => (r.params.actions as { action: string }[]).map((a) => a.action))).toEqual([['left_click']])
      expect(await journal(h)).toEqual([
        ['Clicked', 'ok', undefined],
        ['Type', 'failed', 'The window was minimized'],
        ['Press', 'stopped', 'Run now was not chosen']
      ])
    })

    it('a named click, then text in the next segment, runs: the prior names what it resolved and focused', async () => {
      const h = split()
      await h.run('computer_observe', { app: 'Splitty' })
      const o = await h.run('computer_batch', { app: 'Splitty', actions: [{ action: 'left_click', named: 'Search' }, { action: 'type', text: 'hello' }] })
      expect(o.steps).toEqual(['left_click "Search" [7] text field · ax · changed', 'type "hello" · ax-insert · changed'])
      expect(batches(h).map((r) => r.params.prior)).toEqual([undefined, { effect: 'changed', focusTo: 7, targeted: [7] }])
    })

    it('a Return that focused a rename field, then text in the next segment, runs', async () => {
      const h = split()
      await h.run('computer_observe', { app: 'Splitty' })
      const o = await h.run('computer_batch', { app: 'Splitty', actions: [{ action: 'key', text: 'Return' }, { action: 'type', text: 'New name' }] })
      expect(o.steps[1]).toBe('type "New name" · ax-insert · changed')
      expect(batches(h)[1].params.prior).toEqual({ effect: 'changed', focusTo: 8, targeted: [] })
    })

    it('the same with the focus moved to another field between the segments writes nothing, and is not retried', async () => {
      const h = split({ FAKE_FOCUS_DRIFT: '1' })
      await h.run('computer_observe', { app: 'Splitty' })
      const o = await h.run('computer_batch', { app: 'Splitty', actions: [{ action: 'key', text: 'Return' }, { action: 'type', text: 'New name' }] })
      expect(o.steps[1]).toBe('type "New name" · failed: [9] text field "Other" has the focus, which no step of this batch aimed at; name the element the text is for')
      expect(batches(h)).toHaveLength(2)
    })
  })
})

describe('the journal (history.ts): one start and one end per call', () => {
  /** every record of a thread's log, once everything queued is written */
  const records = async (h: ComputerHarness, key = 't1'): Promise<{ r: string; n: number; [k: string]: unknown }[]> => {
    const file = join(h.dataDir, 'history', key, 'log.jsonl')
    // the queue's tail takes the picture; a read then waits out the key's write chain
    await h.sessions.drained(key)
    await h.history!.read([key])
    return existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  }
  const calls = async (h: ComputerHarness, key = 't1') => {
    await h.sessions.drained(key)
    return (await h.history!.read([key]))[0].calls
  }
  const kinds = (rs: { r: string; n: number }[]): string[] => rs.filter((r) => r.r !== 'picture').map((r) => `${r.r} ${r.n}`)

  it('a read, an act, a batch and the apps call each write a start and an end, in order', async () => {
    const h = make({ history: { pictures: () => false } })
    await h.run('computer_apps', {})
    await h.run('computer_observe', { app: 'TextEdit' })
    await h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 21 }, { action: 'key', text: 'super+s' }] })
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 3 })
    expect(kinds(await records(h))).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3', 'start 4', 'end 4'])
    const got = await calls(h)
    expect(got.map((c) => [c.state, c.app, c.window, c.steps.map((s) => `${s.verb} ${s.object}`.trim())])).toEqual([
      ['done', '', null, ['Listed apps']],
      ['done', 'TextEdit', 'Untitled', ['Read']],
      ['done', 'TextEdit', 'Untitled', ['Clicked bold', 'Pressed ⌘S']],
      ['done', 'TextEdit', 'Untitled', ['Clicked a text area']]
    ])
    // the read's summary and text are kept
    expect(got[1]).toMatchObject({ read: 'Read 40 elements', text: true, turn: 1 })
    expect((await h.history!.step('t1', 2)).text).toContain('[21] checkbox "bold"')
    // a step's target was read from the book before the call's closing read moved it, its tier is the step's own
    expect(got[2].steps[0]).toMatchObject({ kind: 'click', state: 'ok', tier: 'ax', target: 'a checkbox in the "Formatting" group', element: 21, inApp: 'bold in TextEdit' })
    // while it ran, the batch's start held its plan in the card's words
    const starts = (await records(h)).filter((r) => r.r === 'start')
    expect(starts[2].plan).toEqual(['Click bold', 'Press ⌘S'])
    expect(starts[0].plan).toBeUndefined()
    expect(starts[3].plan).toBeUndefined()
    // no picture is asked with the switch off, and each call says so
    expect(count(h, 'capture.screenshot')).toBe(0)
    expect(got.map((c) => c.picture)).toEqual([{ none: 'no-read' }, { none: 'off' }, { none: 'off' }, { none: 'off' }])
  })

  it('without a journal nothing is written and every answer is what it was', async () => {
    const plain = make()
    const journaled = make({ history: { pictures: () => false } })
    for (const h of [plain, journaled]) {
      await h.run('computer_observe', { app: 'TextEdit' })
      await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    }
    expect(plain.history).toBeNull()
    expect(existsSync(join(plain.dataDir, 'history'))).toBe(false)
    // the same requests in the same order, each with the same params but for the process's own epoch and data dir
    const strip = (h: ComputerHarness) => h.requests().map((r) => ({ method: r.method, params: r.method === 'initialize' ? {} : { ...r.params, epoch: undefined } }))
    expect(strip(journaled)).toEqual(strip(plain))
  })

  it('a denied call keeps its text and says the kind; its record reads You didn’t allow it', async () => {
    const h = make({ history: { pictures: () => false } })
    h.set('t1', { permission: 'safe' })
    await h.run('computer_observe', { app: 'TextEdit' })
    const o = h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 21 }, { action: 'key', text: 'super+s' }] })
    await until(() => h.cards.length === 1, 'the card')
    h.cards[0].decide(false)
    const out = await o
    expect(out).toMatchObject({ isError: true, body: hostErrorLine('denied'), refused: 'denied' })
    expect(h.text(out)).toBe(hostErrorLine('denied'))
    const call = (await calls(h))[1]
    // the person's no is a stop, not a failure, and nothing reads as done
    expect(call.steps.map((s) => [s.verb, s.state, s.reason])).toEqual([['Click', 'stopped', "You didn't allow it"], ['Press', 'not-run', undefined]])
    expect(call.picture).toEqual({ none: 'no-read' })
  })

  it('each refusal before the call starts is journaled with its kind, the text unchanged', async () => {
    const h = make({ history: { pictures: () => false } })
    // paused
    h.set('t1', { status: 'paused' })
    const paused = await h.run('computer_observe', { app: 'TextEdit' })
    expect(paused).toMatchObject({ body: 'refused: the thread is paused', refused: 'paused' })
    h.set('t1', { status: 'running' })
    // an element of an app the thread has not read
    const unread = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    expect(unread).toMatchObject({ body: '[21] comes from no read of TextEdit in this thread; read the window first', refused: 'no_observation' })
    // TempCode itself
    const own = await h.run('computer_apps', { launch: 'TempCode' })
    expect(own).toMatchObject({ body: hostErrorLine('refused_app', 'tempcode'), refused: 'refused_app' })
    // a line with no kind of the host's
    const scheme = await h.run('computer_apps', { launch: 'Preview', open: ['ftp://files.test/a.pdf'] })
    expect(scheme.refused).toBeUndefined()
    // arguments the schema refuses are no call at all
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: -1 })
    expect((await calls(h)).map((c) => [c.steps[0].verb, c.steps[0].state, c.steps[0].reason])).toEqual([
      ['Read', 'stopped', 'The thread was paused'],
      ['Click', 'failed', 'The window had not been read'],
      ['Launch', 'failed', 'That app is off limits'],
      ['Open', 'failed', 'Only http, https and file items open']
    ])
    expect(count(h, 'state.get') + count(h, 'action.run') + count(h, 'apps.launch')).toBe(0)
  })

  it('a stopped call and the refusals after it are stopped; a failed step says why', async () => {
    const h = make({ history: { pictures: () => false } })
    const slow = h.run('computer_batch', { app: 'Slow', actions: [{ action: 'key', text: 'super+a' }, { action: 'key', text: 'super+b' }] })
    await until(() => count(h, 'action.batch') === 1, 'the batch')
    await h.sessions.stop('t1')
    expect((await slow).body).toBe('stopped by the person; no more computer use this turn')
    const refused = await h.run('computer_observe', { app: 'TextEdit' })
    expect(refused).toMatchObject({ body: 'stopped by the person; no more computer use this turn', refused: 'stopped' })
    const got = await calls(h)
    expect(got[0].steps.map((s) => [s.verb, s.state, s.reason])).toEqual([['Press', 'stopped', 'Stopped'], ['Press', 'not-run', undefined]])
    expect(got[1].steps.map((s) => [s.state, s.reason])).toEqual([['stopped', 'Stopped']])
    expect(got.map((c) => c.state)).toEqual(['done', 'done'])
    // a step the service fails keeps the service's kind
    h.set('t1', { status: 'watching' })
    h.set('t1', { status: 'running' })
    await h.run('computer_batch', { app: 'Sessiony', actions: [{ action: 'hold_key', text: 'shift', duration: 1 }, { action: 'key', text: 'super+s' }] })
    const failed = (await calls(h)).at(-1)!
    expect(failed.turn).toBe(2)
    expect(failed.steps.map((s) => [s.verb, s.state, s.reason])).toEqual([['Hold', 'failed', 'It needed your pointer and keyboard'], ['Press', 'not-run', undefined]])
  })

  it('a step stopped while it waits for the Mac is a stop in the journal, never the red with the hold’s own refusal', async () => {
    const s = scheduled({}, undefined, { history: { pictures: () => false } })
    s.setPresent(true)
    const held = s.h.run('computer_act', { app: 'Sessiony', action: 'hold_key', text: 'shift', duration: 1 })
    await until(() => s.lines.includes('Waiting for the Mac to be free'), 'the held line')
    // the person presses Stop while the step is still held at the gate
    await s.h.sessions.stop('t1')
    await held
    const call = (await calls(s.h)).at(-1)!
    expect(call.steps.map((x) => [x.verb, x.state, x.reason])).toEqual([['Hold', 'stopped', 'Stopped']])
  })

  it('only the model’s own cancel reads as the model’s: an abort with no reason of its own is a plain cancel', async () => {
    const h = make({ history: { pictures: () => false } })
    // a harness that gave the call up, or a dropped bridge, aborts with no reason
    const gaveUp = new AbortController()
    const slow = h.run('computer_act', { app: 'Slow', action: 'key', text: 'super+a' }, 't1', { signal: gaveUp.signal })
    await until(() => count(h, 'action.run') === 1, 'the action')
    gaveUp.abort()
    await slow
    // computer_result's cancel names itself
    const model = new AbortController()
    const again = h.run('computer_act', { app: 'Slow', action: 'key', text: 'super+b' }, 't1', { signal: model.signal })
    await until(() => count(h, 'action.run') === 2, 'the second action')
    model.abort('cancel')
    await again
    const got = await calls(h)
    expect(got.map((c) => [c.steps[0].state, c.steps[0].reason])).toEqual([['stopped', 'Cancelled'], ['stopped', 'The model cancelled it']])
  })

  it('a request the service refuses whole is the call’s failure', async () => {
    const h = make({ history: { pictures: () => false } })
    const o = await h.run('computer_observe', { app: 'TextEdit', window: 'No such window' })
    expect(o.isError).toBe(true)
    expect((await calls(h))[0].steps[0]).toMatchObject({ verb: 'Read', state: 'failed', reason: 'The window was gone' })
  })

  it('no text a password field could hold reaches the log or the text files', async () => {
    const h = make({ history: { pictures: () => false } })
    const secret = 'hunter2-correct-horse'
    await h.run('computer_observe', { app: 'Secret' })
    // by name, with no target after a click, by set_value on a named field, and a bare key
    await h.run('computer_act', { app: 'Secret', action: 'type', text: secret, named: 'Password' })
    await h.run('computer_batch', { app: 'Secret', actions: [{ action: 'left_click', element: 13 }, { action: 'type', text: secret }, { action: 'key', text: 'x' }] })
    await h.run('computer_act', { app: 'Secret', action: 'set_value', value: secret, named: 'User' })
    await h.run('computer_act', { app: 'Secret', action: 'paste', text: secret })
    // a denied call: its plan and steps were written before the card
    h.set('t1', { permission: 'safe' })
    const denied = h.run('computer_act', { app: 'Secret', action: 'type', text: secret, element: 12 })
    await until(() => h.cards.length === 1, 'the card')
    h.cards[0].decide(false)
    await denied
    await records(h)
    const dir = join(h.dataDir, 'history', 't1')
    const written = [readFileSync(join(dir, 'log.jsonl'), 'utf8'), ...readdirSync(join(dir, 'steps')).map((f) => readFileSync(join(dir, 'steps', f), 'utf8'))].join('\n')
    expect(written).not.toContain(secret)
    expect(written).not.toContain('hunter2')
    expect(written).toContain(`${secret.length} characters`)
    expect(written).toContain('a key')
  })

  it('a text the steps held back is taken out of the read the journal keeps', async () => {
    const h = make({ history: { pictures: () => false } })
    await h.run('computer_observe', { app: 'TextEdit' })
    // text with no target after a click is a length in its step; the window's title stands in for a secret the read shows
    const out = await h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 21 }, { action: 'type', text: 'Untitled' }] })
    expect(h.text(out)).toContain('"Untitled"')
    await records(h)
    const call = (await calls(h))[1]
    expect(call.steps[1]).toMatchObject({ verb: 'Typed', target: '8 characters' })
    expect(call.text).toBe(true)
    const kept = readFileSync(join(h.dataDir, 'history', 't1', 'steps', `${call.n}.txt`), 'utf8')
    expect(kept).not.toContain('Untitled')
    expect(kept).toContain('‹8 characters›')
  })

  it('a field named by index that is no password field keeps its text, until the book says otherwise', async () => {
    const h = make({ history: { pictures: () => false } })
    await h.run('computer_observe', { app: 'Secret' })
    await h.run('computer_act', { app: 'Secret', action: 'type', text: 'ana', element: 11 })
    expect((await calls(h))[1].steps[0]).toMatchObject({ verb: 'Typed', object: 'into User', target: '"ana"', state: 'ok' })
  })

  it('the apps call says what the launch did', async () => {
    const h = make({ history: { pictures: () => false } })
    await h.run('computer_apps', { launch: 'Preview' })
    await h.run('computer_apps', { launch: 'Preview' })
    await h.run('computer_apps', { launch: 'Preview', open: ['/tmp/report.pdf'] })
    expect((await calls(h)).map((c) => `${c.steps[0].verb} ${c.steps[0].object}`)).toEqual(['Launched Preview', 'Listed apps', 'Opened report.pdf in Preview'])
  })

  it('a launch the service answered stays in the journal when the list after it fails', async () => {
    const h = make({ history: { pictures: () => false } })
    const send = h.service.request.bind(h.service) as (...a: unknown[]) => Promise<unknown>
    h.service.request = ((method: string, ...rest: unknown[]) =>
      method === 'apps.list' ? Promise.reject(new ComputerHostError('service_restarted')) : send(method, ...rest)) as typeof h.service.request
    expect((await h.run('computer_apps', { launch: 'Preview' })).isError).toBe(true)
    expect((await calls(h)).at(-1)!.steps).toMatchObject([{ verb: 'Launched', object: 'Preview', state: 'ok', facts: ['the list of apps could not be read after it'] }])
  })

  it("the row carries asking while this host's card waits, and not after", async () => {
    const h = make({ history: { pictures: () => false } })
    h.set('t1', { permission: 'safe' })
    await h.run('computer_observe', { app: 'TextEdit' })
    expect(h.sessions.rowOf('t1')?.asking).toBeUndefined()
    const o = h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    await until(() => h.cards.length === 1, 'the card')
    const row = h.sessions.rowOf('t1')!
    expect(row.asking).toEqual({ line: 'Click checkbox "bold" in TextEdit, window "Untitled"?' })
    expect(row.running).toMatchObject({ words: LOCAL_CARD_WORDS, held: true })
    // the journal shows the call running meanwhile
    expect((await h.history!.read(['t1']))[0].calls.at(-1)).toMatchObject({ state: 'running', steps: [{ verb: 'Clicking', object: 'bold' }] })
    h.cards[0].decide(true)
    await o
    expect(h.sessions.rowOf('t1')?.asking).toBeUndefined()
    // a card the caller asks itself (a box thread's, through the bridge) is the bridge's to say
    const bridged = h.sessions.run({ threadId: 't1', approve: () => new Promise<boolean>((r) => setTimeout(() => r(true), 30)) }, 'computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    await until(() => h.sessions.rowOf('t1')?.running?.held === true, 'the bridged card')
    expect(h.sessions.rowOf('t1')?.asking).toBeUndefined()
    await bridged
  })

  it('a bridged call’s turn token groups its calls; this host’s own follow beginTurn', async () => {
    const h = make({ history: { pictures: () => false } })
    const run = (turn: string) => h.sessions.run({ threadId: 'mac:env_1:t9', turn }, 'computer_observe', { app: 'TextEdit' })
    await run('a')
    h.sessions.beginTurn('mac:env_1:t9')
    await run('a')
    await run('b')
    const key = 'mac:env_1:t9'
    expect((await h.history!.read([key]))[0].calls.map((c) => c.turn)).toEqual([1, 1, 2])
    await h.run('computer_observe', { app: 'TextEdit' })
    h.set('t1', { status: 'watching' })
    h.set('t1', { status: 'running' })
    await h.run('computer_observe', { app: 'TextEdit' })
    expect((await calls(h)).map((c) => c.turn)).toEqual([1, 2])
  })

  it("an idle close and the thread's end keep the history", async () => {
    const clock = new ManualClock()
    const h = make({ clock, history: { pictures: () => false } })
    await h.run('computer_observe', { app: 'TextEdit' })
    await clock.advance(IDLE_CLOSE_MS + 1)
    await until(() => count(h, 'session.close') === 1, 'the idle close')
    expect(await calls(h)).toHaveLength(1)
    await h.sessions.end(['t1'])
    expect(await calls(h)).toHaveLength(1)
    expect(existsSync(join(h.dataDir, 'history', 't1', 'log.jsonl'))).toBe(true)
  })
})
