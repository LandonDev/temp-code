import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/server/db'
import { AddonStore } from '../src/main/server/addonStore'
import { DEV_ADDON_URL, FEEDBACK_KEY, saveSourceText, type Exec } from './lib/benchChecks'
import { parseObservation, type ParsedObservation } from '../src/shared/computer/observation'
import {
  BENCH_ORDERS,
  COMPUTER_ONLY_LINE,
  COMPUTER_TASKS,
  FORM_STATUS,
  benchWindow,
  deleteTarget,
  flaggedBeforeDelete,
  gateTasks,
  orderCount,
  seededOrders,
  statusText,
  taskById,
  type CallRecord,
  type TaskContext,
  type TaskReader,
  type TaskStart
} from './lib/computerTasks'

const BENCH = readFileSync(join(__dirname, '../src/main/server/computer/fixtures/page/bench.html'), 'utf8')

function bench(seed: number, name: string): JSDOM {
  return new JSDOM(BENCH, { url: `file:///bench.html#seed=${seed}&name=${name}`, runScripts: 'dangerously' })
}

describe('bench.html', () => {
  it('lists the orders seededOrders gives, under a title naming the run', () => {
    for (const seed of [1, 7, 4242]) {
      const dom = bench(seed, 'k3x9')
      const doc = dom.window.document
      expect(doc.title).toBe(benchWindow('k3x9'))
      const rows = [...doc.querySelectorAll('#orders li')].map((li) => li.firstChild!.textContent)
      expect(rows).toEqual(seededOrders(seed).map((o) => `Order ${o.id} · ${o.price}`))
      expect(rows).toHaveLength(BENCH_ORDERS)
      expect(doc.getElementById('count')!.textContent).toBe('60 orders')
      // the status and the count sit in the sticky bar, in view whatever the list's scroll
      expect([...doc.querySelectorAll('#bar > p')].map((p) => p.id)).toEqual(['status', 'count'])
    }
    expect(new Set(seededOrders(3).map((o) => o.id)).size).toBe(BENCH_ORDERS)
  })

  it('deletes a row and says so', () => {
    const doc = bench(9, 'n').window.document
    const id = deleteTarget(9)
    ;(doc.querySelector(`button[aria-label="Delete order ${id}"]`) as HTMLButtonElement).click()
    expect(doc.getElementById('status')!.textContent).toBe(`Deleted ${id}`)
    expect(doc.getElementById('count')!.textContent).toBe('59 orders')
    expect(doc.body.textContent).not.toContain(`Order ${id}`)
  })

  it('writes the form into the status and sends nothing', () => {
    const dom = bench(2, 'n')
    const doc = dom.window.document
    ;(doc.getElementById('name') as HTMLInputElement).value = 'Ana Ruiz'
    ;(doc.getElementById('email') as HTMLInputElement).value = 'ana@example.com'
    ;(doc.getElementById('size') as HTMLSelectElement).value = 'L'
    ;(doc.getElementById('gift') as HTMLInputElement).checked = true
    ;(doc.querySelector('input[value="express"]') as HTMLInputElement).checked = true
    ;(doc.getElementById('submit') as HTMLButtonElement).click()
    expect(doc.getElementById('status')!.textContent).toBe(FORM_STATUS)
    expect(dom.window.location.href).toContain('bench.html#seed=2')
  })
})

// ── the checks, on hand-written reads ───────────────────────────────────

const start = (over: Partial<TaskStart> = {}): TaskStart => ({ app: 'Google Chrome', window: benchWindow('n0'), nonce: 'n0', seed: 5, ...over })

function chromeRead(status: string, count: number, extraRows: string[] = []): string {
  return [
    `app "Google Chrome" · window "${benchWindow('n0')}" · 1280×800`,
    `[1] window "${benchWindow('n0')}"`,
    '  [2] status',
    ...(status ? [`    [3] text "${status}"`] : []),
    '  [4] group',
    `    [5] text "${count} orders"`,
    ...extraRows.map((r, i) => `  [${10 + i}] button "Delete order ${r}"`)
  ].join('\n')
}

const noExec: Exec = async () => ({ code: 1, stdout: '', stderr: 'no commands in this test' })
const reader = (tree: string, element?: string, exec: Exec = noExec): TaskReader => ({
  read: async (): Promise<ParsedObservation> => parseObservation(tree),
  element: async (): Promise<ParsedObservation> => parseObservation(element ?? tree),
  exec
})
const execReader = (exec: Exec): TaskReader => reader('', undefined, exec)

describe('the tasks', () => {
  it('name their window or app, end with the computer-tools-only line, and carry a version, a tier and a budget', () => {
    const windows: Record<string, string> = { TextEdit: 'n0', 'Google Chrome': benchWindow('n0'), Electron: 'TempCode', 'System Settings': 'System Settings' }
    for (const t of COMPUTER_TASKS) {
      const s = start({ app: t.app, window: windows[t.app], orderId: 'ABCD' })
      const message = t.prompt(s)
      expect(message, t.id).toContain(s.window)
      expect(message.endsWith(COMPUTER_ONLY_LINE)).toBe(true)
      if (t.then) expect(t.then.message.endsWith(COMPUTER_ONLY_LINE), t.id).toBe(true)
      expect(t.version, t.id).toBeGreaterThanOrEqual(1)
      expect(['background', 'session']).toContain(t.tier)
      expect(t.stepBudget, t.id).toBeGreaterThanOrEqual(6)
    }
    expect(new Set(COMPUTER_TASKS.map((t) => t.id)).size).toBe(7)
    expect(COMPUTER_TASKS.filter((t) => t.shared).map((t) => [t.id, t.shared])).toEqual([
      ['devapp-form', 'dev-instance'],
      ['settings-toggle', 'system-settings']
    ])
  })

  it('gives the gate every background task', () => {
    expect(gateTasks().map((t) => t.id)).toEqual(COMPUTER_TASKS.filter((t) => t.tier === 'background').map((t) => t.id))
    expect(gateTasks([{ ...taskById('save-dialog'), tier: 'session' }, taskById('chrome-read')]).map((t) => t.id)).toEqual(['chrome-read'])
  })

  it("read the status off Chrome's tree when no element is called status, by what the page writes there", () => {
    const chrome = [
      `app "Google Chrome" · window "${benchWindow('n0')}" · 1280×800`,
      `[1] window "${benchWindow('n0')}"`,
      '  [2] web area "TempCode bench n0"',
      '    [3] group',
      `      [4] text = "${FORM_STATUS}"`,
      '      [5] text = "60 orders"',
      '    [6] text = "Order ABCD · 12.40"'
    ].join('\n')
    expect(statusText(parseObservation(chrome))).toBe(FORM_STATUS)
    expect(orderCount(parseObservation(chrome))).toBe(60)
    expect(statusText(parseObservation(chrome.replace(`text = "${FORM_STATUS}"`, 'text = "Order list"')))).toBeNull()
  })

  it('read the status and the count off a read', () => {
    const o = parseObservation(chromeRead('Deleted ABCD', 59))
    expect(statusText(o)).toBe('Deleted ABCD')
    expect(orderCount(o)).toBe(59)
    expect(statusText(parseObservation(chromeRead('', 60)))).toBe('')
  })

  it('textedit-write passes only on the exact text', async () => {
    const t = taskById('textedit-write')
    const s = start({ app: 'TextEdit', window: 'n0' })
    const tree = (value: string): string =>
      [`app "TextEdit" · window "n0.rtf" · 800×600 · focused [3]`, '[1] window "n0.rtf"', `  [3] text area = ${JSON.stringify(value)} focused`].join('\n')
    expect((await t.check(s, reader(tree('x'), tree('Hello from TempCode n0\n')), '', [])).ok).toBe(true)
    expect((await t.check(s, reader(tree('x'), tree('Probe line one\nHello from TempCode n0')), '', [])).ok).toBe(false)
  })

  it('chrome-read wants the 47th price and an unchanged page', async () => {
    const t = taskById('chrome-read')
    const s = start()
    const price = seededOrders(5)[46].price
    expect((await t.check(s, reader(chromeRead('', 60)), `It is ${price}.`, [])).ok).toBe(true)
    expect((await t.check(s, reader(chromeRead('', 60)), '1.00', [])).ok).toBe(false)
    expect((await t.check(s, reader(chromeRead('Deleted ABCD', 59)), price, [])).ok).toBe(false)
  })

  it('chrome-form wants the submitted line', async () => {
    const t = taskById('chrome-form')
    expect((await t.check(start(), reader(chromeRead(FORM_STATUS, 60)), '', [])).ok).toBe(true)
    expect((await t.check(start(), reader(chromeRead('Submitted: Ana Ruiz, ana@example.com, M, gift, express', 60)), '', [])).ok).toBe(false)
  })

  it('chrome-delete wants the row gone, and its policy the delete flagged before it went', async () => {
    const t = taskById('chrome-delete')
    const s = start({ orderId: 'ABCD' })
    const click = (confirm?: object, result = 'left_click [9] button "Delete order ABCD" · ax · changed\n~ [3] text "Deleted ABCD"'): CallRecord => ({
      name: 'mcp__app__computer_act',
      input: { app: 'Google Chrome', action: 'left_click', element: 9, ...(confirm ? { confirm } : {}) },
      result
    })
    const gone = reader(chromeRead('Deleted ABCD', 59))
    // the end state alone: a gone row passes with no flag recorded, and the policy fails it
    expect((await t.check(s, gone, '', [click()])).ok).toBe(true)
    expect(t.policy!(s, [click()]).ok).toBe(false)
    expect(t.policy!(s, [click({ kind: 'delete', what: 'Delete order ABCD' })]).ok).toBe(true)
    expect((await t.check(s, reader(chromeRead('Deleted ABCD', 59, ['ABCD'])), '', [])).ok).toBe(false)
    expect((await t.check(s, reader(chromeRead('', 60)), '', [])).ok).toBe(false)
  })

  it('a flag after the row went does not count', () => {
    const calls: CallRecord[] = [
      { name: 'computer_left_click', input: {}, result: 'Deleted ABCD' },
      { name: 'computer_left_click', input: { confirm: { kind: 'delete', what: 'x' } }, result: '' }
    ]
    expect(flaggedBeforeDelete(calls, 'ABCD')).toEqual({ ok: false, detail: 'the delete ran unflagged (call 1)' })
    expect(flaggedBeforeDelete([calls[1]], 'ABCD').ok).toBe(true)
  })
})

// ── the benchmark's own tasks ───────────────────────────────────────────

const dirs: string[] = []
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'computer-tasks-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ctx = (over: Partial<TaskContext> = {}): TaskContext => ({
  nonce: 'n0',
  seed: 5,
  dir: scratch(),
  benchUrl: 'file:///bench.html',
  writeFile: async (p, t) => writeFileSync(p, t),
  open: async () => {},
  run: noExec,
  home: scratch(),
  ...over
})

describe('settings-toggle', () => {
  const t = taskById('settings-toggle')
  /** `defaults` answering one value; System Settings running or not. */
  const mac = (value: number, running = false): Exec => async (cmd, args) => {
    if (cmd === 'osascript') return { code: 0, stdout: `${running}\n`, stderr: '' }
    expect([cmd, args.slice(0, 3)]).toEqual(['defaults', ['read', '-g', FEEDBACK_KEY]])
    return { code: 0, stdout: `${value}\n`, stderr: '' }
  }

  it('skips when System Settings is already open, and launches it otherwise', async () => {
    const opened: string[] = []
    expect(await t.setup(ctx({ run: mac(0, true), open: async (app) => void opened.push(app) }))).toEqual({ skip: 'System Settings is open' })
    expect(opened).toEqual([])
    expect(await t.setup(ctx({ run: mac(1), open: async (app) => void opened.push(app) }))).toMatchObject({ app: 'System Settings', toggle: { value: 1, setting: 1 } })
    expect(opened).toEqual(['System Settings'])
  })

  it('turn one passes on the other value and fails on the first; turn two the reverse', async () => {
    const s = start({ app: 'System Settings', window: 'System Settings', toggle: { value: 0, setting: 0 } })
    expect((await t.then!.check(s, execReader(mac(1)))).ok).toBe(true)
    expect((await t.then!.check(s, execReader(mac(0)))).ok).toBe(false)
    expect((await t.check(s, execReader(mac(0)), '', [])).ok).toBe(true)
    expect((await t.check(s, execReader(mac(1)), '', [])).ok).toBe(false)
  }, 10_000)

  it('teardown puts the key back only when it moved, deleting one that was never set', async () => {
    const writes: string[][] = []
    const run = (value: number | null): Exec => async (cmd, args) => {
      if (args[0] === 'write' || args[0] === 'delete') return void writes.push(args), { code: 0, stdout: '', stderr: '' }
      return value === null ? { code: 1, stdout: '', stderr: `Error: Could not find key '${FEEDBACK_KEY}'` } : mac(value)(cmd, args)
    }
    await t.teardown!(start({ toggle: { value: 0, setting: 0 } }), run(0))
    expect(writes).toEqual([])
    await t.teardown!(start({ toggle: { value: 0, setting: 0 } }), run(1))
    expect(writes).toEqual([['write', '-g', FEEDBACK_KEY, '-int', '0']])
    writes.length = 0
    // never set before the run: System Settings wrote it, the run deletes it again
    await t.teardown!(start({ toggle: { value: 0, setting: null } }), run(1))
    expect(writes).toEqual([['delete', '-g', FEEDBACK_KEY]])
    writes.length = 0
    await t.teardown!(start({ toggle: { value: 0, setting: null } }), run(null))
    expect(writes).toEqual([])
  })
})

describe('save-dialog', () => {
  const t = taskById('save-dialog')
  /** textutil over plain files and Spotlight answering `named`. */
  const files = (named: string[]): Exec => async (cmd, args) => {
    if (cmd === 'mdfind') return { code: 0, stdout: named.join('\n'), stderr: '' }
    if (cmd === 'textutil' && args[0] === '-convert' && args[1] === 'rtf') {
      writeFileSync(args[3], readFileSync(args[4], 'utf8'))
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'textutil') return { code: 0, stdout: readFileSync(args.at(-1)!, 'utf8'), stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

  it('starts on two scratch files and checks the target holds the text with nothing strayed', async () => {
    const c = ctx({ run: files([]) })
    const s = (await t.setup(c)) as TaskStart
    expect(t.prompt(s)).toContain('n0-target.rtf')
    expect(readFileSync(s.saveDialog!.target, 'utf8').trim()).toBe('old')
    expect((await t.check(s, execReader(files([])), '', [])).ok).toBe(false)
    writeFileSync(s.saveDialog!.target, saveSourceText('n0') + '\n')
    expect(await t.check(s, execReader(files([s.saveDialog!.source])), '', [])).toEqual({ ok: true, detail: 'saved over the target' })
    const stray = join(s.saveDialog!.home, 'Documents', 'n0.rtf')
    expect((await t.check(s, execReader(files([stray])), '', [])).ok).toBe(false)
  })
})

describe('devapp-form', () => {
  const t = taskById('devapp-form')
  const instance = (url: string, workspaceId: string | null = null): TaskStart => {
    const userData = scratch()
    const db = openDb(join(userData, 'temp-code.db'))
    new AddonStore(db).set({ name: 'bench-n0', workspaceId, spec: { transport: 'http', url, headers: [], auth: 'none' } }, { kind: 'person' })
    db.close()
    return start({ app: 'Electron', window: 'TempCode', dev: { database: join(userData, 'temp-code.db'), stop: async () => {} } })
  }

  it('passes on the instance’s database holding the row, and fails on a wrong url or a workspace scope', async () => {
    expect((await t.check(instance(DEV_ADDON_URL), reader(''), '', [])).ok).toBe(true)
    expect((await t.check(instance('http://127.0.0.1:9/x'), reader(''), '', [])).ok).toBe(false)
    expect((await t.check(instance(DEV_ADDON_URL, 'ws_1'), reader(''), '', [])).ok).toBe(false)
  })

  it('skips with no dev instance, and stops the instance it started', async () => {
    expect(await t.setup(ctx())).toEqual({ skip: 'no dev instance here' })
    expect(await t.setup(ctx({ devInstance: async () => ({ skip: 'out/ is not HEAD’s build' }) }))).toEqual({ skip: 'out/ is not HEAD’s build' })
    let stopped = 0
    const s = (await t.setup(ctx({ devInstance: async () => ({ userData: '/tmp/u', window: 'TempCode', stop: async () => void stopped++ }) }))) as TaskStart
    expect(s.dev!.database).toBe('/tmp/u/temp-code.db')
    await t.teardown!(s, noExec)
    expect(stopped).toBe(1)
  })
})
