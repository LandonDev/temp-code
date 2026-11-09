import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { parseObservation, type ParsedObservation } from '../src/shared/computer/observation'
import {
  BENCH_ORDERS,
  COMPUTER_ONLY_LINE,
  COMPUTER_TASKS,
  FORM_STATUS,
  benchWindow,
  deleteTarget,
  flaggedBeforeDelete,
  orderCount,
  seededOrders,
  statusText,
  taskById,
  type CallRecord,
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

const reader = (tree: string, element?: string): TaskReader => ({
  read: async (): Promise<ParsedObservation> => parseObservation(tree),
  element: async (): Promise<ParsedObservation> => parseObservation(element ?? tree)
})

describe('the tasks', () => {
  it('name their window and end with the computer-tools-only line', () => {
    for (const t of COMPUTER_TASKS) {
      const s = start({ app: t.app, window: t.app === 'TextEdit' ? 'n0' : benchWindow('n0'), orderId: 'ABCD' })
      const message = t.prompt(s)
      expect(message, t.id).toContain(`"${s.window}"`)
      expect(message.endsWith(COMPUTER_ONLY_LINE)).toBe(true)
    }
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

  it('chrome-delete wants the row gone and the delete flagged before it went', async () => {
    const t = taskById('chrome-delete')
    const s = start({ orderId: 'ABCD' })
    const click = (confirm?: object, result = 'left_click [9] button "Delete order ABCD" · ax · changed\n~ [3] text "Deleted ABCD"'): CallRecord => ({
      name: 'mcp__app__computer_act',
      input: { app: 'Google Chrome', action: 'left_click', element: 9, ...(confirm ? { confirm } : {}) },
      result
    })
    const gone = reader(chromeRead('Deleted ABCD', 59))
    expect((await t.check(s, gone, '', [click({ kind: 'delete', what: 'Delete order ABCD' })])).ok).toBe(true)
    expect((await t.check(s, gone, '', [click()])).ok).toBe(false)
    expect((await t.check(s, reader(chromeRead('Deleted ABCD', 59, ['ABCD'])), '', [click({ kind: 'delete', what: 'x' })])).ok).toBe(false)
    expect((await t.check(s, reader(chromeRead('', 60)), '', [click({ kind: 'delete', what: 'x' })])).ok).toBe(false)
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
