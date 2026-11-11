import { describe, expect, it } from 'vitest'
import { MENU_BLOCK, parseObservation, type ElementLine } from '../../src/shared/computer/observation'
import { BatchResultSchema, type BatchResult, type ComputerActionName, type StepResult } from '../../src/shared/computer/protocol'
import { FEWER_PROBE, MENU_BLOCK_MISSING, menuClosedByPerson, judgeFewerMenu, judgeFewerNote, judgeFewerPopup, judgeFewerRename, judgeFewerStopped, rowShowing } from './fewerLeg'

const waited = { waitedMs: 450, settled: true, busy: false, reason: 'quiet' as const }
const ok = (index: number, action: ComputerActionName, extra: Partial<Extract<StepResult, { status: 'ok' }>> = {}): StepResult => ({
  index, action, status: 'ok', tier: 'ax', effect: 'changed', waited, ...extra
})

/** Wire-shaped fixtures pass the same zod as the stdio service before a judge sees them. */
function result(steps: StepResult[], body: string[], opts: { note?: boolean; diff?: boolean; unchanged?: boolean; focus?: number } = {}): BatchResult {
  const title = opts.note ? FEWER_PROBE.note : FEWER_PROBE.window
  const header = `app "TC Probe" · window "${title}" · 360×240${opts.focus === undefined ? '' : ` · focused [${opts.focus}]`}${opts.diff ? ' · changes since your last read' : opts.unchanged ? ' · no changes' : ''}`
  const text = [header, ...body].join('\n')
  return BatchResultSchema.parse({
    steps, waited,
    observation: {
      epoch: 'fewer-epoch', session: 'proof', app: { pid: 123, bundleId: 'dev.landon.tempcode.computer-probe', name: 'TC Probe' },
      window: { id: opts.note ? 302 : 301, title, frame: { x: 560, y: 360, w: 360, h: 240 } },
      kind: opts.diff ? 'diff' : opts.unchanged ? 'unchanged' : 'full', seq: 2, ...(opts.diff ? { base: 1 } : {}), text,
      space: { width: 360, height: 240, scale: 1 },
      stats: { elements: body.length, lines: body.length + 1, bytes: Buffer.byteLength(text), omitted: 0, thin: false, partial: false, readMs: 3 }
    }
  })
}

const popup = (): BatchResult => result([
  ok(0, 'left_click'), ok(1, 'left_click', { resolved: 53, input: { via: 'pick', on: 'Team' } })
], ['~ [4] pop up "Destination" = "Team"'], { diff: true })
const note = (): BatchResult => result([
  ok(0, 'left_click', { opened: { id: 302, title: FEWER_PROBE.note }, resolved: 42, focusTo: 12, input: { via: 'menu', on: 'Probe › New Note' } }),
  ok(1, 'type', { input: { via: 'ax-insert', on: 'Note' } })
], ['[11] window "TC Probe Note"', `  [12] text area "Note" = "${FEWER_PROBE.text}" focused`], { note: true, focus: 12 })
const rename = (): BatchResult => result([
  ok(0, 'left_click', { focusTo: 5 }), ok(1, 'key', { tier: 'process', focusTo: 17 }),
  ok(2, 'type'), ok(3, 'key', { tier: 'process', focusTo: 5 })
], ['~ [7] row "Renamed note" selected'], { diff: true })
const stopped = (): BatchResult => result([
  ok(0, 'left_click', { effect: 'none' }),
  ...(['key', 'type', 'key'] as const).map((action, i): StepResult => ({ index: i + 1, action, status: 'not-run', stopped: { afterStep: 0, reason: 'no-change' } }))
], [], { unchanged: true })
const menu = (): BatchResult => result([ok(0, 'left_click')], [
  '+ menu opened by step 1: [51] menu "Destination"',
  '  [52] menu item "Personal"', '  [53] menu item "Team" checked', '  [54] menu item "Archive"'
], { unchanged: true })

function editText(r: BatchResult, from: string, to: string): BatchResult {
  r.observation!.text = r.observation!.text.replace(from, to)
  return r
}

describe('the --fewer single-batch judges (§27.15)', () => {
  it('accepts a named pop-up pick and the selected value in its closing diff', () => {
    expect(judgeFewerPopup(popup())).toEqual([])
  })
  it('rejects a successful pick whose selected value is wrong', () => {
    expect(judgeFewerPopup(editText(popup(), '= "Team"', '= "Personal"'))).toContain('the closing observation must show Team selected in Destination')
  })
  it('requires the named target resolution and a closed menu', () => {
    const r = popup()
    if (r.steps[1].status === 'ok') delete r.steps[1].resolved
    r.observation!.text += '\n+ menu opened by step 1; its items did not answer: pick one with named, or close it with key Escape'
    expect(judgeFewerPopup(r)).toEqual(expect.arrayContaining(['the named pick must report its resolved element', 'the picked menu must be closed']))
  })
  it('does not count a removed pop-up line as its selected state', () => {
    expect(judgeFewerPopup(editText(popup(), '~ [4]', '- [4]'))).not.toEqual([])
  })

  it('accepts menu resolution, opened, a full read of that window and type at focusTo', () => {
    expect(judgeFewerNote(note(), 301)).toEqual([])
  })
  it.each(['missing', 'old-window', 'wrong-window', 'diff', 'wrong-text', 'wrong-focus', 'no-focusTo', 'no-resolved'])(
    'rejects a note result with %s', (fault) => {
      const r = note()
      const first = r.steps[0] as Extract<StepResult, { status: 'ok' }>
      if (fault === 'missing') delete first.opened
      if (fault === 'old-window') first.opened!.id = 301
      if (fault === 'wrong-window') r.observation!.window.id = 999
      if (fault === 'diff') r.observation!.kind = 'diff'
      if (fault === 'wrong-text') editText(r, FEWER_PROBE.text, 'elsewhere')
      if (fault === 'wrong-focus') editText(r, 'focused [12]', 'focused [99]')
      if (fault === 'no-focusTo') delete first.focusTo
      if (fault === 'no-resolved') delete first.resolved
      expect(judgeFewerNote(r, 301)).not.toEqual([])
    }
  )

  it('accepts all four rename steps and the committed row', () => {
    expect(judgeFewerRename(rename())).toEqual([])
  })
  it("accepts the committed row's cell, read as an unfocused input", () => {
    const r = rename()
    editText(r, '~ [7] row "Renamed note" selected', '~ [8] input = "Renamed note" actions: show menu, confirm')
    expect(judgeFewerRename(r)).toEqual([])
  })
  it('finds a row by its own name or by the editable cell it holds', () => {
    const lines = (text: string): ElementLine[] => parseObservation(text).lines.flatMap((l) => (l.type === 'element' ? [l] : []))
    const table = lines([
      'app "TC Probe" · window "TC Probe Fewer" · 720×544',
      '[66] table "Notes"', '  [67] row', '    [68] input = "Draft note"', '  [69] row', '    [70] input = "Second note"', '  [71] row "Third note"'
    ].join('\n'))
    expect(rowShowing(table, 'Draft note')?.index).toBe(67)
    expect(rowShowing(table, 'Second note')?.index).toBe(69)
    expect(rowShowing(table, 'Third note')?.index).toBe(71)
    expect(rowShowing(table, 'Notes')).toBeUndefined()
  })
  it.each(['no-editor', 'old-name', 'still-editing', 'not-committed', 'label-only'])('rejects a rename with %s', (fault) => {
    const r = rename()
    if (fault === 'no-editor' && r.steps[1].status === 'ok') delete r.steps[1].focusTo
    if (fault === 'old-name') editText(r, 'Renamed note', 'Draft note')
    if (fault === 'label-only') editText(r, 'row', 'text')
    if (fault === 'still-editing') r.observation!.text += '\n~ [17] input = "Renamed note" focused'
    if (fault === 'not-committed' && r.steps[3].status === 'ok') r.steps[3].effect = 'none'
    expect(judgeFewerRename(r)).not.toEqual([])
  })

  it('accepts no-change with every later report stopped, including the tail after type', () => {
    expect(judgeFewerStopped(stopped())).toEqual([])
  })
  it.each([1, 2, 3])('requires stopped on every not-run report, including step %i', (i) => {
    const r = stopped()
    if (r.steps[i].status === 'not-run') delete r.steps[i].stopped
    expect(judgeFewerStopped(r)).not.toEqual([])
  })
  it.each(['changed', 'wrong-source', 'ran', 'text-written'])('rejects no-change proof with %s', (fault) => {
    const r = stopped()
    if (fault === 'changed' && r.steps[0].status === 'ok') r.steps[0].effect = 'changed'
    if (fault === 'wrong-source' && r.steps[2].status === 'not-run') r.steps[2].stopped!.afterStep = 1
    if (fault === 'ran') r.steps[3] = ok(3, 'key')
    if (fault === 'text-written') r.observation!.text = r.observation!.text.replace(' · no changes', '') + `\n[17] input = "${FEWER_PROBE.forbidden}"`
    expect(judgeFewerStopped(r)).not.toEqual([])
  })

  it('accepts a one-based menu block even when the body reports no changes', () => {
    expect(judgeFewerMenu(menu())).toEqual([])
  })
  it('accepts §27.4’s exact silent-menu recovery block', () => {
    const r = result([ok(0, 'left_click')], [`${MENU_BLOCK.prefix}1${MENU_BLOCK.silent}`], { diff: true })
    expect(judgeFewerMenu(r)).toEqual([])
  })
  it.each(['missing', 'wrong-step', 'missing-item', 'disabled-item', 'malformed'])('rejects an opened menu with %s', (fault) => {
    const r = menu()
    if (fault === 'missing') r.observation!.text = r.observation!.text.split('\n')[0]
    if (fault === 'wrong-step') editText(r, 'step 1', 'step 2')
    if (fault === 'missing-item') editText(r, '\n  [54] menu item "Archive"', '')
    if (fault === 'disabled-item') editText(r, 'menu item "Archive"', 'menu item "Archive" disabled')
    if (fault === 'malformed') editText(r, 'step 1:', 'step one:')
    expect(judgeFewerMenu(r)).not.toEqual([])
  })

  const judges = [judgeFewerPopup, (r: BatchResult) => judgeFewerNote(r, 301), judgeFewerRename, judgeFewerStopped, judgeFewerMenu]
  const fixtures = [popup, note, rename, stopped, menu]
  it.each(judges.map((judge, i) => ({ judge, fixture: fixtures[i], i })))('rejects missing observations and failed steps in judge $i', ({ judge, fixture }) => {
    const absent = fixture()
    delete absent.observation
    expect(judge(absent)).not.toEqual([])
    const failed = fixture()
    failed.steps[0] = { index: 0, action: 'left_click', status: 'failed', error: { kind: 'needs_tier', needed: 'session', message: 'needs the session tier' } }
    expect(judge(failed)).not.toEqual([])
  })
  it('requires the exact step count, order and allowed tiers', () => {
    const count = popup()
    count.steps.push(ok(2, 'key'))
    expect(judgeFewerPopup(count)).not.toEqual([])
    const order = popup()
    order.steps[1].index = 3
    expect(judgeFewerPopup(order)).not.toEqual([])
    const tier = popup()
    if (tier.steps[0].status === 'ok') tier.steps[0].tier = 'session'
    expect(judgeFewerPopup(tier)).not.toEqual([])
  })
})

describe('menuClosedByPerson', () => {
  it('voids a missing menu block only when the person used the Mac and nothing else failed', () => {
    expect(menuClosedByPerson([MENU_BLOCK_MISSING], true)).toBe(true)
    expect(menuClosedByPerson([MENU_BLOCK_MISSING], false)).toBe(false)
    expect(menuClosedByPerson([MENU_BLOCK_MISSING, 'opening the pop-up must change the state'], true)).toBe(false)
    expect(menuClosedByPerson([], true)).toBe(false)
  })
})
