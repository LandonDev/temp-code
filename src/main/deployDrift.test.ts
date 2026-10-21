import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MASTER_FETCH_EVERY_MS,
  MASTER_FOCUS_RECHECK_MS,
  MASTER_RELEASE_URL,
  MasterReleaseWatcher,
  parseMasterRelease
} from './deployDrift'

type Answer = { ok: boolean; body: string } | Error
function harness(answers: Answer[]) {
  const calls: string[] = []
  const changes: number[] = []
  const fetch = vi.fn(async (url: string) => {
    calls.push(url)
    const a = answers.length > 1 ? answers.shift()! : answers[0]
    if (a instanceof Error) throw a
    return { ok: a.ok, text: async () => a.body }
  })
  const watcher = new MasterReleaseWatcher({ fetch, onChange: (m) => changes.push(m.release) })
  return { watcher, calls, changes }
}
const ok = (n: number): Answer => ({ ok: true, body: JSON.stringify({ n, notes: 'x', ts: 1 }) })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('parseMasterRelease', () => {
  it('reads n and refuses anything else', () => {
    expect(parseMasterRelease('{"n": 273, "notes": "x"}')).toBe(273)
    expect(parseMasterRelease('{"n": "273"}')).toBeNull()
    expect(parseMasterRelease('{"n": 0}')).toBeNull()
    expect(parseMasterRelease('<html>')).toBeNull()
  })
})

describe('MasterReleaseWatcher', () => {
  it('fetches master release.json at start and every ten minutes, no faster', async () => {
    const { watcher, calls, changes } = harness([ok(273)])
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([MASTER_RELEASE_URL])
    expect(watcher.current()).toMatchObject({ release: 273, version: '1.0.273' })
    expect(changes).toEqual([273])
    await vi.advanceTimersByTimeAsync(MASTER_FETCH_EVERY_MS - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(MASTER_FETCH_EVERY_MS)
    expect(calls).toHaveLength(3)
    // The same number again is not a change.
    expect(changes).toEqual([273])
    watcher.stop()
    await vi.advanceTimersByTimeAsync(MASTER_FETCH_EVERY_MS * 2)
    expect(calls).toHaveLength(3)
  })

  it('a window coming forward fetches again only after fifteen idle minutes', async () => {
    const { watcher, calls } = harness([ok(273)])
    await watcher.refresh()
    expect(calls).toHaveLength(1)
    watcher.focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(MASTER_FOCUS_RECHECK_MS)
    watcher.focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    watcher.focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    // While the interval runs, no focus ever comes more than ten minutes after a fetch.
    watcher.start()
    await vi.advanceTimersByTimeAsync(MASTER_FOCUS_RECHECK_MS * 4)
    const before = calls.length
    watcher.focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(before)
    watcher.stop()
  })

  it('a failed fetch is silent and keeps the last value; a later success replaces it', async () => {
    const { watcher, changes } = harness([ok(273), new Error('offline'), { ok: false, body: 'rate limited' }, { ok: true, body: 'not json' }, ok(275)])
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watcher.current()?.release).toBe(273)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(MASTER_FETCH_EVERY_MS)
      expect(watcher.current()?.release).toBe(273)
    }
    await vi.advanceTimersByTimeAsync(MASTER_FETCH_EVERY_MS)
    expect(watcher.current()?.release).toBe(275)
    expect(changes).toEqual([273, 275])
    watcher.stop()
  })

  it('starts unknown and stays unknown through failures; one refresh at a time', async () => {
    const { watcher, calls } = harness([new Error('offline')])
    expect(watcher.current()).toBeNull()
    const a = watcher.refresh()
    const b = watcher.refresh()
    expect(b).toBe(a)
    expect(await a).toBeNull()
    expect(calls).toHaveLength(1)
    expect(watcher.current()).toBeNull()
  })
})
