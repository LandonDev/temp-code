import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseObservation, type ParsedObservation } from '../src/shared/computer/observation'
import type { Exec } from './lib/benchChecks'
import { COMPUTER_ONLY_LINE, type TaskContext, type TaskReader, type TaskStart } from './lib/computerTasks'
import {
  FIELD_CITIES,
  FIELD_FORM,
  FIELD_TASKS,
  STRAY_WAIT,
  bytesUnder,
  confirmationText,
  docRtf,
  docText,
  fieldCode,
  fieldFormCode,
  fieldOf,
  fieldRows,
  fieldTaskById,
  fieldWindow,
  BENCH_TRASH_RE,
  benchTrashNames,
  editedInRun,
  finderDeleteTrashItems,
  finderDraft,
  finderKeep,
  finderLog,
  finderNames,
  finderTrashNames,
  probeCloseSheet,
  readCloseConfirm,
  trashNamesOf,
  writeCloseConfirm,
  foldRow,
  formHtml,
  holdsMarker,
  invoiceItems,
  invoiceRtf,
  nearRow,
  noteFiles,
  removeStrays,
  replyCityToken,
  replyNumberToken,
  reportHtml,
  spotlightStrays,
  tableReplyCheck,
  topRow,
  treeShowsNumber,
  windowGone,
  type FieldStart
} from './lib/fieldTasks'

// The stray retries wait for Spotlight on a Mac; the tests never do.
STRAY_WAIT.wait = async () => {}

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'field-tasks-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const okExec: Exec = async () => ({ code: 0, stdout: '', stderr: '' })
/** An exec whose osascript answers whether Calculator runs; everything else answers empty. */
const execWith =
  (answers: Record<string, string>): Exec =>
  async (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    for (const [needle, stdout] of Object.entries(answers)) if (key.includes(needle)) return { code: 0, stdout, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

interface FakeCtx extends TaskContext {
  written: string[]
  opened: { app: string; target: string; args?: string[] }[]
  pinned: [string, number][]
}

/**
 * The probe's Mac: TextEdit's pids before and after the probe's own launch,
 * its window listed, and the sheet seen (or not) after the close button.
 */
const probeMac = (opts: { sheet: boolean; log?: string[] }): Exec => {
  let launched = false
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    opts.log?.push(key)
    const said = (stdout: string) => ({ code: 0, stdout, stderr: '' })
    if (cmd === 'pgrep') return said(launched ? '111\n4242\n' : '111\n')
    if (cmd === 'open') {
      launched = true
      return said('')
    }
    if (key.includes('exists sheet')) return said(String(opts.sheet))
    if (key.includes('exists (first window')) return said('true')
    return said('')
  }
}

/** The suite's Mac answered by a stub: Calculator not running, the probe seeing the sheet, the pref key absent. */
const fieldExec = (over: Record<string, string> = {}): Exec => {
  const base = execWith(over)
  const mac = probeMac({ sheet: true })
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    if (Object.keys(over).some((needle) => key.includes(needle))) return base(cmd, args)
    if (key.includes('is running')) return { code: 0, stdout: 'false', stderr: '' }
    if (cmd === 'defaults' && args[0] === 'read') return { code: 1, stdout: '', stderr: 'does not exist' }
    return mac(cmd, args)
  }
}

const fakeCtx = (dir: string, run: Exec = fieldExec()): FakeCtx => {
  const ctx: FakeCtx = {
    nonce: 'n0f1',
    seed: 7,
    dir,
    benchUrl: 'file:///bench.html',
    written: [],
    opened: [],
    pinned: [],
    writeFile: async (p, t) => {
      ctx.written.push(p)
      writeFileSync(p, t)
    },
    open: async (app, target, opts) => {
      ctx.opened.push({ app, target, ...(opts?.args ? { args: opts.args } : {}) })
    },
    pin: (app, pid) => ctx.pinned.push([app, pid]),
    run,
    home: dir
  }
  return ctx
}

const reader = (tree: string | null, exec: Exec = okExec, throwMessage = 'window_not_found'): TaskReader => ({
  read: async (): Promise<ParsedObservation> => {
    if (tree === null) throw new Error(throwMessage)
    return parseObservation(tree)
  },
  element: async (): Promise<ParsedObservation> => parseObservation(tree ?? ''),
  exec
})

/** A call that typed the line: the close-discard check's evidence the window was edited (C6). */
const typedCall = (text: string): { name: string; input: Record<string, unknown>; result: string } => ({
  name: 'mcp__app__computer_act',
  input: { app: 'TextEdit', action: 'type', text },
  result: 'type · ax · changed'
})

const win = (app: string, title: string, lines: string[]): string => [`app "${app}" · window "${title}" · 1280×800`, `[1] window "${title}"`, ...lines].join('\n')

describe('the field set', () => {
  it('names each task once, with a verify, a cleanup, a budget, a wall time and the only-computer-tools line', () => {
    expect(new Set(FIELD_TASKS.map((t) => t.id)).size).toBe(FIELD_TASKS.length)
    expect(FIELD_TASKS.length).toBe(14)
    for (const t of FIELD_TASKS) {
      expect(t.id, t.id).toMatch(/^field-/)
      expect(typeof t.check, t.id).toBe('function')
      expect(typeof t.teardown, t.id).toBe('function')
      expect(t.stepBudget, t.id).toBeGreaterThan(0)
      expect(t.wallMs, t.id).toBeGreaterThan(0)
      expect(t.version, t.id).toBeGreaterThanOrEqual(1)
      expect(['background', 'session']).toContain(t.tier)
      const s: FieldStart = { app: t.app, window: 'w', nonce: 'n0f1', seed: 7, field: { city: 'Lyon', extra: 'Added n0f1', text: 'Computer use test n0f1', dir: '/tmp/x' } }
      expect(t.prompt(s).endsWith(COMPUTER_ONLY_LINE), t.id).toBe(true)
    }
    // the tasks the field test could only commit at the session tier are marked, never excluded
    expect(FIELD_TASKS.filter((t) => t.tier === 'session').map((t) => t.id)).toEqual([
      'field-textedit-save-as',
      'field-finder-rename',
      'field-finder-trash',
      'field-finder-new-folder'
    ])
    // the shared apps serialize across lanes
    expect(fieldTaskById('field-calc').shared).toBe('calculator')
    expect(fieldTaskById('field-finder-rename').shared).toBe('finder')
    expect(() => fieldTaskById('nope')).toThrow(/no field task/)
  })

  it('writes scratch content under the run’s dir alone', async () => {
    for (const t of FIELD_TASKS) {
      const dir = tmp()
      const ctx = fakeCtx(dir)
      const s = await t.setup(ctx)
      expect('skip' in s, t.id).toBe(false)
      for (const p of ctx.written) expect(p.startsWith(dir + '/'), `${t.id} wrote ${p}`).toBe(true)
      for (const o of ctx.opened) {
        if (o.target) expect(o.target.includes(dir), `${t.id} opened ${o.target}`).toBe(true)
        for (const a of o.args ?? []) if (a.includes('/')) expect(a.includes(dir), `${t.id} passed ${a}`).toBe(true)
      }
    }
  })

  it('skips the Calculator tasks while Calculator is open: its window is the person’s', async () => {
    const ctx = fakeCtx(tmp(), execWith({ 'is running': 'true' }))
    for (const id of ['field-calc', 'field-app-launch']) expect(await fieldTaskById(id).setup(ctx)).toMatchObject({ skip: expect.stringContaining('person') })
  })

  it('launches the report behind a front tab for the background-tab and tab-switch tasks', async () => {
    for (const id of ['field-chrome-bg-tab', 'field-chrome-tab-switch']) {
      const ctx = fakeCtx(tmp())
      await fieldTaskById(id).setup(ctx)
      const [o] = ctx.opened
      expect(o.target, id).toContain('front.html')
      expect(o.args?.[0], id).toContain('report.html')
    }
  })
})

describe('seeded content', () => {
  it('shuffles the 40 cities with unguessable revenues, the same for a seed', () => {
    const rows = fieldRows(7)
    expect(rows).toHaveLength(40)
    expect(new Set(rows.map((r) => r.city)).size).toBe(40)
    expect(new Set(rows.map((r) => r.revenue)).size).toBe(40)
    expect(rows.map((r) => r.city).sort()).toEqual([...FIELD_CITIES].sort())
    expect(fieldRows(7)).toEqual(rows)
    expect(fieldRows(8)).not.toEqual(rows)
    expect(topRow(7).revenue).toBe(Math.max(...rows.map((r) => r.revenue)))
    expect(rows.findIndex((r) => r.city === foldRow(7).city)).toBeGreaterThanOrEqual(30)
    expect(rows.findIndex((r) => r.city === nearRow(7).city)).toBe(2)
  })

  it('writes the report and form pages with their window titles and the seeded facts', () => {
    const report = reportHtml(7, 'n0f1')
    expect(report).toContain(`<title>${fieldWindow('report', 'n0f1')}</title>`)
    expect(report).toContain(topRow(7).city)
    expect(report).toContain(topRow(7).revenue.toLocaleString('en-US'))
    const form = formHtml('n0f1')
    expect(form).toContain(`<title>${fieldWindow('form', 'n0f1')}</title>`)
    expect(form).toContain("const n='n0f1'")
  })

  it('computes the form code as suite.py’s fnv does', () => {
    // reference values from the python fnv in .temp-code/cu-vs-codex/mac/tc-cu-test/suite.py
    expect(fieldCode('a')).toBe('TC-E40C292C')
    expect(fieldCode(`${FIELD_FORM.name}|${FIELD_FORM.email}|${FIELD_FORM.plan}|abc123`)).toBe('TC-25A594B7')
    expect(fieldFormCode('abc123')).toBe('TC-25A594B7')
  })

  it('builds the scratch documents with their lines', () => {
    const items = invoiceItems(7)
    expect(items).toHaveLength(3)
    expect(invoiceItems(7)).toEqual(items)
    const rtf = invoiceRtf('n0f1', items)
    expect(rtf).toContain('Invoice n0f1')
    expect(rtf).toContain(`Item A: ${items[0].toLocaleString('en-US')}`)
    expect(docRtf(['x'])).toContain('{\\rtf1')
  })
})

describe('the checks', () => {
  it('replyNumberToken wants the number as its own token, and never joins adjacent numbers (C2)', () => {
    expect(replyNumberToken('Lisbon: 964,801 dollars', 964801)).toBe(true)
    expect(replyNumberToken('964801', 964801)).toBe(true)
    expect(replyNumberToken('96,480', 964801)).toBe(false)
    // a digit before or after is no boundary
    expect(replyNumberToken('1964801', 964801)).toBe(false)
    expect(replyNumberToken('9648012', 964801)).toBe(false)
    // whitespace never joins two numbers of a dump into the expected one
    expect(replyNumberToken('rows: 3,456\n789,012 and more', 456789)).toBe(false)
    expect(replyNumberToken("Swiss style 964'801", 964801)).toBe(true)
  })

  it('replyCityToken wants the city as its own word, in the table’s case', () => {
    expect(replyCityToken('The top city is Lisbon.', 'Lisbon')).toBe(true)
    expect(replyCityToken('I split the window', 'Split')).toBe(false)
    expect(replyCityToken('Split had the most', 'Split')).toBe(true)
    expect(replyCityToken('Lisbonne', 'Lisbon')).toBe(false)
  })

  it('tableReplyCheck fails a hedge or a dump naming more than one candidate (C2)', () => {
    const rows = fieldRows(7)
    const want = topRow(7)
    const other = rows.find((r) => r !== want)!
    expect(tableReplyCheck(`${want.city}: ${want.revenue.toLocaleString('en-US')}`, rows, want, { city: true }).ok).toBe(true)
    expect(tableReplyCheck(`maybe ${want.city} (${want.revenue}) or ${other.city} (${other.revenue})`, rows, want, { city: true })).toMatchObject({
      ok: false,
      detail: expect.stringContaining('2 of the table')
    })
    expect(tableReplyCheck(`${other.city}: ${other.revenue}`, rows, want, { city: true }).ok).toBe(false)
    // a number-only task still fails on two candidate numbers
    expect(tableReplyCheck(`${want.revenue} or ${other.revenue}`, rows, want, { city: false }).ok).toBe(false)
    expect(tableReplyCheck(String(want.revenue), rows, want, { city: false }).ok).toBe(true)
    // naming another city in passing is fine when only the number was asked
    expect(tableReplyCheck(`${other.city} is not it; the revenue is ${want.revenue}`, rows, want, { city: false }).ok).toBe(true)
  })

  it('the three Chrome table tasks judge the reply through tableReplyCheck', async () => {
    const rows = fieldRows(7)
    const hedge = `${topRow(7).city} ${topRow(7).revenue} or ${rows[0] === topRow(7) ? rows[1].city : rows[0].city} ${rows[0] === topRow(7) ? rows[1].revenue : rows[0].revenue}`
    const bg = fieldTaskById('field-chrome-bg-tab')
    const s: FieldStart = { app: 'Google Chrome', window: 'w', nonce: 'n', seed: 7, field: { city: topRow(7).city, revenue: topRow(7).revenue } }
    expect((await bg.check(s, reader(''), `${topRow(7).city}: ${topRow(7).revenue.toLocaleString('en-US')}`, [])).ok).toBe(true)
    expect((await bg.check(s, reader(''), hedge, [])).ok).toBe(false)
    const fold = fieldTaskById('field-chrome-below-fold')
    const sf: FieldStart = { ...s, field: { city: foldRow(7).city, revenue: foldRow(7).revenue } }
    expect((await fold.check(sf, reader(''), String(foldRow(7).revenue), [])).ok).toBe(true)
  })

  it('treeShowsNumber finds Calculator’s display however it groups, as one value', () => {
    const tree = win('Calculator', 'Calculator', ['  [2] group', '    [3] text = "12,345,678"'])
    expect(treeShowsNumber(parseObservation(tree), 12345678)).toBe(true)
    expect(treeShowsNumber(parseObservation(tree), 999)).toBe(false)
    expect(treeShowsNumber(parseObservation(tree), 345678)).toBe(false)
  })

  it('field-calc believes the reply only when Calculator showed the product', async () => {
    const task = fieldTaskById('field-calc')
    const s: FieldStart = { app: 'Calculator', window: 'Calculator', nonce: 'n', seed: 7, field: { product: 123456 } }
    const shows = win('Calculator', 'Calculator', ['  [2] text = "123,456"'])
    expect((await task.check(s, reader(shows), 'The product is 123,456.', [])).ok).toBe(true)
    expect((await task.check(s, reader(shows), 'no number here', [])).ok).toBe(false)
    const blank = win('Calculator', 'Calculator', ['  [2] text = "0"'])
    expect((await task.check(s, reader(blank), '123456', [])).ok).toBe(false)
  })

  it('field-app-launch finds the launched Calculator by pgrep and pins it for the read', async () => {
    const task = fieldTaskById('field-app-launch')
    const pins: number[] = []
    const s: FieldStart = { app: 'Calculator', window: 'Calculator', nonce: 'n', seed: 7, field: { product: 42, pin: (pid) => pins.push(pid) } }
    const shows = win('Calculator', 'Calculator', ['  [2] text = "42"'])
    const exec = execWith({ 'pgrep -x Calculator': '4242\n' })
    expect((await task.check(s, reader(shows, exec), '42', [])).ok).toBe(true)
    expect(pins).toEqual([4242])
    const gone = execWith({})
    expect((await task.check(s, reader(shows, gone), '42', [])).ok).toBe(false)
  })

  it('confirmationText reads the form page’s status line', () => {
    const tree = win('Google Chrome', 'TC field form n', ['  [2] web area', '    [3] text = "Confirmation: TC-25A594B7"'])
    expect(confirmationText(parseObservation(tree))).toBe('Confirmation: TC-25A594B7')
    const empty = win('Google Chrome', 'TC field form n', ['  [2] web area', '    [3] text = "Please complete every field."'])
    expect(confirmationText(parseObservation(empty))).toBeNull()
  })

  it('field-web-form passes only on the exact code', async () => {
    const task = fieldTaskById('field-web-form')
    const s: FieldStart = { app: 'Google Chrome', window: fieldWindow('form', 'n'), nonce: 'n', seed: 7, field: { code: 'TC-25A594B7' } }
    const good = win('Google Chrome', s.window, ['  [2] text = "Confirmation: TC-25A594B7"'])
    const wrong = win('Google Chrome', s.window, ['  [2] text = "Confirmation: TC-00000000"'])
    expect((await task.check(s, reader(good), '', [])).ok).toBe(true)
    expect((await task.check(s, reader(wrong), '', [])).ok).toBe(false)
  })

  it('field-textedit-add-line wants the total on disk AND the window no longer Edited', async () => {
    const task = fieldTaskById('field-textedit-add-line')
    const dir = tmp()
    const file = join(dir, 'doc.rtf')
    writeFileSync(file, docRtf(['Invoice', 'Total: $5,522']))
    const s: FieldStart = { app: 'TextEdit', window: 'doc', nonce: 'n', seed: 7, field: { file, total: 5522 } }
    const clean = win('TextEdit', 'doc', ['  [2] text area'])
    const edited = [`app "TextEdit" · window "doc — Edited" · 800×600`, `[1] window "doc — Edited"`].join('\n')
    expect((await task.check(s, reader(clean), '', [])).ok).toBe(true)
    expect((await task.check(s, reader(edited), '', []))).toMatchObject({ ok: false, detail: expect.stringContaining('Edited') })
    // a closed window is fine once the disk answered
    expect((await task.check(s, reader(null), '', [])).ok).toBe(true)
    writeFileSync(file, docRtf(['Invoice, no total']))
    expect((await task.check(s, reader(clean), '', [])).ok).toBe(false)
  })

  it('field-textedit-save-as wants note in the folder and re-reads Spotlight before declaring no stray', async () => {
    const task = fieldTaskById('field-textedit-save-as')
    const home = tmp()
    const dir = join(home, 'run')
    mkdirSync(dir)
    const s: FieldStart = { app: 'TextEdit', window: 'n-seed', nonce: 'n0f1', seed: 7, field: { dir, text: 'Computer use test n0f1', home } }
    // no note yet
    expect((await task.check(s, reader('', okExec), '', [])).ok).toBe(false)
    writeFileSync(join(dir, 'note.rtf'), docRtf(['Computer use test n0f1']))
    expect((await task.check(s, reader('', okExec), '', [])).ok).toBe(true)
    // a stray autosave copy under Documents fails the run even with the note in place
    const docs = join(home, 'Documents')
    mkdirSync(docs)
    writeFileSync(join(docs, 'Computer Use Test.rtf'), 'Computer use test n0f1')
    const mdfind = execWith({ mdfind: `${join(docs, 'Computer Use Test.rtf')}\n` })
    expect(await task.check(s, reader('', mdfind), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('strayed') })
    // Spotlight lags: an index that answers only on a later read still fails the run
    let asks = 0
    const lagging: Exec = async (cmd, args) => (cmd === 'mdfind' && ++asks >= 3 ? { code: 0, stdout: `${join(docs, 'Computer Use Test.rtf')}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' })
    expect(await task.check(s, reader('', lagging), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('strayed') })
    expect(asks).toBeGreaterThanOrEqual(3)
    expect(noteFiles(dir)).toEqual([join(dir, 'note.rtf')])
    // the teardown removes the stray it can prove is the run's, and leaves everything else
    writeFileSync(join(docs, 'person.rtf'), 'the person’s own n0f1-free file')
    await task.teardown!(s, mdfind)
    expect(existsSync(join(docs, 'Computer Use Test.rtf'))).toBe(false)
    expect(existsSync(join(docs, 'person.rtf'))).toBe(true)
  })

  it('spotlightStrays asks again before answering empty; removeStrays removes only content-proved files', async () => {
    const home = tmp()
    const docs = join(home, 'Documents')
    mkdirSync(docs)
    const stray = join(docs, 'autosave.rtf')
    writeFileSync(stray, 'holds nonce9')
    let asks = 0
    const lagging: Exec = async () => (++asks >= 4 ? { code: 0, stdout: `${stray}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' })
    expect(await spotlightStrays(lagging, 'nonce9', home)).toEqual([stray])
    expect(asks).toBe(4)
    const none: Exec = async () => ({ code: 0, stdout: '', stderr: '' })
    expect(await spotlightStrays(none, 'nonce9', home, { tries: 2 })).toEqual([])
    const innocent = join(docs, 'innocent.rtf')
    writeFileSync(innocent, 'nothing of the run')
    expect(removeStrays([stray, innocent], 'nonce9')).toEqual([stray])
    expect(existsSync(stray)).toBe(false)
    expect(existsSync(innocent)).toBe(true)
    expect(holdsMarker(innocent, 'nonce9')).toBe(false)
  })

  it('field-textedit-close-discard wants the edit typed, the window gone and the bytes untouched (C6)', async () => {
    const task = fieldTaskById('field-textedit-close-discard')
    const dir = tmp()
    const file = join(dir, 'n.rtf')
    writeFileSync(file, docRtf(['Field probe n', 'line two']))
    const bytes = readFileSync(file).toString('base64')
    const s: FieldStart = { app: 'TextEdit', window: 'n', nonce: 'n', seed: 7, field: { file, bytes, extra: 'Added n' } }
    const typed = [typedCall('Added n')]
    expect((await task.check(s, reader(null), '', typed)).ok).toBe(true)
    // a model that closed the untouched window (no typing, no sheet) produced the same end state: it fails
    expect(await task.check(s, reader(null), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('unedited') })
    expect((await task.check(s, reader(win('TextEdit', 'n', [])), '', typed)).ok).toBe(false)
    // a read ERROR is not "gone": a hung app or a service restart fails the check with the reason
    expect(await task.check(s, reader(null, okExec, 'TextEdit did not answer within 2 s and may be hung'), '', typed)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('could not be read')
    })
    writeFileSync(file, docRtf(['Field probe n', 'line two', 'Added n']))
    expect(await task.check(s, reader(null), '', typed)).toMatchObject({ ok: false, detail: expect.stringContaining('changed') })
  })

  it('field-textedit-close-keep wants the edit typed, the window gone and the line kept', async () => {
    const task = fieldTaskById('field-textedit-close-keep')
    const dir = tmp()
    const file = join(dir, 'n.rtf')
    writeFileSync(file, docRtf(['Field probe n', 'Added n']))
    const s: FieldStart = { app: 'TextEdit', window: 'n', nonce: 'n', seed: 7, field: { file, extra: 'Added n' } }
    const typed = [typedCall('Added n')]
    expect((await task.check(s, reader(null), '', typed)).ok).toBe(true)
    // the same guard as close-discard: a line kept by autosave luck, never typed in the run, is no pass
    expect(await task.check(s, reader(null), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('unedited') })
    expect((await task.check(s, reader(null, okExec, 'socket closed'), '', typed)).ok).toBe(false)
    writeFileSync(file, docRtf(['Field probe n']))
    expect((await task.check(s, reader(null), '', typed)).ok).toBe(false)
    expect(editedInRun(typed, 'Added n')).toBe(true)
    expect(editedInRun([], 'Added n')).toBe(false)
  })

  it('the Finder checks read the disk, never the list, on the nonce-named files', async () => {
    const NONCE = 'abcd1234'
    const names = finderNames(NONCE)
    const rename = fieldTaskById('field-finder-rename')
    const dir = tmp()
    const files = join(dir, `files-${NONCE}`)
    mkdirSync(files)
    writeFileSync(join(files, names.draft), finderDraft(NONCE))
    writeFileSync(join(files, names.log), finderLog(NONCE))
    writeFileSync(join(files, names.keep), finderKeep(NONCE))
    const s: FieldStart = { app: 'Finder', window: `files-${NONCE}`, nonce: NONCE, seed: 7, field: { dir: files, home: dir } }
    expect(rename.prompt(s)).toContain(names.draft)
    // the field test's false success: the list showed the new name, the disk still held the old
    expect((await rename.check(s, reader(''), '', [])).ok).toBe(false)
    writeFileSync(join(files, names.final), finderDraft(NONCE))
    expect(await rename.check(s, reader(''), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining(names.draft) })
    rmSync(join(files, names.draft))
    expect((await rename.check(s, reader(''), '', [])).ok).toBe(true)

    const folder = fieldTaskById('field-finder-new-folder')
    expect((await folder.check(s, reader(''), '', [])).ok).toBe(false)
    writeFileSync(join(files, 'archive'), 'a plain file is no folder')
    expect((await folder.check(s, reader(''), '', [])).ok).toBe(false)
    rmSync(join(files, 'archive'))
    mkdirSync(join(files, 'archive'))
    expect((await folder.check(s, reader(''), '', [])).ok).toBe(true)
  })

  it('field-finder-trash wants the bytes out of the whole folder AND in the Trash, read through Finder (TCC)', async () => {
    const NONCE = 'abcd1234'
    const names = finderNames(NONCE)
    const trash = fieldTaskById('field-finder-trash')
    const home = tmp()
    const files = join(home, `files-${NONCE}`)
    mkdirSync(files)
    writeFileSync(join(files, names.log), finderLog(NONCE))
    writeFileSync(join(files, names.keep), finderKeep(NONCE))
    const s: FieldStart = { app: 'Finder', window: `files-${NONCE}`, nonce: NONCE, seed: 7, field: { dir: files, home } }
    const trashWith = (items: string): TaskReader => reader('', execWith({ 'every item of trash': items }))
    // still in the folder
    expect((await trash.check(s, trashWith(''), '', [])).ok).toBe(false)
    // renamed in place: the bytes are still under the folder
    renameSync(join(files, names.log), join(files, `old-${NONCE} 22.33.44.log`))
    expect(await trash.check(s, trashWith(''), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('still under the folder') })
    // moved into a subfolder: still not a trash
    mkdirSync(join(files, 'archive'))
    renameSync(join(files, `old-${NONCE} 22.33.44.log`), join(files, 'archive', names.log))
    expect(await trash.check(s, trashWith(''), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('still under the folder') })
    // deleted outright: gone from the folder, Finder lists no bench item
    rmSync(join(files, 'archive', names.log))
    expect(await trash.check(s, trashWith('somebody-else.txt\n'), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('not in the Trash') })
    // another run's item in the Trash proves nothing for this one
    expect((await trash.check(s, trashWith('old-ffff0000.log\n'), '', [])).ok).toBe(false)
    // really trashed, under Finder's duplicate rename: found by its unique nonce name
    expect((await trash.check(s, trashWith(`keep-zzz.md\nold-${NONCE} 10.11.12.log\n`), '', [])).ok).toBe(true)
    expect(bytesUnder(files, finderLog(NONCE))).toBeNull()
    // Finder failing to answer fails the check with its words, never a pass
    const broken: Exec = async (cmd, args) =>
      [cmd, ...args].join(' ').includes('every item of trash') ? { code: 1, stdout: '', stderr: 'Finder got an error: AppleEvent timed out.' } : { code: 0, stdout: '', stderr: '' }
    expect(await trash.check(s, reader('', broken), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('could not list the Trash') })
  })

  it('field-menu-shortcut wants the duplicated document’s window', async () => {
    const task = fieldTaskById('field-menu-shortcut')
    const s: FieldStart = { app: 'TextEdit', window: 'n0f1', nonce: 'n0f1', seed: 7, field: {} }
    expect((await task.check(s, reader(win('TextEdit', 'n0f1 copy', [])), '', [])).ok).toBe(true)
    expect((await task.check(s, reader(null), '', [])).ok).toBe(false)
  })

  it('windowGone believes only "no such window"; any other error is the check’s failure (C6)', async () => {
    expect(await windowGone(reader(null), 'TextEdit', 'x')).toEqual({ gone: true })
    expect(await windowGone(reader(null, okExec, 'TextEdit has no window open.'), 'TextEdit', 'x')).toEqual({ gone: true })
    expect(await windowGone(reader(null, okExec, 'TextEdit quit.'), 'TextEdit', 'x')).toEqual({ gone: true })
    expect(await windowGone(reader(win('TextEdit', 'x', [])), 'TextEdit', 'x')).toEqual({ gone: false })
    expect(await windowGone(reader(null, okExec, 'Finder did not answer within 2 s and may be hung'), 'TextEdit', 'x')).toEqual({
      gone: false,
      error: 'Finder did not answer within 2 s and may be hung'
    })
    const dir = tmp()
    const file = join(dir, 'a.rtf')
    writeFileSync(file, docRtf(['plain words n9']))
    expect(await docText(okExec, file)).toContain('plain words n9')
  })

  it('the Trash helpers: names read through Finder, matched by the bench shape, deleted item by item', async () => {
    const names = ['old-abcd1234 22.33.44.log', 'draft-abcd1234.txt', 'old-ffff0000.log', 'old notes.log', 'Computer Use Test.rtf']
    expect(trashNamesOf(names, 'abcd1234')).toEqual(['old-abcd1234 22.33.44.log', 'draft-abcd1234.txt'])
    expect(trashNamesOf(names, 'ffff0000')).toEqual(['old-ffff0000.log'])
    expect(benchTrashNames(names)).toEqual(['old-abcd1234 22.33.44.log', 'draft-abcd1234.txt', 'old-ffff0000.log'])
    expect(benchTrashNames(names, 'ab')).toEqual(['old-abcd1234 22.33.44.log', 'draft-abcd1234.txt'])
    expect(BENCH_TRASH_RE.test('files-abcd1234')).toBe(true)
    expect(BENCH_TRASH_RE.test('old-short.log')).toBe(false)

    const listed = await finderTrashNames(execWith({ 'every item of trash': 'a.txt\nold-abcd1234.log\n' }))
    expect(listed).toEqual(['a.txt', 'old-abcd1234.log'])
    const down: Exec = async () => ({ code: 1, stdout: '', stderr: 'Finder got an error' })
    await expect(finderTrashNames(down)).rejects.toThrow(/could not list the Trash/)

    const scripts: string[] = []
    const capturing: Exec = async (_cmd, args) => {
      scripts.push(args[1] ?? '')
      return { code: 0, stdout: '', stderr: '' }
    }
    const removed = await finderDeleteTrashItems(capturing, ['old-abcd1234.log', 'evil"name.txt'])
    expect(removed).toEqual(['old-abcd1234.log'])
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('delete item "old-abcd1234.log" of trash')
    expect(scripts[0]).not.toContain('empty')
  })

  it('the Finder teardown deletes only this run’s name-matched Trash items, through Finder', async () => {
    const NONCE = 'abcd1234'
    const task = fieldTaskById('field-finder-trash')
    const scripts: string[] = []
    const run: Exec = async (_cmd, args) => {
      const script = args[1] ?? ''
      scripts.push(script)
      if (script.includes('every item of trash')) return { code: 0, stdout: `old-${NONCE} 22.33.44.log\nold-ffff0000.log\nperson.txt\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const s: FieldStart = { app: 'Finder', window: `files-${NONCE}`, nonce: NONCE, seed: 7, field: { dir: '/tmp/x', home: '/tmp/h' } }
    await task.teardown!(s, run)
    const deletes = scripts.filter((x) => x.includes('delete item'))
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toContain(`delete item "old-${NONCE} 22.33.44.log" of trash`)
  })

  it('the close tasks set the pref for the run, prove the sheet, and restore exactly (skip when the premise is absent)', async () => {
    // probe: its own TextEdit (open -n, the new pid), a dirty saved document closed over AX, the sheet seen and answered, the instance killed
    const log: string[] = []
    const fast = { wait: async () => {} }
    expect(await probeCloseSheet(probeMac({ sheet: true, log }), { file: '/tmp/d/probe-n.rtf', nonce: 'n', ...fast })).toMatchObject({ sheet: true })
    expect(log.find((k) => k.startsWith('open '))).toMatch(/^open -n -g -a TextEdit \/tmp\/d\/probe-n\.rtf/)
    expect(log.some((k) => k.includes('unix id is 4242') && k.includes('set value of text area 1'))).toBe(true)
    expect(log.some((k) => k.includes('AXCloseButton'))).toBe(true)
    expect(log.some((k) => k.includes('click button "Revert Changes" of sheet 1'))).toBe(true)
    expect(log.at(-1)).toBe('kill -9 4242')
    // never the person's TextEdit: no script addresses the app by name
    expect(log.some((k) => k.includes('tell application "TextEdit"'))).toBe(false)
    // a dirty close that runs through silently: the premise is absent, and the probe's instance is still killed
    const silentLog: string[] = []
    const silentMac = probeMac({ sheet: false, log: silentLog })
    let closed = false
    const silent: Exec = async (cmd, args) => {
      const key = [cmd, ...args].join(' ')
      if (key.includes('AXCloseButton')) closed = true
      if (closed && key.includes('exists (first window')) return { code: 0, stdout: 'false', stderr: '' }
      return silentMac(cmd, args)
    }
    expect(await probeCloseSheet(silent, { file: '/tmp/d/probe-n.rtf', nonce: 'n', ...fast })).toMatchObject({ sheet: false, detail: 'a dirty saved document closed with no sheet' })
    expect(silentLog.at(-1)).toBe('kill -9 4242')

    // the pref: read, write for the run, restore exactly
    const calls: string[][] = []
    const defaultsExec =
      (readAnswer: { code: number; stdout: string }): Exec =>
      async (cmd, args) => {
        if (cmd === 'defaults') calls.push(args)
        return cmd === 'defaults' && args[0] === 'read' ? { ...readAnswer, stderr: '' } : { code: 0, stdout: '', stderr: '' }
      }
    expect(await readCloseConfirm(defaultsExec({ code: 1, stdout: '' }))).toBeNull()
    expect(await readCloseConfirm(defaultsExec({ code: 0, stdout: '0\n' }))).toBe('0')
    calls.length = 0
    await writeCloseConfirm(defaultsExec({ code: 0, stdout: '' }), '1')
    await writeCloseConfirm(defaultsExec({ code: 0, stdout: '' }), '0')
    await writeCloseConfirm(defaultsExec({ code: 0, stdout: '' }), null)
    expect(calls).toEqual([
      ['write', 'com.apple.TextEdit', 'NSCloseAlwaysConfirmsChanges', '-bool', 'true'],
      ['write', 'com.apple.TextEdit', 'NSCloseAlwaysConfirmsChanges', '-bool', 'false'],
      ['delete', 'com.apple.TextEdit', 'NSCloseAlwaysConfirmsChanges']
    ])

    // setup with no sheet: skipped with the reason, the pref restored first (the key was absent → deleted again)
    const seen: string[][] = []
    const noSheetMac = probeMac({ sheet: false })
    const noSheet: Exec = async (cmd, args) => {
      if (cmd === 'defaults') {
        seen.push(args)
        return args[0] === 'read' ? { code: 1, stdout: '', stderr: 'does not exist' } : { code: 0, stdout: '', stderr: '' }
      }
      return noSheetMac(cmd, args)
    }
    const noSheetCtx = fakeCtx(tmp(), noSheet)
    const skipped = await fieldTaskById('field-textedit-close-discard').setup(noSheetCtx)
    expect(skipped).toMatchObject({ skip: expect.stringContaining('premise is absent') })
    // the task's window is never opened when its premise is absent
    expect(noSheetCtx.opened).toEqual([])
    expect(seen.at(-1)).toEqual(['delete', 'com.apple.TextEdit', 'NSCloseAlwaysConfirmsChanges'])

    // a good setup carries the old pref, and the teardown puts it back as a bool write
    const ctx = fakeCtx(tmp(), fieldExec({ 'defaults read': '' }))
    const started = await fieldTaskById('field-textedit-close-keep').setup({ ...ctx, run: fieldExec() })
    expect('skip' in started).toBe(false)
    const restore: string[][] = []
    const restoring: Exec = async (cmd, args) => {
      if (cmd === 'defaults') restore.push(args)
      if (cmd === 'pgrep') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await fieldTaskById('field-textedit-close-keep').teardown!({ ...(started as FieldStart), field: { ...(started as FieldStart).field, pref: '1' } }, restoring)
    expect(restore).toEqual([['write', 'com.apple.TextEdit', 'NSCloseAlwaysConfirmsChanges', '-bool', 'true']])
    await fieldTaskById('field-textedit-close-keep').teardown!(started as FieldStart, restoring)
    expect(restore.at(-1)).toEqual(['delete', 'com.apple.TextEdit', 'NSCloseAlwaysConfirmsChanges'])
  })

  it('fieldOf reads the start’s field bag, empty for a gate start', () => {
    expect(fieldOf({ app: 'TextEdit', window: 'w', nonce: 'n', seed: 1 } as TaskStart)).toEqual({})
    expect(fieldOf({ app: 'TextEdit', window: 'w', nonce: 'n', seed: 1, field: { total: 3 } } as TaskStart)).toEqual({ total: 3 })
  })
})
