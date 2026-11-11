import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  FINDER_DRAFT,
  FINDER_LOG,
  confirmationText,
  docRtf,
  docText,
  fieldCode,
  fieldFormCode,
  fieldOf,
  fieldRows,
  fieldTaskById,
  fieldWindow,
  foldRow,
  formHtml,
  invoiceItems,
  invoiceRtf,
  nearRow,
  noteFiles,
  removeTrashedScratch,
  replyHasNumber,
  reportHtml,
  topRow,
  treeShowsNumber,
  windowGone,
  type FieldStart
} from './lib/fieldTasks'

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

const fakeCtx = (dir: string, run: Exec = execWith({ 'is running': 'false' })): FakeCtx => {
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

const reader = (tree: string | null, exec: Exec = okExec): TaskReader => ({
  read: async (): Promise<ParsedObservation> => {
    if (tree === null) throw new Error('window_not_found')
    return parseObservation(tree)
  },
  element: async (): Promise<ParsedObservation> => parseObservation(tree ?? ''),
  exec
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
  it('replyHasNumber takes any digit grouping', () => {
    expect(replyHasNumber('Lisbon: 964,801 dollars', 964801)).toBe(true)
    expect(replyHasNumber('964 801', 964801)).toBe(true)
    expect(replyHasNumber('96,480', 964801)).toBe(false)
  })

  it('treeShowsNumber finds Calculator’s display however it groups', () => {
    const tree = win('Calculator', 'Calculator', ['  [2] group', '    [3] text = "12,345,678"'])
    expect(treeShowsNumber(parseObservation(tree), 12345678)).toBe(true)
    expect(treeShowsNumber(parseObservation(tree), 999)).toBe(false)
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

  it('field-textedit-save-as wants note in the folder and no stray copy', async () => {
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
    writeFileSync(join(docs, 'Computer Use Test.rtf'), 'x')
    const mdfind = execWith({ mdfind: `${join(docs, 'Computer Use Test.rtf')}\n` })
    expect(await task.check(s, reader('', mdfind), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('strayed') })
    expect(noteFiles(dir)).toEqual([join(dir, 'note.rtf')])
  })

  it('field-textedit-close-discard wants the window gone and the bytes untouched', async () => {
    const task = fieldTaskById('field-textedit-close-discard')
    const dir = tmp()
    const file = join(dir, 'n.rtf')
    writeFileSync(file, docRtf(['Field probe n', 'line two']))
    const bytes = readFileSync(file).toString('base64')
    const s: FieldStart = { app: 'TextEdit', window: 'n', nonce: 'n', seed: 7, field: { file, bytes, extra: 'Added n' } }
    expect((await task.check(s, reader(null), '', [])).ok).toBe(true)
    expect((await task.check(s, reader(win('TextEdit', 'n', [])), '', [])).ok).toBe(false)
    writeFileSync(file, docRtf(['Field probe n', 'line two', 'Added n']))
    expect(await task.check(s, reader(null), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('changed') })
  })

  it('field-textedit-close-keep wants the window gone and the line kept', async () => {
    const task = fieldTaskById('field-textedit-close-keep')
    const dir = tmp()
    const file = join(dir, 'n.rtf')
    writeFileSync(file, docRtf(['Field probe n', 'Added n']))
    const s: FieldStart = { app: 'TextEdit', window: 'n', nonce: 'n', seed: 7, field: { file, extra: 'Added n' } }
    expect((await task.check(s, reader(null), '', [])).ok).toBe(true)
    writeFileSync(file, docRtf(['Field probe n']))
    expect((await task.check(s, reader(null), '', [])).ok).toBe(false)
  })

  it('the Finder checks read the disk, never the list', async () => {
    const rename = fieldTaskById('field-finder-rename')
    const dir = tmp()
    const files = join(dir, 'files-n')
    mkdirSync(files)
    writeFileSync(join(files, 'draft.txt'), FINDER_DRAFT)
    writeFileSync(join(files, 'old.log'), FINDER_LOG)
    writeFileSync(join(files, 'keep.md'), '# keep\n')
    const s: FieldStart = { app: 'Finder', window: 'files-n', nonce: 'n', seed: 7, field: { dir: files, home: dir } }
    // the field test's false success: the list showed final.txt, the disk still held draft.txt
    expect((await rename.check(s, reader(''), '', [])).ok).toBe(false)
    writeFileSync(join(files, 'final.txt'), FINDER_DRAFT)
    expect(await rename.check(s, reader(''), '', [])).toMatchObject({ ok: false, detail: expect.stringContaining('draft.txt') })
    rmSync(join(files, 'draft.txt'))
    expect((await rename.check(s, reader(''), '', [])).ok).toBe(true)

    const trash = fieldTaskById('field-finder-trash')
    expect((await trash.check(s, reader(''), '', [])).ok).toBe(false)
    rmSync(join(files, 'old.log'))
    expect((await trash.check(s, reader(''), '', [])).ok).toBe(true)

    const folder = fieldTaskById('field-finder-new-folder')
    expect((await folder.check(s, reader(''), '', [])).ok).toBe(false)
    writeFileSync(join(files, 'archive'), 'a plain file is no folder')
    expect((await folder.check(s, reader(''), '', [])).ok).toBe(false)
    rmSync(join(files, 'archive'))
    mkdirSync(join(files, 'archive'))
    expect((await folder.check(s, reader(''), '', [])).ok).toBe(true)
  })

  it('field-menu-shortcut wants the duplicated document’s window', async () => {
    const task = fieldTaskById('field-menu-shortcut')
    const s: FieldStart = { app: 'TextEdit', window: 'n0f1', nonce: 'n0f1', seed: 7, field: {} }
    expect((await task.check(s, reader(win('TextEdit', 'n0f1 copy', [])), '', [])).ok).toBe(true)
    expect((await task.check(s, reader(null), '', [])).ok).toBe(false)
  })

  it('windowGone and docText answer from what they are given', async () => {
    expect(await windowGone(reader(null), 'TextEdit', 'x')).toBe(true)
    expect(await windowGone(reader(win('TextEdit', 'x', [])), 'TextEdit', 'x')).toBe(false)
    const dir = tmp()
    const file = join(dir, 'a.rtf')
    writeFileSync(file, docRtf(['plain words n9']))
    expect(await docText(okExec, file)).toContain('plain words n9')
  })

  it('removeTrashedScratch takes only the scratch log’s copies', () => {
    const home = tmp()
    const trash = join(home, '.Trash')
    mkdirSync(trash)
    writeFileSync(join(trash, 'old.log'), FINDER_LOG)
    writeFileSync(join(trash, 'old 22.33.44.log'), FINDER_LOG)
    writeFileSync(join(trash, 'old notes.log'), 'the person’s own file\n')
    writeFileSync(join(trash, 'keep.txt'), FINDER_LOG)
    expect(removeTrashedScratch(home).sort()).toEqual(['old 22.33.44.log', 'old.log'])
    expect(existsSync(join(trash, 'old notes.log'))).toBe(true)
    expect(existsSync(join(trash, 'keep.txt'))).toBe(true)
  })

  it('fieldOf reads the start’s field bag, empty for a gate start', () => {
    expect(fieldOf({ app: 'TextEdit', window: 'w', nonce: 'n', seed: 1 } as TaskStart)).toEqual({})
    expect(fieldOf({ app: 'TextEdit', window: 'w', nonce: 'n', seed: 1, field: { total: 3 } } as TaskStart)).toEqual({ total: 3 })
  })
})
