import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coldPathFor, openDb } from './db'
import { startCheckpointWorker, WRITER_BACKSTOP_FRAMES, WRITER_DEFAULT_FRAMES, type CheckpointWorker } from './dbWorkers'

/**
 * The checkpoint worker (dbWorkers.ts) owns the WAL checkpoints of the hot
 * and cold files on its own connection, while the writer keeps a 10,000
 * frame backstop. These pin the handover both ways, both schemas, the
 * finish of a WAL a reader held half done, and that the writer still
 * closes clean after the worker is gone.
 */

let root: string
let path: string
let db: DatabaseSync
let worker: CheckpointWorker | null
const workers: CheckpointWorker[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-ckpt-'))
  path = join(root, 'test.db')
  db = openDb(path)
  worker = null
})
afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop()
  try {
    db.close()
  } catch {
    // a test closed it
  }
  rmSync(root, { recursive: true, force: true })
})

const start = (target = db, file = path, extra: Record<string, unknown> = {}): CheckpointWorker => {
  const w = startCheckpointWorker(target, file, { pollMs: 10, log: () => {}, ...extra })
  workers.push(w)
  return w
}
const autocheckpoint = (target = db): number =>
  (target.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint
const wal = (schema: 'main' | 'cold'): { log: number; checkpointed: number } =>
  db.prepare(`PRAGMA ${schema}.wal_checkpoint(NOOP)`).get() as unknown as { log: number; checkpointed: number }
/** Lands `rows` events of one page each, so the WAL grows by about that many frames. */
const write = (table: 'events' | 'cold.events', rows: number, from = 0): void => {
  const insert = db.prepare(`INSERT INTO ${table} (session_id, seq, ts, payload) VALUES ('s', ?, 1, ?)`)
  const payload = 'x'.repeat(3900)
  db.exec('BEGIN')
  for (let i = 0; i < rows; i++) insert.run(from + i, payload)
  db.exec('COMMIT')
}
const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('checkpoint worker', () => {
  it('moves the writer to the backstop once ready, and checkpoints a thousand waiting frames itself', async () => {
    expect(autocheckpoint()).toBe(WRITER_DEFAULT_FRAMES)
    worker = start()
    expect(await worker.ready).toBe(true)
    expect(autocheckpoint()).toBe(WRITER_BACKSTOP_FRAMES)
    write('events', 1500)
    const grown = wal('main')
    expect(grown.log).toBeGreaterThanOrEqual(1500)
    await until(() => wal('main').checkpointed === wal('main').log)
    // The writer could not have done it: its threshold is ten times the WAL.
    expect(autocheckpoint()).toBe(WRITER_BACKSTOP_FRAMES)
    expect(wal('main').log).toBeLessThan(WRITER_BACKSTOP_FRAMES)
  })

  it('checkpoints the cold schema the same way', async () => {
    worker = start()
    expect(await worker.ready).toBe(true)
    write('cold.events', 1500)
    expect(wal('cold').log).toBeGreaterThanOrEqual(1500)
    await until(() => wal('cold').checkpointed === wal('cold').log)
    expect(existsSync(`${coldPathFor(path)}-wal`)).toBe(true)
  })

  it('finishes a WAL a reader left half done once the writes pause and the reader ends', async () => {
    worker = start()
    expect(await worker.ready).toBe(true)
    // 600 frames sit under the trigger; a reader's snapshot then pins the
    // WAL there, so of the next 600 (1200 waiting, over the trigger) the
    // worker can copy only the first 600 and 600 stay, still under the
    // trigger: only the idle rule finishes them once the reader is gone.
    write('events', 600)
    const reader = new DatabaseSync(path, { readOnly: true })
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM events').get()
    write('events', 600, 600)
    await until(() => wal('main').checkpointed > 0)
    const held = wal('main')
    expect(held.checkpointed).toBeLessThan(held.log)
    expect(held.log - held.checkpointed).toBeLessThan(1000)
    await new Promise((r) => setTimeout(r, 60))
    expect(wal('main')).toEqual(held)
    reader.exec('COMMIT')
    reader.close()
    await until(() => wal('main').checkpointed === wal('main').log)
    expect(wal('main').log).toBe(held.log)
  })

  it('hands checkpointing back to the writer when the worker ends, once', async () => {
    worker = start()
    expect(await worker.ready).toBe(true)
    expect(autocheckpoint()).toBe(WRITER_BACKSTOP_FRAMES)
    await worker.stop()
    expect(autocheckpoint()).toBe(WRITER_DEFAULT_FRAMES)
    db.exec('PRAGMA wal_autocheckpoint = 5000')
    await worker.stop()
    expect(autocheckpoint()).toBe(5000)
  })

  it('a worker that cannot open its file reports it and leaves the writer as it was', async () => {
    const lines: string[] = []
    worker = start(db, join(root, 'missing', 'nested', 'x.db'), { log: (l: string) => lines.push(l) })
    expect(await worker.ready).toBe(false)
    expect(autocheckpoint()).toBe(WRITER_DEFAULT_FRAMES)
    expect(lines.join('\n')).toMatch(/checkpoint worker (failed|crashed|exited)/)
  })

  it('starts nothing for an in-memory database', async () => {
    const mem = openDb(':memory:')
    const w = startCheckpointWorker(mem, ':memory:')
    expect(await w.ready).toBe(false)
    await w.stop()
    expect(autocheckpoint(mem)).toBe(WRITER_DEFAULT_FRAMES)
    mem.close()
  })

  it('the writer closes clean after the worker stopped: last connection, WAL checkpointed and removed', async () => {
    worker = start()
    expect(await worker.ready).toBe(true)
    write('events', 200)
    await worker.stop()
    db.close()
    expect(existsSync(`${path}-wal`)).toBe(false)
    const check = new DatabaseSync(path)
    expect((check.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(200)
    check.close()
  })
})
