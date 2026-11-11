import { describe, expect, it } from 'vitest'
import { PendingCalls, type CallReader, type PendingClock } from './pending'
import { refusal, type ComputerToolOutcome } from './result'

/** Timers that run only when the test moves the clock. */
function fakeClock(): PendingClock & { advance(ms: number): Promise<void> } {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => void timers.delete(h as number),
    advance: async (ms) => {
      const end = now + ms
      for (;;) {
        await flush()
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
      await flush()
    }
  }
}

const ok = (line: string): ComputerToolOutcome => ({ steps: [line], shots: [], body: 'app "TextEdit"', isError: false })

/** One call under test: its hold, its run's end, its reader, the requests it sends. */
function setup() {
  const clock = fakeClock()
  const readerChanges: string[] = []
  const store = new PendingCalls({ clock, timings: { answerMs: 20_000, waitMs: 20_000, unreadMs: 60_000 }, readerChanged: (id) => readerChanges.push(id) })
  const start = (threadId = 't1') => {
    const c = {
      hold: null as string | null,
      reader: null as CallReader | null,
      signal: null as AbortSignal | null,
      /** steps that ran; a cancel answers them */
      ran: [] as string[],
      sent: 0,
      finish: (_o: ComputerToolOutcome) => {},
      request: (): Promise<void> => c.reader!.request(c.signal!, async () => void c.sent++),
      own: new AbortController(),
      answer: null as ComputerToolOutcome | null,
      answered: Promise.resolve(null as unknown as ComputerToolOutcome)
    }
    c.answered = store
      .start(
        {
          threadId,
          what: 'key in TextEdit',
          holdWords: () => c.hold,
          run: ({ signal, reader }) => {
            c.reader = reader
            c.signal = signal
            return new Promise((resolve) => {
              c.finish = resolve
              signal.addEventListener('abort', () => resolve(refusal(`cancelled: ${String(signal.reason)}`, c.ran)), { once: true })
            })
          }
        },
        c.own.signal
      )
      .then((o) => (c.answer = o))
    return c
  }
  const result = (id: string, cancel = false, signal = new AbortController().signal) => store.result('t1', id, cancel, signal)
  return { clock, store, start, result, readerChanges }
}

describe('PendingCalls', () => {
  it('a call done in 5 s answers its result as today', async () => {
    const { clock, start } = setup()
    const c = start()
    await clock.advance(5_000)
    c.finish(ok('key a · ax · changed'))
    await clock.advance(0)
    expect(c.answer).toEqual(ok('key a · ax · changed'))
  })

  it('a call held 20 s answers with its line and id, and runs nothing until it is read', async () => {
    const { clock, start, result } = setup()
    const c = start()
    c.hold = 'Waiting for the Mac to be free'
    await clock.advance(19_999)
    expect(c.answer).toBeNull()
    await clock.advance(1)
    expect(c.answer).toEqual({
      steps: [],
      shots: [],
      body: 'Held after 20s: Waiting for the Mac to be free. Nothing runs until you ask for it: call computer_result with id "c1". Your next other computer call cancels it.',
      isError: false
    })
    expect(c.reader!.present()).toBe(false)
    // the hold lifts: its next request waits for a reader
    c.hold = null
    const req = c.request()
    await clock.advance(1_000)
    expect(c.sent).toBe(0)
    const read = result('c1')
    await clock.advance(0)
    await req
    expect(c.sent).toBe(1)
    c.finish(ok('key a · ax · changed'))
    expect(await read).toEqual(ok('key a · ax · changed'))
  })

  it('a call running at 20 s keeps its reader and answers at its end', async () => {
    const { clock, start } = setup()
    const c = start()
    let release!: () => void
    const out = c.reader!.request(c.signal!, () => new Promise<void>((r) => (release = r)))
    await clock.advance(30_000)
    expect(c.answer).toBeNull()
    release()
    await out
    c.finish(ok('key a · ax · changed'))
    await clock.advance(0)
    expect(c.answer).toEqual(ok('key a · ax · changed'))
  })

  it('a call running at 20 s answers held once a later hold begins with nothing out', async () => {
    const { clock, store, start } = setup()
    const c = start()
    let release!: () => void
    const out = c.reader!.request(c.signal!, () => new Promise<void>((r) => (release = r)))
    await clock.advance(25_000)
    c.hold = 'Waiting for the clipboard'
    store.poke()
    await clock.advance(0)
    expect(c.answer).toBeNull()
    release()
    await out
    await clock.advance(0)
    expect(c.answer?.body).toMatch(/^Held after 25s: Waiting for the clipboard\./)
  })

  it('computer_result: still held after its wait, waits through running, the result, a spent id', async () => {
    const { clock, start, result } = setup()
    const c = start()
    c.hold = 'Waiting for your approval'
    await clock.advance(20_000)
    const still = result('c1')
    await clock.advance(20_000)
    expect((await still).body).toBe('Still held, 40s: Waiting for your approval. Call computer_result again, or go on: your next other computer call cancels it.')
    const read = result('c1')
    await clock.advance(0)
    c.hold = null
    let release!: () => void
    const out = c.reader!.request(c.signal!, () => new Promise<void>((r) => (release = r)))
    await clock.advance(25_000)
    release()
    await out
    c.finish(ok('key a · process · changed'))
    expect(await read).toEqual(ok('key a · process · changed'))
    expect(await result('c1')).toMatchObject({ isError: true, body: 'nothing held under "c1": its result was given, or it was cancelled' })
    expect(await result('c9')).toMatchObject({ isError: true, body: 'nothing held under "c9": its result was given, or it was cancelled' })
  })

  it('computer_result with cancel cancels the call and says nothing ran, or what did', async () => {
    const { clock, start, result } = setup()
    const a = start()
    a.hold = 'Waiting for your approval'
    await clock.advance(20_000)
    const cancelled = result('c1', true)
    await clock.advance(0)
    expect(a.signal!.reason).toBe('cancel')
    expect(await cancelled).toEqual({ steps: ['Cancelled c1 (key in TextEdit) before it ran.'], shots: [], body: null, isError: false })
    const b = start()
    b.ran.push('left_click [3] · ax · changed')
    b.hold = 'Waiting for the Mac to be free'
    await clock.advance(20_000)
    expect((await result('c2', true)).steps).toEqual(['Cancelled c2 (key in TextEdit); these steps ran first:', 'left_click [3] · ax · changed'])
  })

  it('a cancelled computer_result only detaches while the call is held, and cancels a call it was running for', async () => {
    const { clock, start, result } = setup()
    const c = start()
    c.hold = 'Waiting for the Mac to be free'
    await clock.advance(20_000)
    const gone = new AbortController()
    const read = result('c1', false, gone.signal)
    await clock.advance(0)
    expect(c.reader!.present()).toBe(true)
    gone.abort()
    expect((await read).isError).toBe(true)
    expect(c.signal!.aborted).toBe(false)
    expect(c.reader!.present()).toBe(false)
    // read again; this time a request is out when the read is cancelled
    const again = new AbortController()
    const read2 = result('c1', false, again.signal)
    await clock.advance(0)
    c.hold = null
    const out = c.reader!.request(c.signal!, () => new Promise<void>(() => {}))
    await clock.advance(0)
    again.abort()
    await read2
    expect(c.signal!.reason).toBe('unread')
    void out.catch(() => undefined)
  })

  it("the call's own request, cancelled while it reads, cancels the call", async () => {
    const { clock, start } = setup()
    const c = start()
    c.own.abort()
    await clock.advance(0)
    expect(c.answer).toMatchObject({ isError: true, body: 'cancelled: the call was given up' })
    expect(c.signal!.aborted).toBe(true)
  })

  it('a pending call nobody reads for 60 s is cancelled, and the next answer says so once; none while a read is in flight', async () => {
    const { clock, store, start, result } = setup()
    const c = start()
    c.hold = 'Waiting for the Mac to be free'
    await clock.advance(20_000)
    // a read in flight holds the clock off
    const read = result('c1')
    await clock.advance(19_000)
    expect(c.signal!.aborted).toBe(false)
    await clock.advance(1_000)
    await read
    await clock.advance(59_999)
    expect(c.signal!.aborted).toBe(false)
    await clock.advance(1)
    expect(c.signal!.reason).toBe('unread')
    expect(store.take('t1')).toEqual(['Cancelled c1 (key in TextEdit) before it ran.'])
    expect(store.take('t1')).toEqual([])
    expect(await result('c1')).toMatchObject({ isError: true })
  })

  it('the next other call cancels a pending one first: before and after its steps ran', async () => {
    const { clock, store, start } = setup()
    const a = start()
    a.hold = 'Waiting for your approval'
    await clock.advance(20_000)
    expect(await store.supersede('t1')).toEqual(['Cancelled c1 (key in TextEdit) before it ran.'])
    expect(a.signal!.reason).toBe('superseded')
    const b = start()
    b.ran.push('key a · ax · changed')
    b.hold = 'Waiting for the Mac to be free'
    await clock.advance(20_000)
    expect(await store.supersede('t1')).toEqual(['Cancelled c2 (key in TextEdit); these steps ran first:', 'key a · ax · changed'])
    // a call still read by its own request is not anyone's to cancel
    const c = start()
    expect(await store.supersede('t1')).toEqual([])
    expect(c.signal!.aborted).toBe(false)
  })

  it('a pending call that ended on its own unread says what it said', async () => {
    const { clock, store, start } = setup()
    const c = start()
    c.hold = 'Waiting for your approval'
    await clock.advance(20_000)
    c.finish(refusal('stopped by the person; no more computer use this turn'))
    await clock.advance(0)
    expect(await store.supersede('t1')).toEqual(['c1 (key in TextEdit) ended before its result was read: stopped by the person; no more computer use this turn'])
  })

  it('a reader that joins while the gate is being shut is told the call is read again', async () => {
    const { clock, start, result } = setup()
    const c = start()
    c.hold = 'Waiting for the Mac to be free'
    await clock.advance(20_000)
    expect(c.answer?.body).toMatch(/^Held after 20s/)
    // from here the Mac decides when the last reader may leave
    let answerMac!: (held: boolean) => void
    c.reader!.releaseBy(() => new Promise<boolean>((r) => (answerMac = r)))
    const told: boolean[] = []
    c.reader!.onChange((p) => told.push(p))
    const first = result('c1')
    await clock.advance(20_000)
    // the Mac has not answered; a second computer_result comes meanwhile
    const second = result('c1')
    await clock.advance(0)
    answerMac(true)
    await clock.advance(0)
    expect((await first).body).toMatch(/^Still held, 40s/)
    expect(c.reader!.present()).toBe(true)
    // the first read's attach, then the second reader's: the Mac reads the call again
    expect(told).toEqual([true, true])
    c.finish(ok('key a · ax · changed'))
    expect(await second).toEqual(ok('key a · ax · changed'))
  })

  it('settle and close cancel every call; unread() and readerChanged follow the pending call', async () => {
    const { clock, store, start, readerChanges } = setup()
    const a = start()
    a.hold = 'Waiting for your approval'
    await clock.advance(20_000)
    expect(store.unread('t1')).toBe(true)
    expect(readerChanges).toEqual(['t1'])
    store.settle('t1', 'settled')
    expect(a.signal!.reason).toBe('settled')
    expect(store.unread('t1')).toBe(false)
    expect(readerChanges).toEqual(['t1', 't1'])
    const b = start('t2')
    store.closeAll()
    expect(b.signal!.reason).toBe('ended')
    await clock.advance(0)
    expect(b.answer?.isError).toBe(true)
  })
})
