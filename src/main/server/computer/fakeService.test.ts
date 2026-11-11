import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PREVIEW_STREAM, COMPUTER_ACTION_NAMES, COMPUTER_METHODS, ComputerNotificationSchema, RpcErrorResponseSchema,
  SessionChangeSchema, resultFrameSchema, requestFrameSchema,
  type ComputerAction, type ComputerMethod, type ComputerParams, type ComputerResult, type Observation, type Shot
} from '../../../shared/computer/protocol'
import { parseObservation } from '../../../shared/computer/observation'
import { codeImage } from '../../../../scripts/lib/codeImage'
import { FAKE_APPS, fakeServiceBin } from './testFake'

type Frame = { jsonrpc: string; id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
const clients: Client[] = []
const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-computer-test-'))
  dirs.push(dir)
  return dir
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 1500
  while (!predicate()) {
    if (Date.now() > end) throw new Error('The fake did not produce the expected output.')
    await delay(5)
  }
}
function checkObservation(value: Observation): void {
  expect(() => parseObservation(value.text)).not.toThrow()
  const lines = value.text.split('\n')
  expect(value.stats).toEqual({
    elements: lines.filter((line) => line.includes('[')).length, lines: lines.length - 1,
    bytes: Buffer.byteLength(value.text), omitted: 0, thin: value.app.name === 'Thin', partial: false, readMs: 5
  })
  expect(value.waited).toEqual({ waitedMs: 12, settled: true, busy: false, reason: 'quiet' })
  expect(value.space).toEqual({ width: 1280, height: 1072, scale: 1.6 })
}
function checkShot(value: Shot, name: string): void {
  const bytes = readFileSync(value.path)
  expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  expect(bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
  expect(bytes.length).toBe(value.bytes)
  expect(basename(value.path)).toMatch(new RegExp(`^\\d{4,}-${name}\\.jpg$`))
  expect(value).toMatchObject({ format: 'jpeg', width: 1280, height: 1072, scale: 1.6, blank: false })
  expect(value.capturedAt).toBeGreaterThan(0)
}

class Client {
  child: ChildProcessWithoutNullStreams
  frames: Frame[] = []
  lines: string[] = []
  sent: string[] = []
  stderr = ''
  epoch = ''
  features: string[] = []
  dataDir: string
  exit: Promise<number | null>
  private nextId = 0
  private waiting = new Map<number, (frame: Frame) => void>()

  constructor(env: Record<string, string> = {}, dataDir = temp()) {
    this.dataDir = dataDir
    const childEnv = { ...process.env }
    for (const key of Object.keys(childEnv)) if (key.startsWith('FAKE_')) delete childEnv[key]
    this.child = spawn(fakeServiceBin(), ['serve'], { env: { ...childEnv, ...env } })
    this.exit = new Promise((resolve, reject) => {
      this.child.once('error', reject)
      this.child.once('close', resolve)
    })
    this.child.stderr.on('data', (data: Buffer) => { this.stderr += data.toString() })
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.lines.push(line)
      let frame: Frame
      try { frame = JSON.parse(line) as Frame } catch { return }
      this.frames.push(frame)
      if (frame.id !== undefined) {
        this.waiting.get(frame.id)?.(frame)
        this.waiting.delete(frame.id)
      }
    })
    clients.push(this)
  }

  send(method: string, params: unknown = {}): { id: number; response: Promise<Frame> } {
    const id = ++this.nextId
    const response = new Promise<Frame>((resolve) => this.waiting.set(id, resolve))
    this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return { id, response }
  }

  write(line: string): void {
    this.sent.push(line)
    this.child.stdin.write(line + '\n')
  }

  cancel(id: number): void {
    this.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancel', params: { id } }))
  }

  async call<M extends ComputerMethod>(method: M, params: ComputerParams<M>): Promise<ComputerResult<M>> {
    const request = this.send(method, params)
    requestFrameSchema(method).parse({ jsonrpc: '2.0', id: request.id, method, params })
    return this.success(method, await request.response)
  }

  success<M extends ComputerMethod>(method: M, frame: Frame): ComputerResult<M> {
    resultFrameSchema(method).parse(frame)
    const value = frame.result as ComputerResult<M>
    if (method === 'state.get') checkObservation(value as Observation)
    if ((method === 'action.run' || method === 'action.batch') && 'observation' in value && value.observation) checkObservation(value.observation)
    return value
  }

  async error(method: string, params: unknown, kind: string | undefined, code = -32000) {
    const frame = RpcErrorResponseSchema.parse(await this.send(method, params).response)
    expect(frame.error.code).toBe(code)
    expect(frame.error.data?.kind).toBe(kind)
    if (frame.error.data) expect(frame.error.data.message).toMatch(/^[^\n]+\.$/)
    return frame.error.data
  }

  async initialize(): Promise<void> {
    const result = await this.call('initialize', { protocol: 1, client: { name: 'fake-test', version: '1' }, dataDir: this.dataDir, features: ['front', 'commit', 'save_as'] })
    this.epoch = result.epoch
    this.features = result.features ?? []
    expect(this.epoch).toMatch(/^e-[a-z0-9]{8}$/)
  }

  async open(): Promise<void> {
    await this.initialize()
    await this.call('session.open', { session: 's1' })
  }

  target(name = 'TextEdit') {
    return { session: 's1', app: { app: name }, epoch: this.epoch }
  }

  async act(name: string, action: ComputerAction, tiers: ComputerParams<'action.run'>['tiers'] = ['ax', 'process']) {
    return this.call('action.run', { ...this.target(name), action, tiers, observe: { mode: 'none' } })
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => {
    if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill()
    await client.exit
  }))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('fake tc-computer wire', () => {
  it('answers every method with the schema and parses each observation', async () => {
    const c = new Client()
    await c.open()
    expect(c.stderr).toBe('fake tc-computer up\n')
    expect(await c.call('permissions.get', {})).toEqual({ accessibility: true, screenRecording: true })
    expect(await c.call('permissions.request', { which: 'accessibility' })).toEqual({ accessibility: true, screenRecording: true })
    const plain = await c.call('apps.list', {})
    expect(plain.apps[0]).toMatchObject({ name: 'TextEdit', active: true })
    expect(plain.apps.every((app) => app.windows === undefined)).toBe(true)
    expect(plain.apps.some((app) => app.name === 'Preview')).toBe(false)
    expect(plain.apps.slice(1).map((app) => app.name)).toEqual(plain.apps.slice(1).map((app) => app.name).sort((a, b) => a.localeCompare(b)))
    const listed = await c.call('apps.list', { windows: true })
    expect(listed.apps.find((app) => app.name === 'Finder')).toMatchObject({ pid: 400, hidden: true, windows: [] })
    expect(listed.apps[0].windows).toEqual([
      { id: 1581, title: 'Untitled', frame: { x: 100, y: 100, w: 800, h: 670 }, main: true, focused: true, minimized: false, onScreen: true, space: 'current' },
      { id: 1582, title: 'Notes.rtf', frame: { x: 100, y: 100, w: 800, h: 670 }, main: false, focused: false, minimized: true, onScreen: false, space: 'current' }
    ])
    for (const app of listed.apps.filter((app) => app.name !== 'Finder')) {
      const expected = FAKE_APPS[app.name as keyof typeof FAKE_APPS]
      expect(app).toMatchObject({ pid: expected.pid, bundleId: expected.bundleId })
      expect(app.windows?.[0].id).toBe(expected.windowId)
    }
    expect(await c.call('apps.launch', { app: 'TextEdit' })).toEqual({ pid: 16800, launched: false })
    expect(await c.call('apps.launch', { app: 'Preview' })).toEqual({ pid: 17000, launched: true })
    expect(await c.call('apps.launch', { app: 'Preview' })).toEqual({ pid: 17000, launched: false })
    expect((await c.call('apps.list', {})).apps.some((app) => app.name === 'Preview')).toBe(true)
    expect((await c.error('apps.launch', { app: 'Missing' }, 'app_not_found'))?.candidates?.length).toBeLessThanOrEqual(5)
    await c.call('session.open', { session: 's1' })
    const full = await c.call('state.get', c.target())
    expect(full).toMatchObject({ kind: 'full', seq: 1 })
    expect(full.shot).toBeUndefined()
    expect(await c.call('state.get', c.target())).toMatchObject({ kind: 'unchanged', seq: 2 })
    const run = await c.call('action.run', { ...c.target(), action: { action: 'type', text: 'Hello' }, tiers: ['ax'], observe: { mode: 'none' } })
    expect(run.step).toMatchObject({ status: 'ok', tier: 'ax', input: { via: 'ax-insert' } })
    expect(run.observation).toBeUndefined()
    expect(await c.call('state.get', c.target())).toMatchObject({ kind: 'diff', seq: 3, base: 2 })
    const subtree = await c.call('state.get', { ...c.target(), element: 3 })
    expect(subtree).toMatchObject({ kind: 'subtree', seq: 3 })
    expect(subtree.text.split('\n')[1]).toBe('[3] text area = "Hello from the probe\\nSecond line" focused caret 0 actions: show menu')
    const batch = await c.call('action.batch', { ...c.target(), actions: [{ action: 'left_click', element: 21 }, { action: 'key', text: 'Tab' }], tiers: ['ax', 'process'] })
    expect(batch.steps.map((step) => step.status)).toEqual(['ok', 'ok'])
    expect(batch.observation).toMatchObject({ kind: 'diff', seq: 4, base: 3 })
    checkShot(await c.call('capture.screenshot', c.target()), 'screenshot')
    expect(await c.call('capture.stream.start', { ...c.target(), stream: 'preview' })).toEqual({ stream: 'preview', width: 960, height: 804 })
    await c.call('capture.stream.stop', { stream: 'preview' })
    expect(await c.call('input.probe', c.target())).toEqual({ pid: 16800, bundleId: 'com.apple.TextEdit', keyWindow: 'target', results: ['scroll', 'key', 'click'].map((kind) => ({ class: kind, outcome: 'honoured', restored: true, ms: 5 })) })
    expect(await c.call('input.restoreSession', {})).toEqual({ frontmost: 'nothing', pointer: 'nothing', held: null })
    expect(await c.call('clipboard.state', {})).toMatchObject({ changeCount: 1, foreignChangeAt: null, watchingSince: expect.any(Number) })
    expect(await c.call('escape.watch', { on: true, leaseMs: 30_000 })).toEqual({})
    expect(await c.call('escape.watch', { on: false })).toEqual({})
    await c.call('session.close', { session: 's1' })
    await c.call('shutdown', {})
    expect(await c.exit).toBe(0)
    const methods = c.sent.map((line) => (JSON.parse(line) as { method: string }).method)
    expect(new Set(methods)).toEqual(new Set(Object.keys(COMPUTER_METHODS)))
  })

  it('rejects calls in target-check order and reports unknown methods without data', async () => {
    const c = new Client()
    await c.error('permissions.get', {}, 'not_initialized')
    await c.open()
    await c.error('future.method', {}, undefined, -32601)
    await c.error('state.get', { ...c.target('Missing'), session: 'closed' }, 'unknown_session')
    await c.error('state.get', c.target('Missing'), 'app_not_found')
    await c.error('input.probe', { ...c.target(), app: { pid: 123 } }, 'app_not_found')
    await c.error('state.get', { ...c.target('NoAX'), window: { id: 0 }, element: 3, epoch: 'wrong' }, 'permission_missing')
    expect(await c.error('state.get', { ...c.target(), window: { title: 'Missing' }, element: 3, epoch: 'wrong' }, 'window_not_found')).toMatchObject({ candidates: ['Untitled', 'Notes.rtf'] })
    expect(await c.error('state.get', { ...c.target(), element: 3, epoch: 'wrong' }, 'stale_element')).toMatchObject({ element: 3, reason: 'service-restarted' })
    await c.error('action.run', { ...c.target(), epoch: 'wrong', action: { action: 'left_click', element: 3 }, tiers: ['ax'] }, 'stale_element')
    await c.error('action.batch', { ...c.target(), epoch: 'wrong', actions: [{ action: 'left_click_drag', start_element: 3, element: 4 }], tiers: ['process'] }, 'stale_element')
    for (const method of ['state.get', 'action.run', 'action.batch', 'capture.screenshot', 'capture.stream.start', 'input.probe']) {
      await c.error(method, { ...c.target(), session: 'closed' }, 'unknown_session')
    }
  })

  it('resolves names, bundle ids, pids and windows and resets only closed session state', async () => {
    const c = new Client()
    await c.open()
    expect(await c.call('state.get', c.target('tExTeDiT'))).toMatchObject({ app: { name: 'TextEdit' }, seq: 1 })
    const notes = await c.call('state.get', { ...c.target('COM.APPLE.TEXTEDIT'), mode: 'full', window: { title: 'Notes' } })
    expect(notes.text).toContain('app "TextEdit" · window "Notes.rtf"')
    expect(notes.text).toContain('[1] window "Notes.rtf"')
    expect(await c.call('state.get', { ...c.target(), app: { pid: 16800 }, window: { id: 1582 } })).toMatchObject({ seq: 3, window: { title: 'Notes.rtf' } })
    expect(await c.call('state.get', c.target('Thin'))).toMatchObject({ seq: 1 })
    await c.call('session.open', { session: 's2' })
    expect(await c.call('state.get', { ...c.target(), session: 's2' })).toMatchObject({ seq: 1 })
    await c.call('session.close', { session: 's1' })
    await c.error('state.get', c.target(), 'unknown_session')
    await c.call('session.close', { session: 's1' })
    await c.call('session.open', { session: 's1' })
    expect(await c.call('state.get', c.target())).toMatchObject({ kind: 'full', seq: 1 })
    expect(await c.call('state.get', { ...c.target(), session: 's2' })).toMatchObject({ kind: 'unchanged', seq: 2 })
    await c.error('state.get', c.target('Preview'), 'app_not_found')
    expect(await c.call('state.get', { ...c.target('Preview'), launch: true })).toMatchObject({ window: { id: 170000, title: 'Preview' } })
    expect(await c.call('apps.launch', { app: 'dev.fake.thin' })).toEqual({ pid: 16801, launched: false })
  })

  it('keeps subtree reads out of the baseline and honours full and screenshot options', async () => {
    const c = new Client()
    await c.open()
    expect(await c.call('state.get', { ...c.target(), element: 8 })).toMatchObject({ kind: 'subtree', seq: 0, text: expect.stringContaining('[8] group "Part"') })
    expect(await c.act('TextEdit', { action: 'left_click', element: 3 })).toMatchObject({ step: { status: 'failed', error: { kind: 'no_such_element' } } })
    const first = await c.call('state.get', { ...c.target(), screenshot: 'always' })
    checkShot(first.shot!, 'observe')
    await c.act('TextEdit', { action: 'type', text: 'Hi' })
    expect(await c.call('state.get', { ...c.target(), element: 3 })).toMatchObject({ seq: 1 })
    expect(await c.call('state.get', c.target())).toMatchObject({ kind: 'diff', seq: 2, base: 1 })
    expect(await c.act('TextEdit', { action: 'left_click', element: 47 })).toMatchObject({ step: { status: 'ok', element: { index: 47, line: 'menu item "Italic" disabled' } } })
    expect(await c.act('TextEdit', { action: 'left_click', element: 48 })).toMatchObject({ step: { error: { kind: 'no_such_element', element: 48 } } })
    const full = await c.call('state.get', { ...c.target(), mode: 'full', screenshot: 'never' })
    expect(full).toMatchObject({ kind: 'full', seq: 3 })
    expect(full.shot).toBeUndefined()
    expect(await c.act('TextEdit', { action: 'left_click', element: 41 })).toMatchObject({ step: { error: { kind: 'no_such_element' } } })
    const closing = await c.call('action.run', { ...c.target(), action: { action: 'wait', duration: 1 }, tiers: ['ax'], observe: { mode: 'full', screenshot: 'always' } })
    expect(closing.observation).toMatchObject({ kind: 'full', seq: 4 })
    checkShot(closing.observation!.shot!, 'action')
  })

  it('runs every verb, chooses tiers in order, and reports input routes and element lines', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target())
    const actions: ComputerAction[] = [
      { action: 'screenshot' }, { action: 'zoom', region: [0, 0, 10, 10] },
      ...(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'] as const).map((action) => ({ action, element: 3 })),
      { action: 'left_click_drag', start_element: 3, element: 4 }, { action: 'mouse_move', element: 3 },
      { action: 'left_mouse_down' }, { action: 'left_mouse_up' }, { action: 'cursor_position' },
      { action: 'scroll', scroll_direction: 'down', scroll_amount: 3 }, { action: 'type', text: 'Hi', element: 3 },
      { action: 'key', text: 'Tab' }, { action: 'hold_key', text: 'Tab', duration: 1 }, { action: 'wait', duration: 1 },
      { action: 'set_value', element: 3, value: 'Hi' }, { action: 'perform', element: 3, name: 'show menu' },
      { action: 'select_text', element: 3, text: 'Hello' }, { action: 'paste', text: 'Hi' }, { action: 'save_as', path: '~/run/note.txt' }
    ]
    expect(actions.map((a) => a.action)).toEqual([...COMPUTER_ACTION_NAMES])
    for (const action of actions) {
      if (action.action === 'save_as') {
        expect(await c.act('TextEdit', action, ['ax', 'process', 'front'])).toMatchObject({ step: { status: 'ok', tier: 'front', input: { via: 'panel' }, disk: { saved: '~/run/note.txt' } } })
        continue
      }
      const result = await c.act('TextEdit', action)
      expect(result.step.status).toBe('ok')
      if (result.step.status !== 'ok') throw new Error('The step failed.')
      if (['screenshot', 'zoom', 'cursor_position', 'wait'].includes(action.action)) {
        expect(result.step).toMatchObject({ tier: null, effect: 'none' })
        if (action.action === 'screenshot' || action.action === 'zoom') checkShot(result.step.shot!, action.action)
        if (action.action === 'wait') expect(result.step.waited?.reason).toBe('quiet')
        if (action.action === 'cursor_position') expect(result.step.text).toBe('X=0, Y=0')
      } else {
        const ax = ['left_click', 'right_click', 'double_click', 'type', 'set_value', 'perform', 'select_text'].includes(action.action)
        expect(result.step).toMatchObject({ tier: ax ? 'ax' : 'process', effect: 'changed' })
      }
    }
    expect(await c.act('TextEdit', { action: 'left_click', element: 3 }, ['process', 'ax'])).toMatchObject({ step: { tier: 'process' } })
    expect(await c.act('TextEdit', { action: 'left_click', element: 3 }, ['ax'])).toMatchObject({ step: { element: { line: 'text area = "Hello from the probe\\nSecond line" focused caret 0 actions: show menu' } } })
    expect(await c.act('TextEdit', { action: 'left_click', element: 8 })).toMatchObject({ step: { element: { line: 'group "Part"' } } })
    expect(await c.act('TextEdit', { action: 'type', text: 'Hi' }, ['process'])).toMatchObject({ step: { input: { via: 'keys' } } })
    expect(await c.act('TextEdit', { action: 'paste', text: 'Hi' }, ['process'])).toMatchObject({ step: { input: { via: 'paste', clipboard: 'restored' } } })
    expect(await c.act('TextEdit', { action: 'key', text: 'Tab' }, ['ax'])).toMatchObject({ step: { error: { kind: 'needs_tier', needed: 'process' } } })
    expect(await c.act('TextEdit', { action: 'set_value', element: 3, value: 'Hi' }, ['process'])).toMatchObject({ step: { error: { kind: 'needs_tier', needed: 'ax' } } })
    for (const action of [{ action: 'left_click' }, { action: 'right_click', coordinate: [10, 10] }] as ComputerAction[]) {
      expect(await c.act('TextEdit', action, ['ax'])).toMatchObject({ step: { error: { needed: 'process' } } })
      const result = await c.act('TextEdit', action, ['session'])
      expect(result.step).toMatchObject({ tier: 'session', effect: 'changed' })
      if (result.step.status === 'ok') SessionChangeSchema.parse(result.step.session)
    }
  })

  it('stops batches at the first failure and still returns the closing observation', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target())
    const batch = await c.call('action.batch', { ...c.target(), tiers: ['ax'], actions: [
      { action: 'type', text: 'First' }, { action: 'left_click', element: 90 }, { action: 'type', text: 'Last' }
    ] })
    expect(batch.steps.map((step) => step.status)).toEqual(['ok', 'failed', 'not-run'])
    expect(batch.observation).toMatchObject({ kind: 'diff', seq: 2, base: 1 })
    const noRead = await c.call('action.batch', { ...c.target(), tiers: ['ax'], actions: [{ action: 'wait', duration: 1 }], observe: { mode: 'none' } })
    expect(noRead.observation).toBeUndefined()
    expect(await c.act('TextEdit', { action: 'left_click_drag', start_element: 90, element: 3 })).toMatchObject({ step: { error: { kind: 'no_such_element', element: 90 } } })
  })

  it('leaves observations unchanged after actions that send no input', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target())
    for (const action of [
      { action: 'screenshot' }, { action: 'zoom', region: [0, 0, 10, 10] },
      { action: 'cursor_position' }, { action: 'wait', duration: 1 }
    ] as ComputerAction[]) {
      const result = await c.call('action.run', { ...c.target(), action, tiers: ['ax'] })
      expect(result.step).toMatchObject({ tier: null, effect: 'none' })
      expect(result.observation?.kind).toBe('unchanged')
    }
  })

  it('Thin returns unknown effects, thin text and auto shots', async () => {
    const c = new Client()
    await c.open()
    const full = await c.call('state.get', { ...c.target('Thin'), screenshot: 'auto' })
    expect(full.stats.thin).toBe(true)
    expect(full.text).toContain('app "Thin" · window "Untitled" · 1024×768 · thin tree, see the screenshot')
    checkShot(full.shot!, 'observe')
    const run = await c.call('action.run', { ...c.target('Thin'), action: { action: 'left_click', element: 3 }, tiers: ['ax'] })
    expect(run.step).toMatchObject({ tier: 'ax', effect: 'unknown' })
    checkShot(run.observation!.shot!, 'action')
    const never = await c.call('state.get', { ...c.target('Thin'), screenshot: 'never' })
    expect(never.shot).toBeUndefined()
    expect((await c.call('input.probe', { ...c.target('Thin'), classes: ['type'] })).results).toEqual([{ class: 'type', outcome: 'untested', reason: 'thin tree', restored: true, ms: 5 }])
  })

  it('KeyWin refuses process keyboard input and allows AX typing and session keys', async () => {
    const c = new Client()
    await c.open()
    for (const action of [{ action: 'type', text: 'Hi' }, { action: 'key', text: 'Tab' }, { action: 'paste', text: 'Hi' }] as ComputerAction[]) {
      expect(await c.act('KeyWin', action, ['process', 'session'])).toMatchObject({ step: { status: 'failed', error: { kind: 'key_window_unavailable', keyWindow: { id: 99, title: 'Other' } } } })
    }
    expect(await c.act('KeyWin', { action: 'type', text: 'Hi' }, ['ax'])).toMatchObject({ step: { status: 'ok', tier: 'ax', input: { via: 'ax-insert' } } })
    for (const action of [{ action: 'key', text: 'Tab' }, { action: 'hold_key', text: 'Tab', duration: 1 }, { action: 'paste', text: 'Hi' }] as ComputerAction[]) {
      expect(await c.act('KeyWin', action, ['ax'])).toMatchObject({ step: { error: { kind: 'needs_tier', needed: 'session' } } })
      const result = await c.act('KeyWin', action, ['ax', 'session'])
      expect(result.step).toMatchObject({ status: 'ok', tier: 'session' })
      if (result.step.status === 'ok') SessionChangeSchema.parse(result.step.session)
    }
    expect((await c.call('input.probe', c.target('KeyWin'))).keyWindow).toBe('other')
  })

  it('Sessiony needs session permission for holds and raising a window', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target('Sessiony'))
    for (const action of [{ action: 'hold_key', text: 'Tab', duration: 1 }, { action: 'perform', element: 1, name: 'raise' }] as ComputerAction[]) {
      expect(await c.act('Sessiony', action)).toMatchObject({ step: { status: 'failed', error: { kind: 'needs_tier', needed: 'session' } } })
      const result = await c.act('Sessiony', action, ['ax', 'process', 'session'])
      expect(result.step).toMatchObject({ tier: 'session', session: { frontmost: { before: { pid: 16800, bundleId: 'com.apple.TextEdit', name: 'TextEdit' }, after: { pid: 16803, bundleId: 'dev.fake.sessiony', name: 'Sessiony' } }, pointer: { before: [10, 10], after: [20, 20] }, restorable: true } })
      if (result.step.status === 'ok') SessionChangeSchema.parse(result.step.session)
    }
  })

  it("a session step says its span, and input.restoreSession puts back what it left in front once", async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target('Sessiony'))
    expect(await c.call('input.restoreSession', {})).toEqual({ frontmost: 'nothing', pointer: 'nothing', held: null })
    const down = await c.act('Sessiony', { action: 'left_mouse_down' }, ['ax', 'process', 'session'])
    expect(down.step).toMatchObject({ status: 'ok', tier: 'session' })
    const span = down.step.status === 'ok' ? down.step.session : undefined
    expect(span?.armedAt).toBeLessThanOrEqual(span?.lastInputAt ?? 0)
    expect(span?.idleAtArmMs).toBe(130_000)
    expect(await c.act('Sessiony', { action: 'left_mouse_up' }, ['ax', 'process'])).toMatchObject({ step: { error: { kind: 'needs_tier', needed: 'session' } } })
    expect(await c.call('input.restoreSession', { afterInterrupt: true })).toEqual({ frontmost: 'restored', pointer: 'restored', held: { pid: 16803, bundleId: 'dev.fake.sessiony', name: 'Sessiony' } })
    expect(await c.call('input.restoreSession', {})).toEqual({ frontmost: 'nothing', pointer: 'nothing', held: null })
  })

  it('Touchy says the person took over before it answers the step interrupted, after the closing wait', async () => {
    const c = new Client({ FAKE_CLOSING_WAIT_MS: '300' })
    await c.open()
    await c.call('state.get', c.target('Touchy'))
    const started = Date.now()
    const pending = c.call('action.run', { ...c.target('Touchy'), action: { action: 'key', text: 'a' }, tiers: ['ax', 'process', 'session'], observe: { mode: 'none' } })
    await until(() => c.frames.some((f) => f.method === 'session/interrupted'))
    const note = ComputerNotificationSchema.parse(c.frames.find((f) => f.method === 'session/interrupted'))
    expect(note.params).toMatchObject({ session: 's1', by: 'person' })
    const answer = await pending
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
    expect(answer.step).toMatchObject({ status: 'failed', error: { kind: 'interrupted', by: 'person', session: { restorable: true } } })
    expect(await c.act('Touchy', { action: 'key', text: 'a' })).toMatchObject({ step: { error: { kind: 'needs_tier', needed: 'session' } } })
  })

  it('holds input.restoreSession for FAKE_RESTORE_MS', async () => {
    const c = new Client({ FAKE_RESTORE_MS: '200' })
    await c.open()
    const started = Date.now()
    await c.call('input.restoreSession', {})
    expect(Date.now() - started).toBeGreaterThanOrEqual(180)
  })

  it("with pasteQuietMs, a paste or a long type inside the person's copy fails recent-copy; a short type and a quiet clipboard go", async () => {
    const c = new Client({ FAKE_CLIPBOARD_COPY_AT_MS: '0' })
    await c.open()
    await c.call('state.get', c.target())
    const state = await c.call('clipboard.state', {})
    expect(state.foreignChangeAt).toBeGreaterThan(state.watchingSince)
    const run = (action: ComputerAction, pasteQuietMs?: number) =>
      c.call('action.run', { ...c.target(), action, tiers: ['ax', 'process'], observe: { mode: 'none' }, ...(pasteQuietMs === undefined ? {} : { pasteQuietMs }) })
    expect(await run({ action: 'paste', text: 'x' }, 60_000)).toMatchObject({ step: { status: 'failed', error: { kind: 'clipboard_busy', reason: 'recent-copy' } } })
    expect(await run({ action: 'type', text: 'x'.repeat(2_000) }, 60_000)).toMatchObject({ step: { status: 'failed', error: { reason: 'recent-copy' } } })
    expect(await run({ action: 'type', text: 'short' }, 60_000)).toMatchObject({ step: { status: 'ok' } })
    expect(await run({ action: 'paste', text: 'x' })).toMatchObject({ step: { status: 'ok', input: { via: 'paste' } } })
    expect(await run({ action: 'paste', text: 'x' }, 0)).toMatchObject({ step: { status: 'ok' } })
  })

  it('FAKE_CLIPBOARD_COPY_EVERY_MS keeps the last foreign change fresh', async () => {
    const c = new Client({ FAKE_CLIPBOARD_COPY_EVERY_MS: '100' })
    await c.open()
    await delay(250)
    const state = await c.call('clipboard.state', {})
    expect(Date.now() - (state.foreignChangeAt ?? 0)).toBeLessThan(150)
  })

  it('Stubborn ignores every process click and honours session clicks', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target('Stubborn'))
    for (const action of ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'] as const) {
      expect(await c.act('Stubborn', { action, element: 3 }, ['ax', 'process'])).toMatchObject({ step: { tier: 'process', effect: 'none' } })
      expect(await c.act('Stubborn', { action, element: 3 }, ['session'])).toMatchObject({ step: { tier: 'session', effect: 'changed' } })
      expect(await c.act('Stubborn', { action, element: 3 }, ['ax'])).toMatchObject({ step: { error: { needed: 'process' } } })
    }
    expect((await c.call('input.probe', c.target('Stubborn'))).results.find((item) => item.class === 'click')?.outcome).toBe('ignored')
    expect(await c.act('Stubborn', { action: 'left_click_drag', start_element: 3, element: 4 }, ['process'])).toMatchObject({ step: { tier: 'process', effect: 'changed' } })
  })

  it('Slow holds reads and actions until their own cancellation arrives', async () => {
    const c = new Client()
    await c.open()
    const state = c.send('state.get', c.target('Slow'))
    const run = c.send('action.run', { ...c.target('Slow'), action: { action: 'type', text: 'Hi' }, tiers: ['ax'] })
    const batch = c.send('action.batch', { ...c.target('Slow'), actions: [{ action: 'type', text: 'Hi' }, { action: 'key', text: 'Tab' }], tiers: ['process'] })
    c.cancel(999)
    await c.call('permissions.get', {})
    expect(c.frames.filter((frame) => [state.id, run.id, batch.id].includes(frame.id!))).toEqual([])
    c.cancel(state.id)
    expect(RpcErrorResponseSchema.parse(await state.response).error.data?.kind).toBe('cancelled')
    c.cancel(run.id)
    const cancelledRun = c.success('action.run', await run.response)
    expect(cancelledRun).toMatchObject({ step: { status: 'failed', error: { kind: 'cancelled' } }, observationError: { kind: 'cancelled' } })
    expect(cancelledRun.observation).toBeUndefined()
    c.cancel(batch.id)
    const cancelledBatch = c.success('action.batch', await batch.response)
    expect(cancelledBatch.steps.map((step) => step.status)).toEqual(['failed', 'not-run'])
    expect(cancelledBatch.observationError?.kind).toBe('cancelled')
    expect(cancelledBatch.observation).toBeUndefined()
    c.cancel(batch.id)
    await c.call('permissions.get', {})
    expect(c.frames.every((frame) => frame.id !== undefined)).toBe(true)
    expect(c.frames.filter((frame) => frame.id === batch.id)).toHaveLength(1)
  })

  it.each(['action.run', 'action.batch'] as const)('Crashy exits 1 on %s', async (method) => {
    const c = new Client()
    await c.open()
    c.send(method, { ...c.target('Crashy'), action: { action: 'type', text: 'Hi' }, actions: [{ action: 'type', text: 'Hi' }], tiers: ['ax'] })
    expect(await c.exit).toBe(1)
    expect(c.stderr).toContain('fake crash\n')
  })

  it('NoAX rejects targets and NoShot returns shot errors and failed capture steps', async () => {
    const c = new Client()
    await c.open()
    expect(await c.error('state.get', c.target('NoAX'), 'permission_missing')).toMatchObject({ which: 'accessibility' })
    expect(await c.error('capture.screenshot', c.target('NoShot'), 'permission_missing')).toMatchObject({ which: 'screenRecording' })
    const read = await c.call('state.get', { ...c.target('NoShot'), screenshot: 'always' })
    expect(read.shot).toBeUndefined()
    expect(read.shotError).toMatchObject({ kind: 'permission_missing', which: 'screenRecording' })
    for (const action of [{ action: 'screenshot' }, { action: 'zoom', region: [0, 0, 10, 10] }] as ComputerAction[]) {
      expect(await c.act('NoShot', action)).toMatchObject({ step: { status: 'failed', error: { kind: 'permission_missing', which: 'screenRecording' } } })
    }
    const never = await c.call('state.get', { ...c.target('NoShot'), screenshot: 'never' })
    expect(never.shotError).toBeUndefined()
  })

  it('keeps shot numbers across apps, a closed session and a new process', async () => {
    const dir = temp()
    const shotsDir = join(dir, 'shots', 's1')
    mkdirSync(shotsDir, { recursive: true })
    writeFileSync(join(shotsDir, '0012-observe.jpg'), 'existing')
    writeFileSync(join(shotsDir, 'unrelated.txt'), 'ignore')
    const first = new Client({}, dir)
    await first.open()
    const a = await first.call('capture.screenshot', first.target())
    expect(basename(a.path)).toBe('0013-screenshot.jpg')
    checkShot(a, 'screenshot')
    await first.call('session.close', { session: 's1' })
    await first.call('session.open', { session: 's1' })
    const b = await first.call('state.get', first.target('Thin'))
    expect(basename(b.shot!.path)).toBe('0014-observe.jpg')
    await first.call('shutdown', {})
    expect(await first.exit).toBe(0)
    const second = new Client({}, dir)
    await second.open()
    expect(second.epoch).not.toBe(first.epoch)
    const d = await second.call('capture.screenshot', second.target())
    expect(basename(d.path)).toBe('0015-screenshot.jpg')
    checkShot(d, 'screenshot')
    expect(readFileSync(a.path)).toEqual(readFileSync(d.path))
  })

  it('reuses an executable wrapper and exits 0 at stdin EOF', async () => {
    const path = fakeServiceBin()
    expect(fakeServiceBin()).toBe(path)
    expect(statSync(path).mode & 0o777).toBe(0o755)
    const wrapper = readFileSync(path, 'utf8')
    expect(wrapper).toContain(`exec "${process.execPath}"`)
    const c = new Client()
    await c.initialize()
    c.child.stdin.end()
    expect(await c.exit).toBe(0)
  })
})

describe('fake service environment knobs', () => {
  it('exits 75 after the nth answered request', async () => {
    const c = new Client({ FAKE_EXIT_75_AFTER: '2' })
    await c.initialize()
    await c.call('permissions.get', {})
    expect(await c.exit).toBe(75)
    expect(c.frames).toHaveLength(2)
  })

  it('writes garbage and an unknown notification after initialization', async () => {
    const c = new Client({ FAKE_GARBAGE: '1', FAKE_UNKNOWN_NOTIFY: '1' })
    await c.initialize()
    await c.call('permissions.get', {})
    expect(JSON.parse(c.lines[0])).toHaveProperty('result.epoch')
    expect(c.lines[1]).toBe('this is not json')
    const notification = c.frames.find((frame) => frame.method === 'future/thing')!
    expect(notification).toEqual({ jsonrpc: '2.0', method: 'future/thing', params: {} })
    expect(ComputerNotificationSchema.safeParse(notification).success).toBe(false)
  })

  it('never answers permissions.get with no pong enabled', async () => {
    const c = new Client({ FAKE_NO_PONG: '1' })
    await c.initialize()
    const unanswered = c.send('permissions.get')
    await c.call('permissions.request', { which: 'screenRecording' })
    expect(c.frames.some((frame) => frame.id === unanswered.id)).toBe(false)
    await c.call('shutdown', {})
    expect(await c.exit).toBe(0)
    expect(c.frames.some((frame) => frame.id === unanswered.id)).toBe(false)
  })

  it('appends every request line exactly, including notifications and malformed JSON', async () => {
    const log = join(temp(), 'requests.log')
    writeFileSync(log, 'prior\n')
    const c = new Client({ FAKE_LOG: log })
    await c.open()
    c.write('  { "jsonrpc": "2.0", "method": "$/cancel", "params": {"id":999} }  ')
    c.write('{broken')
    await c.call('permissions.get', {})
    expect(readFileSync(log, 'utf8')).toBe('prior\n' + c.sent.join('\n') + '\n')
    expect(c.frames.some((frame) => frame.error && RpcErrorResponseSchema.parse(frame).error.code === -32700)).toBe(true)
  })

  it('emits valid log and permission notifications and flips the current permissions', async () => {
    const c = new Client({ FAKE_LOG_NOTIFY: '1', FAKE_PERMISSIONS_CHANGE_MS: '10' })
    await c.initialize()
    await until(() => c.frames.some((frame) => frame.method === 'permissions/changed'))
    const notifications = c.frames.filter((frame) => frame.method)
    expect(notifications).toHaveLength(2)
    for (const frame of notifications) {
      expect(frame.jsonrpc).toBe('2.0')
      ComputerNotificationSchema.parse(frame)
    }
    expect(notifications[0]).toMatchObject({ method: 'log', params: { level: 'info', message: 'fake log line' } })
    expect(notifications[1]).toMatchObject({ method: 'permissions/changed', params: { accessibility: true, screenRecording: false } })
    expect(await c.call('permissions.get', {})).toEqual({ accessibility: true, screenRecording: false })
    expect(await c.call('permissions.request', { which: 'screenRecording' })).toEqual({ accessibility: true, screenRecording: false })
  })

  it('disables recording for observations, screenshots and zoom with FAKE_SCREEN_RECORDING=0', async () => {
    const c = new Client({ FAKE_SCREEN_RECORDING: '0' })
    await c.open()
    expect(await c.call('permissions.get', {})).toEqual({ accessibility: true, screenRecording: false })
    expect(await c.call('state.get', c.target('Thin'))).toMatchObject({ shotError: { kind: 'permission_missing', which: 'screenRecording' } })
    await c.error('capture.screenshot', c.target(), 'permission_missing')
    expect(await c.act('TextEdit', { action: 'zoom', region: [0, 0, 10, 10] })).toMatchObject({ step: { error: { kind: 'permission_missing', which: 'screenRecording' } } })
  })
})

describe('fake preview, Escape and shot controls', () => {
  const notes = (c: Client, method: string) => c.frames.filter((f) => f.method === method).map((f) => {
    const note = ComputerNotificationSchema.parse(f)
    return note.params as Record<string, unknown>
  })
  it('sends frames at fps, waits at maxUnacked, resumes on host ack, and stops', async () => {
    const c = new Client(); await c.open()
    const size = await c.call('capture.stream.start', { ...c.target(), stream: 'pv', fps: 15, maxEdge: 512 })
    expect(size).toEqual({ stream: 'pv', width: 512, height: 429 })
    await until(() => notes(c, 'capture/frame').length === 2)
    await delay(170); expect(notes(c, 'capture/frame')).toHaveLength(PREVIEW_STREAM.maxUnacked)
    c.write(JSON.stringify({ jsonrpc: '2.0', method: 'capture.stream.ack', params: { stream: 'pv', seq: 1 } }))
    await until(() => notes(c, 'capture/frame').length === 3)
    expect(notes(c, 'capture/frame').map((n) => n.seq)).toEqual([1, 2, 3])
    const first = notes(c, 'capture/frame')[0]
    expect(first).toMatchObject({ width: 512, height: 429, format: 'jpeg' })
    expect(Buffer.from(String(first.data), 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    await c.call('capture.stream.stop', { stream: 'pv' })
    c.write(JSON.stringify({ jsonrpc: '2.0', method: 'capture.stream.ack', params: { stream: 'pv', seq: 3 } }))
    await delay(90); expect(notes(c, 'capture/frame')).toHaveLength(3)
  })
  it('ends streams through the knob and refuses minimized windows and missing permission', async () => {
    const c = new Client({ FAKE_STREAM_END_MS: '15', FAKE_STREAM_END_REASON: 'permission' }); await c.open()
    await c.call('capture.stream.start', { ...c.target(), stream: 'pv' })
    await until(() => notes(c, 'capture/streamEnded').length === 1)
    expect(notes(c, 'capture/streamEnded')[0]).toEqual({ stream: 'pv', reason: 'permission' })
    await c.error('capture.stream.start', { ...c.target(), window: { id: 1582 }, stream: 'pv2' }, 'window_minimized')
    const denied = new Client({ FAKE_SCREEN_RECORDING: '0' }); await denied.open()
    await denied.error('capture.stream.start', { ...denied.target(), stream: 'pv' }, 'permission_missing')
  })
  it('maps clicks to every matching stream without a frame and carries only matching recent clicks', async () => {
    const c = new Client({ FAKE_NO_FRAMES: '1' }); await c.open()
    await c.call('capture.stream.start', { ...c.target(), stream: 'a', maxEdge: 512 })
    await c.call('capture.stream.start', { ...c.target(), stream: 'b', maxEdge: 960 })
    await c.act('TextEdit', { action: 'left_click', coordinate: [320, 268] })
    expect(notes(c, 'capture/click')).toEqual([
      { stream: 'a', at: [128, 107], width: 512, height: 429 },
      { stream: 'b', at: [240, 201], width: 960, height: 804 }
    ])
    await c.call('capture.stream.stop', { stream: 'a' }); await c.call('capture.stream.stop', { stream: 'b' })
    await c.call('capture.stream.start', { ...c.target(), stream: 'carried', maxEdge: 512 })
    await until(() => notes(c, 'capture/click').length === 3)
    expect(notes(c, 'capture/click')[2].stream).toBe('carried')
    await c.call('capture.stream.start', { ...c.target('Thin'), stream: 'other' })
    await delay(50); expect(notes(c, 'capture/click')).toHaveLength(3)
    expect(notes(c, 'capture/frame')).toHaveLength(0)
  })
  it('expires carried clicks and clears them when a service session closes', async () => {
    const c = new Client({ FAKE_NO_FRAMES: '1' }); await c.open()
    await c.act('TextEdit', { action: 'left_click', coordinate: [10, 20] })
    await delay(PREVIEW_STREAM.clickCarryMs + 20)
    await c.call('capture.stream.start', { ...c.target(), stream: 'expired' })
    await c.act('TextEdit', { action: 'left_click', coordinate: [10, 20] })
    await until(() => notes(c, 'capture/click').length === 1)
    await c.call('session.close', { session: 's1' }); await c.call('session.open', { session: 's1' })
    await c.call('capture.stream.start', { ...c.target(), stream: 'new-session' })
    await delay(30); expect(notes(c, 'capture/click')).toHaveLength(1)
  })
  it('takes Escape only within an enabled lease and can model an older service', async () => {
    const c = new Client({ FAKE_ESCAPE_PRESS_MS: '20' }); await c.open()
    await c.call('escape.watch', { on: true, leaseMs: 1000 })
    await until(() => notes(c, 'escape/pressed').length === 1)
    await c.call('escape.watch', { on: true, leaseMs: 1000 }); await c.call('escape.watch', { on: false })
    await delay(45); expect(notes(c, 'escape/pressed')).toHaveLength(1)
    const expired = new Client({ FAKE_ESCAPE_PRESS_MS: '1050' }); await expired.open()
    await expired.call('escape.watch', { on: true, leaseMs: 1000 })
    await delay(1100); expect(notes(expired, 'escape/pressed')).toHaveLength(0)
    const old = new Client({ FAKE_ESCAPE_UNSUPPORTED: '1' }); await old.open()
    await old.error('escape.watch', { on: true, leaseMs: 30000 }, undefined, -32601)
  })
  it('takes FAKE_SHOT_FILES in order, repeats the last and reports PNG dimensions', async () => {
    const first = join(temp(), 'first.jpg')
    const last = codeImage(join(temp(), 'last.png')).path
    const jpeg = Buffer.from(JSON.parse(readFileSync(new URL('./fixtures/wire/notify-capture-frame.json', import.meta.url), 'utf8')).params.data, 'base64')
    writeFileSync(first, jpeg)
    const c = new Client({ FAKE_SHOT_FILES: `${first},${last}`, FAKE_SHOT_FILE: first }); await c.open()
    const a = await c.call('capture.screenshot', c.target())
    const b = await c.call('capture.screenshot', c.target())
    const d = await c.call('capture.screenshot', c.target())
    expect(readFileSync(a.path)).toEqual(jpeg)
    for (const shot of [b, d]) {
      expect(readFileSync(shot.path)).toEqual(readFileSync(last))
      expect(shot).toMatchObject({ format: 'png', width: 1280, height: 800 })
    }
  })
  it('copies FAKE_SHOT_FILE for observation, screenshot, zoom and capture shots', async () => {
    const file = join(temp(), 'proof.jpg')
    const bytes = readFileSync(new URL('./fixtures/wire/notify-capture-frame.json', import.meta.url), 'utf8')
    const jpeg = Buffer.from(JSON.parse(bytes).params.data, 'base64')
    writeFileSync(file, jpeg)
    const c = new Client({ FAKE_SHOT_FILE: file }); await c.open()
    const observation = await c.call('state.get', { ...c.target(), screenshot: 'always' })
    const screenshot = await c.act('TextEdit', { action: 'screenshot' })
    const zoom = await c.act('TextEdit', { action: 'zoom', region: [0, 0, 100, 100] })
    const capture = await c.call('capture.screenshot', c.target())
    expect(screenshot.step.status).toBe('ok'); expect(zoom.step.status).toBe('ok')
    if (screenshot.step.status !== 'ok' || zoom.step.status !== 'ok') throw new Error('Shot action failed')
    for (const shot of [observation.shot, screenshot.step.shot, zoom.step.shot, capture]) {
      expect(shot).toBeDefined(); expect(readFileSync(shot!.path)).toEqual(jpeg); expect(shot!.bytes).toBe(jpeg.length)
    }
  })
})

describe('steps that need the app active (§26)', () => {
  it('answers its features to a host that lists them, and runs Fronty\'s Save only in front', async () => {
    const c = new Client()
    await c.open()
    expect(c.features).toEqual(['front', 'commit', 'save_as'])
    await c.call('state.get', c.target('Fronty'))
    expect(await c.act('Fronty', { action: 'key', text: 'super+s' })).toMatchObject({ step: { error: { kind: 'needs_tier', needed: 'front', menu: ['File', 'Save'] } } })
    const saved = await c.act('Fronty', { action: 'key', text: 'super+s' }, ['ax', 'process', 'front'])
    expect(saved).toMatchObject({ step: { tier: 'front', input: { via: 'menu', on: 'File › Save' }, front: { restored: 'restored' }, disk: { saved: '~/run/Total.txt' } } })
  })

  it('splits a batch\'s front steps into holds of at most 2 s', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target('Fronty'))
    const r = await c.call('action.batch', { ...c.target('Fronty'), tiers: ['ax', 'process', 'front'], actions: Array.from({ length: 4 }, () => ({ action: 'key', text: 'super+s' })) })
    expect(r.steps.map((s) => (s.status === 'ok' ? s.front?.heldMs : null))).toEqual([700, 1400, 700, 1400])
  })

  it('Committy reads uncommitted with its hint until the rename commits in front, and names an autosave', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target('Committy'))
    expect(await c.act('Committy', { action: 'key', text: 'Return' })).toMatchObject({ step: { tier: 'process', effect: 'uncommitted', disk: { hint: 'commit it with key Return in the field' } } })
    expect(await c.act('Committy', { action: 'key', text: 'Return' }, ['ax', 'process', 'front'])).toMatchObject({ step: { tier: 'front', effect: 'changed', disk: { renamed: [{ from: '~/run/a.txt', to: '~/run/b.txt' }] } } })
    expect(await c.act('Committy', { action: 'type', text: 'x' }, ['ax'])).toMatchObject({ step: { disk: { unexpected: true } } })
  })

  it('Panely refuses to overwrite without replace and says when no file appeared', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target('Panely'))
    const tiers = ['ax', 'process', 'front'] as const
    expect(await c.act('Panely', { action: 'save_as', path: '~/run/exists.txt' }, [...tiers])).toMatchObject({ step: { error: { kind: 'file_exists' } } })
    expect(await c.act('Panely', { action: 'save_as', path: '~/run/exists.txt', replace: true }, [...tiers])).toMatchObject({ step: { status: 'ok' } })
    expect(await c.act('Panely', { action: 'save_as', path: '~/run/nothing.txt' }, [...tiers])).toMatchObject({ step: { error: { kind: 'not_committed' } } })
  })

  it('Menuy names a menu it could not close', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target('Menuy'))
    expect(await c.act('Menuy', { action: 'perform', element: 4, name: 'show menu' }, ['ax'])).toMatchObject({ menusLeftOpen: ['Action'] })
    expect(await c.act('Menuy', { action: 'perform', element: 3, name: 'show menu' }, ['ax'])).not.toHaveProperty('menusLeftOpen')
  })
})

describe('Webby (§25)', () => {
  it('lists two tabs, refuses active-window reads and screenshots, and selects through an admitted act', async () => {
    const c = new Client({ FAKE_WEB_ACTIVE: '1' })
    await c.open()
    const app = (await c.call('apps.list', { windows: true })).apps.find((a) => a.name === 'Webby')!
    expect(app).toMatchObject({ active: true, windows: [{ tabs: [{ title: 'Web front', selected: true }, { title: 'Web report', selected: false }] }] })
    const target = { ...c.target('Webby'), window: { title: 'Web report' }, tabs: 'background' as const }
    await c.error('state.get', target, 'tab_in_use')
    await c.error('capture.screenshot', target, 'tab_in_use')
    const result = await c.call('action.run', { ...target, tabs: 'any', expectFocus: 3, action: { action: 'key', text: 'Tab' }, tiers: ['ax', 'process', 'session'] })
    expect(result.observation).toMatchObject({ selectedTab: 'Web report', page: { tab: 'Web report', state: 'loading' }, window: { id: 171000 } })
    expect(result.observation?.text).toContain(' · still loading')
    const loaded = await c.call('state.get', { ...c.target('Webby'), window: { id: 171000 } })
    expect(loaded.page?.state).toBe('loaded')
    expect(loaded.selectedTab).toBeUndefined()
    await c.error('action.run', { ...c.target('Webby'), epoch: 'old', expectFocus: 3, action: { action: 'key', text: 'Tab' }, tiers: ['ax', 'process'] }, 'stale_element')
  })

  it('models a pop-up pick, a refused AXValue, scroll-into-view and focus leaving the page', async () => {
    const c = new Client()
    await c.open()
    await c.call('state.get', c.target('Webby'))
    expect((await c.act('Webby', { action: 'set_value', element: 19, value: 'Team' })).step).toMatchObject({ status: 'ok', input: { via: 'pick', on: 'Team' } })
    expect((await c.act('Webby', { action: 'set_value', element: 4, value: 'New' })).step).toMatchObject({ status: 'failed', error: { kind: 'value_not_taken', value: 'Original' } })
    expect((await c.act('Webby', { action: 'scroll', element: 20, scroll_direction: 'down', scroll_amount: 5 })).step).toMatchObject({ status: 'ok', input: { via: 'scroll-into-view' } })
    await c.act('Webby', { action: 'key', text: 'super+l' })
    expect((await c.act('Webby', { action: 'key', text: 'Tab' })).step).toMatchObject({ status: 'failed', error: { kind: 'focus_moved', focused: { index: 9 } } })
    expect((await c.act('Webby', { action: 'key', text: 'Tab', element: 3 })).step.status).toBe('ok')
  })

  it('models a covered page without treating its screenshot as blank', async () => {
    const c = new Client({ FAKE_WEB_NOT_DRAWN: '1' })
    await c.open()
    const obs = await c.call('state.get', { ...c.target('Webby'), screenshot: 'always' })
    expect(obs.page?.state).toBe('not-drawn')
    expect(obs.text).toContain(' · page not drawn')
    expect(obs.shot?.blank).toBe(false)
  })
})
