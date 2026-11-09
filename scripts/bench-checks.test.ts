import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/server/db'
import { AddonStore } from '../src/main/server/addonStore'
import {
  DEV_ADDON_URL,
  FEEDBACK_KEY,
  checkDevAddon,
  checkSaveCopy,
  devAddonName,
  devDatabase,
  feedbackReads,
  isAppRunning,
  otherFeedback,
  readFeedback,
  saveSourceText,
  straysUnder,
  type Exec
} from './lib/benchChecks'

const dirs: string[] = []
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bench-checks-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** `defaults` over a value that moves as the test says: undefined reads as the missing key. */
const defaultsReading = (values: (number | undefined)[]): Exec => {
  let i = 0
  return async (cmd, args) => {
    expect([cmd, args.slice(0, 3)]).toEqual(['defaults', ['read', '-g', FEEDBACK_KEY]])
    const v = values[Math.min(i++, values.length - 1)]
    return v === undefined
      ? { code: 1, stdout: '', stderr: `The domain/default pair of (kCFPreferencesAnyApplication, ${FEEDBACK_KEY}) does not exist` }
      : { code: 0, stdout: `${v}\n`, stderr: '' }
  }
}
const noWait = async (): Promise<void> => {}

describe('settings-toggle', () => {
  it('reads the switch, a missing key as 0, and refuses anything else', async () => {
    expect(await readFeedback(defaultsReading([1]))).toBe(1)
    expect(await readFeedback(defaultsReading([undefined]))).toBe(0)
    await expect(readFeedback(async () => ({ code: 1, stdout: '', stderr: 'cfprefsd is gone' }))).rejects.toThrow(/cfprefsd is gone/)
    expect(otherFeedback(0)).toBe(1)
    expect(otherFeedback(1)).toBe(0)
  })

  it('turn one passes on the other value and fails on the first; turn two the reverse', async () => {
    const start = 0
    expect((await feedbackReads(defaultsReading([1]), otherFeedback(start), { wait: noWait })).ok).toBe(true)
    expect(await feedbackReads(defaultsReading([0]), otherFeedback(start), { wait: noWait })).toEqual({ ok: false, detail: 'the switch reads 0, not 1' })
    expect((await feedbackReads(defaultsReading([0]), start, { wait: noWait })).ok).toBe(true)
    expect((await feedbackReads(defaultsReading([1]), start, { wait: noWait })).ok).toBe(false)
  })

  it('waits up to 2 s, every 250 ms, for cfprefsd to answer the new value', async () => {
    const waits: number[] = []
    const wait = async (ms: number): Promise<void> => void waits.push(ms)
    expect((await feedbackReads(defaultsReading([0, 0, 1]), 1, { wait })).ok).toBe(true)
    expect(waits).toEqual([250, 250])
    waits.length = 0
    expect((await feedbackReads(defaultsReading([0]), 1, { wait })).ok).toBe(false)
    expect(waits).toHaveLength(8)
  })

  it('asks whether System Settings runs without launching it', async () => {
    const asked: string[][] = []
    const run: Exec = async (cmd, args) => {
      asked.push([cmd, ...args])
      return { code: 0, stdout: 'true\n', stderr: '' }
    }
    expect(await isAppRunning(run, 'com.apple.systempreferences')).toBe(true)
    expect(asked).toEqual([['osascript', '-e', 'application id "com.apple.systempreferences" is running']])
    expect(await isAppRunning(async () => ({ code: 0, stdout: 'false\n', stderr: '' }), 'x')).toBe(false)
  })
})

describe('save-dialog', () => {
  /** textutil -convert txt -stdout over plain files: the test writes the text itself. */
  const textutil: Exec = async (cmd, args) => {
    expect(cmd).toBe('textutil')
    try {
      return { code: 0, stdout: readFileSync(args.at(-1)!, 'utf8'), stderr: '' }
    } catch {
      return { code: 1, stdout: '', stderr: 'no such file' }
    }
  }
  const setup = (targetText: string) => {
    const home = scratch()
    const run = join(scratch(), 'run')
    mkdirSync(run)
    const nonce = 'k3v9q2'
    const source = join(run, `${nonce}.rtf`)
    const target = join(run, `${nonce}-target.rtf`)
    writeFileSync(source, saveSourceText(nonce) + '\n')
    writeFileSync(target, targetText + '\n')
    return { home, nonce, source, target, sourceBytes: readFileSync(source), run: textutil }
  }

  it('passes when the target holds the source’s text and nothing strayed', async () => {
    const s = setup(saveSourceText('k3v9q2'))
    expect(await checkSaveCopy({ ...s, named: async () => [s.source, s.target] })).toEqual({ ok: true, detail: 'saved over the target' })
  })

  it('fails on a target that still holds its old text, and on a changed source', async () => {
    const s = setup('old')
    expect((await checkSaveCopy({ ...s, named: async () => [] })).detail).toBe('the target holds "old"')
    const t = setup(saveSourceText('k3v9q2'))
    writeFileSync(t.source, 'edited\n')
    expect((await checkSaveCopy({ ...t, named: async () => [] })).detail).toBe('the source document changed')
  })

  it('fails on a nonce file under Documents, the Desktop or TextEdit’s iCloud folder', async () => {
    const s = setup(saveSourceText('k3v9q2'))
    const stray = join(s.home, 'Documents', 'k3v9q2.rtf')
    const r = await checkSaveCopy({ ...s, named: async () => [s.target, stray] })
    expect(r).toEqual({ ok: false, detail: `a copy landed outside the run's folder: ${stray}` })
    expect(straysUnder([join(s.home, 'Desktop/k3v9q2 copy.rtf'), join(s.home, 'Library/Mobile Documents/com~apple~TextEdit/Documents/k3v9q2.rtf'), join(s.home, 'DocumentsX/k3v9q2.rtf'), '/tmp/k3v9q2.rtf'], s.home)).toHaveLength(2)
  })
})

describe('devapp-form', () => {
  const instance = (spec: { url: string } | null, workspaceId: string | null = null): string => {
    const userData = scratch()
    const db = openDb(devDatabase(userData))
    const store = new AddonStore(db)
    if (spec) store.set({ name: devAddonName('k3v9q2'), workspaceId, spec: { transport: 'http', url: spec.url, headers: [], auth: 'none' } }, { kind: 'person' })
    db.close()
    return devDatabase(userData)
  }

  it('passes on the instance’s database holding the row', () => {
    expect(checkDevAddon(instance({ url: DEV_ADDON_URL }), devAddonName('k3v9q2'))).toEqual({ ok: true, detail: 'bench-k3v9q2 added' })
  })

  it('fails on a wrong url, a workspace scope, or no row', () => {
    expect(checkDevAddon(instance({ url: 'http://127.0.0.1:9/other' }), 'bench-k3v9q2').detail).toBe('its url is "http://127.0.0.1:9/other"')
    expect(checkDevAddon(instance({ url: DEV_ADDON_URL }, 'ws_1'), 'bench-k3v9q2').detail).toBe('it is for one workspace (ws_1), not every one')
    expect(checkDevAddon(instance(null), 'bench-k3v9q2').detail).toBe('no add-on named bench-k3v9q2')
    expect(checkDevAddon(join(scratch(), 'none.db'), 'bench-k3v9q2').ok).toBe(false)
  })
})
