import { describe, expect, it } from 'vitest'
import {
  ACTION_PARAMS,
  ActionBatchParamsSchema,
  ActionRunParamsSchema,
  AppRefSchema,
  COMPUTER_ACTION_NAMES,
  COMPUTER_ACTION_SHAPE,
  COMPUTER_METHODS,
  COMPUTER_WAIT,
  ComputerActionSchema,
  RegionSchema,
  StateGetParamsSchema,
  TargetSchema,
  WaitOptionsSchema,
  lockPath,
  waitActionWait
} from './protocol'

const ok = (v: unknown): boolean => ComputerActionSchema.safeParse(v).success
const messages = (v: unknown): string[] => ComputerActionSchema.safeParse(v).error?.issues.map((i) => i.message) ?? []

describe('the action shape', () => {
  it("takes Anthropic's example calls verbatim", () => {
    expect(ok({ action: 'screenshot' })).toBe(true)
    expect(ok({ action: 'left_click', coordinate: [500, 300] })).toBe(true)
    expect(ok({ action: 'type', text: 'Hello, world!' })).toBe(true)
    expect(ok({ action: 'scroll', coordinate: [500, 400], scroll_direction: 'down', scroll_amount: 3 })).toBe(true)
    expect(ok({ action: 'zoom', region: [100, 200, 400, 350] })).toBe(true)
    expect(ok({ action: 'left_click', coordinate: [500, 300], text: 'shift' })).toBe(true)
    expect(ok({ action: 'key', text: 'ctrl+s' })).toBe(true)
    expect(ok({ action: 'left_click_drag', start_coordinate: [10, 10], coordinate: [200, 300] })).toBe(true)
  })

  it('takes element refs beside coordinates', () => {
    expect(ok({ action: 'left_click', element: 12 })).toBe(true)
    expect(ok({ action: 'scroll', element: 5, scroll_direction: 'up', scroll_amount: 1 })).toBe(true)
    expect(ok({ action: 'type', text: 'Lunch?', element: 33 })).toBe(true)
    expect(ok({ action: 'left_click_drag', start_element: 3, element: 7 })).toBe(true)
    expect(ok({ action: 'left_click_drag', start_element: 3, coordinate: [5, 5] })).toBe(true)
    expect(ok({ action: 'mouse_move', element: 4 })).toBe(true)
    expect(ok({ action: 'set_value', element: 3, value: '' })).toBe(true)
    expect(ok({ action: 'perform', element: 3, name: 'show menu' })).toBe(true)
    expect(ok({ action: 'select_text', element: 3, range: [15, 20] })).toBe(true)
    expect(ok({ action: 'select_text', element: 3, text: 'probe' })).toBe(true)
  })

  it('takes hold_key and wait at 300 s and refuses past it', () => {
    expect(ok({ action: 'hold_key', text: 'shift', duration: 300 })).toBe(true)
    expect(ok({ action: 'wait', duration: 300 })).toBe(true)
    expect(ok({ action: 'wait', duration: 0.5 })).toBe(true)
    expect(ok({ action: 'wait', duration: 301 })).toBe(false)
    expect(ok({ action: 'wait', duration: 0 })).toBe(false)
  })

  it('refuses the excluded pairs', () => {
    expect(messages({ action: 'left_click', element: 3, coordinate: [1, 2] })).toContain('give element or coordinate, not both')
    expect(messages({ action: 'left_click_drag', start_element: 3, start_coordinate: [1, 2], element: 4 })).toContain(
      'give start_element or start_coordinate, not both'
    )
    expect(messages({ action: 'select_text', element: 3, text: 'a', range: [0, 1] })).toContain('give text or range, not both')
  })

  it('refuses a mouse_move without a destination and a drag missing an end', () => {
    expect(messages({ action: 'mouse_move' })).toContain('mouse_move needs one of element, coordinate')
    expect(messages({ action: 'left_click_drag', coordinate: [1, 2] })).toContain('left_click_drag needs one of start_element, start_coordinate')
    expect(messages({ action: 'left_click_drag', start_element: 1 })).toContain('left_click_drag needs one of element, coordinate')
  })

  it('refuses a missing parameter and one the action does not take', () => {
    expect(messages({ action: 'zoom' })).toContain('zoom needs region')
    expect(messages({ action: 'scroll', scroll_direction: 'down' })).toContain('scroll needs scroll_amount')
    expect(messages({ action: 'key' })).toContain('key needs text')
    expect(messages({ action: 'key', text: '' })).toContain('key needs a non-empty text')
    expect(messages({ action: 'perform', element: 2 })).toContain('perform needs name')
    expect(messages({ action: 'set_value', value: 'x' })).toContain('set_value needs element')
    expect(messages({ action: 'screenshot', coordinate: [1, 1] })).toContain('screenshot takes no coordinate')
    expect(messages({ action: 'key', text: 'a', region: [0, 0, 1, 1] })).toContain('key takes no region')
    expect(messages({ action: 'select_text', element: 3, range: [5, 2] })).toContain('a range is [a, b] with a ≤ b')
  })

  it('refuses bad numbers and an unknown action', () => {
    expect(ok({ action: 'left_click', coordinate: [1.5, 2] })).toBe(false)
    expect(ok({ action: 'left_click', coordinate: [1, 2, 3] })).toBe(false)
    expect(ok({ action: 'left_click', element: 0 })).toBe(false)
    expect(ok({ action: 'scroll', scroll_direction: 'down', scroll_amount: 51 })).toBe(false)
    expect(ok({ action: 'key', text: 'a', repeat: 101 })).toBe(false)
    expect(ok({ action: 'double_tap' })).toBe(false)
  })

  it('names every action once, the first 17 as Anthropic does, and describes every parameter it lists', () => {
    expect(new Set(COMPUTER_ACTION_NAMES).size).toBe(20)
    expect(COMPUTER_ACTION_NAMES.slice(17)).toEqual(['set_value', 'perform', 'select_text'])
    for (const name of COMPUTER_ACTION_NAMES)
      for (const p of [...ACTION_PARAMS[name].required, ...ACTION_PARAMS[name].optional]) expect(COMPUTER_ACTION_SHAPE).toHaveProperty(p)
  })
})

describe('targets and params', () => {
  it('names an app by exactly one of app, pid', () => {
    expect(AppRefSchema.safeParse({ app: 'TextEdit' }).success).toBe(true)
    expect(AppRefSchema.safeParse({ pid: 12 }).success).toBe(true)
    expect(AppRefSchema.safeParse({}).success).toBe(false)
    expect(AppRefSchema.safeParse({ app: 'TextEdit', pid: 12 }).success).toBe(false)
    expect(TargetSchema.safeParse({ session: 's', app: { app: 'x' }, window: { id: 1, title: 'y' } }).success).toBe(false)
  })

  it('needs the epoch when a call names an element', () => {
    const base = { session: 's', app: { app: 'TextEdit' } }
    expect(StateGetParamsSchema.safeParse({ ...base, element: 3 }).success).toBe(false)
    expect(StateGetParamsSchema.safeParse({ ...base, element: 3, epoch: 'e1' }).success).toBe(true)
    expect(StateGetParamsSchema.safeParse(base).success).toBe(true)
    const click = { action: 'left_click', element: 3 }
    expect(ActionRunParamsSchema.safeParse({ ...base, action: click, tiers: ['ax'] }).success).toBe(false)
    expect(ActionRunParamsSchema.safeParse({ ...base, action: click, tiers: ['ax'], epoch: 'e1' }).success).toBe(true)
    expect(ActionRunParamsSchema.safeParse({ ...base, action: { action: 'left_click', coordinate: [1, 1] }, tiers: ['ax'] }).success).toBe(true)
    expect(ActionRunParamsSchema.safeParse({ ...base, action: click, tiers: [], epoch: 'e1' }).success).toBe(false)
    const drag = { action: 'left_click_drag', start_element: 2, coordinate: [5, 5] }
    expect(ActionBatchParamsSchema.safeParse({ ...base, actions: [{ action: 'screenshot' }, drag], tiers: ['process'] }).success).toBe(false)
  })

  it('caps a batch at 32 actions', () => {
    const base = { session: 's', app: { app: 'x' }, tiers: ['process'] }
    expect(ActionBatchParamsSchema.safeParse({ ...base, actions: Array(32).fill({ action: 'screenshot' }) }).success).toBe(true)
    expect(ActionBatchParamsSchema.safeParse({ ...base, actions: Array(33).fill({ action: 'screenshot' }) }).success).toBe(false)
    expect(ActionBatchParamsSchema.safeParse({ ...base, actions: [] }).success).toBe(false)
  })

  it('declares 14 methods, each with params and a result', () => {
    expect(Object.keys(COMPUTER_METHODS)).toHaveLength(14)
    for (const [name, m] of Object.entries(COMPUTER_METHODS)) {
      expect(m.params, name).toBeDefined()
      expect(m.result, name).toBeDefined()
    }
  })
})

describe('waits, regions and locks', () => {
  it('keeps every wait row ordered and the wait action capped at its duration', () => {
    for (const w of Object.values(COMPUTER_WAIT)) expect(WaitOptionsSchema.safeParse(w).success).toBe(true)
    expect(waitActionWait(2)).toEqual({ minMs: 0, quietMs: 450, maxMs: 2000, busyMaxMs: 2000 })
    expect(WaitOptionsSchema.safeParse({ minMs: 500, quietMs: 0, maxMs: 100, busyMaxMs: 200 }).success).toBe(false)
  })

  it('refuses an empty or inverted region', () => {
    expect(RegionSchema.safeParse([0, 0, 10, 10]).success).toBe(true)
    expect(RegionSchema.safeParse([10, 0, 10, 10]).success).toBe(false)
    expect(RegionSchema.safeParse([0, 10, 10, 5]).success).toBe(false)
  })

  it('puts both locks in one directory under the temporary directory', () => {
    expect(lockPath('/var/folders/x/T/', 'clipboard')).toBe('/var/folders/x/T/tc-computer/clipboard.lock')
    expect(lockPath('/tmp', 'session')).toBe('/tmp/tc-computer/session.lock')
  })
})
