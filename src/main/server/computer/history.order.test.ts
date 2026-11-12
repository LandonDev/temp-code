import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComputerHistoryCall, ComputerHistoryStep } from '@shared/contract-computer'
import { ComputerHistory, HISTORY_COMPACT_SLACK, HISTORY_KEEP_LINES, HISTORY_KEEP_MS, type HistoryEntry } from './history'
import { serviceSessionId } from './sessionId'

// One order per history folder (history.ts, its head comment). This file is the table of that rule: each job that
// takes something away, against a call's begin, its end and its picture, the job first and the call first, at
// once and a tick apart; then two jobs at once with a call begun between them. After every case the call is where
// the job's own meaning leaves it, and what the journal holds in memory is what a fresh one reads from the disk.

const KEY = 't1'
const step = (verb: string, extra: Partial<ComputerHistoryStep> = {}): ComputerHistoryStep => ({ kind: 'click', verb, object: 'Save', inApp: 'Save in TextEdit', ...extra })
const start = () => ({ app: 'TextEdit', window: 'Untitled', steps: [step('Clicking')] })
const end = () => ({ app: 'TextEdit', window: 'Untitled', steps: [step('Clicked', { state: 'ok', tier: 'ax' })], read: 'Read 3 changes', text: 'app "TextEdit" · window "Untitled"\n[1] window "Untitled"' })
const JPEG = Buffer.from('/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAJgABAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwA//9k=', 'base64')

type Job = 'prune' | 'sweep' | 'switch off' | 'delete' | 'compaction'
type Op = 'begin' | 'end' | 'picture'
const GAPS = {
  'at once': async () => undefined,
  'a tick apart': () => new Promise<void>((r) => setImmediate(r))
} as const

const open: ComputerHistory[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

/** A root with one thread's history, and the journal the case works on. */
async function rig(job: Job, op: Op | null) {
  const root = mkdtempSync(join(tmpdir(), 'tc-history-order-'))
  const dir = join(root, serviceSessionId(KEY))
  const log = join(dir, 'log.jsonl')
  const shotFile = join(mkdtempSync(join(tmpdir(), 'tc-history-order-shot-')), 'shot.jpg')
  writeFileSync(shotFile, JPEG)
  const shot = { shot: { path: shotFile, width: 960, height: 804, capturedAt: 5_000 } }
  let pictures = true
  const make = (): ComputerHistory => {
    const history = new ComputerHistory({ root, pictures: () => pictures })
    open.push(history)
    return history
  }
  const old = (): void => {
    const longAgo = new Date(Date.now() - HISTORY_KEEP_MS - 60_000)
    utimesSync(log, longAgo, longAgo)
  }

  // what is there before the case: a finished call with its picture and text, or, for a log at its bound, as many
  // calls as a log may hold before it is written again
  if (job === 'compaction') {
    mkdirSync(join(dir, 'steps'), { recursive: true })
    const lines: string[] = []
    for (let n = 1; n <= HISTORY_KEEP_LINES; n++) {
      lines.push(JSON.stringify({ v: 1, r: 'start', n, turn: 1, at: n, ...start() }))
      lines.push(JSON.stringify({ v: 1, r: 'end', n, at: n, app: 'TextEdit', window: 'Untitled', steps: end().steps }))
    }
    writeFileSync(log, lines.join('\n') + '\n')
  } else {
    const first = make()
    const entry = first.begin(KEY, start())
    await entry.end(end())
    await entry.picture(shot)
    await first.close()
  }

  const live = make()
  // the job that reads a folder nobody has loaded keeps it unloaded; every other case has a reader's state there
  if (job !== 'sweep') await live.read([KEY])
  if (job === 'compaction') {
    // one short of the bound's slack, so the next start is the one that writes the log again
    const more = op === 'begin' || op === null ? HISTORY_COMPACT_SLACK : HISTORY_COMPACT_SLACK - 1
    for (let i = 0; i < more; i++) await live.begin(KEY, start()).end(end())
  }

  // the call the case is about, as far along as its step needs
  let call: HistoryEntry | null = null
  let ended = false
  let pictured = false
  if (op === 'end' || op === 'picture') {
    call = live.begin(KEY, start())
    await call.n()
    if (op === 'picture') {
      await call.end(end())
      ended = true
    }
  }
  // a history the prune may take: nothing written for the keep time (a call that is open keeps it whatever its age)
  if (job === 'prune' || job === 'sweep') old()

  /** one of the jobs that take something away, as the host runs it */
  const run = async (which: Job): Promise<void> => {
    if (which === 'prune' || which === 'sweep') await live.prune(Date.now())
    else if (which === 'switch off') {
      pictures = false
      await live.dropPictures()
    } else if (which === 'delete') await live.remove(KEY)
    // a log at its bound is written again by the start that crosses it
    else await live.begin(KEY, start()).end(end())
  }
  const acts = {
    job: (): Promise<void> => run(job),
    op: async (): Promise<void> => {
      if (op === 'begin') {
        call = live.begin(KEY, start())
        await call.n()
      } else if (op === 'end') {
        ended = true
        await call!.end(end())
      } else if (op === 'picture') {
        pictured = true
        await call!.picture(shot)
      }
    }
  }
  /** the call runs to its end and its picture, as every call does */
  const finish = async (): Promise<void> => {
    if (!call) return
    if (!ended) await call.end(end())
    if (!pictured) await call.picture(shot)
  }
  /** what the journal holds, and what a journal that knows only the disk reads: the same */
  const settled = async () => {
    await live.close()
    const memory = (await live.read([KEY]))[0].calls
    const disk = (await make().read([KEY]))[0].calls
    const face = (c: ComputerHistoryCall) => [c.n, c.state, c.text, c.picture && 'none' in c.picture ? c.picture.none : c.picture ? 'kept' : undefined]
    expect(memory.map(face), 'memory and disk').toEqual(disk.map(face))
    // every picture a call says it keeps is a file, and no file is a picture no call keeps
    const files = existsSync(join(dir, 'steps')) ? readdirSync(join(dir, 'steps')).filter((f) => f.endsWith('.jpg')).sort() : []
    const kept = disk.filter((c) => c.picture && !('none' in c.picture)).map((c) => `${c.n}.jpg`)
    if (job !== 'compaction') expect(files, 'picture files').toEqual(kept.sort())
    return { memory, n: call ? await call.n() : null, files, firstLine: existsSync(log) ? (JSON.parse(readFileSync(log, 'utf8').split('\n')[0] || '{}') as { n?: number }) : {} }
  }
  return { live, acts, run, finish, settled, shot }
}

const ORDERS = ['the job first', 'the call first'] as const

describe.each(['prune', 'switch off', 'delete', 'compaction'] satisfies Job[])('%s against a call', (job) => {
  describe.each(['begin', 'end', 'picture'] satisfies Op[])('its %s', (op) => {
    it.each(ORDERS.flatMap((order) => Object.keys(GAPS).map((gap) => [order, gap] as const)))('%s, %s', async (order, gap) => {
      const r = await rig(job, op)
      const [first, second] = order === 'the job first' ? [r.acts.job, r.acts.op] : [r.acts.op, r.acts.job]
      const a = first()
      await GAPS[gap as keyof typeof GAPS]()
      const b = second()
      await Promise.all([a, b])
      await r.finish()
      const { memory, n, files, firstLine } = await r.settled()
      const mine = memory.find((c) => c.n === n)

      if (job === 'delete') {
        // a thread's removal takes everything of the history it was asked to remove: a call of that history is
        // gone with it, and one that begins after the removal was asked is the first of the next history
        if (op === 'begin' && order === 'the job first') {
          expect(memory.map((c) => [c.n, c.state])).toEqual([[1, 'done']])
          expect(mine?.picture).toMatchObject({ width: 960 })
        } else expect(memory).toEqual([])
        return
      }
      if (job === 'prune' && op === 'picture' && memory.length === 0) {
        // the one case the prune may take the call: its end was 30 days ago and nothing of it was open or starting
        // when the prune decided; then the whole history went, and its picture was never written
        expect(files).toEqual([])
        return
      }
      // every other job leaves the call: it is there, finished, numbered after what was there
      expect(mine, 'the call').toMatchObject({ state: 'done', text: true })
      if (job === 'switch off') {
        // the switch takes every picture and no line: the call before and this one are both there, neither with one
        expect(memory.map((c) => c.n)).toEqual([1, 2])
        expect(files).toEqual([])
        expect(memory.every((c) => c.picture === undefined || 'none' in c.picture)).toBe(true)
      } else {
        expect(mine!.picture).toMatchObject({ width: 960 })
        if (job === 'prune') expect(memory.map((c) => c.n)).toEqual([1, 2])
        if (job === 'compaction') {
          // the log was written again without its oldest calls, and its newest two are this call and the one beside it
          expect(firstLine.n).toBeGreaterThan(1)
          const top = HISTORY_KEEP_LINES + HISTORY_COMPACT_SLACK + (op === 'begin' ? 2 : 1)
          expect(memory.slice(-2).map((c) => [c.n, c.state])).toEqual([
            [top - 1, 'done'],
            [top, 'done']
          ])
        }
      }
    })
  })
})

describe('a prune of a folder no state is loaded for, against a call that begins', () => {
  it.each(ORDERS.flatMap((order) => Object.keys(GAPS).map((gap) => [order, gap] as const)))('%s, %s', async (order, gap) => {
    const r = await rig('sweep', 'begin')
    const [first, second] = order === 'the job first' ? [r.acts.job, r.acts.op] : [r.acts.op, r.acts.job]
    const a = first()
    await GAPS[gap as keyof typeof GAPS]()
    const b = second()
    await Promise.all([a, b])
    await r.finish()
    const { memory, n } = await r.settled()
    // the call is there whole: after the old call where the prune found the history in use, or the first of a new
    // history where the old one had gone before the call's load
    expect(memory.find((c) => c.n === n)).toMatchObject({ state: 'done', text: true, picture: { width: 960 } })
    expect([1, 2]).toContain(memory.length)
    expect(memory.at(-1)!.n).toBe(memory.length)
  })
})

describe('two jobs at once, and a call begun between them', () => {
  const PAIRS: [Job, Job][] = [
    ['prune', 'switch off'],
    ['switch off', 'prune'],
    ['switch off', 'delete'],
    ['delete', 'prune'],
    ['prune', 'delete'],
    ['sweep', 'switch off'],
    ['sweep', 'delete']
  ]
  it.each(PAIRS.flatMap(([one, two]) => Object.keys(GAPS).map((gap) => [one, two, gap] as const)))('%s, then %s, %s', async (one, two, gap) => {
    const r = await rig(one === 'sweep' ? 'sweep' : 'prune', null)
    const a = r.run(one)
    await GAPS[gap as keyof typeof GAPS]()
    const b = r.run(two)
    await GAPS[gap as keyof typeof GAPS]()
    // the thread uses the computer while both are at work
    const call = r.live.begin(KEY, start())
    const n = await call.n()
    await Promise.all([a, b])
    await call.end(end())
    await call.picture(r.shot)
    const { memory, files } = await r.settled()
    // whatever the two jobs took of the old history, the call that began is there whole, and memory is the disk
    expect(n).not.toBeNull()
    const off = one === 'switch off' || two === 'switch off'
    expect(memory.find((c) => c.n === n)).toMatchObject({ state: 'done', text: true, picture: off ? { none: 'off' } : { width: 960 } })
    if (off) expect(files).toEqual([])
    // a removal was asked before the call began: the call is the first of the next history
    if (one === 'delete' || two === 'delete') expect(memory.map((c) => c.n)).toEqual([1])
  })
})
