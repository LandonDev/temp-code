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
  TOOL_BATCH_MAX_ACTIONS,
  TierVerdictSchema,
  computerToolJsonSchema,
  diskWords,
  formatShotLine,
  formatStepLine,
  mayRunAtAx,
  parseShotLine,
  parseStepLine,
  perVerbTools,
  stepTarget,
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

describe('the front tier, the disk part and save_as (§25.12)', () => {
  const ok = (action: ComputerAction['action'], extra: object): StepResult => ({ index: 0, action, status: 'ok', tier: 'front', effect: 'changed', ...extra }) as StepResult
  const lines: [StepResult, ComputerAction, string, Partial<NonNullable<ReturnType<typeof parseStepLine>>>][] = [
    [
      ok('key', { input: { via: 'menu', on: 'File › Save' }, disk: { saved: '~/run/Total.txt' } }),
      { action: 'key', text: 'super+s' },
      'key super+s · front menu File › Save · changed · on disk: saved ~/run/Total.txt',
      { tier: 'front', route: 'menu File › Save', effect: 'changed', disk: 'saved ~/run/Total.txt' }
    ],
    [
      ok('key', { effect: 'uncommitted', disk: { edited: { before: false, after: false }, hint: 'commit it with key Return in the field' } }),
      { action: 'key', text: 'Return' },
      'key Return · front · on screen only, not on disk; commit it with key Return in the field',
      { tier: 'front', effect: 'uncommitted', hint: 'commit it with key Return in the field' }
    ],
    [
      ok('save_as', { input: { via: 'panel', on: '~/run/note.rtf' }, disk: { saved: '~/run/note.rtf' } }),
      { action: 'save_as', path: '~/run/note.rtf' },
      'save_as ~/run/note.rtf · panel · changed · on disk: saved ~/run/note.rtf',
      { target: '~/run/note.rtf', tier: 'panel', effect: 'changed', disk: 'saved ~/run/note.rtf' }
    ],
    [
      ok('key', { tier: 'ax', input: { via: 'menu', on: 'File › New' } }),
      { action: 'key', text: 'super+n' },
      'key super+n · menu File › New · changed',
      { tier: 'menu File › New', effect: 'changed' }
    ],
    [
      ok('key', { tier: 'process', disk: { renamed: [{ from: '~/run/a.txt', to: '~/run/b.txt' }], saved: '~/Library/Autosave/x', unexpected: true } }),
      { action: 'key', text: 'Return' },
      'key Return · process · changed · on disk: saved by the app itself to ~/Library/Autosave/x, renamed ~/run/a.txt to ~/run/b.txt',
      { tier: 'process', disk: 'saved by the app itself to ~/Library/Autosave/x, renamed ~/run/a.txt to ~/run/b.txt' }
    ],
    [ok('key', { disk: { edited: { before: true, after: false } } }), { action: 'key', text: 'super+s' }, 'key super+s · front · changed · on disk: saved in place', { disk: 'saved in place' }],
    [ok('key', { disk: { unknown: true } }), { action: 'key', text: 'super+s' }, "key super+s · front · changed · on disk: can't tell", { disk: "can't tell" }]
  ]

  it('writes each line of the spec and reads it back', () => {
    for (const [step, action, line, want] of lines) {
      expect(formatStepLine(step, action)).toBe(line)
      expect(parseStepLine(line), line).toMatchObject(want)
    }
  })

  it('says nothing about a disk that did not change, and names save_as with replace', () => {
    expect(diskWords({})).toBeNull()
    expect(diskWords({ edited: { before: true, after: true } })).toBeNull()
    expect(formatStepLine(ok('save_as', { input: { via: 'panel' } }), { action: 'save_as', path: '/tmp/a.txt', replace: true })).toBe('save_as /tmp/a.txt replacing · panel · changed')
  })

  it('refuses a hint on another effect and a part after the effect that is not the disk', () => {
    expect(parseStepLine('key Return · process · changed; commit it')).toBeNull()
    expect(parseStepLine('key Return · process · changed · whatever')).toBeNull()
    expect(parseStepLine('key Return · process · changed · on disk: a · on disk: b')).toBeNull()
  })
})
