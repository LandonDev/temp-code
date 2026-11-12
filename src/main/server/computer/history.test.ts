import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComputerHistoryStep } from '@shared/contract-computer'
import { ComputerHistory, HISTORY_COMPACT_SLACK, HISTORY_KEEP_CALLS, HISTORY_KEEP_LINES, HISTORY_KEEP_MS, HISTORY_PAGE, PICTURE_TIMEOUT_MS, capturePicture, historyPicturesFromEnv, type HistoryChange } from './history'
import { computerHarness, type ComputerHarness } from './runHarness'
import { serviceSessionId } from './sessionId'
import { FAKE_APPS, ManualClock } from './testFake'

const step = (verb: string, object = 'Save', extra: Partial<ComputerHistoryStep> = {}): ComputerHistoryStep => ({ kind: 'click', verb, object, inApp: `${object} in TextEdit`, ...extra })
const start = (extra: object = {}) => ({ app: 'TextEdit', window: 'Untitled', steps: [step('Clicking')], ...extra })
const end = (extra: object = {}) => ({ app: 'TextEdit', window: 'Untitled', steps: [step('Clicked', 'Save', { state: 'ok', tier: 'ax' })], ...extra })
const JPEG = Buffer.from('/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAJgABAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwA//9k=', 'base64')

const open: ComputerHistory[] = []
function journal(opts: { root?: string; pictures?: () => boolean; log?: (line: string) => void } = {}) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'tc-history-'))
  let t = 1_000
  const changes: HistoryChange[] = []
  const history = new ComputerHistory({ root, now: () => (t += 10), ...(opts.pictures ? { pictures: opts.pictures } : {}), ...(opts.log ? { log: opts.log } : {}) })
  history.onChange((c) => changes.push(c))
  open.push(history)
  const shotFile = join(mkdtempSync(join(tmpdir(), 'tc-history-shot-')), 'shot.jpg')
  writeFileSync(shotFile, JPEG)
  return {
    root,
    history,
    changes,
    shot: { shot: { path: shotFile, width: 960, height: 804, capturedAt: 5_000 } },
    dir: (key: string) => join(root, serviceSessionId(key)),
    lines: (key: string) => readFileSync(join(root, serviceSessionId(key), 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    calls: async (key: string, before?: number) => (await history.read([key], before))[0]
  }
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

describe('the journal folds a call from its records', () => {
  it('start, end and picture are one call, each record a revision and a change', async () => {
    const j = journal()
    const entry = j.history.begin('t1', start({ plan: ['click button "Save"', 'press super+s'] }))
    expect(await entry.n()).toBe(1)
    expect((await j.calls('t1')).calls).toEqual([
      { n: 1, turn: 1, at: 1010, state: 'running', app: 'TextEdit', window: 'Untitled', steps: [step('Clicking')], plan: ['click button "Save"', 'press super+s'], text: false, rev: 1 }
    ])
    await entry.end(end({ read: 'Read 3 changes', text: 'app "TextEdit" · window "Untitled" · 1280×1072 · changes since your last read\n~ [3] text area = "x"' }))
    await entry.picture(j.shot)
    const read = await j.calls('t1')
    expect(read.born).toBe(1010)
    expect(read.more).toBe(false)
    expect(read.calls).toEqual([
      {
        n: 1,
        turn: 1,
        at: 1010,
        endedAt: 1020,
        state: 'done',
        app: 'TextEdit',
        window: 'Untitled',
        steps: [step('Clicked', 'Save', { state: 'ok', tier: 'ax' })],
        read: 'Read 3 changes',
        text: true,
        picture: { width: 960, height: 804, at: 5_000 },
        rev: 3
      }
    ])
    // one change per record, each with the call as it stood
    expect(j.changes.map((c) => ('call' in c ? [c.call.state, c.call.rev, c.call.picture !== undefined] : c))).toEqual([['running', 1, false], ['done', 2, false], ['done', 3, true]])
    expect(j.lines('t1').map((l) => l.r)).toEqual(['start', 'end', 'picture'])
    for (const line of j.lines('t1')) expect(line.v).toBe(1)
    expect(readdirSync(join(j.dir('t1'), 'steps')).sort()).toEqual(['1.jpg', '1.txt'])
  })

  it('a step answers the picture bytes and the text, and nothing for a call it does not hold', async () => {
    const j = journal()
    const entry = j.history.begin('t1', start())
    await entry.end(end({ read: 'Read 1 change', text: 'the read' }))
    await entry.picture(j.shot)
    const got = await j.history.step('t1', 1)
    expect(got.text).toBe('the read')
    expect(got.picture).toEqual({ data: JPEG.toString('base64'), mimeType: 'image/jpeg', width: 960, height: 804, at: 5_000 })
    expect(await j.history.step('t1', 2)).toEqual({})
    expect(await j.history.step('other', 1)).toEqual({})
  })

  it('a reason takes the picture’s place, and a call with none yet says nothing of it', async () => {
    const j = journal()
    const a = j.history.begin('t1', start())
    await a.end(end())
    expect((await j.calls('t1')).calls[0].picture).toBeUndefined()
    await a.picture({ none: 'minimized' })
    expect((await j.calls('t1')).calls[0]).toMatchObject({ picture: { none: 'minimized' }, rev: 3 })
    expect(j.lines('t1').at(-1)).toEqual({ v: 1, r: 'picture', n: 1, none: 'minimized' })
    expect(await j.history.step('t1', 1)).toEqual({})
  })

  it('the read text is cut at its budget', async () => {
    const j = journal()
    const entry = j.history.begin('t1', start())
    await entry.end(end({ read: 'Read 900 elements', text: Array.from({ length: 900 }, (_, i) => `[${i + 1}] button "Row ${i}"`).join('\n') }))
    const text = (await j.history.step('t1', 1)).text!
    expect(Buffer.byteLength(text)).toBeLessThan(12_100)
    expect(text.split('\n').at(-1)).toMatch(/^… cut here, \d+ more lines$/)
  })
})

describe('n, turn and born', () => {
  it('n counts per thread; a turn starts at the first call after beginTurn', async () => {
    const j = journal()
    const a = j.history.begin('t1', start())
    const b = j.history.begin('t1', start())
    j.history.beginTurn('t1')
    j.history.beginTurn('t1')
    const c = j.history.begin('t1', start())
    const other = j.history.begin('t2', start())
    expect([await a.n(), await b.n(), await c.n(), await other.n()]).toEqual([1, 2, 3, 1])
    expect((await j.calls('t1')).calls.map((x) => x.turn)).toEqual([1, 1, 2])
    expect((await j.calls('t2')).calls.map((x) => x.turn)).toEqual([1])
  })

  it("a bridged call's turn follows its box's token, whatever beginTurn said", async () => {
    const j = journal()
    j.history.begin('mac:box:t', start({ token: 'turn-a' }))
    j.history.beginTurn('mac:box:t')
    j.history.begin('mac:box:t', start({ token: 'turn-a' }))
    j.history.begin('mac:box:t', start({ token: 'turn-b' }))
    expect((await j.calls('mac:box:t')).calls.map((x) => x.turn)).toEqual([1, 1, 2])
    expect(j.lines('mac:box:t').map((l) => l.token)).toEqual(['turn-a', 'turn-a', 'turn-b'])
  })

  it('after a restart both continue from the highest value in the log, and a new process is a new turn', async () => {
    const j = journal()
    const a = j.history.begin('t1', start())
    j.history.beginTurn('t1')
    const b = j.history.begin('t1', start())
    await b.end(end())
    // the picture of call 1 lands after call 2's end: the log's last line is not its highest call
    await a.end(end())
    await a.picture({ none: 'failed' })
    await j.history.close()
    expect(j.lines('t1').at(-1)).toMatchObject({ r: 'picture', n: 1 })

    const again = journal({ root: j.root })
    const c = again.history.begin('t1', start())
    expect(await c.n()).toBe(3)
    const read = await again.calls('t1')
    expect(read.calls.map((x) => [x.n, x.turn, x.state])).toEqual([[1, 1, 'done'], [2, 2, 'done'], [3, 3, 'running']])
    expect(read.born).toBe(1010)
  })

  it("an idle close inside one of a box thread's turns does not split it: the token is in the record", async () => {
    const j = journal()
    await j.history.begin('mac:box:t', start({ token: 'turn-a' })).end(end())
    await j.history.close()
    const again = journal({ root: j.root })
    again.history.begin('mac:box:t', start({ token: 'turn-a' }))
    again.history.begin('mac:box:t', start({ token: 'turn-b' }))
    expect((await again.calls('mac:box:t')).calls.map((x) => x.turn)).toEqual([1, 1, 2])
  })

  it('a start whose end never came is unfinished once its process is gone', async () => {
    const j = journal()
    j.history.begin('t1', start())
    expect((await j.calls('t1')).calls[0].state).toBe('running')
    await j.history.close()
    const again = journal({ root: j.root })
    // the flip is a revision: a reader that held it running takes the unfinished call
    expect((await again.calls('t1')).calls[0]).toMatchObject({ state: 'unfinished', rev: 2 })
  })

  it('a call that never finished reads as what was asked of it; while it runs, and once it ends, it reads as it was written', async () => {
    const j = journal()
    const asked = { verb: 'Click', object: 'Save', inApp: 'Save in TextEdit' }
    j.history.begin('t1', { ...start(), steps: [{ ...step('Clicking'), asked }] })
    const done = j.history.begin('t1', { ...start(), steps: [{ ...step('Clicking'), asked }] })
    await done.end(end())
    const live = (await j.calls('t1')).calls
    expect(live.map((c) => [c.state, c.steps[0].verb])).toEqual([['running', 'Clicking'], ['done', 'Clicked']])
    // a call that runs keeps what was asked beside its words (a step held before it began reads by it); an ended one has none
    expect(live[0].steps[0].asked).toEqual(asked)
    expect(live[1].steps[0]).not.toHaveProperty('asked')
    await j.history.close()
    const again = journal({ root: j.root })
    const reloaded = (await again.calls('t1')).calls
    expect(reloaded.map((c) => [c.state, c.steps[0].verb])).toEqual([['unfinished', 'Click'], ['done', 'Clicked']])
    expect(reloaded[0].steps[0]).not.toHaveProperty('asked')
    expect(reloaded[0].rev).toBeGreaterThan(live[0].rev)
  })

  it('a read that waited out a removal answers nothing of what went', async () => {
    const j = journal()
    await j.history.begin('t1', start()).end(end())
    await j.calls('t1')
    // the read is asked, then the history removed before the read's turn comes
    const reading = j.history.read(['t1'])
    const removing = j.history.remove('t1')
    expect((await reading)[0]).toEqual({ key: 't1', born: 0, calls: [], more: false })
    await removing
    expect(await j.history.step('t1', 1)).toEqual({})
  })

  it('a log that passes its bound inside one host run is written again too, and its reader keeps its born', async () => {
    const j = journal()
    const dir = j.dir('t1')
    mkdirSync(join(dir, 'steps'), { recursive: true })
    const total = HISTORY_KEEP_LINES + HISTORY_COMPACT_SLACK
    const records: string[] = []
    for (let n = 1; n <= total; n++) {
      records.push(JSON.stringify({ v: 1, r: 'start', n, turn: 1, at: n * 10, ...start() }))
      records.push(JSON.stringify({ v: 1, r: 'end', n, at: n * 10 + 1, ...end() }))
    }
    // a log just under the bound it is loaded at... which is itself over the kept lines: loading compacts once
    writeFileSync(join(dir, 'log.jsonl'), records.slice(0, HISTORY_KEEP_LINES * 2).join('\n') + '\n')
    const born = (await j.calls('t1')).born
    // the run goes on past the slack
    for (let i = 0; i < HISTORY_COMPACT_SLACK + 1; i++) await j.history.begin('t1', start()).end(end())
    const lines = j.lines('t1')
    expect(new Set(lines.map((l) => l.n)).size).toBe(HISTORY_KEEP_LINES)
    expect(lines.at(-1)).toMatchObject({ r: 'end', n: HISTORY_KEEP_LINES + HISTORY_COMPACT_SLACK + 1 })
    const read = await j.calls('t1')
    expect(read.born).toBe(born)
    expect(read.calls.at(-1)!.n).toBe(HISTORY_KEEP_LINES + HISTORY_COMPACT_SLACK + 1)
  })

  it('a key with nothing on disk is not loaded for a reader, and still takes its first call', async () => {
    const j = journal()
    const loaded = (): number => (j.history as unknown as { states: Map<string, unknown> }).states.size
    expect(await j.history.read(['nobody', 'no-one'])).toEqual([{ key: 'nobody', born: 0, calls: [], more: false }, { key: 'no-one', born: 0, calls: [], more: false }])
    expect(await j.history.step('nobody', 1)).toEqual({})
    expect(loaded()).toBe(0)
    await j.history.begin('nobody', start()).end(end())
    expect((await j.calls('nobody')).calls).toHaveLength(1)
    expect(loaded()).toBe(1)
  })

  it('a log past its bound is written again with its newest calls when it is loaded; the counters go on', async () => {
    const j = journal()
    const dir = j.dir('t1')
    mkdirSync(join(dir, 'steps'), { recursive: true })
    const total = HISTORY_KEEP_LINES + 5
    const records: string[] = []
    for (let n = 1; n <= total; n++) {
      records.push(JSON.stringify({ v: 1, r: 'start', n, turn: Math.ceil(n / 10), at: n * 10, ...start() }))
      records.push(JSON.stringify({ v: 1, r: 'end', n, at: n * 10 + 1, ...end() }))
    }
    writeFileSync(join(dir, 'log.jsonl'), records.join('\n') + '\n')
    const newest = await j.calls('t1')
    expect(newest.calls.at(-1)!.n).toBe(total)
    // born moved to the oldest call still kept, which tells a reader to drop the ones that went
    expect(newest.born).toBe(60)
    const kept = j.lines('t1')
    expect(kept).toHaveLength(HISTORY_KEEP_LINES * 2)
    expect(kept[0]).toMatchObject({ r: 'start', n: 6 })
    expect(existsSync(join(dir, 'log.jsonl.tmp'))).toBe(false)
    // the oldest page ends at the oldest kept call
    let before = newest.calls[0].n
    let oldest = before
    for (;;) {
      const page = await j.calls('t1', before)
      if (!page.calls.length) break
      oldest = before = page.calls[0].n
    }
    expect(oldest).toBe(6)
    // the next call goes on from the highest number and turn the log held
    const next = j.history.begin('t1', start())
    expect(await next.n()).toBe(total + 1)
    expect((await j.calls('t1')).calls.at(-1)!.turn).toBe(Math.ceil(total / 10) + 1)
  })

  it('a torn last line and a foreign line are skipped', async () => {
    const j = journal()
    await j.history.begin('t1', start()).end(end())
    await j.history.close()
    appendFileSync(join(j.dir('t1'), 'log.jsonl'), '{"v":2,"r":"start","n":9}\nnot json\n{"v":1,"r":"end","n":7,"at":1}\n{"v":1,"r":"start","n":2,"turn":1,"at":2000,"app":"TextEdit","wind')
    const again = journal({ root: j.root })
    const read = await again.calls('t1')
    expect(read.calls.map((x) => [x.n, x.state])).toEqual([[1, 'done']])
    // the counter still clears the end with no start
    const next = again.history.begin('t1', start())
    expect(await next.n()).toBe(8)
    // the new call's records start on a line of their own, never joined to the torn one: it is there at the next load
    await next.end(end({ read: 'Read 3 changes', text: 'the read' }))
    await next.picture(again.shot)
    await again.history.close()
    const third = journal({ root: j.root })
    const reloaded = (await third.calls('t1')).calls
    expect(reloaded.map((x) => [x.n, x.state])).toEqual([[1, 'done'], [8, 'done']])
    expect(reloaded[1]).toMatchObject({ text: true, picture: { width: 960, height: 804 } })
    expect((await third.history.step('t1', 8)).text).toBe('the read')
  })

  it('a log that cannot be read is not an empty history: the read fails, nothing is journaled over it, and it is read again when it can be', async () => {
    const j = journal()
    for (let i = 0; i < 3; i++) await j.history.begin('t1', start()).end(end({ read: 'Read 3 changes', text: `read ${i + 1}` }))
    await j.history.close()
    const log = join(j.dir('t1'), 'log.jsonl')
    const bytes = readFileSync(log)
    // the log's place holds something that cannot be read as a file: an error that is not "no such file"
    rmSync(log)
    mkdirSync(log)
    const lines: string[] = []
    const again = journal({ root: j.root, log: (line) => lines.push(line) })
    await expect(again.history.read(['t1'])).rejects.toThrow('could not be read')
    await expect(again.history.step('t1', 1)).rejects.toThrow('could not be read')
    // a call made meanwhile answers as ever and journals nothing: it must not become call 1 over the thread's first
    const lost = again.history.begin('t1', start())
    expect(await lost.n()).toBeNull()
    await lost.end(end({ read: 'Read 1 change', text: 'never kept' }))
    expect(readFileSync(join(j.dir('t1'), 'steps', '1.txt'), 'utf8')).toBe('read 1')
    expect(lines.some((l) => l.includes('a write failed'))).toBe(true)
    // the log can be read again: the history is whole, and the next call goes on from its numbers
    rmSync(log, { recursive: true })
    writeFileSync(log, bytes)
    const read = (await again.history.read(['t1']))[0]
    expect(read.calls.map((c) => c.n)).toEqual([1, 2, 3])
    const next = again.history.begin('t1', start())
    expect(await next.n()).toBe(4)
    expect((await again.history.step('t1', 1)).text).toBe('read 1')
    // a key with no folder at all is still simply no history
    expect(await again.history.read(['nobody'])).toEqual([{ key: 'nobody', born: 0, calls: [], more: false }])
  })

  it('a kept file that cannot be read just now is not said gone: the read fails and may be asked again; one that is gone is gone', async () => {
    const j = journal()
    const entry = j.history.begin('t1', start())
    await entry.end(end({ read: 'Read 3 changes', text: 'the read' }))
    await entry.picture(j.shot)
    const jpg = join(j.dir('t1'), 'steps', '1.jpg')
    const bytes = readFileSync(jpg)
    // the picture's place holds something that is no file to read: an error that is not "no such file"
    rmSync(jpg)
    mkdirSync(jpg)
    await expect(j.history.step('t1', 1)).rejects.toThrow()
    // the host still lists it, and the next read of it works
    expect((await j.calls('t1')).calls[0].picture).toEqual({ width: 960, height: 804, at: 5_000 })
    rmSync(jpg, { recursive: true })
    writeFileSync(jpg, bytes)
    expect((await j.history.step('t1', 1)).picture?.data).toBe(bytes.toString('base64'))
    // a file that is not there is gone, and the list says so
    rmSync(jpg)
    expect((await j.history.step('t1', 1)).picture).toBeUndefined()
    expect((await j.calls('t1')).calls[0].picture).toEqual({ none: 'gone' })
  })

  it('a history removed and begun again has a new born, and its numbers start over', async () => {
    const j = journal()
    const old = j.history.begin('t1', start())
    await old.end(end())
    const born = (await j.calls('t1')).born
    await j.history.remove('t1')
    expect(existsSync(j.dir('t1'))).toBe(false)
    expect(j.changes.at(-1)).toEqual({ key: 't1', gone: true })
    expect(await j.calls('t1')).toEqual({ key: 't1', born: 0, calls: [], more: false })
    const fresh = j.history.begin('t1', start())
    expect(await fresh.n()).toBe(1)
    expect((await j.calls('t1')).born).toBeGreaterThan(born)
  })
})

describe('best effort', () => {
  it('a failed append is logged once, changes no answer and keeps the call for this process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-history-'))
    // the key's directory is a file: every write under it fails
    writeFileSync(join(root, 't1'), 'in the way')
    const logged: string[] = []
    const j = journal({ root, log: (l) => logged.push(l) })
    const entry = j.history.begin('t1', start())
    await expect(entry.n()).resolves.toBe(1)
    await expect(entry.end(end({ read: 'Read 1 change', text: 'text' }))).resolves.toBeUndefined()
    await expect(entry.picture(j.shot)).resolves.toBeUndefined()
    const second = j.history.begin('t1', start())
    await expect(second.end(end())).resolves.toBeUndefined()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('computer history')
    // what could not be written is not claimed: no text, and the picture is a failure
    expect((await j.calls('t1')).calls.map((c) => [c.state, c.text, c.picture])).toEqual([['done', false, { none: 'failed' }], ['done', false, undefined]])
  })

  it('a listener that throws stops nothing', async () => {
    const j = journal()
    j.history.onChange(() => {
      throw new Error('boom')
    })
    await j.history.begin('t1', start()).end(end())
    expect(j.lines('t1')).toHaveLength(2)
  })
})

describe('read pages by n', () => {
  it('the newest 200, then the 200 under before, and more says there is older', async () => {
    const j = journal()
    for (let i = 0; i < HISTORY_PAGE + 30; i++) void j.history.begin('t1', start()).end(end())
    const newest = await j.calls('t1')
    expect(newest.calls).toHaveLength(HISTORY_PAGE)
    expect([newest.calls[0].n, newest.calls.at(-1)!.n, newest.more]).toEqual([31, 230, true])
    const older = await j.calls('t1', 31)
    expect([older.calls[0].n, older.calls.at(-1)!.n, older.more]).toEqual([1, 30, false])
    // several keys answer in one read, a key with nothing among them
    const both = await j.history.read(['t1', 'nobody'])
    expect(both.map((r) => [r.key, r.calls.length])).toEqual([['t1', HISTORY_PAGE], ['nobody', 0]])
  })
})

describe('the newest 400 calls keep their picture and text', () => {
  it('the oldest pair goes when the 401st lands; its lines stay and a read says gone', async () => {
    const j = journal()
    const first = j.history.begin('t1', start())
    await first.end(end({ read: 'Read 1 change', text: 'first text' }))
    await first.picture(j.shot)
    for (let i = 1; i < HISTORY_KEEP_CALLS; i++) void j.history.begin('t1', start()).end(end())
    expect((await j.calls('t1', 2)).calls[0]).toMatchObject({ n: 1, text: true, picture: { width: 960 }, rev: 3 })
    j.changes.length = 0
    await j.history.begin('t1', start()).n()
    expect(readdirSync(join(j.dir('t1'), 'steps'))).toEqual([])
    const gone = (await j.calls('t1', 2)).calls[0]
    // each file that went is a revision, so a reader that held the old call takes this one
    expect(gone).toMatchObject({ n: 1, text: false, picture: { none: 'gone' }, rev: 5, read: 'Read 1 change' })
    expect(j.changes.some((c) => 'call' in c && c.call.n === 1 && c.call.rev === 5)).toBe(true)
    expect(await j.history.step('t1', 1)).toEqual({})
    expect(j.lines('t1').filter((l) => l.n === 1).map((l) => l.r)).toEqual(['start', 'end', 'picture'])
  })
})

describe('removal, the switch and the prune', () => {
  it('nothing lands after a removal: an entry begun before it writes nothing', async () => {
    const j = journal()
    const entry = j.history.begin('t1', start())
    await entry.n()
    const removed = j.history.remove('t1')
    const ended = entry.end(end({ read: 'Read 1 change', text: 'late' }))
    const pictured = entry.picture(j.shot)
    await Promise.all([removed, ended, pictured])
    expect(existsSync(j.dir('t1'))).toBe(false)
    expect((await j.calls('t1')).calls).toEqual([])
  })

  it('a picture that lands with the switch off is not kept', async () => {
    let on = true
    const j = journal({ pictures: () => on })
    const entry = j.history.begin('t1', start())
    await entry.end(end())
    on = false
    await entry.picture(j.shot)
    expect((await j.calls('t1')).calls[0].picture).toEqual({ none: 'off' })
    expect(readdirSync(join(j.dir('t1'), 'steps'))).toEqual([])
  })

  it('turning the switch off removes every kept picture, loaded or not; the lines and the texts stay', async () => {
    const j = journal()
    for (const key of ['t1', 't2']) {
      const entry = j.history.begin(key, start())
      await entry.end(end({ read: 'Read 1 change', text: 'kept text' }))
      await entry.picture(j.shot)
    }
    await j.history.close()
    const again = journal({ root: j.root })
    await again.calls('t1')
    again.changes.length = 0
    await again.history.dropPictures()
    for (const key of ['t1', 't2']) expect(readdirSync(join(j.dir(key), 'steps'))).toEqual(['1.txt'])
    expect((await again.calls('t1')).calls[0]).toMatchObject({ picture: { none: 'gone' }, text: true, rev: 4 })
    expect((await again.calls('t2')).calls[0]).toMatchObject({ picture: { none: 'gone' }, text: true })
    // the loaded key's readers hear it
    expect(again.changes).toEqual([{ key: 't1', call: expect.objectContaining({ n: 1, picture: { none: 'gone' } }) }])
    expect(again.lines('t1')).toHaveLength(3)
  })

  it('a history whose log was not written for 30 days goes; a newer one and one in flight stay', async () => {
    const j = journal()
    for (const key of ['old', 'new', 'busy']) await j.history.begin(key, start()).end(end())
    j.history.begin('busy', start())
    await j.calls('busy')
    await j.history.close()
    const longAgo = new Date(Date.now() - HISTORY_KEEP_MS - 60_000)
    for (const key of ['old', 'busy']) utimesSync(join(j.dir(key), 'log.jsonl'), longAgo, longAgo)
    // an unloaded old history too
    mkdirSync(join(j.root, 'stray', 'steps'), { recursive: true })
    writeFileSync(join(j.root, 'stray', 'log.jsonl'), '')
    utimesSync(join(j.root, 'stray', 'log.jsonl'), longAgo, longAgo)
    j.changes.length = 0
    await j.calls('old')
    await j.history.prune(Date.now())
    expect(readdirSync(j.root).sort()).toEqual(['busy', 'new'])
    expect(j.changes).toContainEqual({ key: 'old', gone: true })
  })
})

describe('a key never escapes its directory', () => {
  it('any key lands in one directory right under the root', async () => {
    const j = journal()
    const keys = ['../../etc/passwd', '..', '.', '/abs/path', 'a/b', 'mac:env_1:thread', 'x'.repeat(300), 'plain-Thread_1']
    for (const key of keys) await j.history.begin(key, start()).end(end())
    const names = readdirSync(j.root)
    expect(names).toHaveLength(keys.length)
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(names).toContain('plain-Thread_1')
    // and a read of each finds its own
    for (const key of keys) expect((await j.calls(key)).calls).toHaveLength(1)
  })
})

describe('the picture seam', () => {
  it('no pictures under TEMP_CODE_COMPUTER_HISTORY=0, nor in a proof instance without the override', () => {
    expect(historyPicturesFromEnv({})).toBe(true)
    expect(historyPicturesFromEnv({ TEMP_CODE_COMPUTER_HISTORY: '0' })).toBe(false)
    expect(historyPicturesFromEnv({ TEMP_CODE_E2E_STATUS: '1' })).toBe(false)
    expect(historyPicturesFromEnv({ TEMP_CODE_E2E_STATUS: '1', TEMP_CODE_COMPUTER_HISTORY: '1' })).toBe(true)
    expect(historyPicturesFromEnv({ TEMP_CODE_E2E_STATUS: '1', TEMP_CODE_COMPUTER_HISTORY: '0' })).toBe(false)
    expect(historyPicturesFromEnv({ TEMP_CODE_COMPUTER_HISTORY: '1' })).toBe(true)
  })
})

// ── the picture: one capture.screenshot per call, on the thread's queue after the answer ──

const harnesses: ComputerHarness[] = []
const host = (opts: Parameters<typeof computerHarness>[0] = {}): ComputerHarness => {
  const h = computerHarness({ history: true, ...opts })
  harnesses.push(h)
  return h
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})
const shots = (h: ComputerHarness) => h.requests().filter((r) => r.method === 'capture.screenshot')
const callsOf = async (h: ComputerHarness, key = 't1') => {
  await h.sessions.drained(key)
  return (await h.history!.read([key]))[0].calls
}
const waitFor = async (pred: () => boolean, label: string): Promise<void> => {
  const end = Date.now() + 5_000
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('the kept picture', () => {
  it("asks the window by its id over the read's whole space, 960 at most, as a JPEG, and never by a title", async () => {
    const h = host()
    await h.run('computer_observe', { app: 'TextEdit', window: 'Untitled' })
    const [call] = await callsOf(h)
    expect(shots(h)).toHaveLength(1)
    expect(shots(h)[0].params).toEqual({
      session: 't1',
      app: { pid: FAKE_APPS.TextEdit.pid },
      window: { id: FAKE_APPS.TextEdit.windowId },
      region: [0, 0, 1280, 1072],
      maxEdge: 960,
      format: 'jpeg'
    })
    expect(call.picture).toMatchObject({ width: 1280, height: 1072 })
    const kept = await h.history!.step('t1', 1)
    expect(kept.picture?.mimeType).toBe('image/jpeg')
    expect(Buffer.from(kept.picture!.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    // it is the journal's own: no picture landed in the thread's attachments, none is in the answer
    expect(existsSync(join(h.landingRoot, 't1'))).toBe(false)
  })

  it('every call with a closing read gets one, an act and a batch too', async () => {
    const h = host()
    await h.run('computer_observe', { app: 'TextEdit' })
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    await h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'key', text: 'super+a' }, { action: 'key', text: 'super+c' }] })
    await h.run('computer_apps', {})
    const calls = await callsOf(h)
    expect(shots(h)).toHaveLength(3)
    expect(calls.map((c) => (c.picture && 'none' in c.picture ? c.picture.none : 'kept'))).toEqual(['kept', 'kept', 'kept', 'no-read'])
  })

  it("the caller has its answer before the picture is asked, and the thread's next call runs after it", async () => {
    const h = host({ env: { FAKE_SHOT_MS: '80' } })
    const order: string[] = []
    const a = h.run('computer_observe', { app: 'TextEdit' }).then((o) => {
      // A's answer is back: its picture has not been asked yet
      order.push(`a answered, ${shots(h).length} picture(s) asked`)
      return o
    })
    const b = h.run('computer_observe', { app: 'TextEdit', full: true }).then((o) => {
      order.push(`b answered, ${shots(h).length} picture(s) asked`)
      return o
    })
    await Promise.all([a, b])
    expect(order).toEqual(['a answered, 0 picture(s) asked', 'b answered, 1 picture(s) asked'])
    // B's read went to the service only after A's picture answered
    const methods = h.requests().map((r) => r.method).filter((m) => m === 'state.get' || m === 'capture.screenshot')
    expect(methods.slice(0, 3)).toEqual(['state.get', 'capture.screenshot', 'state.get'])
    expect((await callsOf(h)).map((c) => c.picture && !('none' in c.picture))).toEqual([true, true])
  })

  it('is given up after two seconds: the request is cancelled and the queue moves on', async () => {
    const clock = new ManualClock()
    const h = host({ clock, env: { FAKE_SHOT_MS: '60000' } })
    await h.run('computer_observe', { app: 'TextEdit' })
    await waitFor(() => shots(h).length === 1, 'the picture request')
    const next = h.run('computer_observe', { app: 'TextEdit' })
    let answered = false
    void next.then(() => (answered = true))
    await clock.advance(PICTURE_TIMEOUT_MS - 1)
    expect(answered).toBe(false)
    await clock.advance(2)
    await next
    await waitFor(() => h.requests().some((r) => r.method === '$/cancel'), 'the cancel')
    // the second call's picture is as slow: give it up too, so the queue drains
    await waitFor(() => shots(h).length === 2, 'the second picture request')
    await clock.advance(PICTURE_TIMEOUT_MS + 1)
    expect((await callsOf(h)).map((c) => c.picture)).toEqual([{ none: 'failed' }, { none: 'failed' }])
  })

  it('a Stop gives up a picture being taken: the session closes without waiting out the two seconds', async () => {
    const clock = new ManualClock()
    const h = host({ clock, env: { FAKE_SHOT_MS: '60000' } })
    await h.run('computer_observe', { app: 'TextEdit' })
    await waitFor(() => shots(h).length === 1, 'the picture request')
    // no clock moves: the stop alone ends the capture
    await h.sessions.stop('t1')
    await waitFor(() => h.requests().some((r) => r.method === '$/cancel'), 'the cancel')
    expect((await callsOf(h))[0].picture).toEqual({ none: 'failed' })
    expect(h.requests().some((r) => r.method === 'session.close')).toBe(true)
  })

  it('a signal already fired, or fired while the capture is out, answers at once', async () => {
    const h = host({ env: { FAKE_SHOT_MS: '60000' } })
    await h.run('computer_observe', { app: 'TextEdit' })
    const up = h.service.state()
    const fired = new AbortController()
    fired.abort()
    const before = shots(h).length
    const target = { session: 't1', pid: FAKE_APPS.TextEdit.pid, windowId: 1, width: 1280, height: 1072, epoch: up.epoch! }
    expect(await capturePicture(h.service, target, { signal: fired.signal })).toEqual({ none: 'failed' })
    expect(shots(h).length).toBe(before)
    const cut = new AbortController()
    const taking = capturePicture(h.service, target, { signal: cut.signal })
    cut.abort()
    expect(await taking).toEqual({ none: 'failed' })
  })

  it('sends no request with Screen Recording off, and says why', async () => {
    const h = host({ env: { FAKE_SCREEN_RECORDING: '0' } })
    await h.run('computer_observe', { app: 'TextEdit' })
    expect((await callsOf(h))[0].picture).toEqual({ none: 'permission' })
    expect(shots(h)).toHaveLength(0)
    expect(h.requests().some((r) => r.method === 'permissions.request')).toBe(false)
  })

  it('sends no request with the switch off, in a stopped or an ended thread, or for a call with no read', async () => {
    let on = false
    const h = host({ history: { pictures: () => on } })
    await h.run('computer_observe', { app: 'TextEdit' })
    expect((await callsOf(h))[0].picture).toEqual({ none: 'off' })
    on = true
    // stopped while the call was in flight: its closing read came back, its picture is not taken
    const slow = h.run('computer_act', { app: 'Slow', action: 'key', text: 'super+a' })
    await waitFor(() => h.requests().filter((r) => r.method === 'action.run').length === 1, 'the action')
    await h.sessions.stop('t1')
    await slow
    // a refused call has no closing read
    await h.run('computer_observe', { app: 'TextEdit' })
    const calls = await callsOf(h)
    expect(calls.map((c) => c.picture)).toEqual([{ none: 'off' }, { none: 'no-read' }, { none: 'no-read' }])
    expect(shots(h)).toHaveLength(0)
    // an ended thread: the call queued behind the end answers cancelled and journals nothing
    const other = h.run('computer_observe', { app: 'TextEdit' }, 't2')
    await h.sessions.end(['t2'])
    await other
    expect(shots(h)).toHaveLength(0)
  })

  it('a thread stopped between the answer and the picture takes none', async () => {
    const h = host()
    const o = h.run('computer_observe', { app: 'TextEdit' })
    // Stop lands before the queue's tail runs: the flag is set, and the tail sees it
    await o
    const stopping = h.sessions.stop('t1')
    await stopping
    const [call] = await callsOf(h)
    // either the picture was already asked before the Stop, or it was skipped: never a request after it
    const asked = shots(h).length
    expect(asked === 0 ? call.picture : { none: 'failed' }).toEqual({ none: 'failed' })
  })

  it("never starts a service or opens a session for a picture: a moved epoch is a reason and no request", async () => {
    const h = host()
    await h.run('computer_observe', { app: 'TextEdit' })
    await h.sessions.drained('t1')
    const before = h.requests().length
    const up = h.service.state()
    const target = { session: 't1', pid: FAKE_APPS.TextEdit.pid, windowId: FAKE_APPS.TextEdit.windowId, width: 1280, height: 1072, epoch: 'e-another' }
    expect(await capturePicture(h.service, target)).toEqual({ none: 'failed' })
    expect(await capturePicture(h.service, null)).toEqual({ none: 'no-read' })
    // a service that is not up is never asked, so it is never spawned for a picture
    const down = { state: () => ({ ...up, state: 'idle' as const }), permissions: () => up.permissions, request: () => Promise.reject(new Error('never asked')) }
    expect(await capturePicture(down as never, { ...target, epoch: up.epoch! })).toEqual({ none: 'failed' })
    expect(h.requests().length).toBe(before)
  })

  it('a minimized window, a blank shot and a refusal are each a reason and nothing else', async () => {
    for (const [env, none] of [
      [{ FAKE_SHOT_MINIMIZED: '1' }, 'minimized'],
      [{ FAKE_SHOT_BLANK: '1' }, 'not-drawn'],
      [{ FAKE_SHOT_REFUSE: '1' }, 'failed']
    ] as const) {
      const h = host({ env })
      const o = await h.run('computer_observe', { app: 'TextEdit' })
      expect(o.isError, none).toBe(false)
      const [call] = await callsOf(h)
      expect(call.picture, none).toEqual({ none })
      expect(shots(h), none).toHaveLength(1)
      expect(existsSync(join(h.dataDir, 'history', 't1', 'steps', '1.jpg')), none).toBe(false)
    }
    // an app the service cannot capture answers permission_missing
    const h = host()
    await h.run('computer_observe', { app: 'NoShot' })
    expect((await callsOf(h))[0].picture).toEqual({ none: 'permission' })
  })

  it('a removal during a capture leaves nothing behind', async () => {
    const h = host({ env: { FAKE_SHOT_MS: '60' } })
    await h.run('computer_observe', { app: 'TextEdit' })
    await waitFor(() => shots(h).length === 1, 'the picture request')
    await h.history!.remove('t1')
    await h.sessions.drained('t1')
    await h.history!.read(['t1'])
    expect(existsSync(join(h.dataDir, 'history', 't1'))).toBe(false)
  })

  it('the switch going off during a capture keeps no picture', async () => {
    let on = true
    const h = host({ history: { pictures: () => on }, env: { FAKE_SHOT_MS: '60' } })
    await h.run('computer_observe', { app: 'TextEdit' })
    await waitFor(() => shots(h).length === 1, 'the picture request')
    on = false
    await h.history!.dropPictures()
    const [call] = await callsOf(h)
    expect(call.picture).toEqual({ none: 'off' })
    expect(readdirSync(join(h.dataDir, 'history', 't1', 'steps')).filter((f) => f.endsWith('.jpg'))).toEqual([])
  })

  it('the picture changes no answer: the same text with the journal and without', async () => {
    const plain = computerHarness()
    harnesses.push(plain)
    const kept = host()
    const texts = async (h: ComputerHarness): Promise<string[]> => {
      const out: string[] = []
      out.push(h.text(await h.run('computer_observe', { app: 'TextEdit' })))
      out.push(h.text(await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })))
      out.push(h.text(await h.run('computer_act', { app: 'TextEdit', action: 'left_click', coordinate: [10, 10] })))
      return out
    }
    expect(await texts(kept)).toEqual(await texts(plain))
    await kept.sessions.drained('t1')
    expect(shots(kept)).toHaveLength(3)
    expect(shots(plain)).toHaveLength(0)
  })
})
