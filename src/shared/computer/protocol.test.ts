import { describe, expect, it } from 'vitest'
import {
  ACTION_PARAMS,
  ActionBatchParamsSchema,
  ActionRunParamsSchema,
  AppRefSchema,
  COMPUTER_ACTION_NAMES,
  COMPUTER_ACTION_SHAPE,
  COMPUTER_ERROR_KINDS,
  COMPUTER_METHODS,
  COMPUTER_WAIT,
  ActionResultSchema,
  BatchResultSchema,
  ComputerActionSchema,
  ComputerErrorSchema,
  IgnoredRoutesSchema,
  ComputerNotificationSchema,
  FrontReportSchema,
  InputProbeParamsSchema,
  InputViaSchema,
  LEARNED_VIAS,
  ProbeReportSchema,
  RawAXNodeSchema,
  RegionSchema,
  SCROLL_POINTS_PER_CLICK,
  SERVICE,
  STEP_ONLY_ERROR_KINDS,
  SessionRestoreSchema,
  StateGetParamsSchema,
  StepResultSchema,
  TargetSchema,
  WaitOptionsSchema,
  TIER_ORDER,
  TierSchema,
  lockPath,
  tierRank,
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
    expect(new Set(COMPUTER_ACTION_NAMES).size).toBe(22)
    expect(COMPUTER_ACTION_NAMES.slice(17)).toEqual(['set_value', 'perform', 'select_text', 'paste', 'save_as'])
    for (const name of COMPUTER_ACTION_NAMES)
      for (const p of [...ACTION_PARAMS[name].required, ...ACTION_PARAMS[name].optional]) expect(COMPUTER_ACTION_SHAPE).toHaveProperty(p)
  })
})

describe('the input amendments', () => {
  it('takes paste in each format and with an element', () => {
    expect(ok({ action: 'paste', text: 'Hello' })).toBe(true)
    for (const format of ['text', 'markdown', 'html']) expect(ok({ action: 'paste', text: '**Hi**', format }), format).toBe(true)
    expect(ok({ action: 'paste', text: '<b>Hi</b>', format: 'html', element: 33 })).toBe(true)
    expect(ok({ action: 'paste', text: 'x'.repeat(200_000) })).toBe(true)
  })

  it('refuses paste without text, with a coordinate, with an unknown format or past 200,000 units', () => {
    expect(messages({ action: 'paste' })).toContain('paste needs text')
    expect(messages({ action: 'paste', text: '' })).toContain('paste needs a non-empty text')
    expect(messages({ action: 'paste', text: 'a', coordinate: [1, 2] })).toContain('paste takes no coordinate')
    expect(ok({ action: 'paste', text: 'a', format: 'rtf' })).toBe(false)
    expect(messages({ action: 'paste', text: 'x'.repeat(200_001) })).toContain('paste takes at most 200000 UTF-16 units')
  })

  it('takes select_text with prefix, suffix and place, and refuses them elsewhere or with range', () => {
    expect(ok({ action: 'select_text', element: 3, text: 'Total', prefix: 'Sub', suffix: ':' })).toBe(true)
    for (const place of ['select', 'before', 'after']) expect(ok({ action: 'select_text', element: 3, text: 'a', place }), place).toBe(true)
    expect(ok({ action: 'select_text', element: 3, range: [2, 2], place: 'after' })).toBe(true)
    expect(messages({ action: 'select_text', element: 3, range: [0, 1], prefix: 'a' })).toContain('give range or prefix, not both')
    expect(messages({ action: 'select_text', element: 3, range: [0, 1], suffix: 'a' })).toContain('give range or suffix, not both')
    expect(messages({ action: 'type', text: 'a', prefix: 'b' })).toContain('type takes no prefix')
    expect(messages({ action: 'left_click', element: 3, place: 'after' })).toContain('left_click takes no place')
    expect(ok({ action: 'select_text', element: 3, text: 'a', place: 'middle' })).toBe(false)
  })

  it('takes a click duration up to 10 s and refuses 0 or 11', () => {
    for (const action of ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'])
      expect(ok({ action, element: 3, duration: 10 }), action).toBe(true)
    expect(ok({ action: 'left_click', coordinate: [1, 1], duration: 0.2 })).toBe(true)
    expect(ok({ action: 'left_click', element: 3, duration: 0 })).toBe(false)
    expect(messages({ action: 'left_click', element: 3, duration: 11 })).toContain('a click holds its button at most 10 s')
    expect(messages({ action: 'mouse_move', element: 3, duration: 1 })).toContain('mouse_move takes no duration')
  })

  it('carries what a session step changed on an ok step and in a failed step\'s error', () => {
    const session = {
      frontmost: { before: { pid: 511, bundleId: 'com.apple.Terminal', name: 'Terminal' }, after: { pid: 16800, bundleId: null, name: 'TextEdit' } },
      pointer: { before: [812.5, 400], after: [3900, -100] },
      restorable: true
    }
    const okStep = { index: 0, action: 'left_click', status: 'ok', tier: 'session', effect: 'changed', session }
    expect(StepResultSchema.safeParse(okStep).success).toBe(true)
    const failed = {
      index: 1,
      action: 'key',
      status: 'failed',
      error: { kind: 'interrupted', message: 'The person took over.', by: 'person', session: { ...session, restorable: true } }
    }
    expect(StepResultSchema.safeParse(failed).success).toBe(true)
    expect(StepResultSchema.safeParse({ ...okStep, session: { ...session, pointer: { before: [1], after: [2, 3] } } }).success).toBe(false)
  })

  it('names the new error data: the key window and the session reasons', () => {
    expect(ComputerErrorSchema.safeParse({ kind: 'key_window_unavailable', message: 'm', keyWindow: { id: 4, title: 'Inspector' } }).success).toBe(true)
    for (const reason of ['locked', 'secure-input', 'activation-refused', 'in-use'])
      expect(ComputerErrorSchema.safeParse({ kind: 'session_unavailable', message: 'm', reason }).success, reason).toBe(true)
    expect(ComputerErrorSchema.safeParse({ kind: 'text_not_found', message: 'm', element: 7 }).success).toBe(true)
    expect(ComputerErrorSchema.safeParse({ kind: 'session_unavailable', message: 'm', reason: 'busy' }).success).toBe(false)
  })

  it('probes by class and reports each with its outcome; a restore says what it put back', () => {
    const target = { session: 's', app: { app: 'TextEdit' } }
    expect(InputProbeParamsSchema.safeParse(target).success).toBe(true)
    expect(InputProbeParamsSchema.safeParse({ ...target, classes: ['drag'] }).success).toBe(true)
    expect(InputProbeParamsSchema.safeParse({ ...target, classes: [] }).success).toBe(false)
    const report = { pid: 1, bundleId: null, keyWindow: 'none', results: [{ class: 'key', outcome: 'untested', reason: 'the window is not key', restored: true, ms: 1 }] }
    expect(ProbeReportSchema.safeParse(report).success).toBe(true)
    expect(ProbeReportSchema.safeParse({ ...report, keyWindow: 'main' }).success).toBe(false)
    expect(SessionRestoreSchema.safeParse({ frontmost: 'nothing', pointer: 'nothing', held: null }).success).toBe(true)
    expect(SessionRestoreSchema.safeParse({ frontmost: 'app-gone', pointer: 'restored', held: { pid: 2, bundleId: 'x', name: 'X' } }).success).toBe(true)
    expect(SessionRestoreSchema.safeParse({ frontmost: 'gone', pointer: 'restored', held: null }).success).toBe(false)
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

  it('declares 18 methods, each with params and a result', () => {
    expect(Object.keys(COMPUTER_METHODS)).toHaveLength(18)
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

describe('the service shell\'s additions', () => {
  it('answers clipboard.state with the change count, the last foreign change and the watch start', () => {
    const { result } = COMPUTER_METHODS['clipboard.state']
    expect(result.safeParse({ changeCount: 3, foreignChangeAt: null, watchingSince: 1 }).success).toBe(true)
    expect(result.safeParse({ changeCount: 3, foreignChangeAt: 2, watchingSince: 1 }).success).toBe(true)
    expect(result.safeParse({ changeCount: 3, watchingSince: 1 }).success).toBe(false)
  })

  it('lets an observation say why it carries no shot', () => {
    const { result } = COMPUTER_METHODS['state.get']
    const base = {
      epoch: 'e', session: 's', app: { pid: 1, bundleId: null, name: 'A' },
      window: { id: 2, title: 'W', frame: { x: 0, y: 0, w: 10, h: 10 } }, kind: 'full', seq: 1, text: '',
      space: { width: 10, height: 10, scale: 1 },
      stats: { elements: 0, lines: 0, bytes: 0, omitted: 0, thin: true, partial: false, readMs: 0 }
    }
    const shotError = { kind: 'permission_missing', message: 'Screen Recording is off.', which: 'screenRecording' }
    expect(result.safeParse({ ...base, shotError }).success).toBe(true)
  })

  it('names already_running as an error a request answers', () => {
    expect(COMPUTER_ERROR_KINDS).toContain('already_running')
    expect(STEP_ONLY_ERROR_KINDS).not.toContain('already_running')
  })
})

describe("the tier scheduling's additions", () => {
  const target = { session: 's', app: { app: 'TextEdit' } }
  const session = { frontmost: {}, pointer: { before: [1, 2], after: [3, 4] }, restorable: true }

  it('takes input.restoreSession with {} and with afterInterrupt', () => {
    const { params } = COMPUTER_METHODS['input.restoreSession']
    expect(params.safeParse({}).success).toBe(true)
    expect(params.safeParse({ afterInterrupt: true }).success).toBe(true)
    expect(params.safeParse({ afterInterrupt: 'yes' }).success).toBe(false)
    expect(SERVICE.restoreAfterInterruptMs).toBe(2_000)
  })

  it('carries pasteQuietMs on action.run and action.batch', () => {
    expect(ActionRunParamsSchema.safeParse({ ...target, action: { action: 'paste', text: 'x' }, tiers: ['process'], pasteQuietMs: 5_000 }).success).toBe(true)
    expect(ActionBatchParamsSchema.safeParse({ ...target, actions: [{ action: 'key', text: 'a' }], tiers: ['process'], pasteQuietMs: 0 }).success).toBe(true)
    expect(ActionRunParamsSchema.safeParse({ ...target, action: { action: 'key', text: 'a' }, tiers: ['process'], pasteQuietMs: -1 }).success).toBe(false)
  })

  it("parses a session step's span, and a change without one", () => {
    const span = { armedAt: 1_800_000_000_100, idleAtArmMs: 130_000, lastInputAt: 1_800_000_000_900 }
    const okStep = { index: 0, action: 'left_click', status: 'ok', tier: 'session', effect: 'changed', session: { ...session, ...span } }
    expect(StepResultSchema.parse(okStep)).toEqual(okStep)
    expect(StepResultSchema.safeParse({ ...okStep, session }).success).toBe(true)
    expect(StepResultSchema.safeParse({ ...okStep, session: { ...session, ...span, idleAtArmMs: -1 } }).success).toBe(false)
  })

  it('names recent-copy as the reason a paste was held off', () => {
    expect(ComputerErrorSchema.safeParse({ kind: 'clipboard_busy', message: 'The person copied just now.', reason: 'recent-copy' }).success).toBe(true)
  })
})

describe('the window actions (§22)', () => {
  it('carries a recorded window\'s AXMinimized on its raw node', () => {
    const node = RawAXNodeSchema.parse({ role: 'AXWindow', subrole: 'AXStandardWindow', title: 'Notes', minimized: true, children: [] })
    expect(node.minimized).toBe(true)
    expect(RawAXNodeSchema.safeParse({ role: 'AXWindow', minimized: 'yes', children: [] }).success).toBe(false)
  })
})

describe('the background fallbacks (§24)', () => {
  const target = { session: 's', app: { app: 'TextEdit' } }
  const step = { index: 0, action: 'key', status: 'ok', tier: 'ax', effect: 'changed' }

  it('names each fallback route on a step, with what it acted on', () => {
    for (const via of ['menu', 'hit', 'caret', 'scroll-bar', 'scroll-page']) expect(InputViaSchema.safeParse(via).success).toBe(true)
    // appended after the typing routes, so the Swift enum keeps its old order
    expect(InputViaSchema.options.slice(0, 4)).toEqual(['ax-insert', 'ax-value', 'keys', 'paste'])
    const menu = { ...step, input: { via: 'menu', on: 'File › Close' } }
    expect(StepResultSchema.parse(menu)).toEqual(menu)
    expect(StepResultSchema.safeParse({ ...step, input: { via: 'hit', on: 'x'.repeat(201) } }).success).toBe(false)
    expect(LEARNED_VIAS).toEqual(['hit', 'caret', 'scroll-page'])
    expect(SCROLL_POINTS_PER_CLICK).toBe(40)
  })

  it('carries the ignored routes on action.run and action.batch', () => {
    const ignored = { via: ['hit', 'scroll-page'], process: ['click'], skip: true }
    expect(ActionRunParamsSchema.safeParse({ ...target, action: { action: 'left_click', coordinate: [1, 2] }, tiers: ['ax'], ignored }).success).toBe(true)
    expect(ActionBatchParamsSchema.safeParse({ ...target, actions: [{ action: 'key', text: 'a' }], tiers: ['ax'], ignored: {} }).success).toBe(true)
    expect(IgnoredRoutesSchema.safeParse({ via: ['nope'] }).success).toBe(false)
    expect(IgnoredRoutesSchema.safeParse({ process: ['tap'] }).success).toBe(false)
  })

  it("names a disabled menu item's path on the error", () => {
    const e = { kind: 'needs_tier', message: 'File › Close is disabled while TextEdit is in the background.', needed: 'session', menu: ['File', 'Close'] }
    expect(ComputerErrorSchema.parse(e)).toEqual(e)
    expect(ComputerErrorSchema.safeParse({ ...e, menu: Array(9).fill('a') }).success).toBe(false)
  })
})

describe('the front guard\'s additions (§23)', () => {
  const launch = COMPUTER_METHODS['apps.launch']

  it('takes a launch with items, a session and the refused bundles, and the old shape alike', () => {
    expect(launch.params.safeParse({ app: 'TextEdit' }).success).toBe(true)
    expect(launch.params.safeParse({ app: 'Preview', open: ['/tmp/a.pdf'], session: 's', refuse: ['dev.landon.tempcode'] }).success).toBe(true)
    expect(launch.params.safeParse({ app: 'Preview', session: '' }).success).toBe(false)
  })

  it('answers a launch with the front report, the new window and the others, each optional', () => {
    expect(launch.result.parse({ pid: 1, launched: false })).toEqual({ pid: 1, launched: false })
    const full = {
      pid: 1,
      launched: true,
      front: { raised: true, restored: 'restored', ms: 180 },
      window: { id: 9, title: 'report.pdf' },
      others: [{ id: 8, title: 'Untitled — iCloud' }]
    }
    expect(launch.result.parse(full)).toEqual(full)
    expect(FrontReportSchema.safeParse({ raised: true, restored: 'gone' }).success).toBe(false)
    expect(FrontReportSchema.safeParse({ raised: false }).success).toBe(true)
  })

  it('carries front on an action result and a batch result', () => {
    const step = { index: 0, action: 'left_click', status: 'ok', tier: 'ax', effect: 'changed' }
    const front = { raised: true, restored: 'hid-app' }
    expect(ActionResultSchema.parse({ step, front }).front).toEqual(front)
    const waited = { waitedMs: 1, settled: true, busy: false, reason: 'quiet' }
    expect(BatchResultSchema.parse({ steps: [step], waited, front }).front).toEqual(front)
    expect(BatchResultSchema.parse({ steps: [step], waited }).front).toBeUndefined()
  })

  it('tells a late steal as apps/frontRestored', () => {
    const note = { method: 'apps/frontRestored', params: { pid: 3, name: 'IntelliJ IDEA', front: { raised: true, restored: 'restored', ms: 90 }, afterMs: 14_000 } }
    expect(ComputerNotificationSchema.safeParse(note).success).toBe(true)
    expect(ComputerNotificationSchema.safeParse({ ...note, params: { ...note.params, afterMs: -1 } }).success).toBe(false)
  })

  it('refuses an open as open_refused with its reason, a request error', () => {
    expect(COMPUTER_ERROR_KINDS).toContain('open_refused')
    expect(STEP_ONLY_ERROR_KINDS).not.toContain('open_refused')
    for (const reason of ['missing', 'executable', 'scheme', 'app'])
      expect(ComputerErrorSchema.safeParse({ kind: 'open_refused', message: 'x', reason }).success, reason).toBe(true)
  })

  it('keeps its numbers in SERVICE', () => {
    expect(SERVICE).toMatchObject({ frontWatchMs: 30_000, frontChoiceMs: 500, frontRestoreMs: 400, frontStealsMax: 3, openItemsMax: 8 })
  })
})

describe('the front tier, save_as and the commit check (§25)', () => {
  it('appends front to the tier enum and orders it between process and session', () => {
    expect(TierSchema.options).toEqual(['ax', 'process', 'session', 'front'])
    expect(TIER_ORDER).toEqual(['ax', 'process', 'front', 'session'])
    expect(tierRank('front')).toBeGreaterThan(tierRank('process'))
    expect(tierRank('front')).toBeLessThan(tierRank('session'))
  })

  it('takes save_as with a path and replace, and refuses a relative path, a folder, an empty one or replace elsewhere', () => {
    expect(ok({ action: 'save_as', path: '~/run/note.rtf' })).toBe(true)
    expect(ok({ action: 'save_as', path: '/tmp/run/note.txt', replace: true })).toBe(true)
    expect(messages({ action: 'save_as', path: 'run/note.rtf' })).toContain('save_as takes an absolute path or one under ~/')
    expect(messages({ action: 'save_as', path: '~/run/' })).toContain('save_as needs the file name at the end of path')
    expect(ok({ action: 'save_as', path: '' })).toBe(false)
    expect(ok({ action: 'save_as', path: '/' + 'a'.repeat(1_024) })).toBe(false)
    expect(messages({ action: 'save_as' })).toContain('save_as needs path')
    expect(messages({ action: 'key', text: 'a', replace: true })).toContain('key takes no replace')
  })

  it('carries a hold and a disk change on an ok step, and a hold in a failed step\'s error', () => {
    const front = { heldMs: 600, activateMs: 80, restoreMs: 40, restored: 'restored' as const }
    const step = { index: 0, action: 'key', status: 'ok', tier: 'front', effect: 'uncommitted', front, disk: { edited: { before: true, after: true }, hint: 'commit it with key Return in the field' } }
    expect(StepResultSchema.safeParse(step).success).toBe(true)
    expect(StepResultSchema.safeParse({ ...step, front: { ...front, restored: 'gone' } }).success).toBe(false)
    expect(StepResultSchema.safeParse({ ...step, disk: { renamed: [{ from: '~/a.txt', to: '~/b.txt' }], unknown: true } }).success).toBe(true)
    expect(ComputerErrorSchema.safeParse({ kind: 'timeout', message: 'x', front: { ...front, restored: 'person-moved' } }).success).toBe(true)
  })

  it('appends the panel route, the effect and the step-only kinds', () => {
    expect(InputViaSchema.options.at(-1)).toBe('panel')
    expect(COMPUTER_ERROR_KINDS.slice(-2)).toEqual(['not_committed', 'file_exists'])
    expect(STEP_ONLY_ERROR_KINDS).toEqual(expect.arrayContaining(['not_committed', 'file_exists']))
  })

  it('lets initialize name its features both ways, and an older peer leave them out', () => {
    const params = COMPUTER_METHODS.initialize.params
    const base = { protocol: 1, client: { name: 'TempCode', version: '1' }, dataDir: '/tmp' }
    expect(params.parse(base)).not.toHaveProperty('features')
    expect(params.parse({ ...base, features: ['front', 'later-thing'] }).features).toEqual(['front', 'later-thing'])
  })
})
