import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerNotification } from '@shared/computer/protocol'
import { ComputerPreviews, handleComputerPreview } from './preview'
import { computerHarness, type ComputerHarness } from './runHarness'
import { ManualClock } from './testFake'

type Push = {
  push: string
  preview: string
  seq: number
  state: string
  reason: string
  app: string
  width: number
  at: number[]
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function setup(env: Record<string, string> = {}) {
  const clock = new ManualClock()
  const h = computerHarness({ env, clock })
  await h.run('computer_observe', { app: 'TextEdit' })
  let receive: (n: ComputerNotification) => void = () => {}
  const subscribe = h.service.onNotification.bind(h.service)
  const subscription = vi.spyOn(h.service, 'onNotification').mockImplementation((fn) => {
    receive = fn
    return subscribe(fn)
  })
  const previews = new ComputerPreviews({ service: h.service, sessions: h.sessions, clock })
  subscription.mockRestore()
  cleanups.push(
    () => h.close(),
    () => previews.close()
  )
  const a: Push[] = [],
    b: Push[] = []
  const va = { connection: {}, send: (f: unknown) => a.push(f as Push) }
  const vb = { connection: {}, send: (f: unknown) => b.push(f as Push) }
  return { h, previews, clock, a, b, va, vb, receive: (n: ComputerNotification) => receive(n) }
}
const starts = (h: ComputerHarness) =>
  h.requests().filter((r) => r.method === 'capture.stream.start')
const stopped = (h: ComputerHarness) =>
  h.requests().filter((r) => r.method === 'capture.stream.stop')

describe('ComputerPreviews over tc-computer', () => {
  it('uses the bound pid and window and sends frames only to the asking socket', async () => {
    const { h, previews, a, b, va } = await setup()
    const result = await previews.start(va, { threadId: 't1', maxEdge: 512 })
    expect(result).toMatchObject({ app: 'TextEdit', window: 'Untitled', width: 512, height: 429 })
    expect(starts(h)[0].params).toMatchObject({
      session: 't1',
      app: { pid: 16800 },
      window: { id: 1581 },
      fps: 4,
      maxEdge: 512
    })
    await vi.waitFor(() => expect(a.some((f) => f.push === 'computer-frame')).toBe(true))
    expect(b).toEqual([])
    const frame = a.find((f) => f.push === 'computer-frame')!
    previews.ack({}, result.preview, frame.seq)
    previews.ack(va.connection, result.preview, frame.seq)
    await vi.waitFor(() =>
      expect(a.filter((f) => f.push === 'computer-frame').length).toBeGreaterThan(1)
    )
  })
  it('shares the largest edge, reduces it when needed, and stops the last socket', async () => {
    const { h, previews, va, vb } = await setup()
    const first = await previews.start(va, { threadId: 't1', maxEdge: 960 })
    const second = await previews.start(vb, { threadId: 't1', maxEdge: 256 })
    expect(starts(h)).toHaveLength(1)
    expect(second.width).toBe(960)
    await previews.stop({}, first.preview)
    expect(stopped(h)).toHaveLength(0)
    await previews.stop(va.connection, first.preview)
    expect(starts(h).at(-1)?.params.maxEdge).toBe(256)
    previews.dropConnection(vb.connection)
    await vi.waitFor(() => expect(stopped(h)).toHaveLength(2))
    expect(starts(h)).toHaveLength(2)
  })
  it('answers overlapping starts from the shared stream that actually started', async () => {
    const { h, previews, va, vb } = await setup()
    const [a, b] = await Promise.all([
      previews.start(va, { threadId: 't1', maxEdge: 256 }),
      previews.start(vb, { threadId: 't1', maxEdge: 960 })
    ])
    expect(a).toMatchObject({ app: 'TextEdit', width: 960 })
    expect(b).toMatchObject({ app: 'TextEdit', width: 960 })
    expect(a.preview).not.toBe(b.preview)
    expect(starts(h)).toHaveLength(1)
  })
  it('raises an existing stream to a new watcher’s larger edge', async () => {
    const { h, previews, va, vb } = await setup()
    await previews.start(va, { threadId: 't1', maxEdge: 256 })
    expect((await previews.start(vb, { threadId: 't1', maxEdge: 960 })).width).toBe(960)
    expect(starts(h).map((r) => r.params.maxEdge)).toEqual([256, 960])
  })
  it('keeps watcher ids across targets, drops old clicks, and carries a new window’s click', async () => {
    const { h, previews, va, vb, a, b, receive } = await setup({ FAKE_NO_FRAMES: '1' })
    const first = await previews.start(va, { threadId: 't1', maxEdge: 512 })
    const second = await previews.start(vb, { threadId: 't1', maxEdge: 512 })
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click', coordinate: [640, 536] })
    await vi.waitFor(() => expect(a.some((f) => f.push === 'computer-click')).toBe(true))
    expect(a.find((f) => f.push === 'computer-click')).toMatchObject({
      preview: first.preview,
      at: [256, 215],
      width: 512
    })
    expect(b.find((f) => f.push === 'computer-click')?.preview).toBe(second.preview)
    const old = String(starts(h)[0].params.stream)
    await h.run('computer_act', { app: 'Thin', action: 'left_click', coordinate: [640, 536] })
    await vi.waitFor(() => expect(a.findLast((f) => f.state === 'live')?.app).toBe('Thin'))
    await vi.waitFor(() => expect(a.filter((f) => f.push === 'computer-click')).toHaveLength(2))
    expect(a.filter((f) => f.state === 'live').at(-1)?.preview).toBe(first.preview)
    receive({
      method: 'capture/click',
      params: { stream: old, at: [0, 0], width: 512, height: 429 }
    })
    expect(a.filter((f) => f.push === 'computer-click')).toHaveLength(2)
    receive({
      method: 'capture/click',
      params: {
        stream: String(starts(h).at(-1)!.params.stream),
        at: [20, 30],
        width: 512,
        height: 429
      }
    })
    expect(a.at(-1)).toMatchObject({ push: 'computer-click', preview: first.preview, at: [20, 30] })
    expect(b.at(-1)).toMatchObject({
      push: 'computer-click',
      preview: second.preview,
      at: [20, 30]
    })
    expect(a.some((f) => f.push === 'computer-frame')).toBe(false)
  })
  it('ends a departed row and stops its stream', async () => {
    const { h, previews, va, a, clock } = await setup()
    await previews.start(va, { threadId: 't1', maxEdge: 512 })
    h.set('t1', { status: 'done' })
    await clock.advance(250)
    await vi.waitFor(() => expect(a.at(-1)).toMatchObject({ state: 'ended', reason: 'closed' }))
    await vi.waitFor(() => expect(stopped(h)).toHaveLength(1))
  })
  it('keeps an end that arrives before the stream start answer', async () => {
    const { h, previews, va, a, receive } = await setup()
    let finish!: (value: { stream: string; width: number; height: number }) => void
    const pending = new Promise<{ stream: string; width: number; height: number }>((resolve) => {
      finish = resolve
    })
    const request = vi.spyOn(h.service, 'request').mockReturnValueOnce(pending)
    const starting = previews.start(va, { threadId: 't1', maxEdge: 512 })
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('capture.stream.start', expect.any(Object))
    )
    const stream = (request.mock.calls[0][1] as { stream: string }).stream
    receive({ method: 'capture/streamEnded', params: { stream, reason: 'window-closed' } })
    finish({ stream, width: 512, height: 429 })
    await starting
    expect(a.at(-1)).toMatchObject({ state: 'ended', reason: 'window-closed' })
    expect(a.some((f) => f.state === 'live')).toBe(false)
  })
  it.each(['window-closed', 'permission'])('ends on streamEnded %s', async (reason) => {
    const { previews, va, a } = await setup({
      FAKE_STREAM_END_MS: '30',
      FAKE_STREAM_END_REASON: reason
    })
    await previews.start(va, { threadId: 't1', maxEdge: 512 })
    await vi.waitFor(() => expect(a.at(-1)).toMatchObject({ state: 'ended', reason }))
  })
  it.each([
    ['Notes', {}, 'minimized'],
    [undefined, { FAKE_SCREEN_RECORDING: '0' }, 'permission']
  ] as const)('reports refused starts as %s / %s', async (window, env, reason) => {
    const { h, previews, va, a } = await setup(env)
    if (window) await h.run('computer_observe', { app: 'TextEdit', window })
    await previews.start(va, { threadId: 't1', maxEdge: 512 })
    expect(a.at(-1)).toMatchObject({ state: 'ended', reason })
  })
  it('reopens the session and resumes after a service epoch', async () => {
    const { h, previews, va, a } = await setup()
    const result = await previews.start(va, { threadId: 't1', maxEdge: 512 })
    const conn = await h.service.connection()
    conn.kill()
    await conn.exited
    await h.service.connection()
    await vi.waitFor(() => expect(starts(h)).toHaveLength(2))
    await vi.waitFor(() => expect(a.filter((f) => f.state === 'live')).toHaveLength(2))
    expect(a.filter((f) => f.state === 'live').at(-1)?.preview).toBe(result.preview)
    expect(h.requests().filter((r) => r.method === 'session.open')).toHaveLength(2)
  })
  it('ends a failed restart with restarted, and leaves no stream after a start races socket close', async () => {
    const { h, previews, va, a } = await setup()
    await previews.start(va, { threadId: 't1', maxEdge: 512 })
    vi.spyOn(h.sessions, 'ensureOpen').mockRejectedValueOnce(new Error('reopen failed'))
    const conn = await h.service.connection()
    conn.kill()
    await conn.exited
    await h.service.connection()
    await vi.waitFor(() => expect(a.at(-1)).toMatchObject({ state: 'ended', reason: 'restarted' }))
    const starting = previews.start(va, { threadId: 't1', maxEdge: 512 })
    previews.dropConnection(va.connection)
    await starting
    await previews.close()
    expect(stopped(h).length).toBeGreaterThan(0)
  })
  it('handles ack and stop requests with socket ownership and refuses invalid sizes', async () => {
    const { previews, va, a } = await setup()
    const started = await handleComputerPreview(
      { id: 'p', method: 'computer.preview.start', params: { threadId: 't1', maxEdge: 512 } },
      previews,
      va
    )
    const preview = (started.result as { preview: string }).preview
    await vi.waitFor(() => expect(a.some((f) => f.push === 'computer-frame')).toBe(true))
    const seq = a.find((f) => f.push === 'computer-frame')!.seq
    expect(
      await handleComputerPreview(
        { id: 'a', method: 'computer.preview.ack', params: { preview, seq } },
        previews,
        va
      )
    ).toEqual({ handled: true, result: null })
    expect(
      await handleComputerPreview(
        { id: 's', method: 'computer.preview.stop', params: { preview } },
        previews,
        va
      )
    ).toEqual({ handled: true, result: null })
    await expect(previews.start(va, { threadId: 't1', maxEdge: 100 })).rejects.toThrow(
      'Invalid preview size'
    )
    await previews.close()
    await expect(previews.start(va, { threadId: 't1', maxEdge: 512 })).rejects.toThrow('closed')
  })
  it('notifies only when the last app or bound window changes and refuses reopening closed rows', async () => {
    const { h } = await setup()
    const changed = vi.fn()
    const off = h.sessions.onTarget(changed)
    expect(h.sessions.previewTarget('t1')).toMatchObject({
      serviceSession: 't1',
      app: { pid: 16800 },
      window: { id: 1581 }
    })
    await h.run('computer_observe', { app: 'TextEdit' })
    expect(changed).not.toHaveBeenCalled()
    await h.run('computer_observe', { app: 'TextEdit', window: 'Notes' })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(h.sessions.previewTarget('t1')?.window.id).toBe(1582)
    await h.run('computer_observe', { app: 'Thin' })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(h.sessions.previewTarget('t1')?.app.name).toBe('Thin')
    off()
    await h.sessions.stop('t1')
    expect(h.sessions.previewTarget('t1')).toBeNull()
    await expect(h.sessions.ensureOpen('t1')).rejects.toThrow('closed')
  })
  it('refuses unavailable hosts and unknown windows through the request handler', async () => {
    const { previews, va } = await setup()
    const req = {
      id: 'p',
      method: 'computer.preview.start',
      params: { threadId: 'missing', maxEdge: 512 }
    } as const
    await expect(handleComputerPreview(req, null, va)).rejects.toThrow('not available here')
    await expect(handleComputerPreview(req, previews, va)).rejects.toThrow('No computer window')
    expect(
      await handleComputerPreview(
        { id: 'x', method: 'computer.sessions', params: {} },
        previews,
        va
      )
    ).toEqual({ handled: false })
  })
})
