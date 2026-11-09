import { describe, expect, it } from 'vitest'
import { COMPUTER_ACTION_NAMES, type ComputerAction, type StepResult } from './protocol'
import {
  ACTION_CLASSES,
  COMPUTER_ACTIONS,
  COMPUTER_TOOLS,
  ComputerActInputSchema,
  ComputerBatchInputSchema,
  ComputerObserveInputSchema,
  ComputerToolCallSchema,
  ComputerToolResultSchema,
  NOT_EXECUTED_LINE,
  TOOL_BATCH_MAX_ACTIONS,
  TierVerdictSchema,
  computerToolJsonSchema,
  formatShotLine,
  formatStepLine,
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
