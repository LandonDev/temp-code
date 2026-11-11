import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPUTER_ACTION_NAMES, type ComputerAction, type StepResult } from './protocol'
import {
  ACTION_CLASSES,
  COMPUTER_ACTIONS,
  COMPUTER_TOOLS,
  ComputerActInputSchema,
  ComputerAppsInputSchema,
  ComputerBatchInputSchema,
  ComputerObserveInputSchema,
  ComputerResultInputSchema,
  ComputerToolCallSchema,
  ComputerToolResultSchema,
  NOT_EXECUTED_LINE,
  OPENED_ENDING,
  STOPPED_LINE,
  TOOL_BATCH_MAX_ACTIONS,
  TierVerdictSchema,
  computerToolJsonSchema,
  formatShotLine,
  formatStepLine,
  mayRunAtAx,
  parseShotLine,
  parseStepLine,
  parseStoppedLine,
  perVerbTools,
  stepTarget,
  stoppedLine,
  tierVerdictSetting
} from './tools'

describe('the four tools', () => {
  it('take the examples of the spec verbatim', () => {
    for (const call of [
      { app: 'TextEdit', action: 'left_click', element: 12 },
      { app: 'TextEdit', action: 'left_click', coordinate: [500, 300], text: 'shift' },
      { app: 'Safari', action: 'scroll', scroll_direction: 'down', scroll_amount: 3, element: 5 },
      { app: 'TextEdit', action: 'key', text: 'Tab', repeat: 4 },
      { app: 'Preview', action: 'zoom', region: [100, 200, 400, 350] }
    ])
      expect(ComputerActInputSchema.safeParse(call).success, JSON.stringify(call)).toBe(true)
    const batch = { app: 'Mail', actions: [{ action: 'left_click', element: 31 }, { action: 'type', text: 'Lunch?' }, { action: 'key', text: 'super+Return' }] }
    expect(ComputerBatchInputSchema.safeParse(batch).success).toBe(true)
  })

  it("hold computer_act to the action's rules and cap a batch at 20", () => {
    expect(ComputerActInputSchema.safeParse({ app: 'x', action: 'left_click', element: 1, coordinate: [1, 1] }).success).toBe(false)
    expect(ComputerActInputSchema.safeParse({ action: 'screenshot' }).success).toBe(false)
    const actions = Array(TOOL_BATCH_MAX_ACTIONS + 1).fill({ action: 'screenshot' })
    expect(ComputerBatchInputSchema.safeParse({ app: 'x', actions }).success).toBe(false)
    expect(ComputerObserveInputSchema.safeParse({ app: 'Finder', full: true, element: 6, menus: true }).success).toBe(true)
  })

  it('hold computer_result to an id of 1 to 16 characters and an optional cancel, and keep it out of the four', () => {
    expect(ComputerResultInputSchema.parse({ id: 'c4' })).toEqual({ id: 'c4' })
    expect(ComputerResultInputSchema.parse({ id: 'c4', cancel: true })).toEqual({ id: 'c4', cancel: true })
    for (const bad of [{}, { id: '' }, { id: 'c'.repeat(17) }, { id: 'c4', cancel: 'yes' }]) expect(ComputerResultInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(COMPUTER_TOOLS.map((t) => t.name)).not.toContain('computer_result')
    expect(ComputerToolCallSchema.safeParse({ tool: 'computer_result', args: { id: 'c4' }, threadId: 't', permission: 'auto' }).success).toBe(false)
  })

  it('have flat JSON Schemas, with no oneOf or anyOf at the top', () => {
    expect(COMPUTER_TOOLS.map((t) => t.name)).toEqual(['computer_apps', 'computer_observe', 'computer_act', 'computer_batch'])
    for (const tool of [...COMPUTER_TOOLS, ...perVerbTools()]) {
      const schema = computerToolJsonSchema(tool.input)
      expect(schema.type, tool.name).toBe('object')
      expect(schema, tool.name).not.toHaveProperty('oneOf')
      expect(schema, tool.name).not.toHaveProperty('anyOf')
      expect(schema, tool.name).not.toHaveProperty('$schema')
      expect(tool.description.length, tool.name).toBeGreaterThan(0)
    }
    const act = computerToolJsonSchema(ComputerActInputSchema) as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(act.properties)).toEqual(expect.arrayContaining(['app', 'action', 'element', 'coordinate', 'scroll_direction', 'scroll_amount']))
    expect(act.required).toEqual(['app', 'action'])
  })

  it('build one tool per verb with its required parameters required', () => {
    const tools = perVerbTools()
    expect(tools.map((t) => t.name)).toEqual(COMPUTER_ACTION_NAMES.map((a) => `computer_${a}`))
    const scroll = tools.find((t) => t.name === 'computer_scroll')!
    expect((computerToolJsonSchema(scroll.input) as { required: string[] }).required).toEqual(['app', 'scroll_direction', 'scroll_amount'])
    expect(scroll.input.safeParse({ app: 'x', scroll_direction: 'down', scroll_amount: 2, element: 4 }).success).toBe(true)
    expect(scroll.input.safeParse({ app: 'x', scroll_direction: 'down', scroll_amount: 2, element: 4, coordinate: [1, 1] }).success).toBe(false)
    const move = tools.find((t) => t.name === 'computer_mouse_move')!
    expect(move.input.safeParse({ app: 'x' }).success).toBe(false)
  })
})

describe('the action table', () => {
  it('gives every input action a verdict class and keeps the AX verbs out of it', () => {
    for (const name of COMPUTER_ACTION_NAMES) {
      const spec = COMPUTER_ACTIONS[name]
      if (spec.noInput || spec.axOnly) expect(spec.class, name).toBeNull()
      else expect(ACTION_CLASSES, name).toContain(spec.class)
    }
    expect(COMPUTER_ACTIONS.left_mouse_down.class).toBe('click')
    expect(COMPUTER_ACTIONS.hold_key.class).toBe('key')
    expect(COMPUTER_ACTIONS.select_text).toMatchObject({ axOnly: true, native: false })
    expect(COMPUTER_ACTIONS.wait).toMatchObject({ noInput: true, native: true })
    expect(COMPUTER_ACTIONS.paste).toMatchObject({ class: 'type', axOnly: false, native: false, noInput: false })
  })
})

describe('the peer payloads and the verdict', () => {
  it('carry a call and a result across the bridge', () => {
    const call = { tool: 'computer_act', args: { app: 'TextEdit', action: 'left_click', element: 3 }, threadId: 't1', permission: 'edits' }
    expect(ComputerToolCallSchema.safeParse(call).success).toBe(true)
    expect(ComputerToolCallSchema.safeParse({ ...call, args: { app: 'TextEdit', action: 'mouse_move' } }).success).toBe(false)
    expect(ComputerToolCallSchema.safeParse({ ...call, tool: 'computer_click' }).success).toBe(false)
    const result = { text: 'left_click [3] button "Save" · ax · changed', images: [{ label: 'observation', data: 'AAAA', mimeType: 'image/jpeg', width: 1280, height: 800 }] }
    expect(ComputerToolResultSchema.safeParse(result).success).toBe(true)
  })

  it('keeps a verdict per app and class under one setting', () => {
    expect(TierVerdictSchema.safeParse({ bundleId: 'com.apple.TextEdit', classes: { click: 'ax', type: 'session' }, misses: { key: 1 }, updatedAt: 1 }).success).toBe(true)
    expect(TierVerdictSchema.safeParse({ bundleId: 'x', classes: { click: 'remote' }, misses: {}, updatedAt: 1 }).success).toBe(false)
    expect(tierVerdictSetting('com.apple.TextEdit')).toBe('computer.tiers.com.apple.TextEdit')
    expect(TierVerdictSchema.safeParse({ bundleId: 'com.google.Chrome', classes: { key: 'process' }, misses: {}, needsKeyWindow: true, updatedAt: 1 }).success).toBe(true)
  })
})

describe('the result text', () => {
  const ok = (action: ComputerAction['action'], extra: object): StepResult => ({ index: 0, action, status: 'ok', tier: 'ax', effect: 'changed', ...extra }) as StepResult

  it('writes the step lines of the spec', () => {
    expect(formatStepLine(ok('left_click', { element: { index: 14, line: 'button "Save"' } }), { action: 'left_click', element: 14 })).toBe(
      'left_click [14] button "Save" · ax · changed'
    )
    expect(
      formatStepLine(ok('type', { element: { index: 33, line: 'input "Subject" = "" focused caret 0' }, input: { via: 'ax-insert' } }), {
        action: 'type',
        text: 'Lunch?',
        element: 33
      })
    ).toBe('type "Lunch?" into [33] input "Subject" · ax-insert · changed')
    expect(formatStepLine(ok('key', { tier: 'process', effect: 'none' }), { action: 'key', text: 'super+Return' })).toBe('key super+Return · process · no change seen')
  })

  it('says a failure, the steps after it, the cursor and a wait', () => {
    const failed: StepResult = { index: 1, action: 'perform', status: 'failed', error: { kind: 'action_unsupported', message: '[3] has no action "open".' } }
    expect(formatStepLine(failed, { action: 'perform', element: 3, name: 'open' })).toBe('perform open on [3] · failed: [3] has no action "open".')
    expect(formatStepLine({ index: 2, action: 'key', status: 'not-run' }, { action: 'key', text: 'a' })).toBe(NOT_EXECUTED_LINE)
    expect(formatStepLine(ok('cursor_position', { tier: null, effect: 'unknown', text: 'X=512, Y=384' }), { action: 'cursor_position' })).toBe(
      'cursor_position · X=512, Y=384'
    )
    const waited = { waitedMs: 800, settled: true, busy: false, reason: 'quiet' }
    expect(formatStepLine(ok('wait', { tier: null, effect: 'unknown', waited }), { action: 'wait', duration: 2 })).toBe('wait up to 2 s · settled after 0.8 s')
  })

  it('names targets by point, modifiers, drag ends and repeats', () => {
    expect(stepTarget({ action: 'left_click', coordinate: [500, 300], text: 'shift' })).toBe('500,300 with shift')
    expect(stepTarget({ action: 'left_click' })).toBe('at the cursor')
    expect(stepTarget({ action: 'left_click_drag', start_element: 3, coordinate: [9, 9] })).toBe('[3] to 9,9')
    expect(stepTarget({ action: 'scroll', scroll_direction: 'down', scroll_amount: 3, element: 5 })).toBe('down 3 on [5]')
    expect(stepTarget({ action: 'key', text: 'Tab', repeat: 4 })).toBe('Tab ×4')
    expect(stepTarget({ action: 'zoom', region: [100, 200, 400, 350] })).toBe('100,200 to 400,350')
    expect(stepTarget({ action: 'type', text: 'x'.repeat(70) })).toBe(`"${'x'.repeat(60)}…"`)
  })

  it('names a paste by its format and its tier, never its text', () => {
    const step = ok('paste', { tier: 'process', element: { index: 33, line: 'input "Body"' }, input: { via: 'paste', clipboard: 'restored' } })
    expect(formatStepLine(step, { action: 'paste', text: '# Notes', format: 'markdown', element: 33 })).toBe('paste markdown into [33] input "Body" · process · changed')
    expect(stepTarget({ action: 'paste', text: 'shift' })).toBe('text')
  })

  it('writes a screenshot line and marks one past the image limit', () => {
    const shot = { path: '/w/.temp-code/attachments/s/computer/0007.jpg', width: 1280, height: 800 }
    expect(formatShotLine(1, 'observation', shot, true)).toBe('screenshot 1 (observation): /w/.temp-code/attachments/s/computer/0007.jpg (1280×800)')
    expect(formatShotLine(5, 2, shot, false)).toBe('screenshot 5 (step 2): /w/.temp-code/attachments/s/computer/0007.jpg (1280×800) (not attached)')
  })
})

describe('the line parsers', () => {
  const ok = (action: ComputerAction['action'], extra: object): StepResult => ({ index: 0, action, status: 'ok', tier: 'ax', effect: 'changed', ...extra }) as StepResult
  const save = { index: 14, line: 'button "Save"' }

  it('read a shot line back whole, both sources, attached or not', () => {
    const shot = { path: '/w/My Files (old)/.temp-code/attachments/s/computer/0007.jpg', width: 1280, height: 800 }
    for (const where of ['observation', 2] as const)
      for (const attached of [true, false]) {
        const line = formatShotLine(3, where, shot, attached)
        const back = parseShotLine(line)
        expect(back, line).toEqual({ n: 3, from: where === 'observation' ? 'observation' : { step: 2 }, ...shot, attached })
        expect(formatShotLine(back!.n, back!.from === 'observation' ? 'observation' : back!.from.step, back!, back!.attached)).toBe(line)
      }
  })

  it('refuse lines that are not shot lines', () => {
    for (const junk of ['', 'screenshot', 'screenshot 0 (observation): /a (1×1)', 'screenshot 1 (step two): /a (1×1)', 'left_click [14] button "Save" · ax · changed', 'screenshot 1 (observation): /a'])
      expect(parseShotLine(junk), junk).toBeNull()
  })

  it('read a step line back to its action, element, tier and effect', () => {
    const cases: [StepResult, ComputerAction, Partial<NonNullable<ReturnType<typeof parseStepLine>>>][] = [
      [ok('left_click', { element: save }), { action: 'left_click', element: 14 }, { action: 'left_click', element: { index: 14, role: 'button', name: 'Save' }, tier: 'ax', effect: 'changed' }],
      [ok('left_click', { tier: 'process', effect: 'none' }), { action: 'left_click', coordinate: [5, 6], text: 'shift' }, { target: '5,6 with shift', tier: 'process', effect: 'none' }],
      [ok('right_click', { element: { index: 2, line: 'scroll area' } }), { action: 'right_click', element: 2, text: 'shift' }, { element: { index: 2, role: 'scroll area', name: null } }],
      [ok('type', { element: { index: 33, line: 'input "Sub · ject" = "" focused' }, input: { via: 'ax-insert' } }), { action: 'type', text: 'a · "b"', element: 33 }, { element: { index: 33, role: 'input', name: 'Sub · ject' }, tier: 'ax-insert', effect: 'changed' }],
      [ok('set_value', { element: { index: 33, line: 'text area' } }), { action: 'set_value', element: 33, value: 'Hi' }, { element: { index: 33, role: 'text area', name: null } }],
      [ok('perform', { element: { index: 9, line: 'pop up "Font"' } }), { action: 'perform', element: 9, name: 'show menu' }, { element: { index: 9, role: 'pop up', name: 'Font' } }],
      [ok('scroll', { tier: 'session', effect: 'unknown' }), { action: 'scroll', scroll_direction: 'down', scroll_amount: 3, element: 5 }, { target: 'down 3 on [5]', tier: 'session', effect: 'unknown' }],
      [ok('key', { tier: null, effect: 'none' }), { action: 'key', text: 'Tab', repeat: 4 }, { target: 'Tab ×4', tier: 'no tier', effect: 'none' }],
      [ok('screenshot', { tier: null, effect: 'unknown' }), { action: 'screenshot' }, { action: 'screenshot', target: '' }],
      [ok('zoom', { tier: null }), { action: 'zoom', region: [1, 2, 3, 4] }, { target: '1,2 to 3,4' }],
      [ok('cursor_position', { tier: null, text: 'X=512, Y=384' }), { action: 'cursor_position' }, { target: '' }]
    ]
    for (const [step, action, want] of cases) {
      const line = formatStepLine(step, action)
      const back = parseStepLine(line)
      expect(back, line).toMatchObject(want)
      if (!('element' in want)) expect(back?.element, line).toBeUndefined()
    }
  })

  it('read a failure whole, separators and quotes in its reason too', () => {
    const failed: StepResult = { index: 1, action: 'perform', status: 'failed', error: { kind: 'action_unsupported', message: '[3] has no action "open" · try "press".' } }
    expect(parseStepLine(formatStepLine(failed, { action: 'perform', element: 3, name: 'open' }))).toEqual({
      action: 'perform',
      target: 'open on [3]',
      failed: '[3] has no action "open" · try "press".'
    })
  })

  it('read the wire fixtures as the host writes them', () => {
    const wire = join(__dirname, '../../main/server/computer/fixtures/wire')
    const json = (name: string): { params: { action?: ComputerAction; actions?: ComputerAction[] }; result: { step?: StepResult; steps?: StepResult[] } } =>
      ({ ...JSON.parse(readFileSync(join(wire, `${name}.request.json`), 'utf8')), result: JSON.parse(readFileSync(join(wire, `${name}.response.json`), 'utf8')).result })
    const run = json('action.run')
    const batch = json('action.batch')
    const pairs: [StepResult, ComputerAction][] = [[run.result.step!, run.params.action!], ...batch.result.steps!.map((s, i) => [s, batch.params.actions![i]] as [StepResult, ComputerAction])]
    for (const [step, action] of pairs) {
      const line = formatStepLine(step, action)
      expect(parseStepLine(line)?.action, line).toBe(step.action)
    }
    expect(parseStepLine(formatStepLine(run.result.step!, run.params.action!))?.element).toEqual({ index: 21, role: 'checkbox', name: 'bold' })
  })

  it('refuse every other line', () => {
    for (const junk of [NOT_EXECUTED_LINE, '', 'screenshot 1 (observation): /a (1×1)', 'app "TextEdit" · window "Untitled" · 1280×800', 'click [14] · ax · changed', 'key a · ax · sort of', 'stopped by the person'])
      expect(parseStepLine(junk), junk).toBeNull()
  })
})

describe('the background routes (§24)', () => {
  const ok = (action: ComputerAction['action'], extra: object): StepResult => ({ index: 0, action, status: 'ok', tier: 'ax', effect: 'changed', ...extra }) as StepResult

  it('names each route and what it acted on in the step line', () => {
    expect(formatStepLine(ok('key', { input: { via: 'menu', on: 'File › Close' } }), { action: 'key', text: 'super+w' })).toBe('key super+w · menu File › Close · changed')
    expect(formatStepLine(ok('left_click', { input: { via: 'hit', on: 'button "Save"' } }), { action: 'left_click', coordinate: [412, 230] })).toBe(
      'left_click 412,230 · hit button "Save" · changed'
    )
    expect(formatStepLine(ok('left_click', { input: { via: 'caret', on: 'input "Name"' } }), { action: 'left_click', coordinate: [9, 9] })).toBe('left_click 9,9 · caret input "Name" · changed')
    expect(formatStepLine(ok('scroll', { effect: 'none', input: { via: 'scroll-bar' } }), { action: 'scroll', element: 4, scroll_direction: 'down', scroll_amount: 5 })).toBe(
      'scroll down 5 on [4] · scroll-bar · no change seen'
    )
    expect(formatStepLine(ok('scroll', { input: { via: 'scroll-page' } }), { action: 'scroll', coordinate: [1, 1], scroll_direction: 'down', scroll_amount: 5 })).toMatch(/ · scroll-page · changed$/)
    expect(formatStepLine(ok('set_value', { input: { via: 'pick', on: 'Team' }, element: { index: 19, line: 'pop up "Plan"' } }), { action: 'set_value', element: 19, value: 'Team' })).toMatch(
      / · pick Team · changed$/
    )
    const intoView = formatStepLine(ok('scroll', { input: { via: 'scroll-into-view', on: 'row "Wuhan"' } }), { action: 'scroll', element: 4, scroll_direction: 'down', scroll_amount: 5 })
    expect(intoView).toBe('scroll down 5 on [4] · scroll-into-view row "Wuhan" · changed')
    expect(parseStepLine(intoView)).toMatchObject({ action: 'scroll', tier: 'scroll-into-view row "Wuhan"', effect: 'changed' })
    // what it acted on never holds the separator, so the line reads back
    expect(formatStepLine(ok('left_click', { input: { via: 'hit', on: 'button "A · B"' } }), { action: 'left_click', coordinate: [1, 1] })).toBe('left_click 1,1 · hit button "A B" · changed')
  })

  it('a paste names ax-insert when it went in without the clipboard, else its tier', () => {
    expect(formatStepLine(ok('paste', { input: { via: 'ax-insert' } }), { action: 'paste', element: 9, text: 'hi' })).toMatch(/ · ax-insert · changed$/)
    expect(formatStepLine(ok('paste', { tier: 'process', input: { via: 'paste', clipboard: 'restored' } }), { action: 'paste', element: 9, text: 'hi' })).toMatch(/ · process · changed$/)
  })

  it('knows which steps may have a route at ax', () => {
    expect(mayRunAtAx({ action: 'key', text: 'super+w' })).toBe(true)
    expect(mayRunAtAx({ action: 'key', text: 'ctrl+a' })).toBe(true)
    expect(mayRunAtAx({ action: 'key', text: 'alt+e' })).toBe(false)
    expect(mayRunAtAx({ action: 'key', text: 'Return' })).toBe(false)
    expect(mayRunAtAx({ action: 'key', text: 'not a combo+' })).toBe(false)
    for (const action of ['left_click', 'right_click', 'double_click'] as const) {
      expect(mayRunAtAx({ action, coordinate: [1, 1] })).toBe(true)
      expect(mayRunAtAx({ action, coordinate: [1, 1], text: 'shift' })).toBe(false)
    }
    expect(mayRunAtAx({ action: 'left_click', coordinate: [1, 1], duration: 1 })).toBe(false)
    expect(mayRunAtAx({ action: 'scroll', coordinate: [1, 1], scroll_direction: 'down' })).toBe(true)
    expect(mayRunAtAx({ action: 'scroll', coordinate: [1, 1], scroll_direction: 'down', text: 'shift' })).toBe(false)
    expect(mayRunAtAx({ action: 'paste', text: 'x' })).toBe(true)
    expect(mayRunAtAx({ action: 'type', text: 'x' })).toBe(true)
    for (const action of ['middle_click', 'triple_click', 'left_click_drag', 'mouse_move', 'hold_key'] as const) expect(mayRunAtAx({ action } as ComputerAction)).toBe(false)
  })

  it("parses a verdict's route misses", () => {
    expect(TierVerdictSchema.safeParse({ bundleId: 'x', classes: {}, misses: {}, viaMisses: { hit: 2, 'scroll-page': 1 }, updatedAt: 1 }).success).toBe(true)
    expect(TierVerdictSchema.safeParse({ bundleId: 'x', classes: {}, misses: {}, viaMisses: { hit: -1 }, updatedAt: 1 }).success).toBe(false)
  })
})

describe('computer_apps open', () => {
  const ok = (v: unknown): boolean => ComputerAppsInputSchema.safeParse(v).success
  it('opens up to 8 items into the app launch names, and confirm only beside open', () => {
    expect(ok({})).toBe(true)
    expect(ok({ launch: 'Preview', open: ['/tmp/a.pdf'] })).toBe(true)
    expect(ok({ launch: 'Preview', open: Array.from({ length: 8 }, (_, i) => `/tmp/${i}.pdf`) })).toBe(true)
    expect(ok({ launch: 'Preview', open: Array.from({ length: 9 }, (_, i) => `/tmp/${i}.pdf`) })).toBe(false)
    expect(ok({ launch: 'Preview', open: [] })).toBe(false)
    expect(ComputerAppsInputSchema.safeParse({ open: ['/tmp/a.pdf'] }).error?.issues[0].message).toBe('open needs launch, the app to open it in')
    const confirm = { kind: 'upload', what: 'Uploads a.pdf to the form' }
    expect(ok({ launch: 'Safari', open: ['https://x.test'], confirm })).toBe(true)
    expect(ComputerAppsInputSchema.safeParse({ launch: 'Safari', confirm }).error?.issues[0].message).toBe('confirm goes with open')
  })
})

describe('fewer calls in the step lines (§27)', () => {
  const ok = (action: ComputerAction['action'], extra: object = {}): StepResult => ({ index: 0, action, status: 'ok', tier: 'ax', effect: 'changed', ...extra }) as StepResult
  const team = { index: 52, line: 'menu item "Team"' }

  /** Each line as the host writes it, and what parseStepLine reads back: always the step's own action. */
  const cases: [string, StepResult, ComputerAction, string, Partial<NonNullable<ReturnType<typeof parseStepLine>>>][] = [
    [
      'a named click that resolved',
      ok('left_click', { resolved: 52, element: team }),
      { action: 'left_click', named: 'Team' },
      'left_click "Team" [52] menu item · ax · changed',
      { action: 'left_click', target: '"Team" [52] menu item', named: 'Team', element: { index: 52, role: 'menu item', name: 'Team' }, tier: 'ax', effect: 'changed' }
    ],
    [
      'a named click with no line for its element',
      ok('left_click', { resolved: 52 }),
      { action: 'left_click', named: 'Team' },
      'left_click "Team" [52] · ax · changed',
      { action: 'left_click', named: 'Team', tier: 'ax' }
    ],
    [
      'text into a named field',
      ok('type', { resolved: 4, element: { index: 4, line: 'text field "Search" = ""' }, input: { via: 'ax-insert' } }),
      { action: 'type', text: 'a "b" · c', named: 'Search' },
      'type "a \\"b\\" · c" into "Search" [4] text field · ax-insert · changed',
      { action: 'type', named: 'Search', element: { index: 4, role: 'text field', name: 'Search' }, tier: 'ax-insert' }
    ],
    [
      'a key on a named field',
      ok('key', { tier: 'process', resolved: 4, element: { index: 4, line: 'text field "Search"' } }),
      { action: 'key', text: 'Return', named: 'Search' },
      'key Return on "Search" [4] text field · process · changed',
      { action: 'key', named: 'Search', element: { index: 4, role: 'text field', name: 'Search' }, tier: 'process' }
    ],
    [
      'a menu-bar click, its path joined by ›',
      ok('left_click', { resolved: 157, input: { via: 'menu', on: 'File › Save…' } }),
      { action: 'left_click', menu: 'File > Save…', text: 'shift' },
      'left_click menu File › Save… · menu · changed',
      { action: 'left_click', menu: ['File', 'Save…'], tier: 'menu', effect: 'changed' }
    ],
    [
      'a menu-bar pick, either separator',
      ok('perform', { resolved: 160 }),
      { action: 'perform', name: 'pick', menu: 'Edit › Find > Find…' },
      'perform pick menu Edit › Find › Find… · ax · changed',
      { action: 'perform', menu: ['Edit', 'Find', 'Find…'], tier: 'ax' }
    ],
    [
      'a step that opened a window',
      ok('key', { tier: 'process', opened: { id: 7, title: 'Untitled 2' } }),
      { action: 'key', text: 'super+n' },
      'key super+n · process · changed · opened window "Untitled 2"',
      { action: 'key', target: 'super+n', tier: 'process', effect: 'changed', opened: 'Untitled 2' }
    ],
    [
      'an opened window whose title holds the ending',
      ok('perform', { opened: { id: 8, title: 'a · opened window "b"' } }),
      { action: 'perform', name: 'pick', menu: 'File > New' },
      'perform pick menu File › New · ax · changed · opened window "a · opened window \\"b\\""',
      { action: 'perform', menu: ['File', 'New'], tier: 'ax', effect: 'changed', opened: 'a · opened window "b"' }
    ],
    [
      'a named step that failed',
      { index: 1, action: 'left_click', status: 'failed', error: { kind: 'named_target', message: 'no element is named "Team".' } },
      { action: 'left_click', named: 'Team' },
      'left_click "Team" · failed: no element is named "Team".',
      { action: 'left_click', target: '"Team"', failed: 'no element is named "Team".' }
    ]
  ]
  for (const [name, step, action, line, back] of cases)
    it(`writes and reads back ${name}`, () => {
      expect(formatStepLine(step, action)).toBe(line)
      expect(parseStepLine(line)).toMatchObject({ ...back, action: action.action })
    })

  it('leaves the head of a line with no window opened as it was', () => {
    expect(parseStepLine('key super+n · process · changed')?.opened).toBeUndefined()
    expect(formatStepLine(ok('key', { tier: 'process' }), { action: 'key', text: 'super+n' })).not.toContain(OPENED_ENDING)
  })

  it('says a stop after a step that changed nothing by its number from 1, and the plain line otherwise', () => {
    const stopped: StepResult = { index: 2, action: 'type', status: 'not-run', stopped: { afterStep: 1, reason: 'no-change' } }
    const line = formatStepLine(stopped, { action: 'type', text: 'hi' })
    expect(line).toBe('Not executed: step 2 changed nothing, so these keys had no planned place.')
    expect(line).toBe(stoppedLine(2))
    expect(line).toMatch(STOPPED_LINE)
    expect(parseStoppedLine(line)).toBe(2)
    expect(parseStepLine(line)).toBeNull()
    expect(parseStoppedLine(NOT_EXECUTED_LINE)).toBeNull()
    expect(formatStepLine({ index: 2, action: 'type', status: 'not-run' }, { action: 'type', text: 'hi' })).toBe(NOT_EXECUTED_LINE)
  })

  it("gives a batch step no field descriptions but action's (§27.12)", () => {
    const step = (computerToolJsonSchema(ComputerBatchInputSchema) as { properties: { actions: { items: { properties: Record<string, { description?: string }> } } } }).properties.actions.items.properties
    expect(step.action.description).toBeDefined()
    for (const [k, v] of Object.entries(step)) if (k !== 'action') expect(v.description, k).toBeUndefined()
    expect(Object.keys(step)).toEqual(expect.arrayContaining(['named', 'menu', 'element', 'coordinate']))
    expect(ComputerBatchInputSchema.safeParse({ app: 'Mail', actions: [{ action: 'left_click', named: 'Team' }, { action: 'type', text: 'x' }] }).success).toBe(true)
    expect(ComputerBatchInputSchema.safeParse({ app: 'Mail', actions: [{ action: 'left_click', named: 'Team', element: 3 }] }).success).toBe(false)
  })
})
