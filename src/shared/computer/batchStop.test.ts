import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPrior, lastInputEffect, stopsHere } from './batchStop'
import type { ComputerAction, StepEffect, StepResult } from './protocol'

interface Case {
  name: string
  lastEffect?: StepEffect
  action: ComputerAction
  stops: boolean
}

const table = JSON.parse(readFileSync(resolve(__dirname, '../../main/server/computer/fixtures/batch-stop.json'), 'utf8')) as { cases: Case[] }

describe('§27.8: nothing types after a step that changed nothing', () => {
  for (const c of table.cases) it(c.name, () => expect(stopsHere(c.lastEffect, c.action)).toBe(c.stops))
})

const ok = (index: number, action: ComputerAction['action'], effect: StepEffect, extra: Partial<Extract<StepResult, { status: 'ok' }>> = {}): StepResult => ({
  index,
  action,
  status: 'ok',
  tier: action === 'wait' ? null : 'ax',
  effect,
  ...extra
})

describe('§27.7b: what a segment tells the next', () => {
  it('reads the last step that sent input, past a wait', () => {
    const actions: ComputerAction[] = [{ action: 'left_click', element: 3 }, { action: 'wait', duration: 1 }]
    expect(lastInputEffect(actions, [ok(0, 'left_click', 'none'), ok(1, 'wait', 'unknown')])).toBe('none')
    expect(lastInputEffect([], [], 'changed')).toBe('changed')
  })

  it('carries the targeted elements, the resolved ones, the opened windows and the last focus', () => {
    const actions: ComputerAction[] = [
      { action: 'left_click', element: 3 },
      { action: 'left_click', named: 'Team' },
      { action: 'key', text: 'super+n' }
    ]
    const steps = [ok(0, 'left_click', 'changed'), ok(1, 'left_click', 'changed', { resolved: 52 }), ok(2, 'key', 'changed', { opened: { id: 301, title: 'Untitled 2' }, focusTo: 12 })]
    expect(buildPrior(actions, steps)).toEqual({ effect: 'changed', focusTo: 12, targeted: [3, 52], windows: [301] })
  })

  it('drops the focus a later step did not move, and keeps what earlier segments carried', () => {
    const carried = { effect: 'changed' as const, focusTo: 12, targeted: [3], windows: [301] }
    const actions: ComputerAction[] = [{ action: 'left_click', element: 7 }]
    expect(buildPrior(actions, [ok(0, 'left_click', 'none')], carried)).toEqual({ effect: 'none', targeted: [3, 7], windows: [301] })
  })

  it('counts nothing from a step that failed or did not run', () => {
    const actions: ComputerAction[] = [{ action: 'left_click', element: 3 }, { action: 'type', text: 'x' }]
    const steps: StepResult[] = [
      { index: 0, action: 'left_click', status: 'failed', error: { kind: 'stale_element', message: 'gone' } },
      { index: 1, action: 'type', status: 'not-run' }
    ]
    expect(buildPrior(actions, steps)).toEqual({ effect: 'unknown', targeted: [] })
  })
})
