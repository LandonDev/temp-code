import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPUTER_WAIT, type Observation } from '@shared/computer/protocol'
import { tierVerdictSetting } from '@shared/computer/tools'
import { PERMISSION_SWITCH, remember, type ThreadComputer } from './run'
import { computerHarness, type ComputerHarness } from './runHarness'
import { IDLE_CLOSE_MS } from './sessions'
import { ManualClock, settle } from './testFake'
import type { SessionTierGate, TierGateContext } from './tierGate'

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
      ran: (_c: TierGateContext, change) => ran.push(change)
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

  it('a key-window retry of a key that the gate admits leaves process out', async () => {
    const gate: SessionTierGate = { admitted: () => false, request: async () => ({ admit: true }) }
    const h = make({ gate })
    const o = await h.run('computer_act', { app: 'KeyWin', action: 'key', text: 'a' })
    expect(h.requests().filter((r) => r.method === 'action.run').map((r) => r.params.tiers)).toEqual([
      ['ax', 'process'],
      ['ax', 'session']
    ])
    expect(o.steps).toEqual(['key a · session · changed'])
  })

  it("the gate hears the call's own root and card when the caller names them, else the host's root", async () => {
    const seen: TierGateContext[] = []
    const gate: SessionTierGate = { admitted: () => false, request: async (c) => (seen.push(c), { admit: false, reason: 'denied', message: 'no' }) }
    const h = make({ gate })
    const approve = async (): Promise<boolean> => true
    const batch = { app: 'Sessiony', actions: [{ action: 'hold_key', text: 'shift', duration: 1 }] }
    await h.sessions.run({ threadId: 'env_abcdefghijklmnopqrstuv:t9', rootId: 'env_abcdefghijklmnopqrstuv:root', approve }, 'computer_batch', batch)
    await h.run('computer_batch', batch, 't2')
    expect(seen.map((c) => c.rootId)).toEqual(['env_abcdefghijklmnopqrstuv:root', 't2'])
    expect(seen[0].approve).toBe(approve)
    expect(seen[1].approve).toBeUndefined()
  })

  it('Stubborn raises its click verdict to session through a gate that admits', async () => {
    const gate: SessionTierGate = { admitted: () => true, request: async () => ({ admit: true }) }
    const h = make({ gate })
    await h.run('computer_observe', { app: 'Stubborn' })
    await h.run('computer_act', { app: 'Stubborn', action: 'left_click', coordinate: [5, 5] })
    const verdict = JSON.parse(h.rows.get(tierVerdictSetting('dev.fake.stubborn'))!)
    expect(verdict.classes.click).toBe('session')
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
    expect(JSON.parse(h.rows.get(tierVerdictSetting('com.apple.TextEdit'))!).probedAt).toBeGreaterThan(0)
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
    ended: false
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
