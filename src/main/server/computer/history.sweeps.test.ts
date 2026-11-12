import { existsSync, mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The journal's sweeps (the daily prune, the pictures switch) against a call that begins while one reads or
// removes a folder. The orders are held by hand here, at the file system's own calls, so each case is one
// interleaving and not a race the disk decides.
const gate = vi.hoisted(() => ({
  stat: null as null | ((path: string) => Promise<void> | void),
  rm: null as null | ((path: string) => Promise<void> | void)
}))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    stat: (async (...args: Parameters<typeof real.stat>) => {
      await gate.stat?.(String(args[0]))
      return real.stat(...args)
    }) as typeof real.stat,
    rm: (async (...args: Parameters<typeof real.rm>) => {
      await gate.rm?.(String(args[0]))
      return real.rm(...args)
    }) as typeof real.rm
  }
})

import type { ComputerHistoryStep } from '@shared/contract-computer'
import { ComputerHistory, HISTORY_KEEP_MS, type HistoryChange } from './history'
import { serviceSessionId } from './sessionId'

const step = (verb: string, extra: Partial<ComputerHistoryStep> = {}): ComputerHistoryStep => ({ kind: 'click', verb, object: 'Save', inApp: 'Save in TextEdit', ...extra })
const start = () => ({ app: 'TextEdit', window: 'Untitled', steps: [step('Clicking')] })
const end = () => ({ app: 'TextEdit', window: 'Untitled', steps: [step('Clicked', { state: 'ok', tier: 'ax' })] })

const open: ComputerHistory[] = []
const journal = (root: string) => {
  const changes: HistoryChange[] = []
  const history = new ComputerHistory({ root })
  history.onChange((c) => changes.push(c))
  open.push(history)
  return { history, changes }
}
/** a promise the test lets go of, and one that says the held call was reached */
const hold = () => {
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>((r) => (release = r))
  const at = new Promise<void>((r) => (reached = r))
  return { held, release, at, reached }
}
/** an old history of one finished call, its log last written before the keep time */
const seeded = async () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-history-sweeps-'))
  const first = journal(root)
  await first.history.begin('old', start()).end(end())
  await first.history.close()
  const dir = join(root, serviceSessionId('old'))
  const log = join(dir, 'log.jsonl')
  const longAgo = new Date(Date.now() - HISTORY_KEEP_MS - 60_000)
  utimesSync(log, longAgo, longAgo)
  return { root, dir, log }
}
afterEach(async () => {
  gate.stat = null
  gate.rm = null
  for (const h of open.splice(0)) await h.close()
})

describe('a sweep and a call that begins during it', () => {
  it('a call begun while the prune makes its last check of the disk keeps its history: its start is reserved the moment it begins', async () => {
    const { root, log } = await seeded()
    const { history, changes } = journal(root)
    // a panel has the old history loaded
    expect((await history.read(['old']))[0].calls).toHaveLength(1)
    const last = hold()
    let stats = 0
    // the prune reads the log's age twice: when it scans, and again inside the key's own order
    gate.stat = (path) => (path === log && ++stats === 2 ? (last.reached(), last.held) : undefined)
    const sweep = history.prune(Date.now())
    await last.at
    // the thread uses the computer again while that second read is out
    const entry = history.begin('old', start())
    const ended = entry.end(end())
    last.release()
    await sweep
    await ended
    expect(await entry.n()).toBe(2)
    expect(changes.some((c) => 'gone' in c)).toBe(false)
    expect((await history.read(['old']))[0].calls.map((c) => [c.n, c.state])).toEqual([
      [1, 'done'],
      [2, 'done']
    ])
    expect(existsSync(log)).toBe(true)
  })

  it('a later sweep of a folder waits for one already at work there: no call is written into a folder being removed', async () => {
    const { root, dir } = await seeded()
    const { history } = journal(root)
    // nothing is loaded: the prune removes the old folder itself, and its removal is slow
    const removal = hold()
    let held = false
    gate.rm = (path) => (path === dir && !held ? ((held = true), removal.reached(), removal.held) : undefined)
    const sweep = history.prune(Date.now())
    await removal.at
    // the pictures switch goes off meanwhile: a second sweep of the same folder
    const pictures = history.dropPictures()
    await new Promise((r) => setTimeout(r, 20))
    // and the thread uses the computer again
    const entry = history.begin('old', start())
    let n: number | null | undefined
    void entry.n().then((value) => (n = value))
    await new Promise((r) => setTimeout(r, 20))
    // nothing of it is loaded or written while the removal is out, whichever sweep ended first
    expect(n).toBeUndefined()
    removal.release()
    await sweep
    await pictures
    await entry.end(end())
    // the old history went whole, and the call is the first of the one that begins after it: memory and disk agree
    expect(await entry.n()).toBe(1)
    await history.close()
    const fresh = journal(root)
    expect((await fresh.history.read(['old']))[0].calls.map((c) => [c.n, c.state])).toEqual([[1, 'done']])
  })
})
